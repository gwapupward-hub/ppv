/**
 * The lifecycle half of the devnet smoke suite: real transactions, then the
 * SDK reading its own events back off the chain.
 *
 * Instructions are encoded here rather than through the generated IDL client.
 * That is deliberate — it means the suite exercises the same public interface
 * an outside integrator has (discriminator, borsh args, account order, PDA
 * seeds) instead of a client generated from the same build it is testing. If
 * the two disagree, this is the side that is wrong in the way that matters.
 *
 * Every fixture here is devnet-only test material: throwaway ids, throwaway
 * counterparties, hashes of a fixed test string. Nothing is reused from
 * production, and nothing production depends on it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
} from "@solana/web3.js";

import { PERMANENT_PROGRAM_IDS } from "./lib/identity.mjs";
import { decodeBase58 } from "./lib/pubkey.mjs";

const CORE = new PublicKey(PERMANENT_PROGRAM_IDS.ppv_core);
const COMMERCE = new PublicKey(PERMANENT_PROGRAM_IDS.ppv_commerce);

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export function instructionDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's `#[event_cpi]` appends these two accounts, in this order. */
export function eventCpiAccounts(programId) {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );
  return [
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];
}

export function proofAddress(authority, proofId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), authority.toBytes(), Buffer.from(proofId)],
    CORE,
  )[0];
}

export function agreementAddress(partyA, agreementId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), partyA.toBytes(), Buffer.from(agreementId)],
    COMMERCE,
  )[0];
}

const PROOF_KINDS = ["creation", "document", "agreement", "invoice", "deliverable", "other"];

export function createProofInstruction({ authority, proofId, contentHash, contextHash, kind }) {
  const kindIndex = PROOF_KINDS.indexOf(kind);
  if (kindIndex < 0) throw new Error(`unknown proof kind: ${kind}`);
  const proof = proofAddress(authority, proofId);
  return new TransactionInstruction({
    programId: CORE,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: proof, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...eventCpiAccounts(CORE),
    ],
    data: Buffer.concat([
      instructionDiscriminator("create_proof"),
      Buffer.from(proofId),
      Buffer.from(contentHash),
      Buffer.from(contextHash),
      Buffer.from([kindIndex]),
    ]),
  });
}

export function createAgreementInstruction({
  partyA,
  partyB,
  agreementId,
  contentHash,
  termsHash,
  expiresAt,
}) {
  const agreement = agreementAddress(partyA, agreementId);
  const expiry = Buffer.alloc(8);
  expiry.writeBigInt64LE(BigInt(expiresAt));
  return new TransactionInstruction({
    programId: COMMERCE,
    keys: [
      { pubkey: partyA, isSigner: true, isWritable: true },
      { pubkey: agreement, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...eventCpiAccounts(COMMERCE),
    ],
    data: Buffer.concat([
      instructionDiscriminator("create_agreement"),
      Buffer.from(agreementId),
      partyB.toBuffer(),
      Buffer.from(contentHash),
      Buffer.from(termsHash),
      expiry,
    ]),
  });
}

export function signAgreementInstruction({ signer, agreement, version, contentHash, termsHash }) {
  const versionBytes = Buffer.alloc(4);
  versionBytes.writeUInt32LE(version);
  return new TransactionInstruction({
    programId: COMMERCE,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: agreement, isSigner: false, isWritable: true },
      ...eventCpiAccounts(COMMERCE),
    ],
    data: Buffer.concat([
      instructionDiscriminator("sign_agreement"),
      versionBytes,
      Buffer.from(contentHash),
      Buffer.from(termsHash),
    ]),
  });
}

export function cancelAgreementInstruction({ signer, agreement }) {
  return new TransactionInstruction({
    programId: COMMERCE,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: agreement, isSigner: false, isWritable: true },
      ...eventCpiAccounts(COMMERCE),
    ],
    data: instructionDiscriminator("cancel_agreement"),
  });
}

/** Devnet fixture material. Labelled so nothing here is mistaken for real data. */
export function devnetFixtures() {
  const marker = "ppv-devnet-smoke-fixture";
  const hash = (suffix) => [...createHash("sha256").update(`${marker}:${suffix}`).digest()];
  return {
    marker,
    proofId: [...createHash("sha256").update(`${marker}:proof-id`).digest().subarray(0, 16)],
    agreementId: [...createHash("sha256").update(`${marker}:agreement-id`).digest().subarray(0, 16)],
    contentHash: hash("content"),
    contextHash: hash("context"),
    termsHash: hash("terms"),
  };
}

async function send(connection, wallet, instruction, extraSigners = []) {
  const transaction = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(wallet, ...extraSigners);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return signature;
}

