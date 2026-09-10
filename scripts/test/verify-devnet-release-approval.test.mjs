import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  releaseMessage,
  verifyDevnetReleaseApproval,
} from "../verify-devnet-release-approval.mjs";

const COMMIT = "a".repeat(40);
const PROGRAM_ID = "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeroes++;
  }

  return "1".repeat(leadingZeroes) + (encoded || "");
}

function signer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, base58: encodeBase58(der.subarray(-32)) };
}

const signer1 = signer();
const signer2 = signer();
const signer3 = signer();
const policy = {
  programIds: { ppv_core: PROGRAM_ID },
  squadsVaultPda: "VaultPdaTestValue",
  squadsMembers: [signer1.base58, signer2.base58, signer3.base58].sort(),
  squadsThreshold: "2",
};

function validInput() {
  const message = releaseMessage({
    program: "ppv_core",
    programId: PROGRAM_ID,
    commit: COMMIT,
  });

  return {
    program: "ppv_core",
    programId: PROGRAM_ID,
    commit: COMMIT,
    actualCommit: COMMIT,
    configuredVault: policy.squadsVaultPda,
    configuredThreshold: "2",
    memberList: policy.squadsMembers.join(","),
    approval1Key: signer1.base58,
    approval1Signature: crypto.sign(null, Buffer.from(message), signer1.privateKey).toString("base64"),
    approval2Key: signer2.base58,
    approval2Signature: crypto.sign(null, Buffer.from(message), signer2.privateKey).toString("base64"),
  };
}

test("accepts two distinct valid approvals from the configured 2-of-3 set", () => {
  const result = verifyDevnetReleaseApproval(validInput(), policy);
  assert.equal(result.program, "ppv_core");
  assert.equal(result.programId, PROGRAM_ID);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.approver1, signer1.base58);
  assert.equal(result.approver2, signer2.base58);
});

test("rejects a duplicated approver even if its signature is otherwise valid", () => {
  const input = validInput();
  input.approval2Key = input.approval1Key;
  input.approval2Signature = input.approval1Signature;

  assert.throws(
    () => verifyDevnetReleaseApproval(input, policy),
    /two distinct Squads members/,
  );
});

test("rejects a program ID that is not the permanent selected-program identity", () => {
  const input = validInput();
  input.programId = "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3";

  assert.throws(
    () => verifyDevnetReleaseApproval(input, policy),
    /does not match the permanent ppv_core identity/,
  );
});

test("rejects a signature replayed against a different commit", () => {
  const input = validInput();
  input.commit = "b".repeat(40);
  input.actualCommit = input.commit;

  assert.throws(
    () => verifyDevnetReleaseApproval(input, policy),
    /Approver 1 signature is invalid/,
  );
});

test("rejects configured authority drift before signature verification", () => {
  const input = validInput();
  input.configuredVault = "UnapprovedVaultPda";

  assert.throws(
    () => verifyDevnetReleaseApproval(input, policy),
    /does not match the approved PPV Squads Vault PDA/,
  );
});

test("rejects noncanonical Base64 approval artifacts", () => {
  const input = validInput();
  input.approval1Signature = `${input.approval1Signature}\n`;

  assert.throws(
    () => verifyDevnetReleaseApproval(input, policy),
    /not canonical standard base64/,
  );
});
