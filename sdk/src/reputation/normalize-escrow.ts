import {
  REPUTATION_EVENT_SCHEMA_VERSION,
  isTransactionSignature,
  type ReputationEventType,
  type ReputationEventV1,
  type ReputationOutcome,
} from "./contracts.js";
import { chainEventId } from "./hashing.js";
import { NormalizationError, type GnsSnapshotResolver } from "./normalize.js";
import type { EscrowEventEnvelope } from "../escrow/receipts.js";
import type { PpvEscrowEvent } from "../escrow/events.js";

/**
 * Turns a `ppv_escrow` event into one normalized reputation event.
 *
 * PPV emits facts and GwapScore decides what they mean. Nothing here computes a
 * score, and nothing here is a judgement: `outcome` says which side a dispute
 * went to, never who was right. If a field would require an opinion to fill in,
 * it stays null.
 *
 * The normalizer is stateless, which is why the program events carry both
 * parties. Webhook delivery is at-least-once and unordered, and a consumer that
 * must fetch state to understand an event breaks under replay.
 */

export type EscrowNormalizeOptions = {
  resolveGns: GnsSnapshotResolver;
  expectedProgramId: string;
};

type Mapped = {
  eventType: ReputationEventType;
  actorWallet: string;
  counterpartyWallet: string | null;
  outcome: ReputationOutcome;
  amount: string | null;
  mint: string | null;
  milestoneIndex: number | null;
  ppvProofId: string | null;
  proofHash: string | null;
};

/**
 * Returns null for protocol events that say nothing about anyone's conduct.
 * A bounty naming its payee is a fact about the agreement, not about a
 * participant, and inventing a reputation event for it would put weight on
 * something that carries none.
 */
function mapEscrowEvent(event: PpvEscrowEvent): Mapped | null {
  switch (event.name) {
    case "AgreementOpened":
      return {
        eventType: "agreement.created",
        actorWallet: event.creator,
        counterpartyWallet: namedOrNull(event.counterparty),
        outcome: "recorded",
        amount: event.amount.toString(),
        mint: event.mint,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: event.termsHash,
      };
    case "AgreementFunded":
      return {
        eventType: "escrow.funded",
        actorWallet: event.creator,
        counterpartyWallet: namedOrNull(event.counterparty),
        outcome: "recorded",
        amount: event.amount.toString(),
        mint: event.mint,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: null,
      };
    case "WorkCompleted":
      return {
        eventType: "work.completed",
        actorWallet: event.actor,
        counterpartyWallet: event.creator,
        outcome: "completed",
        amount: null,
        mint: null,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: null,
      };
    case "SettlementExecuted":
      return {
        eventType: "settlement.completed",
        actorWallet: event.buyer,
        counterpartyWallet: event.seller,
        outcome: "completed",
        amount: event.amount.toString(),
        mint: event.mint,
        milestoneIndex: null,
        ppvProofId: event.proof,
        proofHash: null,
      };
    case "RefundExecuted":
      return {
        eventType: "agreement.refunded",
        actorWallet: event.refundedBy,
        counterpartyWallet: event.refundedBy === event.seller ? event.buyer : event.seller,
        // The money went to the party the actor is not. That is the fact; who
        // deserved it is not PPV's to say.
        outcome: "resolved_for_counterparty",
        amount: event.amount.toString(),
        mint: event.mint,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: null,
      };
    case "AgreementAbandoned":
      return {
        eventType: "agreement.cancelled",
        actorWallet: event.cancelledBy,
        counterpartyWallet: namedOrNull(event.counterparty),
        outcome: "cancelled",
        amount: null,
        mint: null,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: null,
      };
    case "DisputeOpened":
      return {
        eventType: "dispute.opened",
        actorWallet: event.openedBy,
        counterpartyWallet: other(event.openedBy, event.creator, event.counterparty),
        outcome: "opened",
        amount: null,
        mint: null,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: event.reasonHash,
      };
    case "DisputeResolved":
      return {
        eventType: "dispute.resolved",
        actorWallet: event.resolvedBy,
        counterpartyWallet: event.beneficiary,
        // Resolution is by concession, so the money always goes to the party
        // the resolver is not. There is no split outcome to report yet.
        outcome: "resolved_for_counterparty",
        amount: null,
        mint: null,
        milestoneIndex: null,
        ppvProofId: null,
        proofHash: null,
      };
    case "ProofSubmitted":
      return {
        eventType: "proof.created",
        actorWallet: event.submitter,
        counterpartyWallet: other(event.submitter, event.creator, event.counterparty),
        outcome: "recorded",
        amount: null,
        mint: null,
        milestoneIndex: null,
        // The ppv_core record, not ppv_escrow's decision account. A receipt's
        // `ppvProofId` is resolved against ppv_core semantics — it is checked
        // for revocation, and only ppv_core proofs can be revoked — so the
        // escrow-side address was never the right thing to put here.
        ppvProofId: event.coreProof,
        proofHash: event.contentHash,
      };
    case "ProofApproved":
    case "ProofRejected":
      return {
        eventType: event.name === "ProofApproved" ? "proof.approved" : "proof.rejected",
        actorWallet: event.decidedBy,
        counterpartyWallet: event.submitter,
        outcome: event.name === "ProofApproved" ? "completed" : "rejected",
        amount: null,
        mint: null,
        milestoneIndex: null,
        ppvProofId: event.coreProof,
        // A decision event carries no hash; it is an attribute of the proof,
        // available on the ppv_core record at `ppvProofId` and on the
        // `proof.created` receipt for the same id.
        proofHash: null,
      };
    case "MilestoneCreated":
      return {
        eventType: "milestone.created",
        actorWallet: event.creator,
        counterpartyWallet: event.counterparty,
        outcome: "recorded",
        amount: event.amount.toString(),
        mint: null,
        milestoneIndex: event.milestoneIndex,
        ppvProofId: null,
        proofHash: event.termsHash,
      };
    case "MilestoneSubmitted":
      return {
        eventType: "milestone.delivered",
        actorWallet: event.counterparty,
        counterpartyWallet: event.creator,
        outcome: "recorded",
        amount: null,
        mint: null,
        milestoneIndex: event.milestoneIndex,
        ppvProofId: null,
        proofHash: null,
      };
    case "MilestoneApproved":
    case "MilestoneRejected":
      return {
        eventType: event.name === "MilestoneApproved" ? "milestone.approved" : "milestone.rejected",
        actorWallet: event.creator,
        counterpartyWallet: event.counterparty,
        outcome: event.name === "MilestoneApproved" ? "completed" : "rejected",
        amount: null,
        mint: null,
        milestoneIndex: event.milestoneIndex,
        ppvProofId: null,
        proofHash: null,
      };
    case "MilestoneSettled":
      return {
        eventType: "milestone.settled",
        actorWallet: event.creator,
        counterpartyWallet: event.counterparty,
        outcome: "completed",
        amount: event.amount.toString(),
        mint: null,
        milestoneIndex: event.milestoneIndex,
        ppvProofId: event.proof,
        proofHash: null,
      };
    case "CounterpartyAssigned":
      return null;
  }
}

