import { createHash } from "node:crypto";

import type { PpvEscrowEvent } from "./events.js";
import type { AgreementState } from "./states.js";

/**
 * PPV receipts, reconstructed rather than stored.
 *
 * The design decision §19 of the protocol spec demands be made explicitly: the
 * escrow kernel writes **no receipt account**. A receipt PDA would duplicate
 * data the event already committed, in the same transaction that produced it,
 * at a rent cost per transition — and it would add no verifiability, because
 * anyone auditing the receipt would still be checking it against that event.
 * So a receipt here is a deterministic projection of an immutable chain event
 * plus the chain coordinates that carried it.
 *
 * The consequence is a rule: a receipt can only ever be built from a confirmed
 * transaction's committed event. Nothing in this module can manufacture one
 * from a failed attempt, an intention, or a database row.
 *
 * A dedicated on-chain receipt account is reconsidered only when something has
 * to be *proved to another program* on chain, which nothing in Phase 1 does.
 */

const RECEIPT_DOMAIN = "ppv-escrow-receipt:v1";
const ID_HEX_LENGTH = 40;

export const ESCROW_RECEIPT_SCHEMA_VERSION = 1;

export const ESCROW_RECEIPT_ACTIONS = {
  AgreementCreated: "AGREEMENT_CREATED",
  AgreementFunded: "AGREEMENT_FUNDED",
  WorkCompleted: "WORK_COMPLETED",
  SettlementExecuted: "SETTLEMENT_EXECUTED",
  ProofSubmitted: "PROOF_SUBMITTED",
  ProofApproved: "PROOF_APPROVED",
  ProofRejected: "PROOF_REJECTED",
  AgreementCancelled: "AGREEMENT_CANCELLED",
  DisputeOpened: "DISPUTE_OPENED",
  DisputeResolved: "DISPUTE_RESOLVED",
  RefundExecuted: "REFUND_EXECUTED",
  MilestoneCreated: "MILESTONE_CREATED",
  MilestoneSubmitted: "MILESTONE_SUBMITTED",
  MilestoneApproved: "MILESTONE_APPROVED",
  MilestoneRejected: "MILESTONE_REJECTED",
  MilestoneSettled: "MILESTONE_SETTLED",
} as const;

/**
 * Not every protocol fact moves the agreement. A transition is a step in the
 * lifecycle; an annotation is something that happened *during* a step —
 * evidence anchored, a decision recorded, one milestone of many paid out.
 *
 * Which one a receipt is follows from the fact itself: it is a transition when
 * the agreement's state changed, and an annotation when it did not. Deciding by
 * event name instead would be a second source of truth that could disagree with
 * the states the event actually reports — and it could not express a
 * `SettlementExecuted` that paid a milestone without ending the agreement.
 */
export type EscrowReceiptKind = "transition" | "annotation";

function kindOf(previousState: AgreementState | null, newState: AgreementState): EscrowReceiptKind {
  return previousState === null || previousState !== newState ? "transition" : "annotation";
}

export type EscrowReceiptAction =
  (typeof ESCROW_RECEIPT_ACTIONS)[keyof typeof ESCROW_RECEIPT_ACTIONS];

/** The chain coordinates that make one emitted event unique. */
export type EscrowEventEnvelope = {
  event: PpvEscrowEvent;
  /** Program id the event CPI targeted. An event is only identified by the pair. */
  programId: string;
  transactionSignature: string;
  /** Slot the transaction committed in. Orders events across transactions. */
  slot: number;
  instructionIndex: number;
  innerInstructionIndex: number | null;
  /** Unix seconds from the block; falls back to the event's own timestamp. */
  blockTime: number | null;
};

export type PpvEscrowReceiptV1 = {
  schemaVersion: number;
  receiptId: string;
  programId: string;
  action: EscrowReceiptAction;
  kind: EscrowReceiptKind;
  agreement: string;
  agreementId: bigint;
  buyer: string;
  seller: string;
  /** The wallet whose signature caused this transition, where the event names one. */
  actor: string;
  mint: string | null;
  /** Tokens that moved in this transition. Null when none did. */
  amount: bigint | null;
  destination: string | null;
  proof: string | null;
  proofIndex: number | null;
  /** The tranche this receipt concerns, for milestone contracts. */
  milestone: string | null;
  milestoneIndex: number | null;
  previousState: AgreementState | null;
  newState: AgreementState;
  occurredAt: string;
  transactionSignature: string;
  slot: number;
  instructionIndex: number;
  innerInstructionIndex: number | null;
};

export class ReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptError";
  }
}

