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
} as const;

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
        previousState: event.previousState,
        newState: event.newState,
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
  settlementDestination: string | null;
  /** Slot of the most recent transition, for cursor bookkeeping. */
  lastSlot: number;
  receipts: readonly PpvEscrowReceiptV1[];
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

  const funded = ordered.find((receipt) => receipt.action === "AGREEMENT_FUNDED");
  const settled = ordered.find((receipt) => receipt.action === "SETTLEMENT_EXECUTED");
  if (settled && funded && settled.amount !== funded.amount) {
    throw new ReceiptError("settled amount does not match the funded amount");
  }
  if (settled && !funded) {
    throw new ReceiptError("settlement without the funding it pays out");
  }

  return {
    agreement,
    agreementId: created.agreementId,
    buyer: created.buyer,
    seller: created.seller,
    mint: created.mint as string,
    state,
    fundedAmount: funded?.amount ?? null,
    settledAmount: settled?.amount ?? null,
    settlementDestination: settled?.destination ?? null,
    lastSlot: previous.slot,
    receipts: ordered,
  };
}