/** The default address means "not named yet", not a participant. */
function namedOrNull(wallet: string): string | null {
  return wallet === "11111111111111111111111111111111" ? null : wallet;
}

function other(actor: string, a: string, b: string): string {
  return actor === a ? b : a;
}

export async function normalizeEscrowEvent(
  envelope: EscrowEventEnvelope,
  options: EscrowNormalizeOptions,
): Promise<ReputationEventV1 | null> {
  if (envelope.programId !== options.expectedProgramId) {
    throw new NormalizationError(
      `${envelope.event.name} arrived from ${envelope.programId}, expected ${options.expectedProgramId}`,
    );
  }
  if (!isTransactionSignature(envelope.transactionSignature)) {
    throw new NormalizationError("invalid transaction signature");
  }
  if (!Number.isInteger(envelope.instructionIndex) || envelope.instructionIndex < 0) {
    throw new NormalizationError("invalid instruction index");
  }

  const mapped = mapEscrowEvent(envelope.event);
  if (!mapped) return null;

  const [actorGnsRecord, counterpartyGnsRecord] = await Promise.all([
    options.resolveGns(mapped.actorWallet),
    mapped.counterpartyWallet
      ? options.resolveGns(mapped.counterpartyWallet)
      : Promise.resolve(null),
  ]);

  const key = {
    transactionSignature: envelope.transactionSignature,
    instructionIndex: envelope.instructionIndex,
    innerInstructionIndex: envelope.innerInstructionIndex,
  };
  const occurredAtUnix = envelope.blockTime ?? envelope.event.timestamp;
  if (!Number.isFinite(occurredAtUnix) || occurredAtUnix < 0) {
    throw new NormalizationError("invalid timestamp");
  }

  return {
    schemaVersion: REPUTATION_EVENT_SCHEMA_VERSION,
    eventId: chainEventId(key, mapped.eventType),
    eventType: mapped.eventType,
    occurredAt: new Date(occurredAtUnix * 1_000).toISOString(),
    eventSource: "chain",
    actorWallet: mapped.actorWallet,
    actorGnsRecord: snapshotFor(actorGnsRecord, mapped.actorWallet),
    counterpartyWallet: mapped.counterpartyWallet,
    counterpartyGnsRecord: mapped.counterpartyWallet
      ? snapshotFor(counterpartyGnsRecord, mapped.counterpartyWallet)
      : null,
    ppvProofId: mapped.ppvProofId,
    proofHash: mapped.proofHash,
    agreementId: envelope.event.agreement,
    escrowId: envelope.event.agreement,
    milestoneIndex: mapped.milestoneIndex,
    sourceProduct: null,
    sourceObjectId: null,
    deliverableId: null,
    amount: mapped.amount,
    mint: mapped.mint,
    outcome: mapped.outcome,
    programId: envelope.programId,
    transactionSignature: envelope.transactionSignature,
    instructionIndex: envelope.instructionIndex,
    innerInstructionIndex: envelope.innerInstructionIndex,
  };
}

function snapshotFor<T extends { owner: string }>(snapshot: T | null, wallet: string): T | null {
  if (!snapshot) return null;
  if (snapshot.owner !== wallet) {
    throw new NormalizationError(
      `GNS snapshot owner ${snapshot.owner} does not match wallet ${wallet}`,
    );
  }
  return snapshot;
}