function isoFromUnix(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new ReceiptError("invalid timestamp");
  return new Date(seconds * 1_000).toISOString();
}

/**
 * Deterministic from chain coordinates alone. Replaying the same transaction
 * any number of times yields the same id, which is what makes an indexer's
 * receipt table idempotent without a uniqueness oracle.
 */
export function escrowReceiptId(
  programId: string,
  transactionSignature: string,
  instructionIndex: number,
  innerInstructionIndex: number | null,
  action: EscrowReceiptAction,
): string {
  const digest = createHash("sha256")
    .update(
      `${RECEIPT_DOMAIN}|${programId}|${transactionSignature}|${instructionIndex}|${innerInstructionIndex ?? "-"}|${action}`,
    )
    .digest("hex");
  return `ppvr_${digest.slice(0, ID_HEX_LENGTH)}`;
}

export function escrowReceiptFromEvent(envelope: EscrowEventEnvelope): PpvEscrowReceiptV1 {
  const receipt = buildReceipt(envelope);
  return { ...receipt, kind: kindOf(receipt.previousState, receipt.newState) };
}

function buildReceipt(envelope: EscrowEventEnvelope): Omit<PpvEscrowReceiptV1, "kind"> {
  const { event } = envelope;
  if (!envelope.transactionSignature) throw new ReceiptError("receipt requires a transaction signature");
  if (!Number.isInteger(envelope.instructionIndex) || envelope.instructionIndex < 0) {
    throw new ReceiptError("invalid instruction index");
  }

  if (!Number.isInteger(envelope.slot) || envelope.slot < 0) {
    throw new ReceiptError("invalid slot");
  }

  const action = ESCROW_RECEIPT_ACTIONS[event.name];
  const common = {
    schemaVersion: ESCROW_RECEIPT_SCHEMA_VERSION,
    receiptId: escrowReceiptId(
      envelope.programId,
      envelope.transactionSignature,
      envelope.instructionIndex,
      envelope.innerInstructionIndex,
      action,
    ),
    programId: envelope.programId,
    action,
    agreement: event.agreement,
    occurredAt: isoFromUnix(envelope.blockTime ?? event.timestamp),
    transactionSignature: envelope.transactionSignature,
    slot: envelope.slot,
    instructionIndex: envelope.instructionIndex,
    innerInstructionIndex: envelope.innerInstructionIndex,
  };

  switch (event.name) {
    case "AgreementCreated":
      return {
        ...common,
        agreementId: event.agreementId,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.creator,
        mint: event.mint,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: null,
        newState: event.newState,
      };
    case "AgreementFunded":
      return {
        ...common,
        // The funding event does not restate the numeric id; the agreement
        // address is the identity that matters and the created receipt carries
        // the number for anyone who wants it.
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.creator,
        mint: event.mint,
        amount: event.amount,
        destination: event.vault,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "WorkCompleted":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.actor,
        mint: null,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "SettlementExecuted":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.buyer,
        seller: event.seller,
        actor: event.seller,
        mint: event.mint,
        amount: event.amount,
        destination: event.destination,
        proof: event.proof,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "MilestoneCreated":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.creator,
        mint: null,
        amount: event.amount,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: event.milestone,
        milestoneIndex: event.milestoneIndex,
        previousState: event.agreementState,
        newState: event.agreementState,
      };
    case "MilestoneSubmitted":
    case "MilestoneApproved":
    case "MilestoneRejected":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.name === "MilestoneSubmitted" ? event.counterparty : event.creator,
        mint: null,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: event.milestone,
        milestoneIndex: event.milestoneIndex,
        previousState: event.agreementState,
        newState: event.agreementState,
      };
    case "MilestoneSettled":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.counterparty,
        mint: null,
        // The payment is reported by the SettlementExecuted emitted beside
        // this one. Counting it here too would double the settled total.
        amount: null,
        destination: event.destination,
        proof: event.proof,
        proofIndex: null,
        milestone: event.milestone,
        milestoneIndex: event.milestoneIndex,
        previousState: event.agreementState,
        newState: event.agreementState,
      };
    case "AgreementCancelled":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.cancelledBy,
        mint: null,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "DisputeOpened":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.openedBy,
        mint: null,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "DisputeResolved":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.resolvedBy,
        mint: null,
        amount: null,
        destination: null,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.resultingState,
        newState: event.resultingState,
      };
    case "RefundExecuted":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.buyer,
        seller: event.seller,
        actor: event.refundedBy,
        mint: event.mint,
        amount: event.amount,
        destination: event.destination,
        proof: null,
        proofIndex: null,
        milestone: null,
        milestoneIndex: null,
        previousState: event.previousState,
        newState: event.newState,
      };
    case "ProofApproved":
    case "ProofRejected":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.decidedBy,
        mint: null,
        amount: null,
        destination: null,
        proof: event.proof,
        proofIndex: event.proofIndex,
        milestone: null,
        milestoneIndex: null,
        previousState: event.agreementState,
        newState: event.agreementState,
      };
    case "ProofSubmitted":
      return {
        ...common,
        agreementId: 0n,
        buyer: event.creator,
        seller: event.counterparty,
        actor: event.submitter,
        mint: null,
        amount: null,
        destination: null,
        proof: event.proof,
        proofIndex: event.proofIndex,
        milestone: null,
        milestoneIndex: null,
        // An annotation starts and ends in the same state, because it did not
        // move the agreement at all.
        previousState: event.agreementState,
        newState: event.agreementState,
      };
  }
}

