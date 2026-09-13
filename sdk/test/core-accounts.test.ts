import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_PROOF_DISCRIMINATOR,
  COMMERCE_AGREEMENT_DISCRIMINATOR,
  decodeCommerceAgreementAccount,
  decodeCoreProofAccount,
  hasCoreContextCommitment,
} from "../src/index.js";
import { walletFromByte } from "./helpers/ppv-events.js";
import { decodeBase58 } from "../src/reputation/base58.js";

/**
 * `ppv_core`'s `ProofRecord`, decoded from the layout the program declares.
 *
 * The decoder's job is not only to read the fields but to refuse bytes that are
 * not a ProofRecord. Account identity is the pair (owning program,
 * discriminator): a discriminator says what an account claims to be, and only
 * its owner says whose it is. So the cases that matter are the ones where the
 * bytes almost work — a Commerce agreement, a truncated account, an enum index
 * the program cannot have written.
 */

// 8 discriminator + schema, bump, proof id, authority, content hash,
// context hash, kind, status, created_at, revoked_at, reserved.
const PROOF_LEN = 8 + 1 + 1 + 16 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 64;

function proofBytes(
  overrides: {
    authority?: string;
    contentHash?: number;
    contextHash?: number;
    kind?: number;
    status?: number;
    createdAt?: bigint;
    revokedAt?: bigint;
    discriminator?: Uint8Array;
  } = {},
): Uint8Array {
  const data = Buffer.alloc(PROOF_LEN);
  Buffer.from(overrides.discriminator ?? CORE_PROOF_DISCRIMINATOR).copy(data, 0);
  data[8] = 1; // schema version
  data[9] = 254; // bump
  data.fill(7, 10, 26); // proof id
  Buffer.from(decodeBase58(overrides.authority ?? walletFromByte(1))).copy(data, 26);
  data.fill(overrides.contentHash ?? 9, 58, 90);
  data.fill(overrides.contextHash ?? 0, 90, 122);
  data[122] = overrides.kind ?? 0;
  data[123] = overrides.status ?? 0;
  data.writeBigInt64LE(overrides.createdAt ?? 1_757_000_000n, 124);
  data.writeBigInt64LE(overrides.revokedAt ?? 0n, 132);
  return new Uint8Array(data);
}

test("a ProofRecord decodes to the fields the program wrote", () => {
  const authority = walletFromByte(5);
  const account = decodeCoreProofAccount(proofBytes({ authority, kind: 2, status: 0 }));

  assert.equal(account.schemaVersion, 1);
  assert.equal(account.bump, 254);
  assert.equal(account.proofId, "07".repeat(16));
  assert.equal(account.authority, authority);
  assert.equal(account.contentHash, "09".repeat(32));
  assert.equal(account.contextHash, "00".repeat(32));
  assert.equal(account.kind, "Agreement");
  assert.equal(account.status, "Active");
  assert.equal(account.createdAt, 1_757_000_000);
  assert.equal(account.revokedAt, 0);
});

test("a revoked proof keeps its revocation timestamp", () => {
  const account = decodeCoreProofAccount(proofBytes({ status: 1, revokedAt: 1_757_000_500n }));
  assert.equal(account.status, "Revoked");
  assert.equal(account.revokedAt, 1_757_000_500);
});

test("an absent context commitment is all zeroes, and reported as absent", () => {
  assert.equal(hasCoreContextCommitment(decodeCoreProofAccount(proofBytes({ contextHash: 0 }))), false);
  assert.equal(hasCoreContextCommitment(decodeCoreProofAccount(proofBytes({ contextHash: 3 }))), true);
});

test("bytes that are not a ProofRecord are refused rather than misread", () => {
  assert.throws(
    () => decodeCoreProofAccount(proofBytes({ discriminator: COMMERCE_AGREEMENT_DISCRIMINATOR })),
    /not a ppv_core ProofRecord account/,
  );
  // Truncated: the reader must not invent the fields it did not receive.
  assert.throws(() => decodeCoreProofAccount(proofBytes().subarray(0, PROOF_LEN - 8)), RangeError);
  // Trailing bytes mean a layout this decoder does not know.
  assert.throws(
    () => decodeCoreProofAccount(new Uint8Array([...proofBytes(), 0])),
    /trailing bytes/,
  );
});

test("an enum index the program cannot have written is refused", () => {
  assert.throws(() => decodeCoreProofAccount(proofBytes({ kind: 9 })), /unknown core proof kind 9/);
  assert.throws(
    () => decodeCoreProofAccount(proofBytes({ status: 7 })),
    /unknown core proof status 7/,
  );
});

test("Core and Commerce accounts cannot be decoded as each other", () => {
  // The two programs deliberately named their accounts differently, so their
  // discriminators differ. This is the check that keeps it that way.
  assert.notDeepEqual([...CORE_PROOF_DISCRIMINATOR], [...COMMERCE_AGREEMENT_DISCRIMINATOR]);
  assert.throws(
    () => decodeCommerceAgreementAccount(proofBytes()),
    /not a ppv_commerce Agreement account/,
  );
});
