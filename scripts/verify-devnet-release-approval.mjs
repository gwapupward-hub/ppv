import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PERMANENT_PROGRAM_IDS = Object.freeze({
  ppv_core: "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU",
  ppv_commerce: "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3",
});

const EXPECTED_SQUADS_VAULT_PDA = "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX";

const EXPECTED_SQUADS_MEMBERS = Object.freeze([
  "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
  "2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
].sort());

const DEFAULT_POLICY = Object.freeze({
  programIds: PERMANENT_PROGRAM_IDS,
  squadsVaultPda: EXPECTED_SQUADS_VAULT_PDA,
  squadsMembers: EXPECTED_SQUADS_MEMBERS,
  squadsThreshold: "2",
});

function fail(message) {
  throw new Error(message);
}

function requireValue(value, name) {
  if (!value) fail(`${name} is required.`);
  return value;
}

export function decodeBase58(input) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;

  for (const char of input) {
    const index = alphabet.indexOf(char);
    if (index === -1) fail(`Invalid base58 character in public key: ${char}`);
    num = num * 58n + BigInt(index);
  }

  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();

  let leadingZeroes = 0;
  for (const char of input) {
    if (char !== "1") break;
    leadingZeroes++;
  }

  return Buffer.concat([Buffer.alloc(leadingZeroes), Buffer.from(bytes)]);
}

export function publicKeyFromSolanaBase58(value) {
  const raw = decodeBase58(value);
  if (raw.length !== 32) {
    fail(`Approval public key ${value} did not decode to 32 bytes.`);
  }

  // DER SubjectPublicKeyInfo prefix for Ed25519 public keys.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, raw]),
    format: "der",
    type: "spki",
  });
}

export function releaseMessage({ program, programId, commit }) {
  return (
    "PPV_DEVNET_RELEASE_V1\n" +
    `program=${program}\n` +
    `program_id=${programId}\n` +
    `commit=${commit}\n` +
    "cluster=devnet"
  );
}

export function verifySignature(publicKeyBase58, signatureBase64, message) {
  // Node's decoder intentionally tolerates malformed input, which is
  // inappropriate for an approval artifact. Require canonical standard Base64.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signatureBase64)) {
    fail("Approval signature is not canonical standard base64.");
  }

  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) {
    fail(`Approval signature must decode to exactly 64 bytes; got ${signature.length}.`);
  }

  return crypto.verify(
    null,
    Buffer.from(message, "utf8"),
    publicKeyFromSolanaBase58(publicKeyBase58),
    signature,
  );
}

function checkedOutCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    fail("Could not determine the checked-out Git commit.");
  }
}

export function verifyDevnetReleaseApproval(input, policy = DEFAULT_POLICY) {
  const program = requireValue(input.program, "PPV_RELEASE_PROGRAM");
  const programId = requireValue(input.programId, "PPV_RELEASE_PROGRAM_ID");
  const commit = requireValue(input.commit, "PPV_RELEASE_COMMIT");
  const configuredVault = requireValue(input.configuredVault, "PPV_SQUADS_VAULT_PDA");
  const configuredThreshold = requireValue(input.configuredThreshold, "PPV_SQUADS_THRESHOLD");
  const memberList = requireValue(input.memberList, "PPV_SQUADS_MEMBER_PUBKEYS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  const approval1Key = requireValue(input.approval1Key, "PPV_RELEASE_APPROVER_1");
  const approval1Signature = requireValue(input.approval1Signature, "PPV_RELEASE_SIGNATURE_1");
  const approval2Key = requireValue(input.approval2Key, "PPV_RELEASE_APPROVER_2");
  const approval2Signature = requireValue(input.approval2Signature, "PPV_RELEASE_SIGNATURE_2");
  const actualCommit = requireValue(input.actualCommit, "checked-out Git commit");

  if (!Object.hasOwn(policy.programIds, program)) {
    fail(`Unsupported release program: ${program}`);
  }
  if (programId !== policy.programIds[program]) {
    fail(`PPV_RELEASE_PROGRAM_ID does not match the permanent ${program} identity.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    fail("PPV_RELEASE_COMMIT must be an exact 40-character Git commit SHA.");
  }
  if (commit.toLowerCase() !== actualCommit.toLowerCase()) {
    fail("PPV_RELEASE_COMMIT does not match the checked-out Git commit.");
  }
  if (configuredVault !== policy.squadsVaultPda) {
    fail("PPV_SQUADS_VAULT_PDA does not match the approved PPV Squads Vault PDA.");
  }
  if (configuredThreshold !== policy.squadsThreshold) {
    fail(`PPV_SQUADS_THRESHOLD must be exactly ${policy.squadsThreshold} for the PPV 2-of-3 policy.`);
  }

  const expectedMembers = [...policy.squadsMembers].sort();
  if (
    memberList.length !== expectedMembers.length ||
    new Set(memberList).size !== memberList.length ||
    memberList.some((member, index) => member !== expectedMembers[index])
  ) {
    fail("Configured Squads members do not match the approved PPV 2-of-3 member set.");
  }
  if (!memberList.includes(approval1Key)) {
    fail("Approver 1 is not a configured Squads member.");
  }
  if (!memberList.includes(approval2Key)) {
    fail("Approver 2 is not a configured Squads member.");
  }
  if (approval1Key === approval2Key) {
    fail("Release approvals must come from two distinct Squads members.");
  }

  const message = releaseMessage({ program, programId, commit });
  if (!verifySignature(approval1Key, approval1Signature, message)) {
    fail("Approver 1 signature is invalid.");
  }
  if (!verifySignature(approval2Key, approval2Signature, message)) {
    fail("Approver 2 signature is invalid.");
  }

  return { program, programId, commit, approver1: approval1Key, approver2: approval2Key };
}

function main() {
  const result = verifyDevnetReleaseApproval({
    program: process.env.PPV_RELEASE_PROGRAM,
    programId: process.env.PPV_RELEASE_PROGRAM_ID,
    commit: process.env.PPV_RELEASE_COMMIT,
    configuredVault: process.env.PPV_SQUADS_VAULT_PDA,
    configuredThreshold: process.env.PPV_SQUADS_THRESHOLD,
    memberList: process.env.PPV_SQUADS_MEMBER_PUBKEYS,
    approval1Key: process.env.PPV_RELEASE_APPROVER_1,
    approval1Signature: process.env.PPV_RELEASE_SIGNATURE_1,
    approval2Key: process.env.PPV_RELEASE_APPROVER_2,
    approval2Signature: process.env.PPV_RELEASE_SIGNATURE_2,
    actualCommit: checkedOutCommit(),
  });

  console.log("PPV devnet release approval verified.");
  console.log(`program=${result.program}`);
  console.log(`program_id=${result.programId}`);
  console.log(`commit=${result.commit}`);
  console.log(`approver_1=${result.approver1}`);
  console.log(`approver_2=${result.approver2}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