export type AgreementLifecycle = {
  agreement: string;
  agreementId: bigint;
  buyer: string;
  seller: string;
  mint: string;
  state: AgreementState;
  fundedAmount: bigint | null;
  settledAmount: bigint | null;
  refundedAmount: bigint | null;
  settlementDestination: string | null;
  /** How the money left the vault, when it did. */
  outcome: "settled" | "refunded" | "cancelled" | "open" | null;
  /** Slot of the most recent transition, for cursor bookkeeping. */
  lastSlot: number;
  /** Evidence anchored to this agreement, in the order it was submitted. */
  proofs: readonly ProofRecord[];
  /** The tranche schedule, for a milestone contract. Empty otherwise. */
  milestones: readonly MilestoneRecord[];
  /** Transitions in chain order, with annotations placed where they landed. */
  receipts: readonly PpvEscrowReceiptV1[];
};

export type MilestoneRecord = {
  milestone: string;
  milestoneIndex: number;
  amount: bigint;
  state: "Pending" | "Submitted" | "Approved" | "Settled";
  /** Where the tranche was paid, once it was. */
  destination: string | null;
  slot: number;
};

export type ProofRecord = {
  proof: string;
  proofIndex: number;
  submitter: string;
  /** The state the agreement was in when this evidence was anchored. */
  agreementState: AgreementState;
  /** Decided by the other party, or "Submitted" while nobody has. */
  status: "Submitted" | "Approved" | "Rejected";
  decidedBy: string | null;
  receiptId: string;
  occurredAt: string;
  slot: number;
};

/**
 * Rebuilds one agreement's history from its receipts. This is the Phase 2 bar:
 * given only chain data, an independent indexer reaches the same lifecycle a
 * PPV database would report — and refuses a history that does not chain.
 *
 * Receipts arrive out of order and more than once; both are normal for webhook
 * and RPC delivery, and neither may change the result.
 *
 * Order comes from the state machine, not from a table of action ranks. Each
 * receipt names the state it started from, so the transitions link into exactly
 * one path from creation, and that path is the history. Chain coordinates are
 * then a *check* on it rather than its source: a transition cannot have
 * committed in an earlier slot than the transition it depends on. Ranking
 * actions instead would work only for a lifecycle that never branches, and
 * disputes, refunds, and milestones all branch.
 */
/**
 * Folds the proof annotations into one record per proof. Decisions arrive as
 * their own events, so the status a proof ends on is the last decision made
 * about it — and a decision for a proof this history never saw submitted is an
 * inconsistency, not a proof.
 */
function proofRecords(annotations: readonly PpvEscrowReceiptV1[]): ProofRecord[] {
  const byProof = new Map<string, ProofRecord>();
  for (const receipt of annotations) {
    if (receipt.action === "PROOF_SUBMITTED") {
      byProof.set(receipt.proof as string, {
        proof: receipt.proof as string,
        proofIndex: receipt.proofIndex as number,
        submitter: receipt.actor,
        agreementState: receipt.newState,
        status: "Submitted",
        decidedBy: null,
        receiptId: receipt.receiptId,
        occurredAt: receipt.occurredAt,
        slot: receipt.slot,
      });
    }
  }
  for (const receipt of annotations) {
    if (receipt.action !== "PROOF_APPROVED" && receipt.action !== "PROOF_REJECTED") continue;
    const record = byProof.get(receipt.proof as string);
    if (!record) {
      throw new ReceiptError(`a decision names proof ${receipt.proof}, which was never submitted`);
    }
    if (record.decidedBy !== null) {
      throw new ReceiptError(`proof ${record.proof} was decided more than once`);
    }
    record.status = receipt.action === "PROOF_APPROVED" ? "Approved" : "Rejected";
    record.decidedBy = receipt.actor;
  }
  return [...byProof.values()];
}

