import { anchorDiscriminator } from "../reputation/hashing.js";
import { BorshReader, bytesEqual } from "../escrow/reader.js";

/**
 * Decoder for `ppv_commerce`'s `Agreement` — the negotiated document, not the
 * escrow. Mirrors `programs/ppv_commerce/src/state.rs` field by field.
 *
 * Negotiation and custody live in separate programs with separate accounts, and
 * this decoder exists so a client can hold both and check that they agree. It
 * does not make one depend on the other.
 */

export const COMMERCE_AGREEMENT_STATES = ["Pending", "Executed", "Cancelled"] as const;
export type CommerceAgreementState = (typeof COMMERCE_AGREEMENT_STATES)[number];

export type CommerceSignature = {
  signer: string;
  versionSigned: number;
  contentHashSigned: string;
  termsHashSigned: string;
  signedAt: number;
};

export type CommerceAgreementAccount = {
  schemaVersion: number;
  bump: number;
  agreementId: string;
  partyA: string;
  partyB: string;
  version: number;
  contentHash: string;
  termsHash: string;
  /** Present only for the *current* version: a revision clears both. */
  signatureA: CommerceSignature | null;
  signatureB: CommerceSignature | null;
  state: CommerceAgreementState;
  createdAt: number;
  expiresAt: number;
  executedAt: number;
  cancelledAt: number;
};

export const COMMERCE_AGREEMENT_DISCRIMINATOR = anchorDiscriminator("account", "Agreement");

function readSignature(reader: BorshReader): CommerceSignature | null {
  const tag = reader.u8();
  if (tag === 0) return null;
  if (tag !== 1) throw new RangeError("invalid Option tag");
  return {
    signer: reader.pubkey(),
    versionSigned: reader.u32(),
    contentHashSigned: reader.hex(32),
    termsHashSigned: reader.hex(32),
    signedAt: reader.i64(),
  };
}

/**
 * `ppv_commerce` and `ppv_escrow` both call their account `Agreement`, so both
 * discriminators are identical — the same collision the events have, for the
 * same reason. Account identity is the pair (owning program, discriminator),
 * and the caller has to know which program's account it fetched.
 */
export function decodeCommerceAgreementAccount(data: Uint8Array): CommerceAgreementAccount {
  if (!bytesEqual(data.subarray(0, 8), COMMERCE_AGREEMENT_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_commerce Agreement account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: CommerceAgreementAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    agreementId: reader.hex(16),
    partyA: reader.pubkey(),
    partyB: reader.pubkey(),
    version: reader.u32(),
    contentHash: reader.hex(32),
    termsHash: reader.hex(32),
    signatureA: readSignature(reader),
    signatureB: readSignature(reader),
    state: commerceStateFromIndex(reader.u8()),
    createdAt: reader.i64(),
    expiresAt: reader.i64(),
    executedAt: reader.i64(),
    cancelledAt: reader.i64(),
  };
  reader.skip(64); // reserved
  if (reader.remaining !== 0) throw new RangeError("commerce agreement has trailing bytes");
  return account;
}

export function commerceStateFromIndex(index: number): CommerceAgreementState {
  const state = COMMERCE_AGREEMENT_STATES[index];
  if (!state) throw new RangeError(`unknown commerce agreement state ${index}`);
  return state;
}
