import { anchorDiscriminator } from "../reputation/hashing.js";
import { BorshReader, assertOnlyUnwrittenSpaceRemains, bytesEqual } from "../escrow/reader.js";

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
 * `ppv_commerce`'s account is `Agreement`; `ppv_escrow`'s is `EscrowAgreement`.
 * They used to share a name, and therefore a discriminator, because Anchor
 * derives one from the name alone — so escrow bytes reached this decoder and
 * were rejected only by their length. The escrow side renamed, since
 * `ppv_commerce` holds a permanent identity and nothing in escrow is deployed.
 *
 * Account identity is still the pair (owning program, discriminator): a
 * discriminator says what an account claims to be, and only its owner says
 * whose it is. `scripts/test/discriminators.test.mjs` fails if any two programs
 * pick the same name again.
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
  assertOnlyUnwrittenSpaceRemains(reader, "commerce agreement");
  return account;
}

export function commerceStateFromIndex(index: number): CommerceAgreementState {
  const state = COMMERCE_AGREEMENT_STATES[index];
  if (!state) throw new RangeError(`unknown commerce agreement state ${index}`);
  return state;
}