/**
 * Folds the milestone annotations into one record per tranche. The state a
 * tranche ends on is the state its last step reported, which is why every
 * milestone event carries both sides of its own transition.
 */
function milestoneRecords(annotations: readonly PpvEscrowReceiptV1[]): MilestoneRecord[] {
  const byMilestone = new Map<string, MilestoneRecord>();
  for (const receipt of annotations) {
    if (receipt.action === "MILESTONE_CREATED") {
      byMilestone.set(receipt.milestone as string, {
        milestone: receipt.milestone as string,
        milestoneIndex: receipt.milestoneIndex as number,
        amount: receipt.amount as bigint,
        state: "Pending",
        destination: null,
        slot: receipt.slot,
      });
    }
  }
  for (const receipt of annotations) {
    const record = byMilestone.get(receipt.milestone ?? "");
    if (!record) {
      if (receipt.milestone && receipt.action !== "MILESTONE_CREATED") {
        throw new ReceiptError(
          `a milestone step names ${receipt.milestone}, which was never created`,
        );
      }
      continue;
    }
    switch (receipt.action) {
      case "MILESTONE_SUBMITTED":
        record.state = "Submitted";
        break;
      case "MILESTONE_APPROVED":
        record.state = "Approved";
        break;
      case "MILESTONE_REJECTED":
        record.state = "Pending";
        break;
      case "MILESTONE_SETTLED":
        record.state = "Settled";
        record.destination = receipt.destination;
        break;
      default:
        break;
    }
  }
  return [...byMilestone.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex);
}

