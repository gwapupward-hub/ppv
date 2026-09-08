/**
 * PPV reputation contracts, version 1.
 *
 * These shapes are shared by every GWAP product that reads or writes PPV
 * activity: PPV itself, GNS Verified Activity, GwapScore, the Marketplace,
 * Daily Ideas, DIMI and GwapOS. They describe facts only. Nothing here carries
 * a trust label, a score, or a quality judgement; interpretation belongs to
 * GwapScore and is deliberately absent from this module.
 *
 * Breaking changes get a new schema version and a new set of types. Fields may
 * be added to a version only when every existing consumer keeps working.
 */

export const REPUTATION_EVENT_SCHEMA_VERSION = 1 as const;
export const DELIVERABLE_REFERENCE_SCHEMA_VERSION = 1 as const;
export const PPV_RECEIPT_SCHEMA_VERSION = 1 as const;
export const GNS_RECORD_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Event types PPV can attest to. Chain-derived types map one-to-one onto a
 * program event; `proof.submitted` is the only product-attested type and can
 * exist only by referencing a chain-verified proof (see `normalize.ts`).
 *
 * Types for escrow, milestones, invoices, disputes and settlement are declared
 * ahead of the custody programs that will emit them so consumers can be built
 * now. Until those programs exist no normalizer produces them.
 */
export const REPUTATION_EVENT_TYPES = [
  "proof.created",
  "proof.revoked",
  "proof.submitted",
  "agreement.created",
  "agreement.revised",
  "agreement.signed",
  "agreement.executed",
  "agreement.cancelled",
  "escrow.funded",
  "milestone.created",
  "milestone.delivered",
  "milestone.approved",
  "milestone.rejected",
  "invoice.paid",
  "dispute.opened",
  "dispute.resolved",
  "settlement.completed",
  // Added by Phase 10, when the escrow kernel gained facts with no existing
  // home. Appended rather than substituted: every type above still means what
  // it meant, and a consumer that ignores a type it does not know keeps working.
  "work.completed",
  "milestone.settled",
  "agreement.refunded",
  "proof.approved",
  "proof.rejected",
] as const;

export type ReputationEventType = (typeof REPUTATION_EVENT_TYPES)[number];

/** Factual result of the event. Never a judgement about a participant. */
export const REPUTATION_OUTCOMES = [
  "recorded",
  "completed",
  "rejected",
  "cancelled",
  "revoked",
  "opened",
  "resolved_for_actor",
  "resolved_for_counterparty",
  "resolved_split",
] as const;

export type ReputationOutcome = (typeof REPUTATION_OUTCOMES)[number];

export const SOURCE_PRODUCTS = [
  "ppv",
  "marketplace",
  "daily-ideas",
  "dimi",
  "gwapos",
] as const;

export type SourceProduct = (typeof SOURCE_PRODUCTS)[number];

export const PARTICIPANT_ROLES = [
  "creator",
  "buyer",
  "seller",
  "payer",
  "payee",
  "collaborator",
  "arbiter",
] as const;

export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

/**
 * Seal states, in ascending order of what the PPV state machine has confirmed.
 * `revoked` is terminal and sits outside the ladder: a revoked proof is never
 * displayed as verified. Every state is derived from events, never stored from
 * a client.
 */
export const PPV_SEAL_STATES = [
  "recorded",
  "verified",
  "counterparty_confirmed",
  "settled",
  "dispute_resolved",
  "revoked",
] as const;

export type PpvSealState = (typeof PPV_SEAL_STATES)[number];

/**
 * The GNS identity that was associated with a wallet when an event happened.
 * A later transfer of the name changes nothing here: the wallet stays the
 * authority and the snapshot stays attached to the wallet that held it.
 */
export type GnsRecordSnapshotV1 = {
  schemaVersion: typeof GNS_RECORD_SNAPSHOT_SCHEMA_VERSION;
  /** Bare label, e.g. `emerald`. */
  name: string;
  /** Full name, e.g. `emerald.gwap`. */
  fullName: string;
  /** Wallet that owned the name at `resolvedAt`. Always equals the snapshot subject. */
  owner: string;
  /** ISO-8601 time the snapshot was taken by the indexer. */
  resolvedAt: string;
};

export type ReputationEventSource = "chain" | "product";

