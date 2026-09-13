import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

// Imported from source rather than by package name: this suite runs under
// `anchor test` -> mocha -> tsx in CommonJS, and the workspaces are ESM-only
// with no `require` export, so a package-name import cannot resolve here.
import {
  CORE_PROOF_DISCRIMINATOR,
  COMMERCE_AGREEMENT_DISCRIMINATOR,
  canonicalizeV1,
  decodeCommerceAgreementAccount,
  decodeCoreProofAccount,
  decodeBase58,
  decodeEventForProgram,
  encodeBase58,
  hashDocumentV1,
} from "../../sdk/src/index.js";


/**
 * PPV Core ↔ Commerce, as one protocol history.
 *
 * Both programs are deployed and independent: Commerce records what two parties
 * negotiated and agreed, Core records that a wallet committed to a specific
 * sequence of bytes at a chain-confirmed time. Neither calls the other, and
 * neither holds value. What makes them a system is that a client can hold an
 * agreement and a proof at once and establish that they refer to the same
 * terms — and can be sure it is not being fooled into reading one as the other.
 *
 * That last part is the reason most of these assertions exist. An Anchor
 * discriminator is derived from a *name*, so two programs that pick the same
 * name produce the same eight bytes; identity is the pair (program, name), never
 * the discriminator alone. Everything below is checked against a real validator
 * with both programs deployed, because the failures worth catching — an event
 * attributed to the wrong program, an account decoded as the wrong type, a
 * second signature from one wallet counted as two parties — are all failures
 * that look perfectly reasonable in a unit test with one program in scope.
 */

/**
 * The indexer's extraction rules, applied here rather than imported.
 *
 * `@gwap/ppv-indexer` is ESM-only and this suite runs under CommonJS, so it
 * cannot be required — the same constraint `tests/escrow.ts` documents for the
 * escrow extractor. The division of labour is deliberate: the indexer's own
 * tests prove `extractPpvEvents` against fixtures this repository writes, and
 * `scripts/devnet-lifecycle.mjs` runs the real extractor against real devnet
 * transactions. What this suite proves is the thing those cannot — that the
 * chain actually produces the shape they assume, with both programs live.
 *
 * The four rules, each a security property rather than a parsing convenience:
 * a failed transaction is not history; only inner instructions are events; only
 * with the emitting program's own `__event_authority`; and the event is decoded
 * *for* that program, so a shared discriminator cannot cross the boundary.
 */
type Envelope = {
  program: "ppv_core" | "ppv_commerce";
  programId: string;
  event: { name: string };
  transactionSignature: string;
  slot: number;
  instructionIndex: number;
  innerInstructionIndex: number;
};

function extractEvents(
  tx: RpcTransaction,
  programs: Readonly<Record<"ppv_core" | "ppv_commerce", string>>,
): Envelope[] {
  if (tx.meta?.err != null) return [];
  const signature = tx.transaction.signatures[0];
  if (!signature) return [];

  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta?.loadedAddresses?.writable ?? []),
    ...(tx.meta?.loadedAddresses?.readonly ?? []),
  ];
  const byId = new Map(
    Object.entries(programs).map(([program, id]) => [id, program as "ppv_core" | "ppv_commerce"]),
  );

  const envelopes: Envelope[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    group.instructions.forEach((instruction, innerInstructionIndex) => {
      const programId = keys[instruction.programIdIndex];
      if (programId === undefined) return;
      const program = byId.get(programId);
      if (program === undefined) return;
      const authority = eventAuthority(new PublicKey(programId)).toBase58();
      if (keys[instruction.accounts[0] ?? -1] !== authority) return;
      const decoded = decodeEventForProgram(program, decodeBase58(instruction.data));
      if (!decoded || decoded.program === "ppv_escrow") return;
      envelopes.push({
        program: decoded.program,
        programId,
        event: decoded.event,
        transactionSignature: signature,
        slot: tx.slot,
        instructionIndex: group.index,
        innerInstructionIndex,
      });
    });
  }
  return envelopes;
}

/** The minimum of the indexer's transaction shape these assertions need. */
type RpcTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: string[]; instructions: unknown[] };
  };
  meta: {
    err: unknown;
    innerInstructions: Array<{
      index: number;
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    }>;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
};

const PROOF_SEED = new TextEncoder().encode("proof");
const AGREEMENT_SEED = new TextEncoder().encode("agreement");
const EVENT_AUTHORITY_SEED = new TextEncoder().encode("__event_authority");

