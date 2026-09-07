import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import { decodeBase58, isAddress, isOnCurve, isProgramDerived } from "../lib/pubkey.mjs";
import { PERMANENT_PROGRAM_IDS } from "../lib/identity.mjs";

/**
 * The on-curve check decides whether a configured upgrade authority is a real
 * multisig vault or somebody's wallet, so it has to be right rather than
 * plausible. It is implemented without dependencies so the preflight runs
 * before any install; @solana/web3.js is used here purely as an oracle.
 */

test("the curve check agrees with @solana/web3.js on real keys and real PDAs", () => {
  let checked = 0;
  for (let i = 0; i < 64; i += 1) {
    const wallet = Keypair.generate().publicKey;
    assert.equal(isOnCurve(wallet.toBase58()), PublicKey.isOnCurve(wallet.toBytes()));
    assert.equal(isOnCurve(wallet.toBase58()), true, "a wallet public key is on the curve");

    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.of(i)], wallet);
    assert.equal(isOnCurve(pda.toBase58()), PublicKey.isOnCurve(pda.toBytes()));
    assert.equal(isOnCurve(pda.toBase58()), false, "a PDA is off the curve");
    checked += 2;
  }
  assert.equal(checked, 128);
});

test("program-derived means off-curve, and a wallet is never program-derived", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("v")], new PublicKey(wallet));
  assert.equal(isProgramDerived(pda.toBase58()), true);
  assert.equal(isProgramDerived(wallet), false);
});

test("address validation accepts the permanent ids and rejects malformed input", () => {
  for (const id of Object.values(PERMANENT_PROGRAM_IDS)) {
    assert.equal(isAddress(id), true, `${id} must be a valid address`);
    assert.equal(decodeBase58(id).length, 32);
  }
  for (const bad of ["", "not-an-address", "0OIl", "1".repeat(64), "abc"]) {
    assert.equal(isAddress(bad), false, `${bad} must not be a valid address`);
  }
  assert.equal(isAddress(undefined), false);
  assert.equal(isAddress(12345), false);
});

test("base58 decoding round-trips through web3.js", () => {
  for (let i = 0; i < 32; i += 1) {
    const key = Keypair.generate().publicKey;
    assert.deepEqual(Buffer.from(decodeBase58(key.toBase58())), Buffer.from(key.toBytes()));
  }
});