export type ReputationEventV1 = {
  schemaVersion: typeof REPUTATION_EVENT_SCHEMA_VERSION;
  /** Deterministic id derived from the idempotency key; see `hashing.ts`. */
  eventId: string;
  eventType: ReputationEventType;
  /** ISO-8601 chain block time for chain events, or the anchoring proof's time for product events. */
  occurredAt: string;
  eventSource: ReputationEventSource;

  actorWallet: string;
  actorGnsRecord: GnsRecordSnapshotV1 | null;

  counterpartyWallet: string | null;
  counterpartyGnsRecord: GnsRecordSnapshotV1 | null;

  /** Proof account address (base58). Globally unique, verifiable on chain. */
  ppvProofId: string | null;
  /** SHA-256 content hash committed by the proof, lowercase hex. */
  proofHash: string | null;

  /** Agreement account address (base58). */
  agreementId: string | null;
  escrowId: string | null;
  milestoneIndex: number | null;

  sourceProduct: SourceProduct | null;
  sourceObjectId: string | null;
  deliverableId: string | null;

  /** Base-unit amount as a decimal string, or null when no value moved. */
  amount: string | null;
  mint: string | null;
  outcome: ReputationOutcome;

  programId: string;
  transactionSignature: string;
  /** Index of the top-level instruction in the transaction. */
  instructionIndex: number;
  /**
   * Position of the event CPI within that instruction's inner instructions.
   * One instruction can emit several events (sign_agreement emits
   * AgreementSigned and AgreementExecuted), so the idempotency key is
   * (transactionSignature, instructionIndex, innerInstructionIndex).
   */
  innerInstructionIndex: number | null;
};

/**
 * One shared proof interface for anything a GWAP product ships. A reference
 * links a product object to a PPV proof; it does not restate the proof. The
 * proof account on chain is the truth, the reference is how a product says
 * "this is the deliverable that proof covers".
 */
export type GwapDeliverableReferenceV1 = {
  schemaVersion: typeof DELIVERABLE_REFERENCE_SCHEMA_VERSION;
  sourceProduct: SourceProduct;
  sourceObjectId: string;
  deliverableId: string;
  creatorWallet: string;
  creatorGnsRecord: GnsRecordSnapshotV1 | null;
  ppvProofId: string;
  proofHash: string;
  createdAt: string;
  /** Optional counterparty the deliverable is submitted to. */
  counterpartyWallet: string | null;
  /** Free-form, product-defined kind such as `master`, `contribution`, `milestone`. */
  deliverableKind: string;
};

export type PpvReceiptV1 = {
  schemaVersion: typeof PPV_RECEIPT_SCHEMA_VERSION;
  /** Deterministic: derived from (eventId, holderWallet, role). */
  receiptId: string;
  /** The normalized event this receipt is a view of. */
  eventId: string;
  ppvProofId: string | null;
  proofHash: string | null;
  agreementId: string | null;

  holderWallet: string;
  holderGnsRecord: GnsRecordSnapshotV1 | null;
  role: ParticipantRole;

  counterpartyWallets: string[];
  counterpartyGnsRecords: Array<GnsRecordSnapshotV1 | null>;

  sourceProduct: SourceProduct | null;
  sourceObjectId: string | null;
  deliverableId: string | null;

  eventType: ReputationEventType;
  outcome: ReputationOutcome;

  amount: string | null;
  mint: string | null;

  programId: string;
  transactionSignature: string;
  instructionIndex: number;
  innerInstructionIndex: number | null;

  completedAt: string;
  sealState: PpvSealState;
  /** True while a dispute touching this proof or agreement is open. */
  disputeOpen: boolean;

  mintEligible: boolean;
  credentialMint: string | null;
};

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const HEX_32 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const GNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isSolanaAddress(value: unknown): value is string {
  return typeof value === "string" && BASE58_ADDRESS.test(value);
}

export function isTransactionSignature(value: unknown): value is string {
  return typeof value === "string" && BASE58_SIGNATURE.test(value);
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

export function isReputationEventType(value: unknown): value is ReputationEventType {
  return typeof value === "string" && (REPUTATION_EVENT_TYPES as readonly string[]).includes(value);
}

export function isReputationOutcome(value: unknown): value is ReputationOutcome {
  return typeof value === "string" && (REPUTATION_OUTCOMES as readonly string[]).includes(value);
}

export function isSourceProduct(value: unknown): value is SourceProduct {
  return typeof value === "string" && (SOURCE_PRODUCTS as readonly string[]).includes(value);
}

export function isParticipantRole(value: unknown): value is ParticipantRole {
  return typeof value === "string" && (PARTICIPANT_ROLES as readonly string[]).includes(value);
}

export function isPpvSealState(value: unknown): value is PpvSealState {
  return typeof value === "string" && (PPV_SEAL_STATES as readonly string[]).includes(value);
}

export function isGnsRecordSnapshot(value: unknown): value is GnsRecordSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<GnsRecordSnapshotV1>;
  return (
    record.schemaVersion === GNS_RECORD_SNAPSHOT_SCHEMA_VERSION &&
    typeof record.name === "string" &&
    GNS_LABEL.test(record.name) &&
    record.fullName === `${record.name}.gwap` &&
    isSolanaAddress(record.owner) &&
    isIsoTimestamp(record.resolvedAt)
  );
}

function nullableAddress(value: unknown) {
  return value === null || isSolanaAddress(value);
}

function nullableString(value: unknown, max = 200) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= max);
}

function nullableSnapshot(value: unknown) {
  return value === null || isGnsRecordSnapshot(value);
}

function isAmount(value: unknown) {
  return value === null || (typeof value === "string" && /^(0|[1-9]\d{0,38})$/.test(value));
}

function isInstructionIndex(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 1_024;
}

