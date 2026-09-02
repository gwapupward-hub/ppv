import {
  isPpvReceiptV1,
  type GnsRecordSnapshotV1,
  type ParticipantRole,
  type PpvReceiptV1,
  type ReputationEventType,
  type SourceProduct,
} from "./contracts.js";
import { receiptId } from "./hashing.js";
import type { SealFacts } from "./seal-state.js";
import { resolveSealState } from "./seal-state.js";

/**
 * Optional credential NFT. The NFT is not the proof. The hierarchy is
 *   PPV proof -> participant receipt -> final settlement -> eligibility -> optional mint
 * and every step is evaluated server-side from chain-derived facts. Nothing a
 * browser sends about eligibility is ever trusted.
 */

export const CREDENTIAL_REJECTIONS = [
  "proof_missing",
  "proof_revoked",
  "proof_not_verified",
  "receipt_invalid",
  "wrong_holder",
  "dispute_active",
  "not_settled",
  "already_minted",
] as const;

export type CredentialRejection = (typeof CREDENTIAL_REJECTIONS)[number];

export type ProofChainState = {
  /** The proof account exists on chain at `ppvProofId`. */
  exists: boolean;
  revoked: boolean;
  /** Wallet authority recorded on the account. */
  authority: string | null;
  contentHash: string | null;
};

export type CredentialEligibilityInput = {
  receipt: unknown;
  /** The wallet asking. Must equal the receipt holder. */
  requestedBy: string;
  proof: ProofChainState;
  facts: SealFacts;
};

export type CredentialEligibility =
  | { eligible: true; receipt: PpvReceiptV1; sealState: "settled" | "dispute_resolved" }
  | { eligible: false; reasons: CredentialRejection[] };

export function evaluateCredentialEligibility(input: CredentialEligibilityInput): CredentialEligibility {
  const reasons: CredentialRejection[] = [];

  if (!isPpvReceiptV1(input.receipt)) return { eligible: false, reasons: ["receipt_invalid"] };
  const receipt = input.receipt;

  if (receiptId(receipt.eventId, receipt.holderWallet, receipt.role) !== receipt.receiptId) {
    reasons.push("receipt_invalid");
  }
  if (receipt.holderWallet !== input.requestedBy) reasons.push("wrong_holder");
  if (receipt.credentialMint) reasons.push("already_minted");

  if (!receipt.ppvProofId || !input.proof.exists) reasons.push("proof_missing");
  else {
    if (input.proof.revoked || input.facts.proofRevoked) reasons.push("proof_revoked");
    if (receipt.proofHash && input.proof.contentHash && receipt.proofHash !== input.proof.contentHash) {
      reasons.push("receipt_invalid");
    }
    if (!input.facts.chainVerified) reasons.push("proof_not_verified");
  }

  if (input.facts.disputeOpen) reasons.push("dispute_active");

  const sealState = resolveSealState(input.facts);
  if (sealState !== "settled" && sealState !== "dispute_resolved") reasons.push("not_settled");

  if (reasons.length) return { eligible: false, reasons: [...new Set(reasons)] };
  return { eligible: true, receipt, sealState: sealState as "settled" | "dispute_resolved" };
}

/**
 * Public credential metadata. Only the fields listed here may ever leave the
 * server. Agreement contents, invoice line items, deliverables, encrypted
 * documents and dispute evidence are private material and are not part of
 * this type; `assertPublicCredentialMetadata` rejects any object carrying them.
 */
export type PpvCredentialMetadataV1 = {
  schemaVersion: 1;
  name: string;
  symbol: "PPV";
  description: string;
  ppv_proof_id: string;
  receipt_id: string;
  holder_wallet: string;
  holder_gns_record: GnsRecordSnapshotV1 | null;
  role: ParticipantRole;
  source_product: SourceProduct | null;
  event_type: ReputationEventType;
  completion_date: string;
  seal_state: "settled" | "dispute_resolved";
  verification_uri: string;
};

export const PRIVATE_METADATA_KEYS = [
  "agreement",
  "agreement_content",
  "agreementContent",
  "terms",
  "invoice",
  "invoice_lines",
  "line_items",
  "lineItems",
  "deliverable",
  "deliverable_content",
  "document",
  "ciphertext",
  "encrypted",
  "evidence",
  "dispute_evidence",
  "attachments",
  "files",
  "context",
  "context_hash",
  "notes",
  "email",
  "phone",
] as const;

const PUBLIC_METADATA_KEYS = new Set<string>([
  "schemaVersion",
  "name",
  "symbol",
  "description",
  "ppv_proof_id",
  "receipt_id",
  "holder_wallet",
  "holder_gns_record",
  "role",
  "source_product",
  "event_type",
  "completion_date",
  "seal_state",
  "verification_uri",
]);

export function buildCredentialMetadata(
  eligibility: Extract<CredentialEligibility, { eligible: true }>,
  verificationUri: string,
): PpvCredentialMetadataV1 {
  const { receipt, sealState } = eligibility;
  if (!/^https:\/\//.test(verificationUri)) throw new TypeError("verification URI must be https");
  const metadata: PpvCredentialMetadataV1 = {
    schemaVersion: 1,
    name: `PPV Receipt · ${receipt.eventType}`,
    symbol: "PPV",
    description:
      "This credential corresponds to a verifiable PPV protocol record. It does not certify quality, ownership, honesty, or future behaviour.",
    ppv_proof_id: receipt.ppvProofId as string,
    receipt_id: receipt.receiptId,
    holder_wallet: receipt.holderWallet,
    holder_gns_record: receipt.holderGnsRecord,
    role: receipt.role,
    source_product: receipt.sourceProduct,
    event_type: receipt.eventType,
    completion_date: receipt.completedAt,
    seal_state: sealState,
    verification_uri: verificationUri,
  };
  assertPublicCredentialMetadata(metadata);
  return metadata;
}

/** Throws when metadata carries any key outside the public allowlist. */
export function assertPublicCredentialMetadata(value: unknown): asserts value is PpvCredentialMetadataV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("metadata must be an object");
  for (const key of Object.keys(value)) {
    if (!PUBLIC_METADATA_KEYS.has(key)) {
      throw new TypeError(`metadata key "${key}" is not public`);
    }
  }
  const nested = (value as { holder_gns_record?: unknown }).holder_gns_record;
  if (nested && typeof nested === "object") {
    for (const key of Object.keys(nested)) {
      if (!["schemaVersion", "name", "fullName", "owner", "resolvedAt"].includes(key)) {
        throw new TypeError(`holder_gns_record key "${key}" is not public`);
      }
    }
  }
}
