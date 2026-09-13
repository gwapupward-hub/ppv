import assert from "node:assert/strict";
import test from "node:test";

import { COMMERCE_AGREEMENT_DISCRIMINATOR, decodeCommerceAgreementAccount } from "../src/index.js";
import { decodeBase58 } from "../src/reputation/base58.js";
import { walletFromByte } from "./helpers/ppv-events.js";

/**
 * `ppv_commerce`'s `Agreement`, decoded in the states it is actually in.
 *
 * The state that matters here is the ordinary one: pending, with at most one
 * signature. Anchor allocates the account at its declared `INIT_SPACE` and then
 * writes borsh into it, and borsh encodes `Option::None` as a single tag byte
 * while `INIT_SPACE` reserves room for the tag *and* the payload. So a pending
 * agreement is shorter on the wire than the space it occupies, and the tail is
 * never written.
 *
 * A decoder that requires nothing to remain therefore rejects every agreement
 * that is not fully signed — which is most of them, and which is what these
 * tests exist to prevent recurring.
 */

const SIGNATURE_LEN = 32 + 4 + 32 + 32 + 8;
const FIELDS_LEN = 1 + 1 + 16 + 32 + 32 + 4 + 32 + 32;
const TAIL_LEN = 1 + 8 + 8 + 8 + 8 + 64; // state, created, expires, executed, cancelled, reserved
/** What the program allocates: both Options at full width. */
const ALLOCATED = 8 + FIELDS_LEN + 2 * (1 + SIGNATURE_LEN) + TAIL_LEN;

function agreementBytes({
  signatureA,
  signatureB,
  state = 0,
  trailingByte,
}: {
  signatureA?: string;
  signatureB?: string;
  state?: number;
  trailingByte?: number;
}): Uint8Array {
  const data = Buffer.alloc(ALLOCATED);
  let offset = 0;
  const put = (bytes: Uint8Array | Buffer) => {
    Buffer.from(bytes).copy(data, offset);
    offset += bytes.length;
  };

  put(COMMERCE_AGREEMENT_DISCRIMINATOR);
  data[offset++] = 1; // schema version
  data[offset++] = 253; // bump
  data.fill(0x11, offset, offset + 16);
  offset += 16;
  put(decodeBase58(walletFromByte(1))); // party A
  put(decodeBase58(walletFromByte(2))); // party B
  data.writeUInt32LE(1, offset);
  offset += 4;
  data.fill(0x22, offset, offset + 32); // content hash
  offset += 32;
  data.fill(0x33, offset, offset + 32); // terms hash
  offset += 32;

  const putSignature = (signer?: string) => {
    if (!signer) {
      data[offset++] = 0; // None: one byte, and nothing else
      return;
    }
    data[offset++] = 1;
    put(decodeBase58(signer));
    data.writeUInt32LE(1, offset);
    offset += 4;
    data.fill(0x22, offset, offset + 32);
    offset += 32;
    data.fill(0x33, offset, offset + 32);
    offset += 32;
    data.writeBigInt64LE(1_757_000_100n, offset);
    offset += 8;
  };
  putSignature(signatureA);
  putSignature(signatureB);

  data[offset++] = state;
  for (const value of [1_757_000_000n, 1_757_900_000n, 0n, 0n]) {
    data.writeBigInt64LE(value, offset);
    offset += 8;
  }
  offset += 64; // reserved, already zero

  if (trailingByte !== undefined) data[offset] = trailingByte;
  return new Uint8Array(data);
}

test("a pending agreement with no signatures decodes", () => {
  // The state every agreement starts in. Nothing about it is exceptional, and
  // a decoder that cannot read it cannot read the chain.
  const account = decodeCommerceAgreementAccount(agreementBytes({}));
  assert.equal(account.state, "Pending");
  assert.equal(account.signatureA, null);
  assert.equal(account.signatureB, null);
  assert.equal(account.partyA, walletFromByte(1));
  assert.equal(account.partyB, walletFromByte(2));
  assert.equal(account.termsHash, "33".repeat(32));
});

test("a pending agreement with one signature decodes", () => {
  // Half-signed: one Option written, one not. This is the shape that the
  // strict trailing-bytes rule rejected.
  const account = decodeCommerceAgreementAccount(
    agreementBytes({ signatureA: walletFromByte(1) }),
  );
  assert.equal(account.state, "Pending");
  assert.equal(account.signatureA?.signer, walletFromByte(1));
  assert.equal(account.signatureA?.termsHashSigned, "33".repeat(32));
  assert.equal(account.signatureB, null);
});

test("a second signature that is not the first party decodes too", () => {
  const account = decodeCommerceAgreementAccount(
    agreementBytes({ signatureB: walletFromByte(2) }),
  );
  assert.equal(account.signatureA, null);
  assert.equal(account.signatureB?.signer, walletFromByte(2));
});

test("a fully executed agreement decodes, and fills its allocation", () => {
  const bytes = agreementBytes({
    signatureA: walletFromByte(1),
    signatureB: walletFromByte(2),
    state: 1,
  });
  const account = decodeCommerceAgreementAccount(bytes);
  assert.equal(account.state, "Executed");
  assert.notEqual(account.signatureA!.signer, account.signatureB!.signer);
  assert.equal(bytes.length, ALLOCATED);
});

test("content after the known fields is refused", () => {
  // Unwritten space is zero. A non-zero byte past the fields this decoder
  // knows means a layout it does not, and must not be read as one it does.
  assert.throws(
    () => decodeCommerceAgreementAccount(agreementBytes({ trailingByte: 9 })),
    /commerce agreement has trailing bytes/,
  );
});

test("bytes that are not an Agreement are refused", () => {
  const bytes = agreementBytes({});
  // Corrupt the discriminator: the account now claims to be something else.
  bytes[0] = (bytes[0] as number) ^ 0xff;
  assert.throws(
    () => decodeCommerceAgreementAccount(bytes),
    /not a ppv_commerce Agreement account/,
  );
});
