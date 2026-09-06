import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGREEMENT_ACCOUNT_DISCRIMINATOR,
  AGREEMENT_ACCOUNT_SIZE,
  decodeAgreementAccount,
  decodeBase58,
  type AgreementAccount,
} from "../src/index.js";
import { addressFromByte, hexFromByte } from "./helpers/escrow-events.js";

/** Mirrors `Agreement` in programs/ppv_escrow/src/state/agreement.rs. */
function encodeAgreementAccount(account: AgreementAccount): Uint8Array {
  const pubkey = (value: string) => Buffer.from(decodeBase58(value));
  const u64 = (value: bigint) => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(value);
    return out;
  };
  const i64 = (value: number) => {
    const out = Buffer.alloc(8);
    out.writeBigInt64LE(BigInt(value));
    return out;
  };
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(AGREEMENT_ACCOUNT_DISCRIMINATOR),
      Buffer.from([account.schemaVersion, account.bump, account.vaultAuthorityBump, account.vaultBump]),
      pubkey(account.creator),
      pubkey(account.counterparty),
      u64(account.agreementId),
      Buffer.from([0]), // AgreementType::Escrow
      pubkey(account.mint),
      pubkey(account.vault),
      u64(account.amount),
      Buffer.from(account.termsHash, "hex"),
      Buffer.from([3]), // AgreementState::Settled
      i64(account.createdAt),
      i64(account.fundedAt),
      i64(account.completedAt),
      i64(account.settledAt),
      Buffer.alloc(64),
    ]),
  );
}

const FIXTURE: AgreementAccount = {
  schemaVersion: 1,
  bump: 254,
  vaultAuthorityBump: 253,
  vaultBump: 252,
  creator: addressFromByte(1),
  counterparty: addressFromByte(2),
  agreementId: 42n,
  agreementType: "Escrow",
  mint: addressFromByte(3),
  vault: addressFromByte(4),
  amount: 100_000_000n,
  termsHash: hexFromByte(7, 32),
  state: "Settled",
  createdAt: 1_700_000_000,
  fundedAt: 1_700_000_100,
  completedAt: 1_700_000_200,
  settledAt: 1_700_000_300,
};

test("the account discriminator is the anchor derivation", () => {
  assert.deepEqual(
    Buffer.from(AGREEMENT_ACCOUNT_DISCRIMINATOR),
    createHash("sha256").update("account:Agreement").digest().subarray(0, 8),
  );
});

test("an agreement account round-trips at the size the program allocates", () => {
  const encoded = encodeAgreementAccount(FIXTURE);
  // 8 + Agreement::INIT_SPACE, pinned at 278 in the Rust unit tests.
  assert.equal(encoded.length, AGREEMENT_ACCOUNT_SIZE);
  assert.equal(AGREEMENT_ACCOUNT_SIZE, 8 + 278);
  assert.deepEqual(decodeAgreementAccount(encoded), FIXTURE);
});

test("another program's account is refused rather than reinterpreted", () => {
  const foreign = encodeAgreementAccount(FIXTURE);
  foreign.set(createHash("sha256").update("account:Proof").digest().subarray(0, 8), 0);
  assert.throws(() => decodeAgreementAccount(foreign), /not a ppv_escrow Agreement account/);
});

test("a truncated or over-long account is refused", () => {
  const encoded = encodeAgreementAccount(FIXTURE);
  assert.throws(() => decodeAgreementAccount(encoded.subarray(0, encoded.length - 1)), /truncated/);
  assert.throws(() => decodeAgreementAccount(Uint8Array.from([...encoded, 0])), /trailing bytes/);
});
