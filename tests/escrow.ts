import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * On-chain adversarial suite for the PPV escrow kernel.
 *
 * The happy path is three assertions of the twenty here. Every other test
 * exists to prove a specific illegal action fails: the state machine is a
 * financial control, and a control nobody attacks is a control nobody has
 * tested. Rows here track the attack matrix in docs/security-model.md.
 */

const AGREEMENT_SEED = new TextEncoder().encode("agreement");
const VAULT_AUTHORITY_SEED = new TextEncoder().encode("vault");
const VAULT_TOKEN_SEED = new TextEncoder().encode("vault_token");
const PROOF_SEED = new TextEncoder().encode("proof");
const DECIMALS = 6;
const AMOUNT = 100_000_000n; // 100 tokens

let nextAgreementId = 1n;
function freshAgreementId(): BN {
  const id = nextAgreementId;
  nextAgreementId += 1n;
  return new BN(id.toString());
}

function idSeed(agreementId: BN): Uint8Array {
  return Uint8Array.from(agreementId.toArrayLike(Buffer, "le", 8));
}

function hash32(marker: number): number[] {
  return Array<number>(32).fill(marker);
}

function addresses(programId: PublicKey, creator: PublicKey, agreementId: BN) {
  const [agreement] = PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, creator.toBytes(), idSeed(agreementId)],
    programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [VAULT_AUTHORITY_SEED, agreement.toBytes()],
    programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_SEED, agreement.toBytes()],
    programId,
  );
  return { agreement, vaultAuthority, vault };
}

function proofAddress(programId: PublicKey, agreement: PublicKey, index: number): PublicKey {
  const seed = Buffer.alloc(4);
  seed.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync(
    [PROOF_SEED, agreement.toBytes(), seed],
    programId,
  )[0];
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof anchor.AnchorError) return error.error.errorCode.code;
  return undefined;
}

async function expectAnchorError(
  operation: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await operation;
    assert.fail(`expected Anchor error ${expectedCode}`);
  } catch (error) {
    const actualCode = errorCode(error);
    if (actualCode !== undefined) {
      assert.equal(actualCode, expectedCode);
      return;
    }
    assert.match(String(error), new RegExp(expectedCode, "i"));
  }
}

