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
const MILESTONE_SEED = new TextEncoder().encode("milestone");
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

const CORE_PROOF_SEED = new TextEncoder().encode("proof");
const CORE_PROOF_ID_DOMAIN = new TextEncoder().encode("ppv:escrow:core-proof:v1");

/**
 * Mirrors `core_proof_id` in `programs/ppv_escrow/src/state/proof.rs`. Written
 * out here rather than imported so a drift between the program and its clients
 * fails a test instead of silently agreeing with itself.
 */
function coreProofId(agreement: PublicKey, index: number): Buffer {
  const seed = Buffer.alloc(4);
  seed.writeUInt32LE(index);
  return createHash("sha256")
    .update(CORE_PROOF_ID_DOMAIN)
    .update(agreement.toBuffer())
    .update(seed)
    .digest()
    .subarray(0, 16);
}

/** Derived under ppv_core's id: the record is ppv_core's account, not ours. */
function coreProofAddress(
  coreProgramId: PublicKey,
  submitter: PublicKey,
  agreement: PublicKey,
  index: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CORE_PROOF_SEED, submitter.toBytes(), coreProofId(agreement, index)],
    coreProgramId,
  )[0];
}

function coreEventAuthority(coreProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    coreProgramId,
  )[0];
}

function milestoneAddress(programId: PublicKey, agreement: PublicKey, index: number): PublicKey {
  const seed = Buffer.alloc(4);
  seed.writeUInt32LE(index);
  return PublicKey.findProgramAddressSync(
    [MILESTONE_SEED, agreement.toBytes(), seed],
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
  // ppv_escrow calls into ppv_core to mint proof commitments, so the proof
  // tests exercise two programs. Both must be deployed for this suite to run.
  const core = anchor.workspace.PpvCore as any;
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

  /**
   * The account list `submit_proof` needs, in one place.
   *
   * ppv_escrow mints the commitment in ppv_core over a CPI, so the instruction
   * carries three accounts beyond its own: the core proof record, ppv_core's
   * event authority, and ppv_core itself as the typed CPI target. Three call
   * sites built this list independently, and when the CPI landed only one of
   * them was updated — nine tests failed on `Account \`coreProof\` not
   * provided`. One builder, so the next account cannot be added to some of them.
   */
  function submitProofAccounts(
    agreement: PublicKey,
    submitter: PublicKey,
    index: number,
    overrides?: { coreProof?: PublicKey; coreProgram?: PublicKey },
  ) {
    return {
      submitter,
      agreement,
      proof: proofAddress(escrow.programId, agreement, index),
      coreProof:
        overrides?.coreProof ??
        coreProofAddress(core.programId, submitter, agreement, index),
      coreEventAuthority: coreEventAuthority(core.programId),
      ppvCoreProgram: overrides?.coreProgram ?? core.programId,
      systemProgram: SystemProgram.programId,
    };
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
      settlementProof?: PublicKey | null;
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
        settlementProof: overrides?.settlementProof ?? null,
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
      const account = await escrow.account.escrowAgreement.fetch(created.agreement);

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

      const event = eventNamed(await eventsOf(created.signature), "agreementOpened");
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
      const account = await escrow.account.escrowAgreement.fetch(theirs.agreement);
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

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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

      // Two guards, and which one answers depends on whose money is offered.
      // Funding from one's own account reaches the state machine, and
      // `require_fundable` refuses a signer who is not the agreement's buyer.
      await expectAnchorError(
        fund(agreement, { signer: seller, source: sellerTokens }),
        "NotTheBuyer",
      );
      await expectAnchorError(
        fund(agreement, { signer: attacker, source: attackerTokens }),
        "NotTheBuyer",
      );

      // Spending the buyer's account never gets that far: the accounts
      // constraint requires the source to belong to the signer, and Anchor
      // resolves constraints before the handler body runs. Both refusals are
      // correct; asserting the wrong one hides which layer is doing the work.
      await expectAnchorError(
        fund(agreement, { signer: seller }),
        "SourceNotOwnedByBuyer",
      );

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("open" in account.state, "no failed attempt advanced the state");
    });

    it("does not treat a direct token transfer as funding", async () => {
      // Anyone can send tokens to a token account. Custody is not consent:
      // the agreement stays Open until the protocol itself accepts a fund().
      const agreement = await initialize();
      await mintTo(connection, payer, mint, agreement.vault, payer, AMOUNT);

      const donated = await getAccount(connection, agreement.vault);
      assert.equal(donated.amount, AMOUNT);
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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
      // `confirmed` explicitly: the provider's connection defaults to
      // `processed`, and web3.js refuses this method below `confirmed` rather
      // than returning a partial answer.
      const history = await connection.getSignaturesForAddress(
        agreement.agreement,
        { limit: 20 },
        "confirmed",
      );
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
      // The attacker's counterparty is irrelevant to what this proves, but it
      // cannot be the attacker: `initialize_agreement` refuses an agreement a
      // wallet holds with itself, so naming themselves fails before the test
      // reaches the thing it is testing.
      const theirs = await initialize({ creator: attacker, counterparty: seller.publicKey });

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
            settlementProof: null,
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
      overrides?: {
        signer?: Keypair;
        index?: number;
        contentHash?: number[];
        metadataHash?: number[];
        coreProof?: PublicKey;
        coreProgram?: PublicKey;
      },
    ) {
      const signer = overrides?.signer ?? seller;
      const index = overrides?.index ?? 0;
      return escrow.methods
        .submitProof(overrides?.contentHash ?? hash32(12), overrides?.metadataHash ?? hash32(0))
        .accounts(
          submitProofAccounts(agreement.agreement, signer.publicKey, index, overrides),
        )
        .signers([signer])
        .rpc();
    }

    it("anchors evidence to the agreement without moving it", async () => {
      const agreement = await fundedAgreement();
      const before = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      const vaultBefore = await getAccount(connection, agreement.vault);

      const signature = await submitProof(agreement);

      const proof = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.equal(proof.agreement.toBase58(), agreement.agreement.toBase58());
      assert.equal(proof.submitter.toBase58(), seller.publicKey.toBase58());
      assert.equal(proof.proofIndex, 0);
      assert.ok("submitted" in proof.status);
      assert.equal(proof.decidedAt.toNumber(), 0);

      // The commitment itself lives in ppv_core, written by the CPI. ppv_escrow
      // stores no hash of its own — one proof primitive, one place to revoke.
      const expectedCoreProof = coreProofAddress(
        core.programId,
        seller.publicKey,
        agreement.agreement,
        0,
      );
      assert.equal(proof.coreProof.toBase58(), expectedCoreProof.toBase58());
      const record = await core.account.proofRecord.fetch(expectedCoreProof);
      assert.deepEqual([...record.contentHash], hash32(12));
      // The submitter's signature crossed the CPI; ppv_escrow signed for
      // nothing, so the authority is the wallet that actually committed and it
      // is the wallet that can revoke.
      assert.equal(record.authority.toBase58(), seller.publicKey.toBase58());
      assert.ok("active" in record.status);

      // A proof is a fact about the agreement, not a step in it.
      const after = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
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
            coreProof: coreProofAddress(
              core.programId,
              seller.publicKey,
              theirs.agreement,
              0,
            ),
            coreEventAuthority: coreEventAuthority(core.programId),
            ppvCoreProgram: core.programId,
            systemProgram: SystemProgram.programId,
          })
          .signers([seller])
          .rpc(),
      );
    });

    it("refuses a core proof account at any address but the derived one", async () => {
      const mine = await fundedAgreement();
      const theirs = await fundedAgreement();

      // The record ppv_core writes is addressed by (submitter, agreement,
      // index) and nothing the client chooses. Substituting another
      // agreement's derivation would file this agreement's evidence somewhere
      // this agreement does not point.
      await expectAnchorError(
        submitProof(mine, {
          coreProof: coreProofAddress(
            core.programId,
            seller.publicKey,
            theirs.agreement,
            0,
          ),
        }),
        "CoreProofMismatch",
      );

      // A wallet the attacker controls is not a ppv_core PDA at all.
      await expectAnchorError(
        submitProof(mine, { coreProof: attacker.publicKey }),
        "CoreProofMismatch",
      );
    });

    it("refuses to call any program but ppv_core", async () => {
      const agreement = await fundedAgreement();

      // `Program<'info, PpvCore>` is an address check. Without it, the client
      // would choose which executable ends up owning PPV's proof records — the
      // arbitrary-CPI-target hole, with the submitter's signature attached.
      await assert.rejects(
        submitProof(agreement, { coreProgram: escrow.programId }),
        /InvalidProgramId|ConstraintAddress|2012|3008/,
      );
      await assert.rejects(
        submitProof(agreement, { coreProgram: SystemProgram.programId }),
        /InvalidProgramId|ConstraintAddress|2012|3008/,
      );
    });

    it("leaves no proof behind when the ppv_core call fails", async () => {
      const agreement = await fundedAgreement();
      const before = await escrow.account.escrowAgreement.fetch(agreement.agreement);

      // The submitter front-runs their own submission by taking the exact
      // address ppv_core would use. ppv_core's `init` then fails, and with it
      // the whole transaction: no escrow proof, and no incremented counter.
      // Self-inflicted only — the address is keyed by the submitter — but it is
      // the cleanest way to make the callee fail after the caller has already
      // written its own state.
      await core.methods
        .createProof(
          [...coreProofId(agreement.agreement, 0)],
          hash32(12),
          hash32(0),
          { deliverable: {} },
        )
        .accounts({
          authority: seller.publicKey,
          proof: coreProofAddress(
            core.programId,
            seller.publicKey,
            agreement.agreement,
            0,
          ),
          systemProgram: SystemProgram.programId,
        })
        .signers([seller])
        .rpc();

      await assert.rejects(submitProof(agreement));

      const after = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.equal(after.proofCount, before.proofCount, "the counter rolled back");
      assert.equal(
        await connection.getAccountInfo(
          proofAddress(escrow.programId, agreement.agreement, 0),
        ),
        null,
        "no escrow proof survived the failed CPI",
      );
    });
  });

  describe("proof decisions", () => {
    function submitProofFor(
      agreement: Awaited<ReturnType<typeof initialize>>,
      signer: Keypair = seller,
      index = 0,
    ) {
      return escrow.methods
        .submitProof(hash32(12), hash32(0))
        .accounts(submitProofAccounts(agreement.agreement, signer.publicKey, index))
        .signers([signer])
        .rpc();
    }

    function decide(
      agreement: Awaited<ReturnType<typeof initialize>>,
      approve: boolean,
      overrides?: { signer?: Keypair; index?: number; proof?: PublicKey },
    ) {
      const signer = overrides?.signer ?? buyer;
      const proof =
        overrides?.proof ?? proofAddress(escrow.programId, agreement.agreement, overrides?.index ?? 0);
      const method = approve ? escrow.methods.approveProof() : escrow.methods.rejectProof();
      return method
        .accounts({ decider: signer.publicKey, agreement: agreement.agreement, proof })
        .signers([signer])
        .rpc();
    }

    it("records the other party's acceptance without moving money", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement);
      const vaultBefore = await getAccount(connection, agreement.vault);

      const signature = await decide(agreement, true);

      const proof = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.ok("approved" in proof.status);
      assert.equal(proof.decidedBy.toBase58(), buyer.publicKey.toBase58());
      assert.ok(proof.decidedAt.toNumber() > 0);

      const vaultAfter = await getAccount(connection, agreement.vault);
      assert.equal(vaultAfter.amount, vaultBefore.amount, "approval is not payment");
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("funded" in account.state, "approval is not a transition");

      const event = eventNamed(await eventsOf(signature), "proofApproved");
      assert.equal(event.decidedBy.toBase58(), buyer.publicKey.toBase58());
      assert.equal(event.submitter.toBase58(), seller.publicKey.toBase58());
    });

    it("refuses a party deciding its own evidence", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement, seller);

      // Both parties are authorized on this agreement, so authorization alone
      // would let the seller approve its own deliverable.
      await expectAnchorError(decide(agreement, true, { signer: seller }), "CannotDecideOwnProof");
      await expectAnchorError(decide(agreement, false, { signer: seller }), "CannotDecideOwnProof");
      await expectAnchorError(decide(agreement, true, { signer: attacker }), "NotAParty");
    });

    it("makes a decision final", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement);
      await decide(agreement, true);

      // Re-deciding would let a party withdraw an approval a settlement had
      // already relied on.
      await expectAnchorError(decide(agreement, true), "ProofAlreadyDecided");
      await expectAnchorError(decide(agreement, false), "ProofAlreadyDecided");
    });

    it("records a rejection as a fact, not an erasure", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement);
      const signature = await decide(agreement, false);

      const proof = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.ok("rejected" in proof.status);
      const record = await core.account.proofRecord.fetch(proof.coreProof);
      assert.deepEqual([...record.contentHash], hash32(12), "the evidence remains anchored");

      eventNamed(await eventsOf(signature), "proofRejected");

      // The seller can anchor more evidence; a rejection ends nothing.
      await submitProofFor(agreement, seller, 1);
    });

    it("refuses a decision on another agreement's evidence", async () => {
      const mine = await fundedAgreement();
      const theirs = await fundedAgreement();
      await submitProofFor(mine);

      await assert.rejects(
        decide(theirs, true, { proof: proofAddress(escrow.programId, mine.agreement, 0) }),
      );
    });

    it("lets settlement cite the approved evidence it pays out against", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement);
      await decide(agreement, true);
      await markCompleted(agreement);

      const proof = proofAddress(escrow.programId, agreement.agreement, 0);
      const signature = await settle(agreement, { settlementProof: proof });

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("settled" in account.state);
      assert.equal(account.settlementProof.toBase58(), proof.toBase58());

      const event = eventNamed(await eventsOf(signature), "settlementExecuted");
      assert.equal(event.proof?.toBase58(), proof.toBase58());
    });

    it("refuses settlement citing evidence that was not approved", async () => {
      const agreement = await fundedAgreement();
      await submitProofFor(agreement);
      await markCompleted(agreement);

      const proof = proofAddress(escrow.programId, agreement.agreement, 0);
      await expectAnchorError(settle(agreement, { settlementProof: proof }), "ProofNotApproved");

      const rejected = await fundedAgreement();
      await submitProofFor(rejected);
      await decide(rejected, false);
      await markCompleted(rejected);
      await expectAnchorError(
        settle(rejected, { settlementProof: proofAddress(escrow.programId, rejected.agreement, 0) }),
        "ProofNotApproved",
      );

      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT, "a refused settlement moves nothing");
    });

    it("refuses settlement citing another agreement's evidence", async () => {
      const mine = await completedAgreement();
      const theirs = await fundedAgreement();
      await submitProofFor(theirs);
      await decide(theirs, true);

      await expectAnchorError(
        settle(mine, { settlementProof: proofAddress(escrow.programId, theirs.agreement, 0) }),
        "ProofAgreementMismatch",
      );
    });

    it("still settles with no evidence cited at all", async () => {
      // Citing a proof is optional on purpose: a plain escrow settles on the
      // parties' own signatures, and requiring one would fold approval into
      // custody.
      const agreement = await completedAgreement();
      await settle(agreement);
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.equal(account.settlementProof.toBase58(), PublicKey.default.toBase58());
    });
  });

  describe("cancellation, disputes and refunds", () => {
    function cancel(agreement: Awaited<ReturnType<typeof initialize>>, signer: Keypair = buyer) {
      return escrow.methods
        .cancel()
        .accounts({ creator: signer.publicKey, agreement: agreement.agreement })
        .signers([signer])
        .rpc();
    }

    function openDispute(
      agreement: Awaited<ReturnType<typeof initialize>>,
      signer: Keypair = buyer,
      reason: number[] = hash32(21),
    ) {
      return escrow.methods
        .openDispute(reason)
        .accounts({ party: signer.publicKey, agreement: agreement.agreement })
        .signers([signer])
        .rpc();
    }

    function resolveDispute(
      agreement: Awaited<ReturnType<typeof initialize>>,
      signer: Keypair,
      destination: PublicKey,
    ) {
      return escrow.methods
        .resolveDispute()
        .accounts({
          signer: signer.publicKey,
          agreement: agreement.agreement,
          mint: agreement.mint,
          vault: agreement.vault,
          vaultAuthority: agreement.vaultAuthority,
          destination,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([signer])
        .rpc();
    }

    function refund(
      agreement: Awaited<ReturnType<typeof initialize>>,
      overrides?: { signer?: Keypair; destination?: PublicKey },
    ) {
      const signer = overrides?.signer ?? seller;
      return escrow.methods
        .refund()
        .accounts({
          seller: signer.publicKey,
          agreement: agreement.agreement,
          mint: agreement.mint,
          vault: agreement.vault,
          vaultAuthority: agreement.vaultAuthority,
          buyerTokenAccount: overrides?.destination ?? buyerTokens,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([signer])
        .rpc();
    }

    it("cancels an unfunded agreement without touching custody", async () => {
      const agreement = await initialize();
      const signature = await cancel(agreement);

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("cancelled" in account.state);
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, 0n);

      const event = eventNamed(await eventsOf(signature), "agreementAbandoned");
      assert.ok("open" in event.previousState);
      assert.ok("cancelled" in event.newState);
    });

    it("refuses cancellation by the seller, and once money is escrowed", async () => {
      const unfunded = await initialize();
      await expectAnchorError(cancel(unfunded, seller), "NotTheBuyer");

      // After funding, giving the money back is a refund. The two are separate
      // instructions precisely so a cancellation can never strand funds.
      const funded = await fundedAgreement();
      await expectAnchorError(cancel(funded), "BadState");
      const vault = await getAccount(connection, funded.vault);
      assert.equal(vault.amount, AMOUNT);
    });

    it("halts settlement the moment a dispute is opened", async () => {
      const agreement = await completedAgreement();
      const signature = await openDispute(agreement, seller);

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("disputed" in account.state);
      assert.equal(account.disputeOpenedBy.toBase58(), seller.publicKey.toBase58());

      // Invariant 9, and not as a separate check: settle demands Completed.
      await expectAnchorError(settle(agreement), "BadState");
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT);

      const event = eventNamed(await eventsOf(signature), "disputeOpened");
      assert.equal(event.openedBy.toBase58(), seller.publicKey.toBase58());
      assert.ok("completed" in event.previousState);
      assert.ok("disputed" in event.newState);
    });

    it("refuses a dispute from an outsider or over nothing", async () => {
      const open = await initialize();
      await expectAnchorError(openDispute(open), "BadState");

      const funded = await fundedAgreement();
      await expectAnchorError(openDispute(funded, attacker), "NotAParty");
      await expectAnchorError(
        openDispute(funded, buyer, Array<number>(32).fill(0)),
        "InvalidContentHash",
      );
    });

    it("still accepts evidence while disputed", async () => {
      // A dispute is exactly when the parties most need the record.
      const agreement = await fundedAgreement();
      await openDispute(agreement);
      await escrow.methods
        .submitProof(hash32(12), hash32(0))
        .accounts(submitProofAccounts(agreement.agreement, seller.publicKey, 0))
        .signers([seller])
        .rpc();

      const proof = await escrow.account.proof.fetch(
        proofAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.equal(proof.submitter.toBase58(), seller.publicKey.toBase58());
    });

    it("lets the buyer concede, paying the seller", async () => {
      const agreement = await fundedAgreement();
      await openDispute(agreement, seller);
      const before = await getAccount(connection, sellerTokens);

      const signature = await resolveDispute(agreement, buyer, sellerTokens);

      const after = await getAccount(connection, sellerTokens);
      assert.equal(after.amount - before.amount, AMOUNT);
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("settled" in account.state);

      const events = await eventsOf(signature);
      const resolved = eventNamed(events, "disputeResolved");
      assert.equal(resolved.resolvedBy.toBase58(), buyer.publicKey.toBase58());
      assert.equal(resolved.beneficiary.toBase58(), seller.publicKey.toBase58());
      assert.ok("sellerPaid" in resolved.outcome);
      // The custody event is the same one the undisputed path emits, so a
      // consumer counting payments has one event type to count.
      const settled = eventNamed(events, "settlementExecuted");
      assert.ok("disputed" in settled.previousState);
      assert.ok("settled" in settled.newState);
    });

    it("lets the seller concede, refunding the buyer", async () => {
      const agreement = await fundedAgreement();
      await openDispute(agreement, buyer);
      const before = await getAccount(connection, buyerTokens);

      const signature = await resolveDispute(agreement, seller, buyerTokens);

      const after = await getAccount(connection, buyerTokens);
      assert.equal(after.amount - before.amount, AMOUNT);
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("refunded" in account.state);

      const events = await eventsOf(signature);
      assert.ok("buyerRefunded" in eventNamed(events, "disputeResolved").outcome);
      eventNamed(events, "refundExecuted");
    });

    it("refuses anyone taking the money for themselves", async () => {
      const agreement = await fundedAgreement();
      await openDispute(agreement, buyer);

      // The whole safety of concession: a party can give its claim away and
      // cannot take the other's.
      await expectAnchorError(resolveDispute(agreement, buyer, buyerTokens), "CannotConcedeToSelf");
      await expectAnchorError(
        resolveDispute(agreement, seller, sellerTokens),
        "CannotConcedeToSelf",
      );
      await expectAnchorError(
        resolveDispute(agreement, attacker, sellerTokens),
        "NotAParty",
      );
      await expectAnchorError(
        resolveDispute(agreement, buyer, attackerTokens),
        "DestinationNotAParty",
      );

      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT, "no refused resolution moved anything");
    });

    it("refuses resolution of an agreement that is not disputed", async () => {
      const funded = await fundedAgreement();
      await expectAnchorError(resolveDispute(funded, buyer, sellerTokens), "BadState");

      const completed = await completedAgreement();
      await expectAnchorError(resolveDispute(completed, buyer, sellerTokens), "BadState");
    });

    it("refuses a second resolution of a resolved dispute", async () => {
      const agreement = await fundedAgreement();
      await openDispute(agreement, buyer);
      await resolveDispute(agreement, seller, buyerTokens);
      await expectAnchorError(resolveDispute(agreement, seller, buyerTokens), "BadState");
    });

    it("lets the seller hand the money back without an argument", async () => {
      const agreement = await fundedAgreement();
      const before = await getAccount(connection, buyerTokens);

      const signature = await refund(agreement);

      const after = await getAccount(connection, buyerTokens);
      assert.equal(after.amount - before.amount, AMOUNT);
      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("refunded" in account.state);

      const event = eventNamed(await eventsOf(signature), "refundExecuted");
      assert.equal(event.refundedBy.toBase58(), seller.publicKey.toBase58());
      assert.ok("funded" in event.previousState);
      assert.ok("refunded" in event.newState);
    });

    it("refuses a buyer taking its own refund, and a redirected one", async () => {
      const agreement = await fundedAgreement();

      // A buyer who wants its money back over the seller's objection has to
      // dispute; it cannot simply take it.
      await expectAnchorError(refund(agreement, { signer: buyer }), "NotTheSeller");
      await expectAnchorError(refund(agreement, { signer: attacker }), "NotTheSeller");
      await expectAnchorError(
        refund(agreement, { destination: attackerTokens }),
        "DestinationNotOwnedByBuyer",
      );
      await expectAnchorError(
        refund(agreement, { destination: sellerTokens }),
        "DestinationNotOwnedByBuyer",
      );

      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT);
    });

    it("closes every ending for good", async () => {
      const refunded = await fundedAgreement();
      await refund(refunded);
      await expectAnchorError(refund(refunded), "BadState");
      await expectAnchorError(openDispute(refunded), "BadState");
      await expectAnchorError(markCompleted(refunded), "BadState");
      await expectAnchorError(settle(refunded), "BadState");

      const cancelled = await initialize();
      await cancel(cancelled);
      await expectAnchorError(fund(cancelled), "BadState");
      await expectAnchorError(cancel(cancelled), "BadState");
    });
  });

  describe("milestones", () => {
    const FIRST = 60_000_000n;
    const SECOND = 40_000_000n;

    function createMilestone(
      agreement: Awaited<ReturnType<typeof initialize>>,
      index: number,
      amount: bigint,
      signer: Keypair = buyer,
    ) {
      return escrow.methods
        .createMilestone(new BN(amount.toString()), hash32(31 + index))
        .accounts({
          creator: signer.publicKey,
          agreement: agreement.agreement,
          milestone: milestoneAddress(escrow.programId, agreement.agreement, index),
          systemProgram: SystemProgram.programId,
        })
        .signers([signer])
        .rpc();
    }

    function step(
      method: "submitMilestone" | "approveMilestone" | "rejectMilestone",
      agreement: Awaited<ReturnType<typeof initialize>>,
      index: number,
      signer: Keypair,
    ) {
      return escrow.methods[method]()
        .accounts({
          signer: signer.publicKey,
          agreement: agreement.agreement,
          milestone: milestoneAddress(escrow.programId, agreement.agreement, index),
        })
        .signers([signer])
        .rpc();
    }

    function settleMilestone(
      agreement: Awaited<ReturnType<typeof initialize>>,
      index: number,
      overrides?: { signer?: Keypair; destination?: PublicKey },
    ) {
      const signer = overrides?.signer ?? seller;
      return escrow.methods
        .settleMilestone()
        .accounts({
          signer: signer.publicKey,
          agreement: agreement.agreement,
          milestone: milestoneAddress(escrow.programId, agreement.agreement, index),
          mint: agreement.mint,
          vault: agreement.vault,
          vaultAuthority: agreement.vaultAuthority,
          sellerTokenAccount: overrides?.destination ?? sellerTokens,
          settlementProof: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([signer])
        .rpc();
    }

    /** A funded two-tranche contract, the shape most tests start from. */
    async function scheduledContract() {
      const agreement = await initialize({ agreementType: { milestoneContract: {} } });
      await createMilestone(agreement, 0, FIRST);
      await createMilestone(agreement, 1, SECOND);
      await fund(agreement);
      return agreement;
    }

    it("plans the whole schedule before any money arrives", async () => {
      const agreement = await initialize({ agreementType: { milestoneContract: {} } });
      const signature = await createMilestone(agreement, 0, FIRST);

      const milestone = await escrow.account.milestone.fetch(
        milestoneAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.equal(milestone.agreement.toBase58(), agreement.agreement.toBase58());
      assert.equal(milestone.amount.toString(), FIRST.toString());
      assert.ok("pending" in milestone.state);

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.equal(account.milestoneCount, 1);
      assert.equal(account.milestoneTotal.toString(), FIRST.toString());
      assert.ok("open" in account.state, "scheduling is not funding");

      const event = eventNamed(await eventsOf(signature), "milestoneCreated");
      assert.equal(event.milestoneIndex, 0);
      assert.equal(event.amount.toString(), FIRST.toString());
    });

    it("refuses funding a contract whose schedule does not add up", async () => {
      const agreement = await initialize({ agreementType: { milestoneContract: {} } });
      await createMilestone(agreement, 0, FIRST);

      // Escrowing money no milestone can release would leave a refund as the
      // only way to get it back.
      await expectAnchorError(fund(agreement), "MilestonesNotFullyScheduled");

      await createMilestone(agreement, 1, SECOND);
      await fund(agreement);
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT);
    });

    it("refuses a schedule that promises more than the escrow holds", async () => {
      const agreement = await initialize({ agreementType: { milestoneContract: {} } });
      await createMilestone(agreement, 0, FIRST);
      await expectAnchorError(
        createMilestone(agreement, 1, AMOUNT),
        "MilestoneTotalMismatch",
      );
    });

    it("refuses scheduling by the seller, or after funding", async () => {
      const agreement = await initialize({ agreementType: { milestoneContract: {} } });
      await expectAnchorError(createMilestone(agreement, 0, FIRST, seller), "NotTheBuyer");

      const funded = await scheduledContract();
      await expectAnchorError(createMilestone(funded, 2, 1n), "BadState");

      // A plain escrow has no schedule at all.
      const plain = await initialize();
      await expectAnchorError(createMilestone(plain, 0, FIRST), "WrongAgreementType");
    });

    it("releases a tranche without ending the agreement", async () => {
      const agreement = await scheduledContract();
      await step("submitMilestone", agreement, 0, seller);
      await step("approveMilestone", agreement, 0, buyer);

      const before = await getAccount(connection, sellerTokens);
      const signature = await settleMilestone(agreement, 0);
      const after = await getAccount(connection, sellerTokens);

      assert.equal(after.amount - before.amount, FIRST);
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, SECOND, "the unearned tranche stays escrowed");

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("funded" in account.state, "one tranche does not finish the agreement");
      assert.equal(account.settledTotal.toString(), FIRST.toString());
      assert.equal(account.milestonesSettled, 1);

      const events = await eventsOf(signature);
      const settled = eventNamed(events, "milestoneSettled");
      assert.equal(settled.amount.toString(), FIRST.toString());
      // The payment is reported by the same event a single-payment agreement
      // emits, with equal previous and new agreement states.
      const payment = eventNamed(events, "settlementExecuted");
      assert.equal(payment.amount.toString(), FIRST.toString());
      assert.ok("funded" in payment.previousState);
      assert.ok("funded" in payment.newState);
    });

    it("settles the agreement when the last tranche is paid", async () => {
      const agreement = await scheduledContract();
      for (const index of [0, 1]) {
        await step("submitMilestone", agreement, index, seller);
        await step("approveMilestone", agreement, index, buyer);
        await settleMilestone(agreement, index);
      }

      const account = await escrow.account.escrowAgreement.fetch(agreement.agreement);
      assert.ok("settled" in account.state);
      assert.equal(account.settledTotal.toString(), AMOUNT.toString());
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, 0n);
    });

    it("gives each step to the right party and only from the right state", async () => {
      const agreement = await scheduledContract();

      await expectAnchorError(step("submitMilestone", agreement, 0, buyer), "NotTheSeller");
      await expectAnchorError(step("approveMilestone", agreement, 0, buyer), "MilestoneBadState");
      await expectAnchorError(settleMilestone(agreement, 0), "MilestoneBadState");

      await step("submitMilestone", agreement, 0, seller);
      // The seller cannot approve its own submission.
      await expectAnchorError(step("approveMilestone", agreement, 0, seller), "NotTheBuyer");
      await expectAnchorError(step("submitMilestone", agreement, 0, seller), "MilestoneBadState");
      await expectAnchorError(settleMilestone(agreement, 0), "MilestoneBadState");

      await step("approveMilestone", agreement, 0, buyer);
      await expectAnchorError(step("approveMilestone", agreement, 0, buyer), "MilestoneBadState");
      await expectAnchorError(settleMilestone(agreement, 0, { signer: attacker }), "NotAParty");
      await expectAnchorError(
        settleMilestone(agreement, 0, { destination: attackerTokens }),
        "DestinationNotOwnedBySeller",
      );
    });

    it("lets a refused tranche be redone", async () => {
      const agreement = await scheduledContract();
      await step("submitMilestone", agreement, 0, seller);
      const signature = await step("rejectMilestone", agreement, 0, buyer);

      const milestone = await escrow.account.milestone.fetch(
        milestoneAddress(escrow.programId, agreement.agreement, 0),
      );
      assert.ok("pending" in milestone.state, "a refusal sends it back to be redone");
      eventNamed(await eventsOf(signature), "milestoneRejected");

      await step("submitMilestone", agreement, 0, seller);
      await step("approveMilestone", agreement, 0, buyer);
      await settleMilestone(agreement, 0);
    });

    it("refuses paying one tranche twice", async () => {
      const agreement = await scheduledContract();
      await step("submitMilestone", agreement, 0, seller);
      await step("approveMilestone", agreement, 0, buyer);
      await settleMilestone(agreement, 0);

      await expectAnchorError(settleMilestone(agreement, 0), "MilestoneBadState");
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, SECOND);
    });

    it("refuses another agreement's tranche", async () => {
      const mine = await scheduledContract();
      const theirs = await scheduledContract();

      await assert.rejects(
        escrow.methods
          .submitMilestone()
          .accounts({
            signer: seller.publicKey,
            agreement: theirs.agreement,
            milestone: milestoneAddress(escrow.programId, mine.agreement, 0),
          })
          .signers([seller])
          .rpc(),
      );
    });

    it("has no single moment of completion to settle at", async () => {
      const agreement = await scheduledContract();
      // A milestone contract is finished by its tranches, not by one
      // completion and one payment.
      await expectAnchorError(markCompleted(agreement), "WrongAgreementType");
    });

    it("refunds only what no tranche has earned", async () => {
      const agreement = await scheduledContract();
      await step("submitMilestone", agreement, 0, seller);
      await step("approveMilestone", agreement, 0, buyer);
      await settleMilestone(agreement, 0);

      const before = await getAccount(connection, buyerTokens);
      await escrow.methods
        .refund()
        .accounts({
          seller: seller.publicKey,
          agreement: agreement.agreement,
          mint: agreement.mint,
          vault: agreement.vault,
          vaultAuthority: agreement.vaultAuthority,
          buyerTokenAccount: buyerTokens,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([seller])
        .rpc();
      const after = await getAccount(connection, buyerTokens);

      // The tranche the seller earned is not the buyer's to take back.
      assert.equal(after.amount - before.amount, SECOND);
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, 0n);
    });

    it("stops tranche work while disputed", async () => {
      const agreement = await scheduledContract();
      await step("submitMilestone", agreement, 0, seller);
      await escrow.methods
        .openDispute(hash32(21))
        .accounts({ party: buyer.publicKey, agreement: agreement.agreement })
        .signers([buyer])
        .rpc();

      await expectAnchorError(step("approveMilestone", agreement, 0, buyer), "BadState");
      await expectAnchorError(settleMilestone(agreement, 0), "BadState");
      const vault = await getAccount(connection, agreement.vault);
      assert.equal(vault.amount, AMOUNT);
    });
  });

  describe("bounties", () => {
    function selectCounterparty(
      agreement: Awaited<ReturnType<typeof initialize>>,
      winner: PublicKey,
      signer: Keypair = buyer,
    ) {
      return escrow.methods
        .selectCounterparty(winner)
        .accounts({ creator: signer.publicKey, agreement: agreement.agreement })
        .signers([signer])
        .rpc();
    }

    it("escrows before it knows who wins, then names the winner", async () => {
      // The point of the exception: applicants can see the money exists before
      // doing the work.
      const bounty = await initialize({
        agreementType: { bounty: {} },
        counterparty: PublicKey.default,
      });
      await fund(bounty);

      const funded = await escrow.account.escrowAgreement.fetch(bounty.agreement);
      assert.equal(funded.counterparty.toBase58(), PublicKey.default.toBase58());
      const vault = await getAccount(connection, bounty.vault);
      assert.equal(vault.amount, AMOUNT);

      const signature = await selectCounterparty(bounty, seller.publicKey);
      const named = await escrow.account.escrowAgreement.fetch(bounty.agreement);
      assert.equal(named.counterparty.toBase58(), seller.publicKey.toBase58());
      assert.ok("funded" in named.state, "naming a payee is not a step in the lifecycle");

      const event = eventNamed(await eventsOf(signature), "counterpartyAssigned");
      assert.equal(event.counterparty.toBase58(), seller.publicKey.toBase58());

      await markCompleted(bounty);
      const before = await getAccount(connection, sellerTokens);
      await settle(bounty);
      const after = await getAccount(connection, sellerTokens);
      assert.equal(after.amount - before.amount, AMOUNT);
    });

    it("pays nobody until a winner is named", async () => {
      const bounty = await initialize({
        agreementType: { bounty: {} },
        counterparty: PublicKey.default,
      });
      await fund(bounty);

      // Nobody can sign as the default address, and the program says so rather
      // than leaving it to be derived.
      await expectAnchorError(markCompleted(bounty), "CounterpartyNotAssigned");
      // `settle` never reaches that check, and does not need to: with no
      // counterparty there is no token account the destination constraint can
      // accept, so it refuses first. The line above already proves the state
      // machine's own guard exists.
      await expectAnchorError(settle(bounty), "DestinationNotOwnedBySeller");
      await expectAnchorError(
        escrow.methods
          .refund()
          .accounts({
            seller: seller.publicKey,
            agreement: bounty.agreement,
            mint: bounty.mint,
            vault: bounty.vault,
            vaultAuthority: bounty.vaultAuthority,
            buyerTokenAccount: buyerTokens,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([seller])
          .rpc(),
        "CounterpartyNotAssigned",
      );
    });

    it("names a winner once and never again", async () => {
      const bounty = await initialize({
        agreementType: { bounty: {} },
        counterparty: PublicKey.default,
      });
      await selectCounterparty(bounty, seller.publicKey);

      // From selection onward the payee is as frozen as any other agreement's.
      // The sponsor cannot re-choose after seeing what a settlement would do.
      await expectAnchorError(
        selectCounterparty(bounty, attacker.publicKey),
        "CounterpartyAlreadyAssigned",
      );
      const account = await escrow.account.escrowAgreement.fetch(bounty.agreement);
      assert.equal(account.counterparty.toBase58(), seller.publicKey.toBase58());
    });

    it("refuses selection by anyone but the sponsor, and of the sponsor", async () => {
      const bounty = await initialize({
        agreementType: { bounty: {} },
        counterparty: PublicKey.default,
      });
      await expectAnchorError(
        selectCounterparty(bounty, seller.publicKey, seller),
        "NotTheBuyer",
      );
      await expectAnchorError(selectCounterparty(bounty, buyer.publicKey), "InvalidCounterparty");
      await expectAnchorError(
        selectCounterparty(bounty, PublicKey.default),
        "InvalidCounterparty",
      );
    });

    it("is the only agreement type that may start without a payee", async () => {
      await expectAnchorError(
        initialize({ counterparty: PublicKey.default }),
        "InvalidCounterparty",
      );
      await expectAnchorError(
        initialize({
          agreementType: { milestoneContract: {} },
          counterparty: PublicKey.default,
        }),
        "InvalidCounterparty",
      );

      // And an ordinary escrow's payee is fixed at creation, so there is
      // nothing to select.
      const plain = await initialize();
      await expectAnchorError(
        selectCounterparty(plain, attacker.publicKey),
        "WrongAgreementType",
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
        [agreement.signature, "AgreementOpened"],
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

      const history = await connection.getSignaturesForAddress(
        funded.agreement,
        { limit: 20 },
        "confirmed",
      );
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
