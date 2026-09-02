import type { PpvChainEvent } from "./chain-events.js";
import { programForEvent } from "./chain-events.js";
import {
  REPUTATION_EVENT_SCHEMA_VERSION,
  isSolanaAddress,
  isSourceProduct,
  isTransactionSignature,
  type GnsRecordSnapshotV1,
  type GwapDeliverableReferenceV1,
  type ReputationEventV1,
  type SourceProduct,
} from "./contracts.js";
import { chainEventId, productEventId } from "./hashing.js";

/**
 * Turns a decoded PPV chain event into one normalized ReputationEventV1.
 *
 * The normalizer is stateless: every field it needs is in the event itself,
 * which is why the program events carry both parties of an agreement. That is
 * what makes out-of-order webhook delivery safe.
 */

export type ChainEventEnvelope = {
  event: PpvChainEvent;
  /** Program id the event CPI targeted. Must be the program that owns the event. */
  programId: string;
  transactionSignature: string;
  instructionIndex: number;
  innerInstructionIndex: number | null;
  /** Unix seconds from the block; falls back to the event's own timestamp. */
  blockTime: number | null;
};

/**
 * Resolves the GNS identity a wallet holds right now. The indexer calls this
 * once when it first sees an event; the answer is frozen into the event and
 * never refreshed, so a later name transfer cannot rewrite history.
 */
export type GnsSnapshotResolver = (wallet: string) => Promise<GnsRecordSnapshotV1 | null>;

/** Looks up the deliverable reference registered for a proof, if any. */
export type DeliverableReferenceLookup = (
  ppvProofId: string,
) => Promise<GwapDeliverableReferenceV1 | null>;

export type NormalizeOptions = {
  resolveGns: GnsSnapshotResolver;
  lookupDeliverable?: DeliverableReferenceLookup;
  expectedProgramIds: { ppvCore: string; ppvCommerce: string };
};

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizationError";
  }
}

function isoFromUnix(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new NormalizationError("invalid timestamp");
  return new Date(seconds * 1_000).toISOString();
}

type Mapped = Pick<
  ReputationEventV1,
  | "eventType"
  | "actorWallet"
  | "counterpartyWallet"
  | "ppvProofId"
  | "proofHash"
  | "agreementId"
  | "outcome"
> & { occurredAtUnix: number };

function mapChainEvent(event: PpvChainEvent): Mapped {
  switch (event.name) {
    case "ProofCreated":
      return {
        eventType: "proof.created",
        actorWallet: event.authority,
        counterpartyWallet: null,
        ppvProofId: event.proof,
        proofHash: event.contentHash,
        agreementId: null,
        outcome: "recorded",
        occurredAtUnix: event.createdAt,
      };
    case "ProofRevoked":
      return {
        eventType: "proof.revoked",
        actorWallet: event.authority,
        counterpartyWallet: null,
        ppvProofId: event.proof,
        proofHash: event.contentHash,
        agreementId: null,
        outcome: "revoked",
        occurredAtUnix: event.revokedAt,
      };
    case "AgreementCreated":
      return {
        eventType: "agreement.created",
        actorWallet: event.partyA,
        counterpartyWallet: event.partyB,
        ppvProofId: null,
        proofHash: event.contentHash,
        agreementId: event.agreement,
        outcome: "recorded",
        occurredAtUnix: event.createdAt,
      };
    case "AgreementRevised":
      return {
        eventType: "agreement.revised",
        actorWallet: event.proposer,
        counterpartyWallet: event.proposer === event.partyA ? event.partyB : event.partyA,
        ppvProofId: null,
        proofHash: event.contentHash,
        agreementId: event.agreement,
        outcome: "recorded",
        occurredAtUnix: event.revisedAt,
      };
    case "AgreementSigned":
      return {
        eventType: "agreement.signed",
        actorWallet: event.signer,
        counterpartyWallet: event.signer === event.partyA ? event.partyB : event.partyA,
        ppvProofId: null,
        proofHash: event.contentHash,
        agreementId: event.agreement,
        outcome: "recorded",
        occurredAtUnix: event.signedAt,
      };
    case "AgreementExecuted":
      return {
        eventType: "agreement.executed",
        actorWallet: event.partyA,
        counterpartyWallet: event.partyB,
        ppvProofId: null,
        proofHash: event.contentHash,
        agreementId: event.agreement,
        outcome: "completed",
        occurredAtUnix: event.executedAt,
      };
    case "AgreementCancelled":
      return {
        eventType: "agreement.cancelled",
        actorWallet: event.cancelledBy,
        counterpartyWallet: event.cancelledBy === event.partyA ? event.partyB : event.partyA,
        ppvProofId: null,
        proofHash: null,
        agreementId: event.agreement,
        outcome: "cancelled",
        occurredAtUnix: event.cancelledAt,
      };
  }
}