/**
 * Reads the escrow-free PPV events back out of a confirmed transaction with the
 * SDK's own decoder. Same three rules the indexer applies: committed
 * transactions only, inner instructions only, event authority required.
 */
async function eventsOf(connection, signature, programId, decodePpvEventData) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`transaction ${signature} not found`);
  if (tx.meta?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(tx.meta.err)}`);

  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );

  const events = [];
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(programId)) continue;
      if (!keys.get(ix.accounts[0])?.equals(eventAuthority)) continue;
      // Inner-instruction data comes back base58-encoded from the JSON RPC.
      const decoded = decodePpvEventData(decodeBase58(ix.data));
      if (decoded) events.push(decoded);
    }
  }
  return events;
}

/**
 * A confirmed transaction in the shape the indexer reads.
 *
 * web3.js hands back a parsed object; the indexer takes the JSON-RPC shape, and
 * the account-key order matters — getting it wrong silently reads the wrong
 * program id off an instruction. `getAccountKeys` produces that order, lookup
 * tables included, so the conversion happens once here rather than at each call.
 */
async function rawTransaction(connection, signature, encodeBase58Sdk) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`transaction ${signature} was not retrievable`);
  const keys = tx.transaction.message
    .getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
    .keySegments()
    .flat()
    .map((key) => key.toBase58());

  return {
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    transaction: {
      signatures: tx.transaction.signatures,
      message: {
        accountKeys: keys,
        // Carried through rather than stubbed: the extractor must be given the
        // real top-level instructions to be trusted when it ignores them.
        instructions: tx.transaction.message.compiledInstructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accounts: ix.accountKeyIndexes,
          data: encodeBase58Sdk(ix.data),
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
      // Already flattened into accountKeys above, so none remain to append.
      loadedAddresses: { writable: [], readonly: [] },
    },
  };
}

export async function runLifecyclePhase({ endpoint, walletPath, record }) {
  const sdk = await import("@gwap/ppv-sdk");
  const { extractPpvEvents } = await import("@gwap/ppv-indexer");
  const connection = new Connection(endpoint, "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))),
  );
  const fixtures = devnetFixtures();

  /**
   * A disposable counterparty, generated per run.
   *
   * It needs no devnet SOL: it signs as the accepting party while the smoke
   * wallet pays the fee. What the protocol requires of party B is a distinct
   * signing authority, and who paid for the transaction is a separate question.
   */
  const partyB = Keypair.generate();

  process.stdout.write("\nLifecycle (devnet fixtures)\n");

  const balance = await connection.getBalance(wallet.publicKey);
  if (balance === 0) throw new Error(`smoke wallet ${wallet.publicKey.toBase58()} has no devnet SOL`);
  record("smoke wallet is funded", true, `${wallet.publicKey.toBase58()} (${balance} lamports)`);
  record("disposable counterparty generated", true, partyB.publicKey.toBase58());

  // ---------------------------------------------------------------- Commerce
  // One agreement carried all the way to executed, by two distinct parties
  // accepting the same committed terms. This is the flow the Core↔Commerce
  // milestone is about; everything after it reads back what it produced.
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const agreement = agreementAddress(wallet.publicKey, fixtures.agreementId);
  const agreementSignature = await send(
    connection,
    wallet,
    createAgreementInstruction({
      partyA: wallet.publicKey,
      partyB: partyB.publicKey,
      agreementId: fixtures.agreementId,
      contentHash: fixtures.contentHash,
      termsHash: fixtures.termsHash,
      expiresAt,
    }),
  );
  const agreementEvents = await eventsOf(
    connection,
    agreementSignature,
    COMMERCE,
    sdk.decodePpvEventData,
  );
  const agreementCreated = agreementEvents.find((e) => e.name === "AgreementCreated");
  if (!agreementCreated) throw new Error("AgreementCreated was not emitted");
  record("agreement creation emits a decodable AgreementCreated", true, agreementSignature);

  // Contract/proof binding: the hashes on chain are the canonical hashes of the
  // documents, not values a client asserted.
  const contentHex = Buffer.from(fixtures.contentHash).toString("hex");
  const termsHex = Buffer.from(fixtures.termsHash).toString("hex");
  if (agreementCreated.contentHash !== contentHex) {
    throw new Error("on-chain content hash does not match the committed document hash");
  }
  if (agreementCreated.termsHash !== termsHex) {
    throw new Error("on-chain terms hash does not match the committed terms hash");
  }
  record("contract binding: on-chain hashes match the canonical document hashes", true);

  const signASignature = await send(
    connection,
    wallet,
    signAgreementInstruction({
      signer: wallet.publicKey,
      agreement,
      version: 1,
      contentHash: fixtures.contentHash,
      termsHash: fixtures.termsHash,
    }),
  );
  record("party A accepts the exact version it saw", true, signASignature);

  const signBSignature = await send(
    connection,
    wallet,
    signAgreementInstruction({
      signer: partyB.publicKey,
      agreement,
      version: 1,
      contentHash: fixtures.contentHash,
      termsHash: fixtures.termsHash,
    }),
    [partyB],
  );
  const executedEvents = await eventsOf(connection, signBSignature, COMMERCE, sdk.decodePpvEventData);
  if (!executedEvents.some((e) => e.name === "AgreementExecuted")) {
    throw new Error("AgreementExecuted was not emitted after the second party accepted");
  }
  record("party B accepts and the agreement executes", true, signBSignature);

  // Read the account back and check the property that makes an executed
  // agreement mean anything: two *distinct* signers on the *same* terms.
  const agreementInfo = await connection.getAccountInfo(agreement, "confirmed");
  if (!agreementInfo) throw new Error(`agreement ${agreement.toBase58()} disappeared`);
  const decoded = sdk.decodeCommerceAgreementAccount(new Uint8Array(agreementInfo.data));
  if (decoded.state !== "Executed") throw new Error(`agreement state is ${decoded.state}`);
  if (!decoded.signatureA || !decoded.signatureB) {
    throw new Error("an executed agreement is missing a signature");
  }
  if (decoded.signatureA.signer === decoded.signatureB.signer) {
    throw new Error("SECURITY: one wallet was counted as both parties");
  }
  if (
    decoded.signatureA.termsHashSigned !== decoded.termsHash ||
    decoded.signatureB.termsHashSigned !== decoded.termsHash
  ) {
    throw new Error("SECURITY: an acceptance names terms other than the committed terms");
  }
  record(
    "executed agreement has two distinct parties on the same committed terms",
    true,
    `${decoded.signatureA.signer} + ${decoded.signatureB.signer}`,
  );

  // -------------------------------------------------------------------- Core
  // Party A timestamps the agreement's exact terms in ppv_core, naming the
  // agreement account as the proof's context. This is the whole linkage: two
  // independent programs, one identity for the thing being agreed.
  const bindingProofId = [...createHash("sha256").update(`${agreement.toBase58()}:terms`).digest().subarray(0, 16)];
  const bindingProof = proofAddress(wallet.publicKey, bindingProofId);
  const proofSignature = await send(
    connection,
    wallet,
    createProofInstruction({
      authority: wallet.publicKey,
      proofId: bindingProofId,
      contentHash: fixtures.termsHash,
      contextHash: [...agreement.toBytes()],
      kind: "agreement",
    }),
  );
  const proofEvents = await eventsOf(connection, proofSignature, CORE, sdk.decodePpvEventData);
  const created = proofEvents.find((e) => e.name === "ProofCreated");
  if (!created) throw new Error("ProofCreated was not emitted");
  record("Core proof created over the agreement terms", true, proofSignature);

  const proofInfo = await connection.getAccountInfo(bindingProof, "confirmed");
  const proof = sdk.decodeCoreProofAccount(new Uint8Array(proofInfo.data));
  if (proof.contentHash !== decoded.termsHash) {
    throw new Error("the Core proof does not commit to the agreement's terms hash");
  }
  if (proof.contextHash !== Buffer.from(agreement.toBytes()).toString("hex")) {
    throw new Error("the Core proof does not name the agreement as its context");
  }
  if (proof.authority !== decoded.partyA) {
    throw new Error("the Core proof was not made by a party to the agreement");
  }
  record(
    "Core proof binds to the agreement, its terms and a real party",
    true,
    `${bindingProof.toBase58()} -> ${agreement.toBase58()}`,
  );

  // Neither account decodes as the other. Distinct programs, distinct accounts.
  let separated = false;
  try {
    sdk.decodeCoreProofAccount(new Uint8Array(agreementInfo.data));
  } catch {
    separated = true;
  }
  if (!separated) throw new Error("SECURITY: a Commerce agreement decoded as a Core proof");
  separated = false;
  try {
    sdk.decodeCommerceAgreementAccount(new Uint8Array(proofInfo.data));
  } catch {
    separated = true;
  }
  if (!separated) throw new Error("SECURITY: a Core proof decoded as a Commerce agreement");
  record("Core and Commerce accounts do not decode as each other", true);

  // ------------------------------------------------------- cancellation path
  // A separate agreement, because executed is terminal: the cancellation path
  // cannot be demonstrated on an agreement that already executed.
  const cancelId = [...createHash("sha256").update(`${agreement.toBase58()}:cancel`).digest().subarray(0, 16)];
  const cancelAgreement = agreementAddress(wallet.publicKey, cancelId);
  await send(
    connection,
    wallet,
    createAgreementInstruction({
      partyA: wallet.publicKey,
      partyB: partyB.publicKey,
      agreementId: cancelId,
      contentHash: fixtures.contentHash,
      termsHash: fixtures.termsHash,
      expiresAt,
    }),
  );
  const cancelSignature = await send(
    connection,
    wallet,
    cancelAgreementInstruction({ signer: wallet.publicKey, agreement: cancelAgreement }),
  );
  const cancelEvents = await eventsOf(
    connection,
    cancelSignature,
    COMMERCE,
    sdk.decodePpvEventData,
  );
  if (!cancelEvents.some((e) => e.name === "AgreementCancelled")) {
    throw new Error("AgreementCancelled was not emitted");
  }
  record("cancellation path reaches a terminal state", true, cancelSignature);

  // ------------------------------------------------ combined reconstruction
  // The history, rebuilt from transactions alone through the indexer's
  // extraction path: correct program attribution, and the same result under
  // duplicate and reordered delivery.
  const programs = {
    ppv_core: PERMANENT_PROGRAM_IDS.ppv_core,
    ppv_commerce: PERMANENT_PROGRAM_IDS.ppv_commerce,
  };
  const signatures = [agreementSignature, signASignature, signBSignature, proofSignature];
  const transactions = [];
  for (const signature of signatures) {
    transactions.push(await rawTransaction(connection, signature, sdk.encodeBase58));
  }
  const reconstruct = (txs) => {
    const seen = new Map();
    for (const envelope of txs.flatMap((tx) => extractPpvEvents(tx, { programs }))) {
      seen.set(
        `${envelope.transactionSignature}:${envelope.instructionIndex}:${envelope.innerInstructionIndex}`,
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
      .map((e) => `${e.program}:${e.event.name}`);
  };

  const history = reconstruct(transactions);
  const expected = [
    "ppv_commerce:AgreementCreated",
    "ppv_commerce:AgreementSigned",
    "ppv_commerce:AgreementSigned",
    "ppv_commerce:AgreementExecuted",
    "ppv_core:ProofCreated",
  ];
  if (JSON.stringify([...history].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`reconstructed history was ${JSON.stringify(history)}`);
  }
  record("combined Core + Commerce history reconstructs from the chain", true, history.join(", "));

  if (JSON.stringify(reconstruct([...transactions, ...transactions])) !== JSON.stringify(history)) {
    throw new Error("duplicate delivery changed the reconstructed history");
  }
  if (JSON.stringify(reconstruct([...transactions].reverse())) !== JSON.stringify(history)) {
    throw new Error("delivery order changed the reconstructed history");
  }
  record("replay is idempotent and order-independent", true);

  // ------------------------------------------------------------- reputation
  // Normalized reputation event, then receipt and seal derivation — all from
  // the events just read back off the chain, with no database in the path.
  const normalized = await sdk.normalizeChainEvent(
    {
      event: created,
      programId: PERMANENT_PROGRAM_IDS.ppv_core,
      transactionSignature: proofSignature,
      instructionIndex: 0,
      innerInstructionIndex: 0,
      blockTime: created.createdAt,
    },
    {
      resolveGns: async () => null,
      expectedProgramIds: {
        ppvCore: PERMANENT_PROGRAM_IDS.ppv_core,
        ppvCommerce: PERMANENT_PROGRAM_IDS.ppv_commerce,
      },
    },
  );
  if (normalized.eventType !== "proof.created") {
    throw new Error(`unexpected normalized event type ${normalized.eventType}`);
  }
  record("normalized reputation event derives from the chain event", true, normalized.eventId);

  const facts = sdk.deriveSealFacts([normalized], { chainVerified: true });
  const seal = sdk.resolveSealState(facts);
  record("credential seal derives from chain facts", true, seal);

  return {
    agreement: agreement.toBase58(),
    partyA: decoded.partyA,
    partyB: decoded.partyB,
    termsHash: decoded.termsHash,
    contentHash: decoded.contentHash,
    state: decoded.state,
    coreProof: bindingProof.toBase58(),
    signatures: {
      agreementCreated: agreementSignature,
      partyASigned: signASignature,
      partyBSignedAndExecuted: signBSignature,
      coreProofCreated: proofSignature,
      agreementCancelled: cancelSignature,
    },
    history,
    seal,
  };
}
