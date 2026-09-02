import {
  PPV_RECEIPT_SCHEMA_VERSION,
  type GnsRecordSnapshotV1,
  type ParticipantRole,
  type PpvReceiptV1,
  type PpvSealState,
  type ReputationEventV1,
} from "./contracts.js";
import { receiptId } from "./hashing.js";

/**
 * Receipt projection. One receipt per relevant participant per event, each a
 * deterministic view of the shared immutable event. A receipt never becomes an
 * independent truth: every field is copied from the event or derived from the
 * PPV state machine, and `receiptId` recomputes from (eventId, holder, role).
 */

export type Participant = { wallet: string; gnsRecord: GnsRecordSnapshotV1 | null; role: ParticipantRole };

export type ReceiptProjectionContext = {
  sealState: PpvSealState;
  disputeOpen: boolean;
  /**
   * Product-supplied role hints keyed by wallet, e.g. a Marketplace agreement
   * knows which party is the buyer. Hints only pick a role; they can never add
   * a participant the event does not name.
   */
  roleHints?: Readonly<Record<string, ParticipantRole>>;
  /** Arbiter wallet for dispute events, when the program names one. */
  arbiterWallet?: string | null;
  arbiterGnsRecord?: GnsRecordSnapshotV1 | null;
};

type DefaultRoles = { actor: ParticipantRole; counterparty: ParticipantRole };

function defaultRoles(event: ReputationEventV1): DefaultRoles {
  switch (event.eventType) {
    case "proof.created":
    case "proof.revoked":
      return { actor: "creator", counterparty: "collaborator" };
    case "proof.submitted":
      return {
        actor: "creator",
        counterparty: event.sourceProduct === "marketplace" ? "buyer" : "collaborator",
      };
    case "agreement.created":
    case "agreement.revised":
    case "agreement.signed":
    case "agreement.executed":
    case "agreement.cancelled":
    case "dispute.opened":
    case "dispute.resolved":
      return { actor: "collaborator", counterparty: "collaborator" };
    case "escrow.funded":
    case "invoice.paid":
    case "milestone.approved":
    case "settlement.completed":
      return { actor: "payer", counterparty: "payee" };
    case "milestone.created":
    case "milestone.rejected":
      return { actor: "buyer", counterparty: "seller" };
    case "milestone.delivered":
      return { actor: "seller", counterparty: "buyer" };
  }
}

export function participantsFor(event: ReputationEventV1, context: ReceiptProjectionContext): Participant[] {
  const roles = defaultRoles(event);
  const hints = context.roleHints ?? {};
  const participants: Participant[] = [
    {
      wallet: event.actorWallet,
      gnsRecord: event.actorGnsRecord,
      role: hints[event.actorWallet] ?? roles.actor,
    },
  ];
  if (event.counterpartyWallet && event.counterpartyWallet !== event.actorWallet) {
    participants.push({
      wallet: event.counterpartyWallet,
      gnsRecord: event.counterpartyGnsRecord,
      role: hints[event.counterpartyWallet] ?? roles.counterparty,
    });
  }
  const isDispute = event.eventType === "dispute.opened" || event.eventType === "dispute.resolved";
  if (isDispute && context.arbiterWallet && !participants.some((p) => p.wallet === context.arbiterWallet)) {
    participants.push({
      wallet: context.arbiterWallet,
      gnsRecord: context.arbiterGnsRecord ?? null,
      role: "arbiter",
    });
  }
  return participants;
}

export function projectReceipt(
  event: ReputationEventV1,
  holder: Participant,
  others: readonly Participant[],
  context: ReceiptProjectionContext,
): PpvReceiptV1 {
  return {
    schemaVersion: PPV_RECEIPT_SCHEMA_VERSION,
    receiptId: receiptId(event.eventId, holder.wallet, holder.role),
    eventId: event.eventId,
    ppvProofId: event.ppvProofId,
    proofHash: event.proofHash,
    agreementId: event.agreementId,
    holderWallet: holder.wallet,
    holderGnsRecord: holder.gnsRecord,
    role: holder.role,
    counterpartyWallets: others.map((p) => p.wallet),
    counterpartyGnsRecords: others.map((p) => p.gnsRecord),
    sourceProduct: event.sourceProduct,
    sourceObjectId: event.sourceObjectId,
    deliverableId: event.deliverableId,
    eventType: event.eventType,
    outcome: event.outcome,
    amount: event.amount,
    mint: event.mint,
    programId: event.programId,
    transactionSignature: event.transactionSignature,
    instructionIndex: event.instructionIndex,
    innerInstructionIndex: event.innerInstructionIndex,
    completedAt: event.occurredAt,
    sealState: context.sealState,
    disputeOpen: context.disputeOpen,
    mintEligible: false,
    credentialMint: null,
  };
}

export function projectReceipts(event: ReputationEventV1, context: ReceiptProjectionContext): PpvReceiptV1[] {
  const participants = participantsFor(event, context);
  return participants.map((holder) =>
    projectReceipt(
      event,
      holder,
      participants.filter((p) => p.wallet !== holder.wallet),
      context,
    ),
  );
}

/**
 * Re-derives the mutable presentation fields of a stored receipt from current
 * facts. Identity fields are never touched: the holder, the GNS snapshot, and
 * the chain coordinates are frozen at first projection.
 */
export function refreshReceiptState(
  receipt: PpvReceiptV1,
  state: { sealState: PpvSealState; disputeOpen: boolean; mintEligible: boolean; credentialMint: string | null },
): PpvReceiptV1 {
  return {
    ...receipt,
    sealState: state.sealState,
    disputeOpen: state.disputeOpen,
    mintEligible: state.mintEligible,
    credentialMint: state.credentialMint,
  };
}
