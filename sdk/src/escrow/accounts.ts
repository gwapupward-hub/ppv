import { anchorDiscriminator } from "../reputation/hashing.js";
import { BorshReader, bytesEqual } from "./reader.js";
import type { AgreementState, AgreementType } from "./states.js";

/** Mirrors `Agreement` in `programs/ppv_escrow/src/state/agreement.rs`. */
export type AgreementAccount = {
  schemaVersion: number;
  bump: number;
  vaultAuthorityBump: number;
  vaultBump: number;
  /** Buyer. */
  creator: string;
  /** Seller. */
  counterparty: string;
  agreementId: bigint;
  agreementType: AgreementType;
  mint: string;
  vault: string;
  amount: bigint;
  termsHash: string;
  state: AgreementState;
  createdAt: number;
  fundedAt: number;
  completedAt: number;
  settledAt: number;
};

export const AGREEMENT_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "Agreement");

/** 8 discriminator + 4 bumps + 2 keys + u64 + type + 2 keys + u64 + hash + state + 4 times + reserved. */
export const AGREEMENT_ACCOUNT_SIZE = 8 + 4 + 32 * 2 + 8 + 1 + 32 * 2 + 8 + 32 + 1 + 8 * 4 + 64;

export function decodeAgreementAccount(data: Uint8Array): AgreementAccount {
  if (!bytesEqual(data.subarray(0, 8), AGREEMENT_ACCOUNT_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_escrow Agreement account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: AgreementAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    vaultAuthorityBump: reader.u8(),
    vaultBump: reader.u8(),
    creator: reader.pubkey(),
    counterparty: reader.pubkey(),
    agreementId: reader.u64(),
    agreementType: reader.agreementType(),
    mint: reader.pubkey(),
    vault: reader.pubkey(),
    amount: reader.u64(),
    termsHash: reader.hex(32),
    state: reader.state(),
    createdAt: reader.i64(),
    fundedAt: reader.i64(),
    completedAt: reader.i64(),
    settledAt: reader.i64(),
  };
  reader.skip(64); // reserved
  if (reader.remaining !== 0) throw new RangeError("agreement account has trailing bytes");
  return account;
}