/**
 * Structural validation of a stored or transported event. Consumers must treat
 * anything that fails this as absent rather than repairing it.
 */
export function isReputationEventV1(value: unknown): value is ReputationEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ReputationEventV1>;
  return (
    event.schemaVersion === REPUTATION_EVENT_SCHEMA_VERSION &&
    typeof event.eventId === "string" &&
    /^evt_[0-9a-f]{40}$/.test(event.eventId) &&
    isReputationEventType(event.eventType) &&
    isIsoTimestamp(event.occurredAt) &&
    (event.eventSource === "chain" || event.eventSource === "product") &&
    isSolanaAddress(event.actorWallet) &&
    nullableSnapshot(event.actorGnsRecord) &&
    nullableAddress(event.counterpartyWallet) &&
    nullableSnapshot(event.counterpartyGnsRecord) &&
    nullableAddress(event.ppvProofId) &&
    (event.proofHash === null || isSha256Hex(event.proofHash)) &&
    nullableAddress(event.agreementId) &&
    nullableAddress(event.escrowId) &&
    (event.milestoneIndex === null ||
      (typeof event.milestoneIndex === "number" && Number.isInteger(event.milestoneIndex) && event.milestoneIndex >= 0)) &&
    (event.sourceProduct === null || isSourceProduct(event.sourceProduct)) &&
    nullableString(event.sourceObjectId) &&
    nullableString(event.deliverableId) &&
    isAmount(event.amount) &&
    nullableAddress(event.mint) &&
    isReputationOutcome(event.outcome) &&
    isSolanaAddress(event.programId) &&
    isTransactionSignature(event.transactionSignature) &&
    isInstructionIndex(event.instructionIndex) &&
    (event.innerInstructionIndex === null || isInstructionIndex(event.innerInstructionIndex))
  );
}

export function isGwapDeliverableReferenceV1(value: unknown): value is GwapDeliverableReferenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<GwapDeliverableReferenceV1>;
  return (
    reference.schemaVersion === DELIVERABLE_REFERENCE_SCHEMA_VERSION &&
    isSourceProduct(reference.sourceProduct) &&
    typeof reference.sourceObjectId === "string" &&
    /^[A-Za-z0-9:_.-]{1,120}$/.test(reference.sourceObjectId) &&
    typeof reference.deliverableId === "string" &&
    /^[A-Za-z0-9:_.-]{1,120}$/.test(reference.deliverableId) &&
    isSolanaAddress(reference.creatorWallet) &&
    nullableSnapshot(reference.creatorGnsRecord) &&
    isSolanaAddress(reference.ppvProofId) &&
    isSha256Hex(reference.proofHash) &&
    isIsoTimestamp(reference.createdAt) &&
    nullableAddress(reference.counterpartyWallet) &&
    typeof reference.deliverableKind === "string" &&
    /^[a-z][a-z0-9-]{0,39}$/.test(reference.deliverableKind)
  );
}

export function isPpvReceiptV1(value: unknown): value is PpvReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<PpvReceiptV1>;
  return (
    receipt.schemaVersion === PPV_RECEIPT_SCHEMA_VERSION &&
    typeof receipt.receiptId === "string" &&
    /^rcpt_[0-9a-f]{40}$/.test(receipt.receiptId) &&
    typeof receipt.eventId === "string" &&
    /^evt_[0-9a-f]{40}$/.test(receipt.eventId) &&
    nullableAddress(receipt.ppvProofId) &&
    (receipt.proofHash === null || isSha256Hex(receipt.proofHash)) &&
    nullableAddress(receipt.agreementId) &&
    isSolanaAddress(receipt.holderWallet) &&
    nullableSnapshot(receipt.holderGnsRecord) &&
    isParticipantRole(receipt.role) &&
    Array.isArray(receipt.counterpartyWallets) &&
    receipt.counterpartyWallets.every(isSolanaAddress) &&
    Array.isArray(receipt.counterpartyGnsRecords) &&
    receipt.counterpartyGnsRecords.length === receipt.counterpartyWallets.length &&
    receipt.counterpartyGnsRecords.every(nullableSnapshot) &&
    (receipt.sourceProduct === null || isSourceProduct(receipt.sourceProduct)) &&
    nullableString(receipt.sourceObjectId) &&
    nullableString(receipt.deliverableId) &&
    isReputationEventType(receipt.eventType) &&
    isReputationOutcome(receipt.outcome) &&
    isAmount(receipt.amount) &&
    nullableAddress(receipt.mint) &&
    isSolanaAddress(receipt.programId) &&
    isTransactionSignature(receipt.transactionSignature) &&
    isInstructionIndex(receipt.instructionIndex) &&
    (receipt.innerInstructionIndex === null || isInstructionIndex(receipt.innerInstructionIndex)) &&
    isIsoTimestamp(receipt.completedAt) &&
    isPpvSealState(receipt.sealState) &&
    typeof receipt.disputeOpen === "boolean" &&
    typeof receipt.mintEligible === "boolean" &&
    nullableAddress(receipt.credentialMint)
  );
}
