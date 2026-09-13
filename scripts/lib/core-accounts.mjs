/**
 * Decoding for the accounts ppv_core owns.
 *
 * ppv_core holds exactly one account type. Decoding it here, from the byte
 * layout the program declares, rather than through a generated client, means a
 * live read exercises the same thing an outside integrator has to get right:
 * the account discriminator, the borsh field order, and the enum encodings.
 */

import { createHash } from "node:crypto";

import { encodeBase58 } from "./pubkey.mjs";

/** Anchor's account discriminator: sha256("account:<Name>")[..8]. */
export function accountDiscriminator(name) {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

export const PROOF_RECORD_DISCRIMINATOR = accountDiscriminator("ProofRecord");

export const PROOF_KINDS = ["creation", "document", "agreement", "invoice", "deliverable", "other"];
export const PROOF_STATUSES = ["active", "revoked"];

/** 8 discriminator bytes plus ProofRecord's declared fields. */
export const PROOF_RECORD_LEN = 8 + 1 + 1 + 16 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 64;

export class DecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecodeError";
  }
}

export function decodeProofRecord(bytes) {
  const data = Buffer.from(bytes);
  if (data.length !== PROOF_RECORD_LEN) {
    throw new DecodeError(`ProofRecord is ${data.length} bytes, expected ${PROOF_RECORD_LEN}`);
  }
  if (!data.subarray(0, 8).equals(PROOF_RECORD_DISCRIMINATOR)) {
    throw new DecodeError("account discriminator is not ProofRecord's");
  }

  const hex = (start, length) => data.subarray(start, start + length).toString("hex");
  const kind = PROOF_KINDS[data[122]];
  const status = PROOF_STATUSES[data[123]];
  if (!kind) throw new DecodeError(`unknown proof kind ${data[122]}`);
  if (!status) throw new DecodeError(`unknown proof status ${data[123]}`);

  // Reserved space exists for compatible schema growth; a non-zero byte in it
  // means this account was written by a schema this decoder does not know.
  const reserved = data.subarray(140, PROOF_RECORD_LEN);
  return {
    schemaVersion: data[8],
    bump: data[9],
    proofId: hex(10, 16),
    authority: encodeBase58(data.subarray(26, 58)),
    contentHash: hex(58, 32),
    contextHash: hex(90, 32),
    kind,
    status,
    createdAt: Number(data.readBigInt64LE(124)),
    revokedAt: Number(data.readBigInt64LE(132)),
    reservedIsZero: reserved.every((byte) => byte === 0),
  };
}