export function reconstructAgreementLifecycle(
  receipts: readonly PpvEscrowReceiptV1[],
): AgreementLifecycle {
  if (receipts.length === 0) throw new ReceiptError("no receipts");

  const byId = new Map<string, PpvEscrowReceiptV1>();
  for (const receipt of receipts) {
    const existing = byId.get(receipt.receiptId);
    if (existing && existing.action !== receipt.action) {
      throw new ReceiptError(`receipt ${receipt.receiptId} replayed with a different action`);
    }
    byId.set(receipt.receiptId, receipt);
  }

  // Only transitions form the chain. Annotations record something that
  // happened during a state, and are placed back into the history afterwards.
  const annotations = [...byId.values()].filter((receipt) => receipt.kind === "annotation");
  for (const annotation of annotations) byId.delete(annotation.receiptId);

  const agreement = [...byId.values()][0]?.agreement as string;
  for (const receipt of byId.values()) {
    if (receipt.agreement !== agreement) {
      throw new ReceiptError("receipts describe more than one agreement");
    }
  }

  // Exactly one receipt opens a history: the one that started from no state.
  const roots = [...byId.values()].filter((receipt) => receipt.previousState === null);
  if (roots.length === 0) throw new ReceiptError("lifecycle is missing its creation receipt");
  if (roots.length > 1) throw new ReceiptError("lifecycle has more than one creation receipt");
  const created = roots[0] as PpvEscrowReceiptV1;

  // Every other receipt is a transition out of exactly one state. Two receipts
  // leaving the same state would mean the chain forked, which the program's
  // state machine makes impossible — so it means the input is wrong.
  const transitions = new Map<AgreementState, PpvEscrowReceiptV1>();
  for (const receipt of byId.values()) {
    if (receipt.previousState === null) continue;
    const existing = transitions.get(receipt.previousState);
    if (existing && existing.receiptId !== receipt.receiptId) {
      throw new ReceiptError(`two transitions leave ${receipt.previousState}`);
    }
    transitions.set(receipt.previousState, receipt);
  }

  const ordered: PpvEscrowReceiptV1[] = [created];
  const visited = new Set<AgreementState>([created.newState]);
  let state = created.newState;
  let previous = created;

  for (let next = transitions.get(state); next; next = transitions.get(state)) {
    if (next.slot < previous.slot) {
      throw new ReceiptError(
        `${next.action} committed in slot ${next.slot}, before the ${previous.action} it follows`,
      );
    }
    transitions.delete(state);
    ordered.push(next);
    state = next.newState;
    previous = next;
    if (visited.has(state)) throw new ReceiptError(`lifecycle revisits ${state}`);
    visited.add(state);
  }

  // Anything left over never attached to the path out of creation.
  const orphan = [...transitions.values()][0];
  if (orphan) {
    throw new ReceiptError(
      `${orphan.action} claims to start from ${orphan.previousState}, which this history never reached`,
    );
  }

  // An annotation belongs to the last transition that had already happened
  // when it was recorded. Ties resolve by chain coordinate and then by receipt
  // id, so placement is total and identical on every replay.
  const sortedAnnotations = [...annotations].sort(
    (a, b) =>
      a.slot - b.slot ||
      a.instructionIndex - b.instructionIndex ||
      (a.innerInstructionIndex ?? -1) - (b.innerInstructionIndex ?? -1) ||
      a.receiptId.localeCompare(b.receiptId),
  );
  const attached = new Map<number, PpvEscrowReceiptV1[]>();
  for (const annotation of sortedAnnotations) {
    let home = -1;
    ordered.forEach((transition, index) => {
      if (transition.slot <= annotation.slot) home = index;
    });
    if (home < 0) {
      throw new ReceiptError(
        `${annotation.action} committed in slot ${annotation.slot}, before this agreement existed`,
      );
    }
    const bucket = attached.get(home);
    if (bucket) bucket.push(annotation);
    else attached.set(home, [annotation]);
  }

  const withAnnotations: PpvEscrowReceiptV1[] = [];
  ordered.forEach((transition, index) => {
    withAnnotations.push(transition);
    for (const annotation of attached.get(index) ?? []) withAnnotations.push(annotation);
  });

  const funded = ordered.find((receipt) => receipt.action === "AGREEMENT_FUNDED");

  // Custody can leave the vault in more than one payment — a milestone
  // contract settles in tranches — so what has to match the funded amount is
  // the total paid out, not any single event. Annotations count: a tranche that
  // did not end the agreement still moved money.
  const all = [...ordered, ...annotations];
  const paidOut = (action: EscrowReceiptAction) =>
    all
      .filter((receipt) => receipt.action === action)
      .reduce<bigint | null>((total, receipt) => (total ?? 0n) + (receipt.amount ?? 0n), null);

  const settledTotal = paidOut("SETTLEMENT_EXECUTED");
  const settled = ordered.find((receipt) => receipt.action === "SETTLEMENT_EXECUTED");
  if (settledTotal !== null && !funded) {
    throw new ReceiptError("settlement without the funding it pays out");
  }
  // Only a finished agreement must add up: a milestone contract mid-flight has
  // paid out less than it holds, and that is not an inconsistency.
  if (settled && funded && settledTotal !== funded.amount) {
    throw new ReceiptError("settled amount does not match the funded amount");
  }
  const refunded = ordered.find((receipt) => receipt.action === "REFUND_EXECUTED");
  const refundedTotal = paidOut("REFUND_EXECUTED");
  if (settled && refunded) {
    throw new ReceiptError("an agreement cannot be both settled and refunded");
  }
  if (refundedTotal !== null && !funded) {
    throw new ReceiptError("refund without the funding it returns");
  }
  // A refund returns whatever is left, which is the whole amount unless
  // milestones already paid some of it out.
  if (refunded && funded) {
    const returnedAndPaid = (refundedTotal ?? 0n) + (settledTotal ?? 0n);
    if (returnedAndPaid !== funded.amount) {
      throw new ReceiptError("refunded and settled amounts do not add up to the funded amount");
    }
  }

  const proofs = proofRecords(sortedAnnotations);
  const milestones = milestoneRecords(sortedAnnotations);
  const scheduled = milestones.reduce((total, record) => total + record.amount, 0n);
  if (milestones.length > 0 && funded && scheduled !== funded.amount) {
    throw new ReceiptError("the milestone schedule does not add up to the funded amount");
  }
  if (settled?.proof) {
    const cited = proofs.find((record) => record.proof === settled.proof);
    if (!cited) {
      throw new ReceiptError(`settlement cites proof ${settled.proof}, which this history never saw`);
    }
    if (cited.status !== "Approved") {
      throw new ReceiptError(`settlement cites proof ${settled.proof}, which is ${cited.status}`);
    }
  }

  return {
    agreement,
    agreementId: created.agreementId,
    buyer: created.buyer,
    seller: created.seller,
    mint: created.mint as string,
    state,
    fundedAmount: funded?.amount ?? null,
    settledAmount: settledTotal,
    refundedAmount: refundedTotal,
    settlementDestination: settled?.destination ?? refunded?.destination ?? null,
    outcome:
      state === "Settled"
        ? "settled"
        : state === "Refunded"
          ? "refunded"
          : state === "Cancelled"
            ? "cancelled"
            : "open",
    lastSlot: previous.slot,
    proofs,
    milestones,
    receipts: withAnnotations,
  };
}