async function fundWallet(connection: Connection, wallet: PublicKey): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.requestAirdrop(wallet, 5 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

describe("PPV escrow kernel", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Generated IDL types are created by `anchor build`; `any` keeps this source
  // type-checkable before build while runtime calls still use the generated IDL.
  const escrow = anchor.workspace.PpvEscrow as any;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  let mint: PublicKey;
  let otherMint: PublicKey;
  let buyer: Keypair;
  let seller: Keypair;
  let attacker: Keypair;
  let buyerTokens: PublicKey;
  let sellerTokens: PublicKey;
  let attackerTokens: PublicKey;

  /** Reads the escrow events one transaction emitted through `emit_cpi!`. */
  async function eventsOf(signature: string): Promise<Array<{ name: string; data: any }>> {
    await connection.confirmTransaction(signature, "confirmed");
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert.ok(tx, "transaction not found");
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses,
    });
    const events: Array<{ name: string; data: any }> = [];
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const ix of inner.instructions) {
        const programId = keys.get(ix.programIdIndex);
        if (!programId?.equals(escrow.programId)) continue;
        // Event CPI data is [8-byte event-ix tag][8-byte discriminator][borsh].
        const data = anchor.utils.bytes.bs58.decode(ix.data);
        if (data.length < 16) continue;
        const decoded = escrow.coder.events.decode(
          Buffer.from(data.subarray(8)).toString("base64"),
        );
        if (decoded) events.push(decoded);
      }
    }
    return events;
  }

  // Anchor has moved event names between PascalCase and camelCase across IDL
  // revisions; the protocol fact is the name, not its casing.
  function eventNamed(events: Array<{ name: string; data: any }>, name: string): any {
    const match = events.find(
      (event) => event.name?.toLowerCase() === name.toLowerCase(),
    );
    assert.ok(match, `expected a ${name} event, saw [${events.map((e) => e.name).join(", ")}]`);
    return match.data;
  }

  async function initialize(options?: {
    creator?: Keypair;
    counterparty?: PublicKey;
    amount?: bigint;
    mint?: PublicKey;
    agreementId?: BN;
    agreementType?: Record<string, unknown>;
    termsHash?: number[];
  }) {
    const creator = options?.creator ?? buyer;
    const agreementId = options?.agreementId ?? freshAgreementId();
    const useMint = options?.mint ?? mint;
    const derived = addresses(escrow.programId, creator.publicKey, agreementId);
    const signature = await escrow.methods
      .initializeAgreement(
        agreementId,
        options?.counterparty ?? seller.publicKey,
        options?.agreementType ?? { escrow: {} },
        new BN((options?.amount ?? AMOUNT).toString()),
        options?.termsHash ?? hash32(7),
      )
      .accounts({
        creator: creator.publicKey,
        mint: useMint,
        agreement: derived.agreement,
        vaultAuthority: derived.vaultAuthority,
        vault: derived.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();
    return { ...derived, agreementId, signature, creator, mint: useMint };
  }

  function fund(
    agreement: Awaited<ReturnType<typeof initialize>>,
    overrides?: {
      signer?: Keypair;
      vault?: PublicKey;
      mint?: PublicKey;
      source?: PublicKey;
    },
  ) {
    const signer = overrides?.signer ?? buyer;
    return escrow.methods
      .fund()
      .accounts({
        buyer: signer.publicKey,
        agreement: agreement.agreement,
        mint: overrides?.mint ?? agreement.mint,
        vault: overrides?.vault ?? agreement.vault,
        funderTokenAccount: overrides?.source ?? buyerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  function markCompleted(
    agreement: Awaited<ReturnType<typeof initialize>>,
    signer: Keypair = seller,
  ) {
    return escrow.methods
      .markCompleted()
      .accounts({ seller: signer.publicKey, agreement: agreement.agreement })
      .signers([signer])
      .rpc();
  }

  function settle(
    agreement: Awaited<ReturnType<typeof initialize>>,
    overrides?: {
      signer?: Keypair;
      destination?: PublicKey;
      vault?: PublicKey;
      vaultAuthority?: PublicKey;
      mint?: PublicKey;
    },
  ) {
    const signer = overrides?.signer ?? seller;
    return escrow.methods
      .settle()
      .accounts({
        signer: signer.publicKey,
        agreement: agreement.agreement,
        mint: overrides?.mint ?? agreement.mint,
        vault: overrides?.vault ?? agreement.vault,
        vaultAuthority: overrides?.vaultAuthority ?? agreement.vaultAuthority,
        sellerTokenAccount: overrides?.destination ?? sellerTokens,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  async function fundedAgreement() {
    const agreement = await initialize();
    await fund(agreement);
    return agreement;
  }

  async function completedAgreement() {
    const agreement = await fundedAgreement();
    await markCompleted(agreement);
    return agreement;
  }

  before(async () => {
    buyer = Keypair.generate();
    seller = Keypair.generate();
    attacker = Keypair.generate();
    for (const wallet of [buyer, seller, attacker]) {
      await fundWallet(connection, wallet.publicKey);
    }

    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    otherMint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);

    buyerTokens = await createAssociatedTokenAccount(connection, payer, mint, buyer.publicKey);
    sellerTokens = await createAssociatedTokenAccount(connection, payer, mint, seller.publicKey);
    attackerTokens = await createAssociatedTokenAccount(connection, payer, mint, attacker.publicKey);

    await mintTo(connection, payer, mint, buyerTokens, payer, 100_000n * 10n ** BigInt(DECIMALS));
  });

  describe("initialization", () => {
    it("creates a namespaced agreement and its own empty vault", async () => {
      const created = await initialize();
      const account = await escrow.account.agreement.fetch(created.agreement);

      assert.equal(account.creator.toBase58(), buyer.publicKey.toBase58());
      assert.equal(account.counterparty.toBase58(), seller.publicKey.toBase58());
      assert.equal(account.mint.toBase58(), mint.toBase58());
      assert.equal(account.vault.toBase58(), created.vault.toBase58());
      assert.equal(account.amount.toString(), AMOUNT.toString());
      assert.ok("open" in account.state);
      assert.equal(account.fundedAt.toNumber(), 0);

      // Custody state and protocol state start independent: the vault exists
      // and holds nothing, and the agreement says so.
      const vault = await getAccount(connection, created.vault);
      assert.equal(vault.amount, 0n);
      assert.equal(vault.mint.toBase58(), mint.toBase58());
      assert.equal(vault.owner.toBase58(), created.vaultAuthority.toBase58());

      const event = eventNamed(await eventsOf(created.signature), "agreementCreated");
      assert.equal(event.agreement.toBase58(), created.agreement.toBase58());
      assert.equal(event.creator.toBase58(), buyer.publicKey.toBase58());
      assert.equal(event.counterparty.toBase58(), seller.publicKey.toBase58());
      assert.equal(event.amount.toString(), AMOUNT.toString());
      assert.ok("open" in event.newState);
    });

    it("refuses a second agreement at the same deterministic address", async () => {
      const created = await initialize();
      await assert.rejects(initialize({ agreementId: created.agreementId }));
    });

    it("gives two creators independent namespaces for the same id", async () => {
      const agreementId = freshAgreementId();
      const mine = await initialize({ agreementId });
      const theirs = await initialize({
        agreementId,
        creator: attacker,
        counterparty: seller.publicKey,
      });

      assert.notEqual(mine.agreement.toBase58(), theirs.agreement.toBase58());
      assert.notEqual(mine.vault.toBase58(), theirs.vault.toBase58());
      const account = await escrow.account.agreement.fetch(theirs.agreement);
      assert.equal(account.creator.toBase58(), attacker.publicKey.toBase58());
    });

    it("rejects an agreement that cannot be settled honestly", async () => {
      await expectAnchorError(
        initialize({ counterparty: buyer.publicKey }),
        "InvalidCounterparty",
      );
      await expectAnchorError(
        initialize({ counterparty: PublicKey.default }),
        "InvalidCounterparty",
      );
      await expectAnchorError(initialize({ amount: 0n }), "InvalidAmount");
      await expectAnchorError(
        initialize({ termsHash: Array<number>(32).fill(0) }),
        "InvalidTermsHash",
      );
    });

    it("rejects an agreement type the kernel does not implement", async () => {
      const unsupported: Array<Record<string, unknown>> = [
        { invoice: {} },
        { contract: {} },
        { milestoneContract: {} },
        { bounty: {} },
        { proofOnly: {} },
      ];
      for (const agreementType of unsupported) {
        await expectAnchorError(initialize({ agreementType }), "UnsupportedAgreementType");
      }
    });
  });

  describe("funding", () => {
    it("moves the exact agreed amount and only then records the transition", async () => {
      const agreement = await initialize();
      const before = await getAccount(connection, buyerTokens);

      const signature = await fund(agreement);

      const vault = await getAccount(connection, agreement.vault);
      const after = await getAccount(connection, buyerTokens);
      assert.equal(vault.amount, AMOUNT);
      assert.equal(before.amount - after.amount, AMOUNT);

      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("funded" in account.state);
      assert.ok(account.fundedAt.toNumber() > 0);

      const event = eventNamed(await eventsOf(signature), "agreementFunded");
      assert.equal(event.amount.toString(), AMOUNT.toString());
      assert.equal(event.vault.toBase58(), agreement.vault.toBase58());
      assert.ok("open" in event.previousState);
      assert.ok("funded" in event.newState);
    });

    it("refuses anyone but the buyer", async () => {
      const agreement = await initialize();
      await expectAnchorError(fund(agreement, { signer: seller }), "NotTheBuyer");
      await expectAnchorError(fund(agreement, { signer: attacker }), "NotTheBuyer");

      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("open" in account.state);
    });

    it("refuses a second funding of the same agreement", async () => {
      const agreement = await fundedAgreement();
      await expectAnchorError(fund(agreement), "BadState");
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT, "a rejected funding moves nothing");
    });

    it("refuses a substituted mint, vault, or funding source", async () => {
      const agreement = await initialize();
      const other = await initialize();

      await expectAnchorError(fund(agreement, { mint: otherMint }), "MintMismatch");
      // Another agreement's canonical vault is not this agreement's vault.
      await assert.rejects(fund(agreement, { vault: other.vault }));
      // Nor is a token account the attacker owns outright.
      const fake = await createAccount(connection, payer, mint, attacker.publicKey, Keypair.generate());
      await assert.rejects(fund(agreement, { vault: fake }));
      await expectAnchorError(
        fund(agreement, { source: sellerTokens }),
        "SourceNotOwnedByBuyer",
      );

      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("open" in account.state, "no failed attempt advanced the state");
    });

    it("does not treat a direct token transfer as funding", async () => {
      // Anyone can send tokens to a token account. Custody is not consent:
      // the agreement stays Open until the protocol itself accepts a fund().
      const agreement = await initialize();
      await mintTo(connection, payer, mint, agreement.vault, payer, AMOUNT);

      const donated = await getAccount(connection, agreement.vault);
      assert.equal(donated.amount, AMOUNT);
      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("open" in account.state);

      // And a real funding still moves exactly the agreed amount on top of it.
      await fund(agreement);
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT * 2n);
    });
  });

  describe("completion", () => {
    it("is the seller's alone and moves no money", async () => {
      const agreement = await fundedAgreement();
      const before = await getAccount(connection, agreement.vault);

      const signature = await markCompleted(agreement);

      const after = await getAccount(connection, agreement.vault);
      assert.equal(after.amount, before.amount, "completion is not settlement");
      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("completed" in account.state);

      const event = eventNamed(await eventsOf(signature), "workCompleted");
      assert.equal(event.actor.toBase58(), seller.publicKey.toBase58());
      assert.ok("funded" in event.previousState);
      assert.ok("completed" in event.newState);
    });

    it("refuses the buyer and any outsider", async () => {
      const agreement = await fundedAgreement();
      await expectAnchorError(markCompleted(agreement, buyer), "NotTheSeller");
      await expectAnchorError(markCompleted(agreement, attacker), "NotTheSeller");
    });

    it("refuses completion before funding, and twice", async () => {
      const unfunded = await initialize();
      await expectAnchorError(markCompleted(unfunded), "BadState");

      const completed = await completedAgreement();
      await expectAnchorError(markCompleted(completed), "BadState");
    });
  });

  describe("settlement", () => {
    it("pays the seller exactly once and closes the lifecycle", async () => {
      const agreement = await completedAgreement();
      const before = await getAccount(connection, sellerTokens);

      const signature = await settle(agreement);

      const vault = await getAccount(connection, agreement.vault);
      const after = await getAccount(connection, sellerTokens);
      assert.equal(vault.amount, 0n);
      assert.equal(after.amount - before.amount, AMOUNT);

      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.ok("settled" in account.state);

      const event = eventNamed(await eventsOf(signature), "settlementExecuted");
      assert.equal(event.buyer.toBase58(), buyer.publicKey.toBase58());
      assert.equal(event.seller.toBase58(), seller.publicKey.toBase58());
      assert.equal(event.destination.toBase58(), sellerTokens.toBase58());
      assert.equal(event.amount.toString(), AMOUNT.toString());
      assert.equal(event.proof, null);
      assert.ok("completed" in event.previousState);
      assert.ok("settled" in event.newState);
    });

    it("cannot run before the work is marked complete", async () => {
      const open = await initialize();
      await expectAnchorError(settle(open), "BadState");

      const funded = await fundedAgreement();
      await expectAnchorError(settle(funded), "BadState");

      const vault = await getAccount(connection, funded.vault);
      assert.equal(vault.amount, AMOUNT, "a rejected settlement moves nothing");
    });

    it("cannot run twice", async () => {
      const agreement = await completedAgreement();
      await settle(agreement);
      await expectAnchorError(settle(agreement), "BadState");

      const seller_after = await getAccount(connection, agreement.vault);
      assert.equal(seller_after.amount, 0n);
    });

    it("cannot be redirected away from the seller", async () => {
      const agreement = await completedAgreement();
      await expectAnchorError(
        settle(agreement, { destination: attackerTokens }),
        "DestinationNotOwnedBySeller",
      );
      await expectAnchorError(
        settle(agreement, { destination: buyerTokens }),
        "DestinationNotOwnedBySeller",
      );

      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT);
    });

    it("refuses a substituted vault, vault authority, or mint", async () => {
      const agreement = await completedAgreement();
      const other = await completedAgreement();

      await assert.rejects(settle(agreement, { vault: other.vault }));
      await assert.rejects(settle(agreement, { vaultAuthority: other.vaultAuthority }));
      await expectAnchorError(settle(agreement, { mint: otherMint }), "MintMismatch");

      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT, "no substitution drained the vault");
    });

    it("refuses an outsider, and lets either party trigger it", async () => {
      const outsiderAttempt = await completedAgreement();
      await expectAnchorError(settle(outsiderAttempt, { signer: attacker }), "NotAParty");

      // The destination is constrained to the seller, so a buyer-triggered
      // settlement can still only pay the seller.
      const before = await getAccount(connection, sellerTokens);
      await settle(outsiderAttempt, { signer: buyer });
      const after = await getAccount(connection, sellerTokens);
      assert.equal(after.amount - before.amount, AMOUNT);
    });

    it("emits nothing when it fails", async () => {
      const agreement = await fundedAgreement();
      try {
        await settle(agreement);
        assert.fail("settlement should have been rejected");
      } catch (error) {
        assert.equal(errorCode(error), "BadState");
      }

      // The transaction never committed, so there is no event and no receipt
      // an indexer could build from it.
      const history = await connection.getSignaturesForAddress(agreement.agreement, {
        limit: 20,
      });
      for (const entry of history) {
        assert.equal(entry.err, null, "a failed transaction must not be recorded as history");
      }
    });

    it("leaves a donated surplus untouched and settles the agreed amount", async () => {
      const agreement = await initialize();
      await fund(agreement);
      await mintTo(connection, payer, mint, agreement.vault, payer, 5_000_000n);
      await markCompleted(agreement);

      const before = await getAccount(connection, sellerTokens);
      await settle(agreement);
      const after = await getAccount(connection, sellerTokens);
      const vault = await getAccount(connection, agreement.vault);

      assert.equal(after.amount - before.amount, AMOUNT, "the seller receives the agreed amount");
      assert.equal(vault.amount, 5_000_000n, "a donation is not the seller's to take");
    });
  });

  describe("cross-agreement isolation", () => {
    it("keeps one agreement's custody unreachable from another", async () => {
      const mine = await completedAgreement();
      const theirs = await initialize({ creator: attacker, counterparty: attacker.publicKey });

      // An attacker's own agreement cannot name someone else's vault, and its
      // vault authority cannot sign for someone else's vault.
      await assert.rejects(
        escrow.methods
          .settle()
          .accounts({
            signer: attacker.publicKey,
            agreement: theirs.agreement,
            mint,
            vault: mine.vault,
            vaultAuthority: theirs.vaultAuthority,
            sellerTokenAccount: attackerTokens,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc(),
      );

      const vault = await getAccount(connection, mine.vault);
      assert.equal(vault.amount, AMOUNT);
    });
  });

  describe("proofs", () => {
    function submitProof(
      agreement: Awaited<ReturnType<typeof initialize>>,
      overrides?: { signer?: Keypair; index?: number; contentHash?: number[]; metadataHash?: number[] },
    ) {
      const signer = overrides?.signer ?? seller;
      const index = overrides?.index ?? 0;
      return escrow.methods
        .submitProof(overrides?.contentHash ?? hash32(12), overrides?.metadataHash ?? hash32(0))
        .accounts({
          submitter: signer.publicKey,
          agreement: agreement.agreement,
          proof: proofAddress(escrow.programId, agreement.agreement, index),
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc();
    }

    it("anchors evidence to the agreement without moving it", async () => {
      const agreement = await fundedAgreement();
      const before = await escrow.account.agreement.fetch(agreement.agreement);
      const vaultBefore = await getAccount(connection, agreement.vault);

      const signature = await submitProof(agreement);

      const proof = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.equal(proof.agreement.toBase58(), agreement.agreement.toBase58());
      assert.equal(proof.submitter.toBase58(), seller.publicKey.toBase58());
      assert.equal(proof.proofIndex, 0);
      assert.deepEqual([...proof.contentHash], hash32(12));
      assert.ok("submitted" in proof.status);
      assert.equal(proof.decidedAt.toNumber(), 0);

      // A proof is a fact about the agreement, not a step in it.
      const after = await escrow.account.agreement.fetch(agreement.agreement);
      assert.deepEqual(after.state, before.state);
      assert.equal(after.proofCount, 1);
      const vaultAfter = await getAccount(connection, agreement.vault);
      assert.equal(vaultAfter.amount, vaultBefore.amount);

      const event = eventNamed(await eventsOf(signature), "proofSubmitted");
      assert.equal(event.agreement.toBase58(), agreement.agreement.toBase58());
      assert.equal(event.submitter.toBase58(), seller.publicKey.toBase58());
      assert.equal(event.proofIndex, 0);
      assert.ok("funded" in event.agreementState);
    });

    it("accepts evidence from either party and nobody else", async () => {
      const agreement = await fundedAgreement();
      await submitProof(agreement, { signer: seller, index: 0 });
      await submitProof(agreement, { signer: buyer, index: 1 });

      await expectAnchorError(
        submitProof(agreement, { signer: attacker, index: 2 }),
        "NotAParty",
      );
      const account = await escrow.account.agreement.fetch(agreement.agreement);
      assert.equal(account.proofCount, 2, "a refused submission consumes no index");
    });

    it("numbers proofs densely, and refuses a client-chosen index", async () => {
      const agreement = await fundedAgreement();
      await submitProof(agreement, { index: 0 });

      // The index comes from the agreement's counter. Passing the account for
      // any other index is a seeds failure, so a client cannot leave gaps or
      // overwrite an existing proof.
      await assert.rejects(submitProof(agreement, { index: 5 }));
      await assert.rejects(submitProof(agreement, { index: 0 }));

      await submitProof(agreement, { index: 1 });
      const second = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 1),
      );
      assert.equal(second.proofIndex, 1);
    });

    it("refuses evidence outside the agreement's live window", async () => {
      const open = await initialize();
      await expectAnchorError(submitProof(open), "BadState");

      const completed = await completedAgreement();
      await submitProof(completed);

      await settle(completed);
      await expectAnchorError(submitProof(completed, { index: 1 }), "BadState");
    });

    it("refuses a commitment to nothing", async () => {
      const agreement = await fundedAgreement();
      await expectAnchorError(
        submitProof(agreement, { contentHash: Array<number>(32).fill(0) }),
        "InvalidContentHash",
      );
    });

    it("keeps one agreement's evidence unusable by another", async () => {
      const mine = await fundedAgreement();
      const theirs = await fundedAgreement();
      await submitProof(mine, { index: 0 });

      // Invariant 11, structurally: index 0 under one agreement is a different
      // address from index 0 under another, so there is no proof to substitute.
      assert.notEqual(
        proofAddress(escrow.programId, mine.agreement, 0).toBase58(),
        proofAddress(escrow.programId, theirs.agreement, 0).toBase58(),
      );
      await assert.rejects(
        escrow.methods
          .submitProof(hash32(12), hash32(0))
          .accounts({
            submitter: seller.publicKey,
            agreement: theirs.agreement,
            proof: proofAddress(escrow.programId, mine.agreement, 0),
            systemProgram: SystemProgram.programId,
          })
          .signers([seller])
          .rpc(),
      );
    });
  });

  describe("chain-data reconstruction", () => {
    // `@gwap/ppv-indexer` rebuilds an agreement's history from RPC alone, and
    // its unit tests run against fixtures this repository writes. That proves
    // the indexer matches our idea of Anchor's output. These assertions check
    // the idea itself against the real thing, on the exact RPC shape the
    // indexer consumes — because every one of them, if wrong, produces an
    // agreement that silently looks like it never happened.
    const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

    function eventDiscriminator(name: string): Buffer {
      return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
    }

    async function rawTransaction(signature: string): Promise<any> {
      await connection.confirmTransaction(signature, "confirmed");
      const response = await fetch(connection.rpcEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            signature,
            { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
          ],
        }),
      });
      const body = (await response.json()) as { result?: any; error?: { message?: string } };
      assert.equal(body.error, undefined, `getTransaction failed: ${body.error?.message}`);
      assert.ok(body.result, "the RPC returned no transaction");
      return body.result;
    }

    /** The account list instruction indices address, in RPC order. */
    function accountKeys(tx: any): string[] {
      return [
        ...tx.transaction.message.accountKeys,
        ...(tx.meta?.loadedAddresses?.writable ?? []),
        ...(tx.meta?.loadedAddresses?.readonly ?? []),
      ];
    }

    function eventInstructions(tx: any, eventAuthority: PublicKey) {
      const keys = accountKeys(tx);
      const found: Array<{ data: Buffer; innerInstructionIndex: number; instructionIndex: number }> = [];
      for (const group of tx.meta?.innerInstructions ?? []) {
        group.instructions.forEach((ix: any, innerInstructionIndex: number) => {
          if (keys[ix.programIdIndex] !== escrow.programId.toBase58()) return;
          if (keys[ix.accounts[0]] !== eventAuthority.toBase58()) return;
          found.push({
            data: Buffer.from(anchor.utils.bytes.bs58.decode(ix.data)),
            innerInstructionIndex,
            instructionIndex: group.index,
          });
        });
      }
      return found;
    }

    it("emits events an outside indexer can find and attribute", async () => {
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        escrow.programId,
      );

      const agreement = await initialize();
      const fundSignature = await fund(agreement);
      const completeSignature = await markCompleted(agreement);
      const settleSignature = await settle(agreement);

      const steps: Array<[string, string]> = [
        [agreement.signature, "AgreementCreated"],
        [fundSignature, "AgreementFunded"],
        [completeSignature, "WorkCompleted"],
        [settleSignature, "SettlementExecuted"],
      ];

      for (const [signature, name] of steps) {
        const tx = await rawTransaction(signature);
        assert.equal(tx.meta.err, null);

        const events = eventInstructions(tx, eventAuthority);
        assert.equal(events.length, 1, `expected exactly one event in the ${name} transaction`);
        const [event] = events;

        // The wire format the SDK decoder assumes: an event-ix tag, then the
        // discriminator derived from the event name, then the borsh fields.
        assert.deepEqual(event!.data.subarray(0, 8), EVENT_IX_TAG);
        assert.deepEqual(event!.data.subarray(8, 16), eventDiscriminator(name));
        // Every escrow event opens with the agreement it describes, which is
        // what lets an indexer attribute one without reading the account.
        assert.equal(
          new PublicKey(event!.data.subarray(16, 48)).toBase58(),
          agreement.agreement.toBase58(),
        );
      }
    });

    it("puts no event in the transaction of a rejected instruction", async () => {
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        escrow.programId,
      );
      const funded = await fundedAgreement();

      // A settlement that the state machine refuses. Nothing commits, so an
      // indexer reading only committed transactions can never see it.
      await expectAnchorError(settle(funded), "BadState");

      const history = await connection.getSignaturesForAddress(funded.agreement, { limit: 20 });
      for (const entry of history) {
        assert.equal(entry.err, null);
        const tx = await rawTransaction(entry.signature);
        for (const event of eventInstructions(tx, eventAuthority)) {
          assert.notDeepEqual(
            event.data.subarray(8, 16),
            eventDiscriminator("SettlementExecuted"),
            "a refused settlement must leave no settlement event behind",
          );
        }
      }
    });
  });
});
