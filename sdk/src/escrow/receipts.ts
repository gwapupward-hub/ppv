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
  receipts: readonly PpvEscrowReceiptV1[];
};

/**
 * Rebuilds one agreement's history from its receipts. This is the Phase 2 bar:
 * given only chain data, an independent indexer reaches the same lifecycle a
 * PPV database would report — and refuses a history that does not chain.
 *
 * Receipts arrive out of order and more than once; both are normal for webhook
 * delivery, and neither may change the result.
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

  const order: Record<EscrowReceiptAction, number> = {
    AGREEMENT_CREATED: 0,
    AGREEMENT_FUNDED: 1,
    WORK_COMPLETED: 2,
    SETTLEMENT_EXECUTED: 3,
  };
  const ordered = [...byId.values()].sort((a, b) => order[a.action] - order[b.action]);

  const agreement = ordered[0]?.agreement as string;
  for (const receipt of ordered) {
    if (receipt.agreement !== agreement) {
      throw new ReceiptError("receipts describe more than one agreement");
    }
  }

  const created = ordered.find((receipt) => receipt.action === "AGREEMENT_CREATED");
  if (!created) throw new ReceiptError("lifecycle is missing its creation receipt");

  // Every step must claim to start where the previous one ended. A receipt that
  // does not chain is a receipt that does not describe this agreement's history.
  let state: AgreementState = created.newState;
  for (const receipt of ordered.slice(1)) {
    if (receipt.previousState !== state) {
      throw new ReceiptError(
        `${receipt.action} claims to start from ${receipt.previousState}, chain is at ${state}`,
      );
    }
    state = receipt.newState;
  }

  const funded = ordered.find((receipt) => receipt.action === "AGREEMENT_FUNDED");
  const settled = ordered.find((receipt) => receipt.action === "SETTLEMENT_EXECUTED");
  if (settled && funded && settled.amount !== funded.amount) {
    throw new ReceiptError("settled amount does not match the funded amount");
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
    receipts: ordered,
  };
}