function id16(): number[] {
  return [...randomBytes(16)];
}

function proofAddress(programId: PublicKey, authority: PublicKey, proofId: number[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PROOF_SEED, authority.toBytes(), Uint8Array.from(proofId)],
    programId,
  )[0];
}

function agreementAddress(programId: PublicKey, partyA: PublicKey, agreementId: number[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, partyA.toBytes(), Uint8Array.from(agreementId)],
    programId,
  )[0];
}

function eventAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], programId)[0];
}

async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  const blockTime = await connection.getBlockTime(slot);
  assert.notEqual(blockTime, null, "local validator did not return block time");
  return blockTime as number;
}

async function fund(connection: Connection, who: PublicKey): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.requestAirdrop(who, 2 * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

/** The raw transaction shape the indexer reads, straight from the RPC. */
async function fetchTransaction(
  connection: Connection,
  signature: string,
): Promise<RpcTransaction> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      // web3.js returns a parsed object; the indexer takes the JSON-RPC shape,
      // so hand it the same fields under the names the RPC uses.
      return {
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        transaction: {
          signatures: tx.transaction.signatures,
          message: {
            accountKeys: tx.transaction.message
              .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
              .keySegments()
              .flat()
              .map((key) => key.toBase58()),
            // Carried through rather than stubbed: the extractor must be given
            // the real top-level instructions to be trusted when it ignores them.
            instructions: tx.transaction.message.compiledInstructions.map((ix) => ({
              programIdIndex: ix.programIdIndex,
              accounts: ix.accountKeyIndexes,
              data: encodeBase58(ix.data),
            })),
          },
        },
        meta: {
          err: tx.meta?.err ?? null,
          innerInstructions: (tx.meta?.innerInstructions ?? []).map((group) => ({
            index: group.index,
            instructions: group.instructions.map((ix) => ({
              programIdIndex: ix.programIdIndex,
              accounts: ix.accounts,
              data: ix.data,
            })),
          })),
          loadedAddresses: { writable: [], readonly: [] },
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`transaction ${signature} was not retrievable`);
}

async function expectError(operation: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await operation;
    assert.fail(`expected ${expectedCode}`);
  } catch (error) {
    if (error instanceof anchor.AnchorError) {
      assert.equal(error.error.errorCode.code, expectedCode);
      return;
    }
    assert.match(String(error), new RegExp(expectedCode, "i"));
  }
}

