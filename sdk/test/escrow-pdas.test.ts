import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  PdaError,
  createProgramAddress,
  deriveAgreement,
  deriveAgreementAddresses,
  deriveProof,
  isOnCurve,
} from "../src/index.js";

/**
 * The SDK ships no runtime dependencies, so it derives PDAs itself rather than
 * pulling in web3.js. That is only defensible if the derivation is provably the
 * same one the runtime performs — which is what these tests establish, using
 * web3.js as a test-only oracle.
 */

const SEED = new TextEncoder().encode("agreement");

function referenceAddresses(program: PublicKey, creator: PublicKey, agreementId: bigint) {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(agreementId);
  const [agreement, agreementBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), creator.toBytes(), id],
    program,
  );
  const [vaultAuthority, vaultAuthorityBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agreement.toBytes()],
    program,
  );
  const [vault, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), agreement.toBytes()],
    program,
  );
  return {
    agreement: agreement.toBase58(),
    agreementBump,
    vaultAuthority: vaultAuthority.toBase58(),
    vaultAuthorityBump,
    vault: vault.toBase58(),
    vaultBump,
  };
}

test("agreement, vault authority, and vault match the runtime derivation", () => {
  for (let i = 0; i < 64; i += 1) {
    const program = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const agreementId = BigInt(Math.floor(Math.random() * 2 ** 32));
    assert.deepEqual(
      deriveAgreementAddresses(program.toBase58(), creator.toBase58(), agreementId),
      referenceAddresses(program, creator, agreementId),
    );
  }
});

test("the curve check accepts real keys and rejects the addresses PDAs must be", () => {
  for (let i = 0; i < 64; i += 1) {
    assert.equal(isOnCurve(Keypair.generate().publicKey.toBytes()), true);
  }
  const program = Keypair.generate().publicKey;
  const { address } = deriveAgreement(program.toBase58(), Keypair.generate().publicKey.toBase58(), 1n);
  assert.equal(isOnCurve(new PublicKey(address).toBytes()), false);
});

test("boundary agreement ids derive, and out-of-range ids are refused", () => {
  const program = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  for (const agreementId of [0n, 1n, 2n ** 63n, 2n ** 64n - 1n]) {
    assert.deepEqual(
      deriveAgreementAddresses(program.toBase58(), creator.toBase58(), agreementId),
      referenceAddresses(program, creator, agreementId),
    );
  }
  assert.throws(() => deriveAgreement(program.toBase58(), creator.toBase58(), -1n), PdaError);
  assert.throws(() => deriveAgreement(program.toBase58(), creator.toBase58(), 2n ** 64n), PdaError);
});

test("the same creator's ids are distinct, and two creators never collide on one id", () => {
  const program = Keypair.generate().publicKey.toBase58();
  const alice = Keypair.generate().publicKey.toBase58();
  const bob = Keypair.generate().publicKey.toBase58();

  // Invariant 8: an agreement id can never silently name another creator's
  // agreement, because the creator is in the seeds.
  assert.notEqual(deriveAgreement(program, alice, 1n).address, deriveAgreement(program, bob, 1n).address);
  assert.notEqual(deriveAgreement(program, alice, 1n).address, deriveAgreement(program, alice, 2n).address);
});

test("a different program id is a different namespace for every address", () => {
  const creator = Keypair.generate().publicKey.toBase58();
  const first = deriveAgreementAddresses(Keypair.generate().publicKey.toBase58(), creator, 7n);
  const second = deriveAgreementAddresses(Keypair.generate().publicKey.toBase58(), creator, 7n);
  assert.notEqual(first.agreement, second.agreement);
  assert.notEqual(first.vault, second.vault);
  assert.notEqual(first.vaultAuthority, second.vaultAuthority);
});

test("seed limits are enforced the way the runtime enforces them", () => {
  const program = Keypair.generate().publicKey.toBase58();
  assert.throws(() => createProgramAddress([new Uint8Array(33)], program), /seed longer than 32/);
  assert.throws(
    () => createProgramAddress(Array.from({ length: 17 }, () => SEED), program),
    /too many seeds/,
  );
});

test("a proof address is bound to its agreement and index", () => {
  const program = Keypair.generate().publicKey;
  const agreement = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;

  const index = Buffer.alloc(4);
  index.writeUInt32LE(3);
  const [reference, referenceBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), agreement.toBytes(), index],
    program,
  );
  const mine = deriveProof(program.toBase58(), agreement.toBase58(), 3);
  assert.equal(mine.address, reference.toBase58());
  assert.equal(mine.bump, referenceBump);

  // Invariant 11: the same index under another agreement is another address,
  // so a proof cannot be presented for an agreement it was not anchored to.
  assert.notEqual(deriveProof(program.toBase58(), other.toBase58(), 3).address, mine.address);
  assert.notEqual(deriveProof(program.toBase58(), agreement.toBase58(), 4).address, mine.address);

  assert.throws(() => deriveProof(program.toBase58(), agreement.toBase58(), -1), PdaError);
  assert.throws(() => deriveProof(program.toBase58(), agreement.toBase58(), 2 ** 32), PdaError);
});
