import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  COMMERCE_AGREEMENT_DISCRIMINATOR,
  AGREEMENT_ACCOUNT_DISCRIMINATOR,
  decodeCommerceAgreementAccount,
  decodeBase58,
  verifyTermsBinding,
  type CommerceAgreementAccount,
  type CommerceSignature,
} from "../src/index.js";
import { addressFromByte, hexFromByte } from "./helpers/escrow-events.js";

const TERMS = hexFromByte(7, 32);
const CONTENT = hexFromByte(6, 32);
const PARTY_A = addressFromByte(1);
const PARTY_B = addressFromByte(2);

function signature(signer: string, overrides?: Partial<CommerceSignature>): CommerceSignature {
  return {
    signer,
    versionSigned: 3,
    contentHashSigned: CONTENT,
    termsHashSigned: TERMS,
    signedAt: 1_700_000_000,
    ...overrides,
  };
}

function contract(overrides?: Partial<CommerceAgreementAccount>): CommerceAgreementAccount {
  return {
    schemaVersion: 1,
    bump: 254,
    agreementId: hexFromByte(5, 16),
    partyA: PARTY_A,
    partyB: PARTY_B,
    version: 3,
    contentHash: CONTENT,
    termsHash: TERMS,
    signatureA: signature(PARTY_A),
    signatureB: signature(PARTY_B),
    state: "Executed",
    createdAt: 1_699_000_000,
    expiresAt: 1_800_000_000,
    executedAt: 1_700_000_000,
    cancelledAt: 0,
    ...overrides,
  };
}

const escrow = { creator: PARTY_A, counterparty: PARTY_B, termsHash: TERMS };

function encodeCommerceAgreement(account: CommerceAgreementAccount): Uint8Array {
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
  const option = (value: CommerceSignature | null) =>
    value === null
      ? Buffer.from([0])
      : Buffer.concat([
          Buffer.from([1]),
          pubkey(value.signer),
          u32(value.versionSigned),
          Buffer.from(value.contentHashSigned, "hex"),
          Buffer.from(value.termsHashSigned, "hex"),
          i64(value.signedAt),
        ]);

  return Uint8Array.from(
    Buffer.concat([
      Buffer.from(COMMERCE_AGREEMENT_DISCRIMINATOR),
      Buffer.from([account.schemaVersion, account.bump]),
      Buffer.from(account.agreementId, "hex"),
      pubkey(account.partyA),
      pubkey(account.partyB),
      u32(account.version),
      Buffer.from(account.contentHash, "hex"),
      Buffer.from(account.termsHash, "hex"),
      option(account.signatureA),
      option(account.signatureB),
      Buffer.from([["Pending", "Executed", "Cancelled"].indexOf(account.state)]),
      i64(account.createdAt),
      i64(account.expiresAt),
      i64(account.executedAt),
      i64(account.cancelledAt),
      Buffer.alloc(64),
    ]),
  );
}

test("a commerce agreement round-trips, signatures and all", () => {
  const encoded = encodeCommerceAgreement(contract());
  assert.deepEqual(decodeCommerceAgreementAccount(encoded), contract());

  const unsigned = contract({ signatureA: null, signatureB: null, state: "Pending" });
  assert.deepEqual(decodeCommerceAgreementAccount(encodeCommerceAgreement(unsigned)), unsigned);
});

test("both programs call their account Agreement, so the discriminators collide", () => {
  // The same collision the events have, for the same reason: Anchor derives it
  // from the name. Account identity is (owning program, discriminator), and the
  // caller has to know which program's account it fetched.
  assert.deepEqual(
    Buffer.from(COMMERCE_AGREEMENT_DISCRIMINATOR),
    Buffer.from(AGREEMENT_ACCOUNT_DISCRIMINATOR),
  );
  assert.deepEqual(
    Buffer.from(COMMERCE_AGREEMENT_DISCRIMINATOR),
    createHash("sha256").update("account:Agreement").digest().subarray(0, 8),
  );
});

test("an executed contract signed by both parties binds its escrow", () => {
  assert.deepEqual(verifyTermsBinding({ escrow, contract: contract() }), {
    bound: true,
    reasons: [],
  });
  // Which party created the escrow does not matter; both are parties to both.
  assert.equal(
    verifyTermsBinding({
      escrow: { creator: PARTY_B, counterparty: PARTY_A, termsHash: TERMS },
      contract: contract(),
    }).bound,
    true,
  );
});

test("a different terms hash is not a binding", () => {
  const result = verifyTermsBinding({
    escrow: { ...escrow, termsHash: hexFromByte(99, 32) },
    contract: contract(),
  });
  assert.equal(result.bound, false);
  assert.match(result.reasons.join(" "), /terms hash does not match/);
});

test("an unexecuted or half-signed contract binds nothing", () => {
  const pending = verifyTermsBinding({
    escrow,
    contract: contract({ state: "Pending", signatureB: null }),
  });
  assert.equal(pending.bound, false);
  assert.match(pending.reasons.join(" "), /is Pending, not Executed/);
  assert.match(pending.reasons.join(" "), /party B has not signed/);

  const cancelled = verifyTermsBinding({ escrow, contract: contract({ state: "Cancelled" }) });
  assert.equal(cancelled.bound, false);
});

test("a stale signature is not acceptance of these terms", () => {
  // The program clears signatures on every revision, so this cannot arise from
  // ppv_commerce itself. Checking anyway keeps the binding sound on its own.
  const result = verifyTermsBinding({
    escrow,
    contract: contract({ signatureA: signature(PARTY_A, { versionSigned: 2 }) }),
  });
  assert.equal(result.bound, false);
  assert.match(result.reasons.join(" "), /signed version 2, not 3/);

  const wrongHash = verifyTermsBinding({
    escrow,
    contract: contract({
      signatureB: signature(PARTY_B, { termsHashSigned: hexFromByte(98, 32) }),
    }),
  });
  assert.equal(wrongHash.bound, false);
  assert.match(wrongHash.reasons.join(" "), /signed a different terms hash/);
});

test("an escrow between other parties is not bound by this contract", () => {
  const result = verifyTermsBinding({
    escrow: { creator: PARTY_A, counterparty: addressFromByte(40), termsHash: TERMS },
    contract: contract(),
  });
  assert.equal(result.bound, false);
  assert.match(result.reasons.join(" "), /not the contract's parties/);
});

test("two signatures from one wallet are not two parties agreeing", () => {
  const result = verifyTermsBinding({
    escrow,
    contract: contract({ signatureB: signature(PARTY_A) }),
  });
  assert.equal(result.bound, false);
  assert.match(result.reasons.join(" "), /both signatures are from the same wallet/);
});

test("every disagreement is reported, not just the first", () => {
  const result = verifyTermsBinding({
    escrow: { ...escrow, termsHash: hexFromByte(99, 32) },
    contract: contract({ state: "Pending", signatureA: null, signatureB: null }),
  });
  assert.equal(result.bound, false);
  assert.ok(result.reasons.length >= 4, `expected several reasons, got ${result.reasons.length}`);
});