describe("PPV Core ↔ Commerce integration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const core = anchor.workspace.PpvCore as any;
  const commerce = anchor.workspace.PpvCommerce as any;
  const connection = provider.connection;

  /**
   * One negotiated engagement, carried all the way through: two parties agree
   * on exact terms, both accept them, the agreement executes, and each party
   * independently timestamps the same terms in Core.
   *
   * Set up once and asserted from many angles, because the interesting
   * properties are relationships between the artifacts rather than facts about
   * any one of them.
   */
  const terms = {
    agreement: "ppv-core-commerce-integration",
    deliverable: "one signed statement of work",
    currency: "none — this layer is non-custodial",
    milestones: [{ name: "delivery", due: "2026-10-01" }],
  };
  const content = { title: "Statement of work", body: "Deliver one signed statement of work." };

  let partyA: Keypair;
  let partyB: Keypair;
  let agreementId: number[];
  let agreement: PublicKey;
  let termsHash: number[];
  let contentHash: number[];
  let createSignature: string;
  let signASignature: string;
  let signBSignature: string;
  let proofSignature: string;
  let proofA: PublicKey;

  before(async () => {
    partyA = Keypair.generate();
    partyB = Keypair.generate();
    await fund(connection, partyA.publicKey);
    await fund(connection, partyB.publicKey);

    // The terms hash is the canonical hash of the terms document, not a hash of
    // whatever JSON.stringify happened to produce. That is the whole point of
    // canonicalization: two clients that agree on the terms must agree on the
    // bytes, and therefore on the commitment.
    termsHash = [...(await hashDocumentV1(terms))];
    contentHash = [...(await hashDocumentV1(content))];

    agreementId = id16();
    agreement = agreementAddress(commerce.programId, partyA.publicKey, agreementId);
    const expiresAt = new BN((await chainTime(connection)) + 3600);

    createSignature = await commerce.methods
      .createAgreement(agreementId, partyB.publicKey, contentHash, termsHash, expiresAt)
      .accounts({ partyA: partyA.publicKey, agreement, systemProgram: SystemProgram.programId })
      .signers([partyA])
      .rpc();

    signASignature = await commerce.methods
      .signAgreement(1, contentHash, termsHash)
      .accounts({ signer: partyA.publicKey, agreement })
      .signers([partyA])
      .rpc();

    signBSignature = await commerce.methods
      .signAgreement(1, contentHash, termsHash)
      .accounts({ signer: partyB.publicKey, agreement })
      .signers([partyB])
      .rpc();

    // Party A timestamps the same terms in Core. The proof's context commitment
    // is the agreement address, which is what ties the two records together.
    const proofId = id16();
    proofA = proofAddress(core.programId, partyA.publicKey, proofId);
    proofSignature = await core.methods
      .createProof(proofId, termsHash, [...agreement.toBytes()], { agreement: {} })
      .accounts({
        authority: partyA.publicKey,
        proof: proofA,
        systemProgram: SystemProgram.programId,
      })
      .signers([partyA])
      .rpc();
  });

  it("gives the agreement one deterministic identity", async () => {
    // The address derives from (program, "agreement", party A, agreement id).
    // Nothing a counterparty controls can move it, so a client that knows those
    // four things can find the agreement without being told where it is.
    const rederived = agreementAddress(commerce.programId, partyA.publicKey, agreementId);
    assert.equal(rederived.toBase58(), agreement.toBase58());

    // Under a different program id the same seeds address nothing.
    const underCore = agreementAddress(core.programId, partyA.publicKey, agreementId);
    assert.notEqual(underCore.toBase58(), agreement.toBase58());
    assert.equal(await connection.getAccountInfo(underCore), null);

    const info = await connection.getAccountInfo(agreement);
    assert.notEqual(info, null);
    assert.equal(info!.owner.toBase58(), commerce.programId.toBase58());

    // Creating it twice is refused, because the address is already occupied.
    // Asserted as "this cannot happen" rather than by error string: the runtime
    // and Anchor word an occupied `init` differently across versions, and the
    // property under test is the refusal, not its phrasing.
    const expiresAt = new BN((await chainTime(connection)) + 3600);
    await assert.rejects(
      commerce.methods
        .createAgreement(agreementId, partyB.publicKey, contentHash, termsHash, expiresAt)
        .accounts({ partyA: partyA.publicKey, agreement, systemProgram: SystemProgram.programId })
        .signers([partyA])
        .rpc(),
    );

    // And the existing agreement is untouched by the attempt.
    const after = decodeCommerceAgreementAccount(
      new Uint8Array((await connection.getAccountInfo(agreement))!.data),
    );
    assert.equal(after.state, "Executed");
    assert.equal(after.version, 1);
  });

  it("binds the executed agreement to the exact canonical terms hash", async () => {
    const info = await connection.getAccountInfo(agreement);
    const decoded = decodeCommerceAgreementAccount(new Uint8Array(info!.data));

    const expectedTerms = Buffer.from(Uint8Array.from(termsHash)).toString("hex");
    assert.equal(decoded.termsHash, expectedTerms);
    assert.equal(decoded.state, "Executed");

    // The commitment is to these exact bytes. Re-canonicalizing the same terms
    // document must reproduce them, and any different document must not.
    assert.equal(
      createHash("sha256").update(canonicalizeV1(terms)).digest("hex"),
      decoded.termsHash,
    );
    const otherTerms = { ...terms, deliverable: "something else entirely" };
    assert.notEqual(
      createHash("sha256").update(canonicalizeV1(otherTerms)).digest("hex"),
      decoded.termsHash,
    );

    // And the program will not accept a signature naming different terms as a
    // signature on the agreement. Checked on a *pending* agreement: on the
    // executed one the state guard fires first and reports BadState, which is
    // correct but says nothing about terms binding.
    const wrongTerms = [...(await hashDocumentV1(otherTerms))];
    const pendingId = id16();
    const pending = agreementAddress(commerce.programId, partyA.publicKey, pendingId);
    await commerce.methods
      .createAgreement(
        pendingId,
        partyB.publicKey,
        contentHash,
        termsHash,
        new BN((await chainTime(connection)) + 3600),
      )
      .accounts({ partyA: partyA.publicKey, agreement: pending, systemProgram: SystemProgram.programId })
      .signers([partyA])
      .rpc();

    await expectError(
      commerce.methods
        .signAgreement(1, contentHash, wrongTerms)
        .accounts({ signer: partyA.publicKey, agreement: pending })
        .signers([partyA])
        .rpc(),
      "TermsHashMismatch",
    );

    // An executed agreement refuses any further signature at all, on its own
    // terms or otherwise: terminal is terminal.
    await expectError(
      commerce.methods
        .signAgreement(1, contentHash, termsHash)
        .accounts({ signer: partyA.publicKey, agreement })
        .signers([partyA])
        .rpc(),
      "BadState",
    );
  });

  it("requires two independent parties, not two signatures from one wallet", async () => {
    const info = await connection.getAccountInfo(agreement);
    const decoded = decodeCommerceAgreementAccount(new Uint8Array(info!.data));

    assert.equal(decoded.signatureA?.signer, partyA.publicKey.toBase58());
    assert.equal(decoded.signatureB?.signer, partyB.publicKey.toBase58());
    assert.notEqual(decoded.signatureA!.signer, decoded.signatureB!.signer);

    // Both accepted the same committed version and the same two hashes.
    for (const signature of [decoded.signatureA!, decoded.signatureB!]) {
      assert.equal(signature.versionSigned, decoded.version);
      assert.equal(signature.termsHashSigned, decoded.termsHash);
      assert.equal(signature.contentHashSigned, decoded.contentHash);
    }

    // A fresh agreement that party A tries to accept twice. The program does
    // not merely decline to execute it — it rejects the second acceptance
    // outright, which is the stronger form of the same guarantee: a wallet
    // cannot represent both sides of its own deal, and cannot even try.
    const soloId = id16();
    const solo = agreementAddress(commerce.programId, partyA.publicKey, soloId);
    const expiresAt = new BN((await chainTime(connection)) + 3600);
    await commerce.methods
      .createAgreement(soloId, partyB.publicKey, contentHash, termsHash, expiresAt)
      .accounts({ partyA: partyA.publicKey, agreement: solo, systemProgram: SystemProgram.programId })
      .signers([partyA])
      .rpc();
    await commerce.methods
      .signAgreement(1, contentHash, termsHash)
      .accounts({ signer: partyA.publicKey, agreement: solo })
      .signers([partyA])
      .rpc();
    await expectError(
      commerce.methods
        .signAgreement(1, contentHash, termsHash)
        .accounts({ signer: partyA.publicKey, agreement: solo })
        .signers([partyA])
        .rpc(),
      "AlreadySigned",
    );

    const soloInfo = await connection.getAccountInfo(solo);
    const soloDecoded = decodeCommerceAgreementAccount(new Uint8Array(soloInfo!.data));
    assert.equal(soloDecoded.state, "Pending", "one wallet signing twice must not execute");
    assert.equal(soloDecoded.signatureB, null);
    assert.equal(soloDecoded.executedAt, 0);
  });

  it("lets a Core proof bind to the same terms and agreement", async () => {
    const info = await connection.getAccountInfo(proofA);
    assert.equal(info!.owner.toBase58(), core.programId.toBase58());
    const proof = decodeCoreProofAccount(new Uint8Array(info!.data));

    const agreementInfo = await connection.getAccountInfo(agreement);
    const decodedAgreement = decodeCommerceAgreementAccount(new Uint8Array(agreementInfo!.data));

    // The proof commits to the agreement's exact terms hash …
    assert.equal(proof.contentHash, decodedAgreement.termsHash);
    // … and names the agreement account itself as its context.
    assert.equal(proof.contextHash, Buffer.from(agreement.toBytes()).toString("hex"));
    // … and was made by a party to that agreement, not a bystander.
    assert.equal(proof.authority, decodedAgreement.partyA);
    assert.equal(proof.kind, "Agreement");
    assert.equal(proof.status, "Active");

    // A proof that commits to different terms does not describe this agreement,
    // and the check that establishes that is a hash comparison, not a guess.
    const otherHash = [...(await hashDocumentV1({ ...terms, deliverable: "other" }))];
    const otherProofId = id16();
    const otherProof = proofAddress(core.programId, partyA.publicKey, otherProofId);
    await core.methods
      .createProof(otherProofId, otherHash, [...agreement.toBytes()], { agreement: {} })
      .accounts({
        authority: partyA.publicKey,
        proof: otherProof,
        systemProgram: SystemProgram.programId,
      })
      .signers([partyA])
      .rpc();
    const otherInfo = await connection.getAccountInfo(otherProof);
    const otherDecoded = decodeCoreProofAccount(new Uint8Array(otherInfo!.data));
    assert.notEqual(otherDecoded.contentHash, decodedAgreement.termsHash);
  });

  it("keeps Core and Commerce accounts from decoding as each other", async () => {
    const agreementData = new Uint8Array((await connection.getAccountInfo(agreement))!.data);
    const proofData = new Uint8Array((await connection.getAccountInfo(proofA))!.data);

    // Distinct account discriminators, because the two programs deliberately
    // gave their accounts distinct names.
    assert.notEqual(
      Buffer.from(COMMERCE_AGREEMENT_DISCRIMINATOR).toString("hex"),
      Buffer.from(CORE_PROOF_DISCRIMINATOR).toString("hex"),
    );

    assert.throws(
      () => decodeCoreProofAccount(agreementData),
      /not a ppv_core ProofRecord account/,
      "a Commerce agreement must not decode as a Core proof",
    );
    assert.throws(
      () => decodeCommerceAgreementAccount(proofData),
      /not a ppv_commerce Agreement account/,
      "a Core proof must not decode as a Commerce agreement",
    );

    // Ownership, not just layout: each account is owned by its own program.
    assert.notEqual(
      (await connection.getAccountInfo(agreement))!.owner.toBase58(),
      (await connection.getAccountInfo(proofA))!.owner.toBase58(),
    );
  });

  it("attributes every event to the program that emitted it", async () => {
    const programs = {
      ppv_core: core.programId.toBase58(),
      ppv_commerce: commerce.programId.toBase58(),
    } as const;

    const created = extractEvents(await fetchTransaction(connection, createSignature), programs);
    assert.equal(created.length, 1);
    assert.equal(created[0]!.program, "ppv_commerce");
    assert.equal(created[0]!.event.name, "AgreementCreated");
    assert.equal(created[0]!.programId, programs.ppv_commerce);

    const proofEvents = extractEvents(await fetchTransaction(connection, proofSignature), programs);
    assert.equal(proofEvents.length, 1);
    assert.equal(proofEvents[0]!.program, "ppv_core");
    assert.equal(proofEvents[0]!.event.name, "ProofCreated");
    assert.equal(proofEvents[0]!.programId, programs.ppv_core);

    // Party B's signature executes the agreement: two events, one transaction,
    // both Commerce, in the order the program emitted them.
    const executed = extractEvents(await fetchTransaction(connection, signBSignature), programs);
    assert.deepEqual(
      executed.map((envelope) => envelope.event.name),
      ["AgreementSigned", "AgreementExecuted"],
    );
    for (const envelope of executed) assert.equal(envelope.program, "ppv_commerce");

    // Every event carries the chain coordinates that make it unique.
    for (const envelope of [...created, ...executed, ...proofEvents]) {
      assert.equal(typeof envelope.slot, "number");
      assert.equal(typeof envelope.transactionSignature, "string");
      assert.equal(typeof envelope.instructionIndex, "number");
      assert.equal(typeof envelope.innerInstructionIndex, "number");
    }
  });

  it("refuses to read a Commerce event as a Core event, or the reverse", async () => {
    const programs = {
      ppv_core: core.programId.toBase58(),
      ppv_commerce: commerce.programId.toBase58(),
    } as const;

    // Extract the Commerce transaction with the two program ids swapped, so the
    // reader believes Commerce's id belongs to Core. The event authority still
    // matches — it is derived from the id on the instruction — so the mislabel
    // survives until the decode, and there it is refused loudly rather than
    // reported as a Core event that never happened. The indexer's own unit
    // tests assert the same refusal.
    await assert.rejects(
      async () =>
        extractEvents(await fetchTransaction(connection, createSignature), {
          ppv_core: programs.ppv_commerce,
          ppv_commerce: programs.ppv_core,
        }),
      /AgreementCreated belongs to ppv_commerce, decoded as ppv_core/,
    );

    // And at the decoder: Commerce event bytes decoded as Core throw rather
    // than returning a plausible-looking event of the wrong kind.
    const tx = await fetchTransaction(connection, createSignature);
    const inner = tx.meta!.innerInstructions![0]!.instructions[0]!;
    assert.throws(
      () => decodeEventForProgram("ppv_core", decodeBase58(inner.data)),
      /belongs to ppv_commerce/,
    );
  });

  it("reconstructs the combined history, deterministically and idempotently", async () => {
    const programs = {
      ppv_core: core.programId.toBase58(),
      ppv_commerce: commerce.programId.toBase58(),
    } as const;
    const signatures = [createSignature, signASignature, signBSignature, proofSignature];
    const transactions = await Promise.all(signatures.map((s) => fetchTransaction(connection, s)));

    /** The whole history, from transactions alone — no database, no local state. */
    const reconstruct = (txs: RpcTransaction[]) => {
      const events = txs.flatMap((tx) => extractEvents(tx, programs));
      // Deduplicated on the chain coordinates that identify an event, so a
      // duplicate delivery of the same transaction cannot double-count.
      const seen = new Map<string, (typeof events)[number]>();
      for (const envelope of events) {
        seen.set(
          [
            envelope.transactionSignature,
            envelope.instructionIndex,
            envelope.innerInstructionIndex,
          ].join(":"),
          envelope,
        );
      }
      return [...seen.values()]
        .sort(
          (a, b) =>
            a.slot - b.slot ||
            a.transactionSignature.localeCompare(b.transactionSignature) ||
            a.instructionIndex - b.instructionIndex ||
            a.innerInstructionIndex - b.innerInstructionIndex,
        )
        .map((envelope) => ({
          program: envelope.program,
          event: envelope.event.name,
          signature: envelope.transactionSignature,
          slot: envelope.slot,
        }));
    };

    const history = reconstruct(transactions);
    const names = history.map((entry) => `${entry.program}:${entry.event}`);
    assert.deepEqual(names, [
      "ppv_commerce:AgreementCreated",
      "ppv_commerce:AgreementSigned",
      "ppv_commerce:AgreementSigned",
      "ppv_commerce:AgreementExecuted",
      "ppv_core:ProofCreated",
    ]);

    // Replaying the same history twice produces the same result, byte for byte.
    assert.equal(JSON.stringify(reconstruct(transactions)), JSON.stringify(history));

    // And delivering every transaction twice changes nothing: an indexer that
    // sees a transaction again must not invent a second event from it.
    assert.equal(
      JSON.stringify(reconstruct([...transactions, ...transactions])),
      JSON.stringify(history),
      "duplicate delivery must be idempotent",
    );

    // A shuffled delivery order reconstructs the same history: order comes from
    // the chain coordinates, not from the order an indexer happened to read.
    assert.equal(
      JSON.stringify(reconstruct([...transactions].reverse())),
      JSON.stringify(history),
    );
  });

  it("ignores a failed transaction entirely", async () => {
    const programs = {
      ppv_core: core.programId.toBase58(),
      ppv_commerce: commerce.programId.toBase58(),
    } as const;

    // A failed transaction committed nothing, so it is not history and must
    // produce no events — whatever its instructions claimed.
    const tx = await fetchTransaction(connection, createSignature);
    const failed: RpcTransaction = {
      ...tx,
      meta: { ...tx.meta!, err: { InstructionError: [0, "Custom"] } },
    };
    assert.deepEqual(extractEvents(failed, programs), []);
  });

  it("requires the program's own event authority", async () => {
    const programs = {
      ppv_core: core.programId.toBase58(),
      ppv_commerce: commerce.programId.toBase58(),
    } as const;

    // An event CPI names the program's `__event_authority` PDA as a signer,
    // which only the program can produce. Point that account somewhere else and
    // the instruction stops counting as an event, which is what stops an
    // arbitrary inner instruction from impersonating one.
    assert.equal(
      eventAuthority(commerce.programId).toBase58() !== eventAuthority(core.programId).toBase58(),
      true,
    );

    const tx = await fetchTransaction(connection, createSignature);
    const keys: string[] = [...tx.transaction.message.accountKeys];
    const authorityIndex = keys.indexOf(eventAuthority(commerce.programId).toBase58());
    assert.notEqual(authorityIndex, -1, "the event authority must appear in the account keys");
    keys[authorityIndex] = Keypair.generate().publicKey.toBase58();

    const tampered: RpcTransaction = {
      ...tx,
      transaction: { ...tx.transaction, message: { ...tx.transaction.message, accountKeys: keys } },
    };
    assert.deepEqual(extractEvents(tampered, programs), []);
  });
});
