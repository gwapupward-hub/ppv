import { BorshReader, bytesEqual } from "../escrow/reader.js";
import { anchorDiscriminator } from "../reputation/hashing.js";

/**
 * Decoder for `ppv_core`'s `ProofRecord` — a wallet's timestamped commitment to
 * a sequence of bytes. Mirrors `programs/ppv_core/src/state.rs` field by field.
 *
 * It exists alongside the `ppv_commerce` decoder so a client can hold a proof
 * and an agreement at once and check that they refer to the same thing, without
 * either program depending on the other. Account identity is the pair (owning
 * program, discriminator): a discriminator says what an account claims to be,
 * and only its owner says whose it is. Passing Commerce bytes to this function
 * is refused rather than misread, and the reverse is refused too.
 */

export const CORE_PROOF_KINDS = [
  "Creation",
  "Document",
  "Agreement",
  "Invoice",
  "Deliverable",
  "Other",
] as const;
export type CoreProofKind = (typeof CORE_PROOF_KINDS)[number];

export const CORE_PROOF_STATUSES = ["Active", "Revoked"] as const;
export type CoreProofStatus = (typeof CORE_PROOF_STATUSES)[number];

export type CoreProofAccount = {
  schemaVersion: number;
  bump: number;
  proofId: string;
  authority: string;
  /** SHA-256 over the canonical plaintext bytes the wallet committed to. */
  contentHash: string;
  /** Commitment to a private manifest. All zeroes means absent. */
  contextHash: string;
  kind: CoreProofKind;
  status: CoreProofStatus;
  createdAt: number;
  revokedAt: number;
};

export const CORE_PROOF_DISCRIMINATOR = anchorDiscriminator("account", "ProofRecord");

export function coreProofKindFromIndex(index: number): CoreProofKind {
  const kind = CORE_PROOF_KINDS[index];
  if (!kind) throw new RangeError(`unknown core proof kind ${index}`);
  return kind;
}

export function coreProofStatusFromIndex(index: number): CoreProofStatus {
  const status = CORE_PROOF_STATUSES[index];
  if (!status) throw new RangeError(`unknown core proof status ${index}`);
  return status;
}

export function decodeCoreProofAccount(data: Uint8Array): CoreProofAccount {
  if (!bytesEqual(data.subarray(0, 8), CORE_PROOF_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_core ProofRecord account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: CoreProofAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    proofId: reader.hex(16),
    authority: reader.pubkey(),
    contentHash: reader.hex(32),
    contextHash: reader.hex(32),
    kind: coreProofKindFromIndex(reader.u8()),
    status: coreProofStatusFromIndex(reader.u8()),
    createdAt: reader.i64(),
    revokedAt: reader.i64(),
  };
  reader.skip(64); // reserved
  if (reader.remaining !== 0) throw new RangeError("core proof has trailing bytes");
  return account;
}

/** An absent context commitment is all zeroes, which is not a real hash. */
export function hasCoreContextCommitment(account: CoreProofAccount): boolean {
  return !/^0+$/.test(account.contextHash);
}
