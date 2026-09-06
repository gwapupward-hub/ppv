import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGREEMENT_ACCOUNT_DISCRIMINATOR,
  AGREEMENT_ACCOUNT_SIZE,
  PROOF_ACCOUNT_DISCRIMINATOR,
  PROOF_ACCOUNT_SIZE,
  decodeAgreementAccount,
  decodeBase58,
  decodeProofAccount,
  type AgreementAccount,
  type ProofAccount,
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
      (() => {
        const out = Buffer.alloc(4);
        out.writeUInt32LE(account.proofCount);
        return out;
      })(),
      Buffer.alloc(60),
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
  proofCount: 2,
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

function encodeProofAccount(account: ProofAccount): Uint8Array {
  const pubkey = (value: string) => Buffer.from(decodeBase58(value));
  const u32 = (value: number) => {
    const out = Buffer.alloc(4);
    out.writeUInt32LE(value);
    return out;
  };
  const i64 = (value: number) => {
    const out = Buffer.alloc(8);
    out.writeBigInt64LE(BigInt(value));
    return out;
  };
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(PROOF_ACCOUNT_DISCRIMINATOR),
      Buffer.from([account.schemaVersion, account.bump]),
      pubkey(account.agreement),
      pubkey(account.submitter),
      u32(account.proofIndex),
      Buffer.from(account.contentHash, "hex"),
      Buffer.from(account.metadataHash, "hex"),
      Buffer.from([0]), // ProofStatus::Submitted
      i64(account.createdAt),
      i64(account.decidedAt),
      pubkey(account.decidedBy),
      Buffer.alloc(32),
    ]),
  );
}

const PROOF_FIXTURE_ACCOUNT: ProofAccount = {
  schemaVersion: 1,
  bump: 250,
  agreement: addressFromByte(5),
  submitter: addressFromByte(2),
  proofIndex: 0,
  contentHash: hexFromByte(12, 32),
  metadataHash: hexFromByte(0, 32),
  status: "Submitted",
  createdAt: 1_700_000_150,
  decidedAt: 0,
  decidedBy: addressFromByte(0),
};

test("a proof account round-trips at the size the program allocates", () => {
  const encoded = encodeProofAccount(PROOF_FIXTURE_ACCOUNT);
  // 8 + Proof::INIT_SPACE, pinned at 215 in the Rust unit tests.
  assert.equal(encoded.length, PROOF_ACCOUNT_SIZE);
  assert.equal(PROOF_ACCOUNT_SIZE, 8 + 215);
  assert.deepEqual(decodeProofAccount(encoded), PROOF_FIXTURE_ACCOUNT);
});

test("an undecided proof reports no decision rather than a stale one", () => {
  const decoded = decodeProofAccount(encodeProofAccount(PROOF_FIXTURE_ACCOUNT));
  assert.equal(decoded.status, "Submitted");
  assert.equal(decoded.decidedAt, 0);
  assert.equal(decoded.decidedBy, addressFromByte(0), "the default address means nobody");
});

test("an agreement account is not decoded as a proof", () => {
  assert.throws(
    () => decodeProofAccount(encodeAgreementAccount(FIXTURE)),
    /not a ppv_escrow Proof account/,
  );
});
