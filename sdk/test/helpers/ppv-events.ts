import { createHash } from "node:crypto";
import { EVENT_IX_TAG, encodeBase58, type PpvChainEvent } from "../../src/index.js";

/** Test-side borsh encoder for PPV events. Layouts mirror programs/<program>/src/events.rs. */

export const PROOF_KIND_INDEX = {
  creation: 0,
  document: 1,
  agreement: 2,
  invoice: 3,
  deliverable: 4,
  other: 5,
} as const;

export function walletFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(32).fill(byte));
}

export function hexFromByte(byte: number, length: number): string {
  return Buffer.alloc(length, byte).toString("hex");
}

export function signatureFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(64).fill(byte));
}

function u32(value: number) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function i64(value: number) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function pubkey(value: string) {
  // Decode via the same codec the SDK exports; tests only need fixed fills.
  const byte = walletsByFill.get(value);
  if (byte === undefined) throw new Error(`unknown fixture wallet ${value}`);
  return Buffer.alloc(32, byte);
}

const walletsByFill = new Map<string, number>();
for (let byte = 0; byte < 256; byte += 1) walletsByFill.set(walletFromByte(byte), byte);

function discriminator(name: string) {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

export function encodePpvEvent(event: PpvChainEvent): Uint8Array {
  let body: Buffer;
  switch (event.name) {
    case "ProofCreated":
      body = Buffer.concat([
        pubkey(event.proof),
        pubkey(event.authority),
        Buffer.from(event.proofId, "hex"),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.contextHash, "hex"),
        Buffer.from([PROOF_KIND_INDEX[event.kind]]),
        i64(event.createdAt),
      ]);
      break;
    case "ProofRevoked":
      body = Buffer.concat([
        pubkey(event.proof),
        pubkey(event.authority),
        Buffer.from(event.proofId, "hex"),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from([PROOF_KIND_INDEX[event.kind]]),
        i64(event.revokedAt),
      ]);
      break;
    case "AgreementCreated":
      body = Buffer.concat([
        pubkey(event.agreement),
        Buffer.from(event.agreementId, "hex"),
        pubkey(event.partyA),
        pubkey(event.partyB),
        u32(event.version),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.termsHash, "hex"),
        i64(event.expiresAt),
        i64(event.createdAt),
      ]);
      break;
    case "AgreementRevised":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.partyA),
        pubkey(event.partyB),
        pubkey(event.proposer),
        u32(event.previousVersion),
        u32(event.newVersion),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.termsHash, "hex"),
        Buffer.from([event.signaturesCleared ? 1 : 0]),
        i64(event.revisedAt),
      ]);
      break;
    case "AgreementSigned":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.partyA),
        pubkey(event.partyB),
        pubkey(event.signer),
        u32(event.version),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.termsHash, "hex"),
        i64(event.signedAt),
      ]);
      break;
    case "AgreementExecuted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.partyA),
        pubkey(event.partyB),
        u32(event.version),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.termsHash, "hex"),
        i64(event.executedAt),
      ]);
      break;
    case "AgreementCancelled":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.partyA),
        pubkey(event.partyB),
        pubkey(event.cancelledBy),
        u32(event.version),
        i64(event.cancelledAt),
      ]);
      break;
  }
  return Uint8Array.from(Buffer.concat([Buffer.from(EVENT_IX_TAG), discriminator(event.name), body]));
}

export const CORE_PROGRAM = walletFromByte(200);
export const COMMERCE_PROGRAM = walletFromByte(201);
export const PROGRAM_IDS = { ppvCore: CORE_PROGRAM, ppvCommerce: COMMERCE_PROGRAM };

export const WALLET_A = walletFromByte(1);
export const WALLET_B = walletFromByte(2);
export const WALLET_C = walletFromByte(3);
export const PROOF_PDA = walletFromByte(10);
export const AGREEMENT_PDA = walletFromByte(11);
export const SIGNATURE_1 = signatureFromByte(21);
export const SIGNATURE_2 = signatureFromByte(22);

export const FIXTURES = {
  proofCreated: {
    name: "ProofCreated",
    proof: PROOF_PDA,
    authority: WALLET_A,
    proofId: hexFromByte(3, 16),
    contentHash: hexFromByte(4, 32),
    contextHash: hexFromByte(5, 32),
    kind: "deliverable",
    createdAt: 1_700_000_000,
  },
  proofRevoked: {
    name: "ProofRevoked",
    proof: PROOF_PDA,
    authority: WALLET_A,
    proofId: hexFromByte(3, 16),
    contentHash: hexFromByte(4, 32),
    kind: "document",
    revokedAt: 1_700_000_001,
  },
  agreementCreated: {
    name: "AgreementCreated",
    agreement: AGREEMENT_PDA,
    agreementId: hexFromByte(7, 16),
    partyA: WALLET_A,
    partyB: WALLET_B,
    version: 1,
    contentHash: hexFromByte(4, 32),
    termsHash: hexFromByte(5, 32),
    expiresAt: 1_800_000_000,
    createdAt: 1_700_000_000,
  },
  agreementRevised: {
    name: "AgreementRevised",
    agreement: AGREEMENT_PDA,
    partyA: WALLET_A,
    partyB: WALLET_B,
    proposer: WALLET_B,
    previousVersion: 1,
    newVersion: 2,
    contentHash: hexFromByte(6, 32),
    termsHash: hexFromByte(5, 32),
    signaturesCleared: true,
    revisedAt: 1_700_000_010,
  },
  agreementSigned: {
    name: "AgreementSigned",
    agreement: AGREEMENT_PDA,
    partyA: WALLET_A,
    partyB: WALLET_B,
    signer: WALLET_B,
    version: 2,
    contentHash: hexFromByte(6, 32),
    termsHash: hexFromByte(5, 32),
    signedAt: 1_700_000_020,
  },
  agreementExecuted: {
    name: "AgreementExecuted",
    agreement: AGREEMENT_PDA,
    partyA: WALLET_A,
    partyB: WALLET_B,
    version: 2,
    contentHash: hexFromByte(6, 32),
    termsHash: hexFromByte(5, 32),
    executedAt: 1_700_000_020,
  },
  agreementCancelled: {
    name: "AgreementCancelled",
    agreement: AGREEMENT_PDA,
    partyA: WALLET_A,
    partyB: WALLET_B,
    cancelledBy: WALLET_A,
    version: 2,
    cancelledAt: 1_700_000_030,
  },
} as const satisfies Record<string, PpvChainEvent>;
