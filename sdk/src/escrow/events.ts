import { anchorDiscriminator } from "../reputation/hashing.js";
import { EVENT_IX_TAG } from "../reputation/chain-events.js";
import { BorshReader, bytesEqual } from "./reader.js";
import type {
  AgreementState,
  AgreementType,
  DisputeOutcome,
  MilestoneState,
} from "./states.js";

/**
 * Decoder for the events `ppv_escrow` emits through Anchor's event CPI.
 * Layouts mirror `programs/ppv_escrow/src/events/` field by field, and the Rust
 * crate pins the same discriminators and byte offsets in its unit tests.
 *
 * An event CPI is an inner instruction to the emitting program whose data is:
 *   [8 bytes event-instruction tag][8 bytes event discriminator][borsh fields]
 *
 * Event identity is the pair (program id, discriminator), never the
 * discriminator alone. `ppv_commerce` also emits an `AgreementCreated` — a
 * different fact with a different layout — and the two share a discriminator
 * because Anchor derives it from the name. That is why this decoder is a
 * separate entry point rather than more cases in the shared one: an indexer
 * must select the decoder by the program id the inner instruction targeted.
 */

export const PPV_ESCROW_EVENT_NAMES = [
  "AgreementCreated",
  "AgreementFunded",
  "WorkCompleted",
  "SettlementExecuted",
  "ProofSubmitted",
  "ProofApproved",
  "ProofRejected",
  "AgreementCancelled",
  "DisputeOpened",
  "DisputeResolved",
  "RefundExecuted",
  "MilestoneCreated",
  "MilestoneSubmitted",
  "MilestoneApproved",
  "MilestoneRejected",
  "MilestoneSettled",
  "CounterpartyAssigned",
] as const;
export type PpvEscrowEventName = (typeof PPV_ESCROW_EVENT_NAMES)[number];

type Base = { program: "ppv_escrow"; agreement: string; timestamp: number };

export type EscrowAgreementCreatedEvent = Base & {
  name: "AgreementCreated";
  agreementId: bigint;
  creator: string;
  counterparty: string;
  agreementType: AgreementType;
  mint: string;
  vault: string;
  amount: bigint;
  termsHash: string;
  newState: AgreementState;
};

