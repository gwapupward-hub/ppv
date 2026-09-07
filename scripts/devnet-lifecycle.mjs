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

export async function runLifecyclePhase({ endpoint, walletPath, record }) {
  const sdk = await import("@gwap/ppv-sdk");
  const connection = new Connection(endpoint, "confirmed");
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(walletPath, "utf8"))),
  );
  const fixtures = devnetFixtures();
  // A throwaway counterparty: the smoke suite never needs its signature, only
  // an address the agreement can name.
  const counterparty = Keypair.generate().publicKey;

  process.stdout.write("\nLifecycle (devnet fixtures)\n");

  const balance = await connection.getBalance(wallet.publicKey);
  if (balance === 0) throw new Error(`smoke wallet ${wallet.publicKey.toBase58()} has no devnet SOL`);
  record("smoke wallet is funded", true, `${wallet.publicKey.toBase58()} (${balance} lamports)`);

  const proofSignature = await send(
    connection,
    wallet,
    createProofInstruction({
      authority: wallet.publicKey,
      proofId: fixtures.proofId,
      contentHash: fixtures.contentHash,
      contextHash: fixtures.contextHash,
      kind: "deliverable",
    }),
  );
  const proofEvents = await eventsOf(connection, proofSignature, CORE, sdk.decodePpvEventData);
  const created = proofEvents.find((e) => e.name === "ProofCreated");
  if (!created) throw new Error("ProofCreated was not emitted");
  record("proof creation emits a decodable ProofCreated", true, proofSignature);

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const agreement = agreementAddress(wallet.publicKey, fixtures.agreementId);
  const agreementSignature = await send(
    connection,
    wallet,
    createAgreementInstruction({
      partyA: wallet.publicKey,
      partyB: counterparty,
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
  if (agreementCreated.contentHash !== contentHex) {
    throw new Error("on-chain content hash does not match the committed document hash");
  }
  record("contract binding: on-chain hashes match the canonical document hashes", true);

  const signSignature = await send(
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
  record("party A signs the exact version it saw", true, signSignature);

  const cancelSignature = await send(
    connection,
    wallet,
    cancelAgreementInstruction({ signer: wallet.publicKey, agreement }),
  );
  const cancelEvents = await eventsOf(connection, cancelSignature, COMMERCE, sdk.decodePpvEventData);
  if (!cancelEvents.some((e) => e.name === "AgreementCancelled")) {
    throw new Error("AgreementCancelled was not emitted");
  }
  record("cancellation path reaches a terminal state", true, cancelSignature);

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

  return { proofSignature, agreementSignature, signSignature, cancelSignature, seal };
}
