import { createHash } from "node:crypto";
import {
  AGREEMENT_STATES,
  AGREEMENT_TYPES,
  EVENT_IX_TAG,
  decodeBase58,
  encodeBase58,
  type AgreementState,
  type AgreementType,
  type EscrowDisputeOpenedEvent,
  type EscrowDisputeResolvedEvent,
  type EscrowProofApprovedEvent,
  type EscrowProofRejectedEvent,
  type EscrowProofSubmittedEvent,
  type EscrowRefundExecutedEvent,
  type PpvEscrowEvent,
} from "../../src/index.js";

/**
 * Test-side borsh encoder for `ppv_escrow` events. Layouts mirror
 * `programs/ppv_escrow/src/events/` and are pinned on the Rust side too, so a
 * drift shows up in CI on whichever side moved.
 */

export function addressFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(32).fill(byte));
}

export function hexFromByte(byte: number, length: number): string {
  return Buffer.alloc(length, byte).toString("hex");
}

export function signatureFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(64).fill(byte));
}

function pubkey(value: string): Buffer {
  const bytes = decodeBase58(value);
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${value}`);
  return Buffer.from(bytes);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function i64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function state(value: AgreementState): Buffer {
  return Buffer.from([AGREEMENT_STATES.indexOf(value)]);
}

function agreementType(value: AgreementType): Buffer {
  return Buffer.from([AGREEMENT_TYPES.indexOf(value)]);
}

function outcome(value: "SellerPaid" | "BuyerRefunded"): Buffer {
  return Buffer.from([value === "SellerPaid" ? 0 : 1]);
}

function optionalPubkey(value: string | null): Buffer {
  return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), pubkey(value)]);
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

export function encodeEscrowEvent(event: PpvEscrowEvent): Uint8Array {
  let body: Buffer = Buffer.alloc(0);
  switch (event.name) {
    case "AgreementCreated":
      body = Buffer.concat([
        pubkey(event.agreement),
        u64(event.agreementId),
        pubkey(event.creator),
        pubkey(event.counterparty),
        agreementType(event.agreementType),
        pubkey(event.mint),
        pubkey(event.vault),
        u64(event.amount),
        Buffer.from(event.termsHash, "hex"),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "AgreementFunded":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        u64(event.amount),
        pubkey(event.mint),
        pubkey(event.vault),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "WorkCompleted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.actor),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "SettlementExecuted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.buyer),
        pubkey(event.seller),
        u64(event.amount),
        pubkey(event.mint),
        pubkey(event.destination),
        optionalPubkey(event.proof),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "ProofSubmitted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.proof),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.submitter),
        u32(event.proofIndex),
        Buffer.from(event.contentHash, "hex"),
        Buffer.from(event.metadataHash, "hex"),
        state(event.agreementState),
        i64(event.timestamp),
      ]);
      break;
    case "ProofApproved":
    case "ProofRejected":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.proof),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.submitter),
        pubkey(event.decidedBy),
        u32(event.proofIndex),
        Buffer.from(event.contentHash, "hex"),
        state(event.agreementState),
        i64(event.timestamp),
      ]);
      break;
    case "AgreementCancelled":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.cancelledBy),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "DisputeOpened":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.openedBy),
        Buffer.from(event.reasonHash, "hex"),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "DisputeResolved":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.resolvedBy),
        pubkey(event.beneficiary),
        outcome(event.outcome),
        pubkey(event.openedBy),
        state(event.resultingState),
        i64(event.timestamp),
      ]);
      break;
    case "RefundExecuted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.buyer),
        pubkey(event.seller),
        pubkey(event.refundedBy),
        u64(event.amount),
        pubkey(event.mint),
        pubkey(event.destination),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
  }
  return Uint8Array.from(Buffer.concat([Buffer.from(EVENT_IX_TAG), discriminator(event.name), body]));
}

const BUYER = addressFromByte(1);
const SELLER = addressFromByte(2);
const MINT = addressFromByte(3);
const VAULT = addressFromByte(4);
const AGREEMENT = addressFromByte(5);
const SELLER_ATA = addressFromByte(6);

/** One complete, well-formed lifecycle, shared by the event and receipt tests. */
export const LIFECYCLE_FIXTURE: readonly PpvEscrowEvent[] = [
  {
    program: "ppv_escrow",
    name: "AgreementCreated",
    agreement: AGREEMENT,
    agreementId: 42n,
    creator: BUYER,
    counterparty: SELLER,
    agreementType: "Escrow",
    mint: MINT,
    vault: VAULT,
    amount: 100_000_000n,
    termsHash: hexFromByte(7, 32),
    newState: "Open",
    timestamp: 1_700_000_000,
  },
  {
    program: "ppv_escrow",
    name: "AgreementFunded",
    agreement: AGREEMENT,
    creator: BUYER,
    counterparty: SELLER,
    amount: 100_000_000n,
    mint: MINT,
    vault: VAULT,
    previousState: "Open",
    newState: "Funded",
    timestamp: 1_700_000_100,
  },
  {
    program: "ppv_escrow",
    name: "WorkCompleted",
    agreement: AGREEMENT,
    creator: BUYER,
    counterparty: SELLER,
    actor: SELLER,
    previousState: "Funded",
    newState: "Completed",
    timestamp: 1_700_000_200,
  },
  {
    program: "ppv_escrow",
    name: "SettlementExecuted",
    agreement: AGREEMENT,
    buyer: BUYER,
    seller: SELLER,
    amount: 100_000_000n,
    mint: MINT,
    destination: SELLER_ATA,
    proof: null,
    previousState: "Completed",
    newState: "Settled",
    timestamp: 1_700_000_300,
  },
];

const PROOF = addressFromByte(8);

/** One proof anchored while the agreement was Funded, for the annotation tests. */
export const PROOF_FIXTURE: EscrowProofSubmittedEvent = {
  program: "ppv_escrow",
  name: "ProofSubmitted",
  agreement: AGREEMENT,
  proof: PROOF,
  creator: BUYER,
  counterparty: SELLER,
  submitter: SELLER,
  proofIndex: 0,
  contentHash: hexFromByte(12, 32),
  metadataHash: hexFromByte(0, 32),
  agreementState: "Funded",
  timestamp: 1_700_000_150,
};

/** The buyer accepting the seller's deliverable. */
export const PROOF_APPROVED_FIXTURE: EscrowProofApprovedEvent = {
  program: "ppv_escrow",
  name: "ProofApproved",
  agreement: AGREEMENT,
  proof: PROOF,
  creator: BUYER,
  counterparty: SELLER,
  submitter: SELLER,
  decidedBy: BUYER,
  proofIndex: 0,
  contentHash: hexFromByte(12, 32),
  agreementState: "Funded",
  timestamp: 1_700_000_180,
};

export const PROOF_REJECTED_FIXTURE: EscrowProofRejectedEvent = {
  ...PROOF_APPROVED_FIXTURE,
  name: "ProofRejected",
};

const BUYER_ATA = addressFromByte(13);

/** A dispute the seller conceded: the buyer gets its money back. */
export const DISPUTE_OPENED_FIXTURE: EscrowDisputeOpenedEvent = {
  program: "ppv_escrow",
  name: "DisputeOpened",
  agreement: AGREEMENT,
  creator: BUYER,
  counterparty: SELLER,
  openedBy: BUYER,
  reasonHash: hexFromByte(21, 32),
  previousState: "Funded",
  newState: "Disputed",
  timestamp: 1_700_000_400,
};

export const REFUND_FIXTURE: EscrowRefundExecutedEvent = {
  program: "ppv_escrow",
  name: "RefundExecuted",
  agreement: AGREEMENT,
  buyer: BUYER,
  seller: SELLER,
  refundedBy: SELLER,
  amount: 100_000_000n,
  mint: MINT,
  destination: BUYER_ATA,
  previousState: "Disputed",
  newState: "Refunded",
  timestamp: 1_700_000_500,
};

export const DISPUTE_RESOLVED_FIXTURE: EscrowDisputeResolvedEvent = {
  program: "ppv_escrow",
  name: "DisputeResolved",
  agreement: AGREEMENT,
  creator: BUYER,
  counterparty: SELLER,
  resolvedBy: SELLER,
  beneficiary: BUYER,
  outcome: "BuyerRefunded",
  openedBy: BUYER,
  resultingState: "Refunded",
  timestamp: 1_700_000_500,
};

export const DISPUTE_FIXTURE: readonly PpvEscrowEvent[] = [
  DISPUTE_OPENED_FIXTURE,
  REFUND_FIXTURE,
  DISPUTE_RESOLVED_FIXTURE,
];

export const CANCELLED_FIXTURE: PpvEscrowEvent = {
  program: "ppv_escrow",
  name: "AgreementCancelled",
  agreement: AGREEMENT,
  creator: BUYER,
  counterparty: SELLER,
  cancelledBy: BUYER,
  previousState: "Open",
  newState: "Cancelled",
  timestamp: 1_700_000_050,
};

export const FIXTURE_ADDRESSES = { BUYER, SELLER, MINT, VAULT, AGREEMENT, SELLER_ATA, PROOF, BUYER_ATA };