export async function normalizeChainEvent(
  envelope: ChainEventEnvelope,
  options: NormalizeOptions,
): Promise<ReputationEventV1> {
  const { event } = envelope;
  const owner = programForEvent(event.name);
  const expected = owner === "ppv_core" ? options.expectedProgramIds.ppvCore : options.expectedProgramIds.ppvCommerce;
  if (envelope.programId !== expected) {
    throw new NormalizationError(`${event.name} arrived from ${envelope.programId}, expected ${expected}`);
  }
  if (!isTransactionSignature(envelope.transactionSignature)) {
    throw new NormalizationError("invalid transaction signature");
  }
  if (!Number.isInteger(envelope.instructionIndex) || envelope.instructionIndex < 0) {
    throw new NormalizationError("invalid instruction index");
  }

  const mapped = mapChainEvent(event);

  const [actorGnsRecord, counterpartyGnsRecord, deliverable] = await Promise.all([
    options.resolveGns(mapped.actorWallet),
    mapped.counterpartyWallet ? options.resolveGns(mapped.counterpartyWallet) : Promise.resolve(null),
    mapped.ppvProofId && options.lookupDeliverable
      ? options.lookupDeliverable(mapped.ppvProofId)
      : Promise.resolve(null),
  ]);

  const key = {
    transactionSignature: envelope.transactionSignature,
    instructionIndex: envelope.instructionIndex,
    innerInstructionIndex: envelope.innerInstructionIndex,
  };

  return {
    schemaVersion: REPUTATION_EVENT_SCHEMA_VERSION,
    eventId: chainEventId(key, mapped.eventType),
    eventType: mapped.eventType,
    occurredAt: isoFromUnix(envelope.blockTime ?? mapped.occurredAtUnix),
    eventSource: "chain",
    actorWallet: mapped.actorWallet,
    actorGnsRecord: snapshotFor(actorGnsRecord, mapped.actorWallet),
    counterpartyWallet: mapped.counterpartyWallet,
    counterpartyGnsRecord: mapped.counterpartyWallet
      ? snapshotFor(counterpartyGnsRecord, mapped.counterpartyWallet)
      : null,
    ppvProofId: mapped.ppvProofId,
    proofHash: mapped.proofHash,
    agreementId: mapped.agreementId,
    escrowId: null,
    milestoneIndex: null,
    sourceProduct: deliverable?.sourceProduct ?? null,
    sourceObjectId: deliverable?.sourceObjectId ?? null,
    deliverableId: deliverable?.deliverableId ?? null,
    amount: null,
    mint: null,
    outcome: mapped.outcome,
    programId: envelope.programId,
    transactionSignature: envelope.transactionSignature,
    instructionIndex: envelope.instructionIndex,
    innerInstructionIndex: envelope.innerInstructionIndex,
  };
}

/** A snapshot is only valid for the wallet it was resolved for. */
function snapshotFor(snapshot: GnsRecordSnapshotV1 | null, wallet: string): GnsRecordSnapshotV1 | null {
  if (!snapshot) return null;
  if (snapshot.owner !== wallet) {
    throw new NormalizationError(`GNS snapshot owner ${snapshot.owner} does not match wallet ${wallet}`);
  }
  return snapshot;
}

export type ProductSubmissionInput = {
  reference: GwapDeliverableReferenceV1;
  /** The chain event that created the referenced proof; the submission borrows its coordinates. */
  proofCreated: ReputationEventV1;
  submittedAt: string;
  counterpartyGnsRecord: GnsRecordSnapshotV1 | null;
};

/**
 * `proof.submitted`: a product attests that an existing, chain-verified proof
 * was submitted as a deliverable. It cannot exist without the `proof.created`
 * event it references, and it inherits that event's chain coordinates.
 */
export function normalizeProductSubmission(input: ProductSubmissionInput): ReputationEventV1 {
  const { reference, proofCreated } = input;
  if (proofCreated.eventType !== "proof.created") {
    throw new NormalizationError("a submission must reference a proof.created event");
  }
  if (proofCreated.ppvProofId !== reference.ppvProofId) {
    throw new NormalizationError("deliverable reference does not match the proof event");
  }
  if (proofCreated.proofHash !== reference.proofHash) {
    throw new NormalizationError("deliverable reference hash does not match the proof event");
  }
  if (proofCreated.actorWallet !== reference.creatorWallet) {
    throw new NormalizationError("deliverable creator is not the proof authority");
  }
  if (!isSourceProduct(reference.sourceProduct)) throw new NormalizationError("invalid source product");
  if (reference.counterpartyWallet !== null && !isSolanaAddress(reference.counterpartyWallet)) {
    throw new NormalizationError("invalid counterparty wallet");
  }

  const key = {
    transactionSignature: proofCreated.transactionSignature,
    instructionIndex: proofCreated.instructionIndex,
    innerInstructionIndex: proofCreated.innerInstructionIndex,
    eventType: "proof.submitted" as const,
    sourceProduct: reference.sourceProduct as SourceProduct,
    sourceObjectId: reference.sourceObjectId,
    deliverableId: reference.deliverableId,
  };

  return {
    schemaVersion: REPUTATION_EVENT_SCHEMA_VERSION,
    eventId: productEventId(key),
    eventType: "proof.submitted",
    occurredAt: input.submittedAt,
    eventSource: "product",
    actorWallet: reference.creatorWallet,
    actorGnsRecord: reference.creatorGnsRecord,
    counterpartyWallet: reference.counterpartyWallet,
    counterpartyGnsRecord: reference.counterpartyWallet
      ? snapshotFor(input.counterpartyGnsRecord, reference.counterpartyWallet)
      : null,
    ppvProofId: reference.ppvProofId,
    proofHash: reference.proofHash,
    agreementId: null,
    escrowId: null,
    milestoneIndex: null,
    sourceProduct: reference.sourceProduct,
    sourceObjectId: reference.sourceObjectId,
    deliverableId: reference.deliverableId,
    amount: null,
    mint: null,
    outcome: "recorded",
    programId: proofCreated.programId,
    transactionSignature: proofCreated.transactionSignature,
    instructionIndex: proofCreated.instructionIndex,
    innerInstructionIndex: proofCreated.innerInstructionIndex,
  };
}