export type EscrowAgreementFundedEvent = Base & {
  name: "AgreementFunded";
  creator: string;
  counterparty: string;
  amount: bigint;
  mint: string;
  vault: string;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowWorkCompletedEvent = Base & {
  name: "WorkCompleted";
  creator: string;
  counterparty: string;
  actor: string;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowSettlementExecutedEvent = Base & {
  name: "SettlementExecuted";
  buyer: string;
  seller: string;
  amount: bigint;
  mint: string;
  destination: string;
  /** Always null in the kernel; the proof vault arrives in Phase 3. */
  proof: string | null;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowProofSubmittedEvent = Base & {
  name: "ProofSubmitted";
  proof: string;
  creator: string;
  counterparty: string;
  submitter: string;
  proofIndex: number;
  contentHash: string;
  metadataHash: string;
  /** The state the agreement was in. Anchoring evidence does not change it. */
  agreementState: AgreementState;
};

/** Approval and rejection carry identical fields; only the name differs. */
type ProofDecision = Base & {
  proof: string;
  creator: string;
  counterparty: string;
  submitter: string;
  decidedBy: string;
  proofIndex: number;
  contentHash: string;
  agreementState: AgreementState;
};

export type EscrowProofApprovedEvent = ProofDecision & { name: "ProofApproved" };
export type EscrowProofRejectedEvent = ProofDecision & { name: "ProofRejected" };

export type EscrowAgreementCancelledEvent = Base & {
  name: "AgreementCancelled";
  creator: string;
  counterparty: string;
  cancelledBy: string;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowDisputeOpenedEvent = Base & {
  name: "DisputeOpened";
  creator: string;
  counterparty: string;
  openedBy: string;
  /** A commitment to the complaint, not the complaint. */
  reasonHash: string;
  previousState: AgreementState;
  newState: AgreementState;
};

/**
 * Reports how a dispute ended, and deliberately not a state transition: the
 * `SettlementExecuted` or `RefundExecuted` emitted beside it carries that. Two
 * events claiming to leave `Disputed` would look like a fork.
 */
export type EscrowDisputeResolvedEvent = Base & {
  name: "DisputeResolved";
  creator: string;
  counterparty: string;
  resolvedBy: string;
  beneficiary: string;
  outcome: DisputeOutcome;
  openedBy: string;
  resultingState: AgreementState;
};

export type EscrowRefundExecutedEvent = Base & {
  name: "RefundExecuted";
  buyer: string;
  seller: string;
  refundedBy: string;
  amount: bigint;
  mint: string;
  destination: string;
  previousState: AgreementState;
  newState: AgreementState;
};

type MilestoneBase = Base & {
  milestone: string;
  creator: string;
  counterparty: string;
  milestoneIndex: number;
  /** The agreement's state; a milestone step does not change it. */
  agreementState: AgreementState;
};

export type EscrowMilestoneCreatedEvent = MilestoneBase & {
  name: "MilestoneCreated";
  amount: bigint;
  termsHash: string;
};

/** Submission, approval and rejection share one shape. */
type MilestoneTransition = MilestoneBase & {
  previousState: MilestoneState;
  newState: MilestoneState;
};

export type EscrowMilestoneSubmittedEvent = MilestoneTransition & { name: "MilestoneSubmitted" };
export type EscrowMilestoneApprovedEvent = MilestoneTransition & { name: "MilestoneApproved" };
export type EscrowMilestoneRejectedEvent = MilestoneTransition & { name: "MilestoneRejected" };

export type EscrowMilestoneSettledEvent = MilestoneTransition & {
  name: "MilestoneSettled";
  amount: bigint;
  destination: string;
  proof: string | null;
};

/** A bounty's payee, named after the fact. Cannot repeat for one agreement. */
export type EscrowCounterpartyAssignedEvent = Base & {
  name: "CounterpartyAssigned";
  creator: string;
  counterparty: string;
  agreementState: AgreementState;
};

export type PpvEscrowEvent =
  | EscrowAgreementCreatedEvent
  | EscrowAgreementFundedEvent
  | EscrowWorkCompletedEvent
  | EscrowSettlementExecutedEvent
  | EscrowProofSubmittedEvent
  | EscrowProofApprovedEvent
  | EscrowProofRejectedEvent
  | EscrowAgreementCancelledEvent
  | EscrowDisputeOpenedEvent
  | EscrowDisputeResolvedEvent
  | EscrowRefundExecutedEvent
  | EscrowMilestoneCreatedEvent
  | EscrowMilestoneSubmittedEvent
  | EscrowMilestoneApprovedEvent
  | EscrowMilestoneRejectedEvent
  | EscrowMilestoneSettledEvent
  | EscrowCounterpartyAssignedEvent;

export function escrowEventDiscriminatorHex(name: PpvEscrowEventName): string {
  return Buffer.from(anchorDiscriminator("event", name)).toString("hex");
}

const DISCRIMINATORS: ReadonlyArray<{ name: PpvEscrowEventName; bytes: Uint8Array }> =
  PPV_ESCROW_EVENT_NAMES.map((name) => ({ name, bytes: anchorDiscriminator("event", name) }));

/**
 * Decodes the data of one inner instruction that targeted the `ppv_escrow`
 * program. Returns null when the data is not a PPV escrow event, and throws
 * when it claims to be one but is malformed, so an indexer can tell "not ours"
 * from "corrupt".
 */
function readMilestoneTransition(reader: BorshReader) {
  return {
    program: "ppv_escrow" as const,
    agreement: reader.pubkey(),
    milestone: reader.pubkey(),
    creator: reader.pubkey(),
    counterparty: reader.pubkey(),
    milestoneIndex: reader.u32(),
    previousState: reader.milestoneState(),
    newState: reader.milestoneState(),
    agreementState: reader.state(),
    timestamp: reader.i64(),
  };
}

export function decodeEscrowEventData(data: Uint8Array): PpvEscrowEvent | null {
  if (data.length < 16 || !bytesEqual(data.subarray(0, 8), EVENT_IX_TAG)) return null;
  const discriminator = data.subarray(8, 16);
  const match = DISCRIMINATORS.find((entry) => bytesEqual(entry.bytes, discriminator));
  if (!match) return null;

  const reader = new BorshReader(data.subarray(16));
  let event: PpvEscrowEvent;
  switch (match.name) {
    case "AgreementCreated":
      event = {
        program: "ppv_escrow",
        name: "AgreementCreated",
        agreement: reader.pubkey(),
        agreementId: reader.u64(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        agreementType: reader.agreementType(),
        mint: reader.pubkey(),
        vault: reader.pubkey(),
        amount: reader.u64(),
        termsHash: reader.hex(32),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "AgreementFunded":
      event = {
        program: "ppv_escrow",
        name: "AgreementFunded",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        amount: reader.u64(),
        mint: reader.pubkey(),
        vault: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "WorkCompleted":
      event = {
        program: "ppv_escrow",
        name: "WorkCompleted",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        actor: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "SettlementExecuted":
      event = {
        program: "ppv_escrow",
        name: "SettlementExecuted",
        agreement: reader.pubkey(),
        buyer: reader.pubkey(),
        seller: reader.pubkey(),
        amount: reader.u64(),
        mint: reader.pubkey(),
        destination: reader.pubkey(),
        proof: reader.optionalPubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "ProofSubmitted":
      event = {
        program: "ppv_escrow",
        name: "ProofSubmitted",
        agreement: reader.pubkey(),
        proof: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        submitter: reader.pubkey(),
        proofIndex: reader.u32(),
        contentHash: reader.hex(32),
        metadataHash: reader.hex(32),
        agreementState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "ProofApproved":
    case "ProofRejected":
      event = {
        program: "ppv_escrow",
        name: match.name,
        agreement: reader.pubkey(),
        proof: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        submitter: reader.pubkey(),
        decidedBy: reader.pubkey(),
        proofIndex: reader.u32(),
        contentHash: reader.hex(32),
        agreementState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "AgreementCancelled":
      event = {
        program: "ppv_escrow",
        name: "AgreementCancelled",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        cancelledBy: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "DisputeOpened":
      event = {
        program: "ppv_escrow",
        name: "DisputeOpened",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        openedBy: reader.pubkey(),
        reasonHash: reader.hex(32),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "DisputeResolved":
      event = {
        program: "ppv_escrow",
        name: "DisputeResolved",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        resolvedBy: reader.pubkey(),
        beneficiary: reader.pubkey(),
        outcome: reader.disputeOutcome(),
        openedBy: reader.pubkey(),
        resultingState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "RefundExecuted":
      event = {
        program: "ppv_escrow",
        name: "RefundExecuted",
        agreement: reader.pubkey(),
        buyer: reader.pubkey(),
        seller: reader.pubkey(),
        refundedBy: reader.pubkey(),
        amount: reader.u64(),
        mint: reader.pubkey(),
        destination: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "MilestoneCreated":
      event = {
        program: "ppv_escrow",
        name: "MilestoneCreated",
        agreement: reader.pubkey(),
        milestone: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        milestoneIndex: reader.u32(),
        amount: reader.u64(),
        termsHash: reader.hex(32),
        agreementState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    // One shape, three names. Read once and name it per case: a variable name
    // would leave the union unnarrowed, and a cast would defeat the point of
    // the union in the first place.
    case "MilestoneSubmitted":
      event = { ...readMilestoneTransition(reader), name: "MilestoneSubmitted" };
      break;
    case "MilestoneApproved":
      event = { ...readMilestoneTransition(reader), name: "MilestoneApproved" };
      break;
    case "MilestoneRejected":
      event = { ...readMilestoneTransition(reader), name: "MilestoneRejected" };
      break;
    case "MilestoneSettled":
      event = {
        program: "ppv_escrow",
        name: "MilestoneSettled",
        agreement: reader.pubkey(),
        milestone: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        milestoneIndex: reader.u32(),
        amount: reader.u64(),
        destination: reader.pubkey(),
        proof: reader.optionalPubkey(),
        previousState: reader.milestoneState(),
        newState: reader.milestoneState(),
        agreementState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "CounterpartyAssigned":
      event = {
        program: "ppv_escrow",
        name: "CounterpartyAssigned",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        agreementState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
  }
  if (reader.remaining !== 0) throw new RangeError("event data has trailing bytes");
  return event;
}
