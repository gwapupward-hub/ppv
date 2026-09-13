import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { collect } from "../collect-deployment-evidence.mjs";
import { MAINNET_GENESIS, readDeployedProgram, rpc, signatureStatus } from "../lib/rpc.mjs";
import { checkChain, checkRecord, verify } from "../verify-deployed-program.mjs";
import {
  CORE_ID,
  CORE_PROGRAM_DATA,
  MEMBERS,
  VAULT_PDA,
  deployedCoreFixture,
  makeRpcTransport,
  programAccount,
  programDataAccount,
} from "./helpers.mjs";

/**
 * The signer-free verifier, exercised entirely through an injected JSON-RPC
 * transport.
 *
 * Every case here is a failure somebody could otherwise talk themselves out of:
 * the program is at an address that is not the permanent identity, the upgrade
 * authority is not the Squads vault, the cluster is not the one the record
 * names, the live bytes are not the release bytes. Each must fail for its own
 * stated reason, and none may require a network — a verifier whose negative
 * tests only pass when devnet is reachable proves nothing about the verifier.
 */

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const DEPLOY_SIG = "3A1fMmAZiBfjKb9ijUW81KaqEyZqEtT7vha2Ms2hZanxhjcDaJn4wKJvEwSkDJBK3Co7eJnTyn6wvc2iXaYaAxAp";
const TRANSFER_SIG = "5TX9vvX5ktHE19mDZw5VXkNajZESrPxQZGqxQ26B5pzrLhuVPELTaB8KTsKXCUmpvNzv9FCj2JpHR8Re3jiuTwgj";
const COMMIT = "861a8dfce9533f75494621b8a36e60e60447cc0c";

const okSignatures = {
  [DEPLOY_SIG]: { slot: 497437304, err: null, confirmationStatus: "finalized" },
  [TRANSFER_SIG]: { slot: 497437312, err: null, confirmationStatus: "finalized" },
};

function fixtureRecord(fixture, overrides = {}) {
  return {
    cluster: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    program: "ppv_core",
    programId: CORE_ID,
    programDataAddress: CORE_PROGRAM_DATA,
    releaseCommit: COMMIT,
    deploymentSignature: DEPLOY_SIG,
    authorityTransferSignature: TRANSFER_SIG,
    upgradeAuthority: VAULT_PDA,
    upgradeAuthorityKind: "squads-multisig",
    upgradeAuthorityThreshold: 2,
    upgradeAuthorityMembers: MEMBERS,
    binaryLength: fixture.binary.length,
    binaryHash: sha256(fixture.binary),
    ...overrides,
  };
}

/** Collects the report lines a run produced, so a test can assert on the reason. */
function collector() {
  const lines = [];
  const report = (ok, message) => lines.push(`${ok === false ? "FAIL " : ""}${message}`);
  report.text = () => lines.join("\n");
  return report;
}

async function run(record, transportConfig) {
  const report = collector();
  const failures = await verify(record, {
    endpoints: ["https://stub.invalid"],
    fetchImpl: makeRpcTransport(transportConfig),
    report,
  });
  return { failures, text: report.text() };
}

test("a correct release verifies with no network and no signer", async () => {
  const fixture = deployedCoreFixture();
  const { failures, text } = await run(fixtureRecord(fixture), {
    accounts: fixture.accounts,
    signatures: okSignatures,
  });
  assert.deepEqual(failures, []);
  assert.match(text, /upgrade authority is the recorded Squads vault/);
  assert.match(text, /live binary matches the recorded release binary/);
  assert.match(text, /deployment transaction succeeded/);
  assert.match(text, /authority transfer transaction succeeded/);
});

test("a program id that is not the permanent identity fails as an identity mismatch", async () => {
  const fixture = deployedCoreFixture();
  const record = fixtureRecord(fixture, { programId: "11111111111111111111111111111112" });
  const { failures, text } = await run(record, { accounts: fixture.accounts });
  assert.equal(failures.length, 1);
  assert.match(text, /record names ppv_core at 11111111111111111111111111111112; the permanent id is/);
  // The record is rejected before any chain read, so this is not reported as a
  // deployment problem at an address nobody in this protocol controls.
  assert.doesNotMatch(text, /not deployed/);
});

test("an upgrade authority that is not the vault fails as an authority mismatch", async () => {
  const fixture = deployedCoreFixture({ authority: MEMBERS[0] });
  const { failures, text } = await run(fixtureRecord(fixture), {
    accounts: fixture.accounts,
    signatures: okSignatures,
  });
  assert.equal(failures.length, 1);
  assert.match(text, /SECURITY: live upgrade authority is .*, the recorded Squads vault is/);
});

test("a revoked upgrade authority fails as an immutable program", async () => {
  const fixture = deployedCoreFixture({ authority: null });
  const { failures, text } = await run(fixtureRecord(fixture), {
    accounts: fixture.accounts,
    signatures: okSignatures,
  });
  assert.equal(failures.length, 1);
  assert.match(text, /immutable: its upgrade authority has been revoked/);
});

test("a cluster whose genesis is not the record's fails as a genesis mismatch", async () => {
  const fixture = deployedCoreFixture();
  const { failures, text } = await run(fixtureRecord(fixture), {
    genesis: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    accounts: fixture.accounts,
    signatures: okSignatures,
  });
  assert.match(text, /cluster genesis .* does not match the recorded/);
  assert.ok(failures.some((f) => /cluster genesis/.test(f)));
});

test("mainnet is refused outright rather than reported as one failed check", async () => {
  const fixture = deployedCoreFixture();
  await assert.rejects(
    run(fixtureRecord(fixture), { genesis: MAINNET_GENESIS, accounts: fixture.accounts }),
    /is mainnet-beta, which is not authorized/,
  );
});

test("a live binary that is not the release binary fails as a binary mismatch", async () => {
  const fixture = deployedCoreFixture({ binary: Buffer.from("a different artifact!!!!!") });
  const record = fixtureRecord(fixture, { binaryHash: sha256(Buffer.from("ppv_core release artifact")) });
  const { failures, text } = await run(record, { accounts: fixture.accounts, signatures: okSignatures });
  assert.equal(failures.length, 1);
  assert.match(text, /live binary is sha256:.*, the recorded release binary is sha256:/);
});

test("a program owned by a loader that is not the upgradeable one fails as a loader mismatch", async () => {
  const fixture = deployedCoreFixture();
  fixture.accounts[CORE_ID] = programAccount(CORE_PROGRAM_DATA, {
    owner: "BPFLoader2111111111111111111111111111111111",
  });
  const { failures, text } = await run(fixtureRecord(fixture), { accounts: fixture.accounts });
  assert.equal(failures.length, 1);
  assert.match(text, /not the BPF upgradeable loader/);
});

test("a program account that does not exist fails as a missing deployment", async () => {
  const fixture = deployedCoreFixture();
  const { failures, text } = await run(fixtureRecord(fixture), { accounts: {} });
  assert.equal(failures.length, 1);
  assert.match(text, /the program is not deployed/);
});

test("ProgramData at an address the record does not name fails as a ProgramData mismatch", async () => {
  const other = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const fixture = deployedCoreFixture({ programDataAddress: other });
  const { failures, text } = await run(fixtureRecord(fixture), {
    accounts: fixture.accounts,
    signatures: okSignatures,
  });
  assert.equal(failures.length, 1);
  assert.match(text, /ProgramData is .*, the record says/);
});

test("a deployment signature missing from history fails rather than being assumed good", async () => {
  const fixture = deployedCoreFixture();
  const { failures, text } = await run(fixtureRecord(fixture), { accounts: fixture.accounts, signatures: {} });
  assert.equal(failures.length, 2);
  assert.match(text, /deployment transaction .* is not in transaction history/);
  assert.match(text, /authority transfer transaction .* is not in transaction history/);
});

test("a deployment signature recorded with an error fails", async () => {
  const fixture = deployedCoreFixture();
  const { failures, text } = await run(fixtureRecord(fixture), {
    accounts: fixture.accounts,
    signatures: { ...okSignatures, [DEPLOY_SIG]: { slot: 1, err: { InstructionError: [0, "Custom"] } } },
  });
  assert.equal(failures.length, 1);
  assert.match(text, /deployment transaction .* failed/);
});

test("the record itself is refused when it claims a policy-forbidden authority", () => {
  const fixture = deployedCoreFixture();
  assert.match(
    checkRecord(fixtureRecord(fixture, { upgradeAuthorityThreshold: 1 })).join("\n"),
    /below the policy minimum of 2/,
  );
  // An on-curve address is a wallet, not a vault: one key could upgrade PPV.
  assert.match(
    checkRecord(fixtureRecord(fixture, { upgradeAuthority: MEMBERS[0] })).join("\n"),
    /is not a program-derived address/,
  );
  assert.match(
    checkRecord(fixtureRecord(fixture, { releaseCommit: "861a8df" })).join("\n"),
    /is not a full 40-character git sha/,
  );
  assert.match(
    checkRecord(fixtureRecord(fixture, { cluster: "mainnet-beta" })).join("\n"),
    /which this verifier does not accept/,
  );
});

test("loader padding is proven to be padding rather than trimmed away", async () => {
  const binary = Buffer.from("ppv_core release artifact");
  const fixture = deployedCoreFixture({ binary, padding: 0 });
  // Padding that is not zero is code this verifier has not accounted for.
  fixture.accounts[CORE_PROGRAM_DATA] = programDataAccount({
    authority: VAULT_PDA,
    binary: Buffer.concat([binary, Buffer.from([0, 0, 7])]),
  });
  const client = rpc("https://stub.invalid", { fetchImpl: makeRpcTransport({ accounts: fixture.accounts }) });
  await assert.rejects(
    readDeployedProgram(client, CORE_ID, { binaryLength: binary.length }),
    /the remainder is not zero padding/,
  );
});

test("signature status search covers transaction history", async () => {
  const transport = makeRpcTransport({ signatures: okSignatures });
  const client = rpc("https://stub.invalid", { fetchImpl: transport });
  const status = await signatureStatus(client, DEPLOY_SIG);
  assert.equal(status.err, null);
  assert.equal(status.slot, 497437304);
});

test("evidence collection refuses to record a binary the chain is not running", async () => {
  const fixture = deployedCoreFixture();
  const client = rpc("https://stub.invalid", {
    fetchImpl: makeRpcTransport({ accounts: fixture.accounts, signatures: okSignatures }),
  });
  const env = {
    PPV_PROGRAM: "ppv_core",
    PPV_RELEASE_COMMIT: COMMIT,
    PPV_DEPLOY_SIGNATURE: DEPLOY_SIG,
    PPV_AUTHORITY_TRANSFER_SIGNATURE: TRANSFER_SIG,
    PPV_UPGRADE_AUTHORITY_MEMBERS: MEMBERS.join(","),
    PPV_UPGRADE_AUTHORITY_THRESHOLD: "2",
  };
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const buildDir = mkdtempSync(join(tmpdir(), "ppv-build-"));
  mkdirSync(join(buildDir, "idl"), { recursive: true });
  mkdirSync(join(buildDir, "deploy"), { recursive: true });
  writeFileSync(join(buildDir, "idl", "ppv_core.json"), JSON.stringify({ address: CORE_ID }));
  writeFileSync(join(buildDir, "deploy", "ppv_core.so"), "a rebuild that is not what was deployed");
  await assert.rejects(collect({ client, env, buildDir }), /BINARY MISMATCH/);

  writeFileSync(join(buildDir, "deploy", "ppv_core.so"), fixture.binary);
  const record = await collect({ client, env, buildDir });
  assert.equal(record.binaryHashesMatch, true);
  assert.equal(record.upgradeAuthority, VAULT_PDA);
  assert.equal(record.programDataAddress, CORE_PROGRAM_DATA);
  assert.equal(record.deploymentSlot, 497437304);
  assert.equal(record.authorityTransferSlot, 497437312);
  assert.equal(record.binaryHash, record.onChainBinaryHash);
  // The record it writes must be one the verifier accepts, or evidence and
  // verification have drifted apart.
  assert.deepEqual(checkRecord(record), []);
});

/**
 * The member list is how every later reader learns what the governance
 * actually is, because the threshold is not readable from the vault account
 * itself. A record that overstates it is believed forever after.
 */
test("evidence collection refuses a member list that does not mean what it says", async () => {
  const fixture = deployedCoreFixture();
  const client = rpc("https://stub.invalid", {
    fetchImpl: makeRpcTransport({ accounts: fixture.accounts, signatures: okSignatures }),
  });
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const buildDir = mkdtempSync(join(tmpdir(), "ppv-governance-"));
  mkdirSync(join(buildDir, "idl"), { recursive: true });
  mkdirSync(join(buildDir, "deploy"), { recursive: true });
  writeFileSync(join(buildDir, "idl", "ppv_core.json"), JSON.stringify({ address: CORE_ID }));
  writeFileSync(join(buildDir, "deploy", "ppv_core.so"), fixture.binary);

  const baseEnv = {
    PPV_PROGRAM: "ppv_core",
    PPV_RELEASE_COMMIT: COMMIT,
    PPV_DEPLOY_SIGNATURE: DEPLOY_SIG,
    PPV_AUTHORITY_TRANSFER_SIGNATURE: TRANSFER_SIG,
    PPV_UPGRADE_AUTHORITY_THRESHOLD: "2",
  };

  // A threshold counts distinct keys. Three entries that are two people is a
  // 2-of-3 only on paper: one holder of the repeated key plus one other
  // satisfies it, which is the 1-of-2 the policy exists to forbid.
  await assert.rejects(
    collect({
      client,
      env: {
        ...baseEnv,
        PPV_UPGRADE_AUTHORITY_MEMBERS: [MEMBERS[0], MEMBERS[0], MEMBERS[1]].join(","),
      },
      buildDir,
    }),
    /duplicates/,
  );

  // The vault cannot be one of its own signers.
  await assert.rejects(
    collect({
      client,
      env: {
        ...baseEnv,
        PPV_UPGRADE_AUTHORITY_MEMBERS: [VAULT_PDA, MEMBERS[0], MEMBERS[1]].join(","),
      },
      buildDir,
    }),
    /listed as one of its own members/,
  );

  // The honest list still records.
  const record = await collect({
    client,
    env: { ...baseEnv, PPV_UPGRADE_AUTHORITY_MEMBERS: MEMBERS.join(",") },
    buildDir,
  });
  assert.equal(record.upgradeAuthorityThreshold, 2);
  assert.equal(new Set(record.upgradeAuthorityMembers).size, MEMBERS.length);
});

/**
 * The committed release records.
 *
 * These files are load-bearing — the deploy workflow, the preflight and the
 * smoke suite all read them — so a record that has drifted out of the shape the
 * verifier accepts would silently weaken all three. Checked here rather than
 * only in the workflow that reads the chain, because this failure does not need
 * a network to detect and should not wait for one.
 */
test("every committed release record is one the verifier accepts", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PERMANENT_PROGRAM_IDS } = await import("../lib/identity.mjs");
  const { REPO } = await import("./helpers.mjs");

  const dir = join(REPO, "deployments", "evidence");
  const records = readdirSync(dir).filter((entry) => entry.endsWith(".json"));
  assert.ok(records.length > 0, "there must be at least one committed release record");

  for (const entry of records) {
    const record = JSON.parse(readFileSync(join(dir, entry), "utf8"));
    assert.deepEqual(checkRecord(record), [], `${entry} is not a record the verifier accepts`);
    assert.equal(record.programId, PERMANENT_PROGRAM_IDS[record.program]);
    assert.equal(record.binaryHash, record.onChainBinaryHash, `${entry} records a binary mismatch`);
    assert.equal(record.binaryHash, record.builtBinaryHash, `${entry} records a binary mismatch`);
    assert.equal(record.binaryHashesMatch, true);
    // The loader's header sits in front of the ELF; the two lengths must agree
    // or the record is describing an account layout that does not exist.
    assert.equal(
      record.programDataLength,
      45 + record.binaryLength + record.programDataPaddingLength,
      `${entry} has inconsistent ProgramData lengths`,
    );
    assert.equal(record.programOwner, "BPFLoaderUpgradeab1e11111111111111111111111");
    assert.equal(record.programDataOwner, "BPFLoaderUpgradeab1e11111111111111111111111");
    assert.equal(record.programExecutable, true);
    assert.equal(record.deploymentStatus, "finalized");
    assert.match(record.idlHash, /^sha256:[0-9a-f]{64}$/);
    // No secret material, ever. A record is published evidence.
    const text = JSON.stringify(record);
    assert.doesNotMatch(text, /PRIVATE KEY|secretKey|mnemonic|\[\s*\d+\s*,\s*\d+\s*,/i);
  }
});

test("the PPV Core record is the release this repository claims to have shipped", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO } = await import("./helpers.mjs");

  const record = JSON.parse(
    readFileSync(join(REPO, "deployments", "evidence", "ppv-core-devnet-861a8df.json"), "utf8"),
  );
  assert.equal(record.releaseCommit, COMMIT);
  assert.equal(record.programId, CORE_ID);
  assert.equal(record.programDataAddress, CORE_PROGRAM_DATA);
  assert.equal(record.deploymentSignature, DEPLOY_SIG);
  assert.equal(record.authorityTransferSignature, TRANSFER_SIG);
  assert.equal(record.upgradeAuthority, "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX");
  assert.equal(record.upgradeAuthorityThreshold, 2);
  assert.equal(record.upgradeAuthorityMembers.length, 3);
  assert.equal(record.cluster, "devnet");
  assert.equal(record.genesisHash, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
});

/**
 * The two ProofRecord decoders, checked against each other.
 *
 * There are now two: `scripts/lib/core-accounts.mjs`, which the signer-free
 * release tooling uses because it must run before any install, and the SDK's
 * TypeScript decoder, which clients use. Two decoders for one on-chain layout
 * is a drift risk, and a drift here means the release tooling and the product
 * disagree about what a proof says. So they are made to decode the same bytes
 * and required to agree.
 */
test("the release tooling and the SDK decode a ProofRecord identically", async () => {
  const { PROOF_RECORD_DISCRIMINATOR, PROOF_RECORD_LEN, decodeProofRecord } = await import(
    "../lib/core-accounts.mjs"
  );
  const { decodeCoreProofAccount } = await import("../../sdk/dist/index.js");

  const authority = "55y7B46ZUAyeYaMFUPxHAg9UUcwrfZ2eZDFDabxinhjp";
  const { decodeBase58 } = await import("../lib/pubkey.mjs");

  const data = Buffer.alloc(PROOF_RECORD_LEN);
  PROOF_RECORD_DISCRIMINATOR.copy(data, 0);
  data[8] = 1;
  data[9] = 250;
  data.fill(0x2a, 10, 26);
  Buffer.from(decodeBase58(authority)).copy(data, 26);
  data.fill(0x5c, 58, 90);
  data.fill(0x77, 90, 122);
  data[122] = 2; // Agreement
  data[123] = 1; // Revoked
  data.writeBigInt64LE(1757000000n, 124);
  data.writeBigInt64LE(1757000900n, 132);

  const fromTooling = decodeProofRecord(data);
  const fromSdk = decodeCoreProofAccount(new Uint8Array(data));

  assert.equal(fromTooling.schemaVersion, fromSdk.schemaVersion);
  assert.equal(fromTooling.bump, fromSdk.bump);
  assert.equal(fromTooling.proofId, fromSdk.proofId);
  assert.equal(fromTooling.authority, fromSdk.authority);
  assert.equal(fromTooling.contentHash, fromSdk.contentHash);
  assert.equal(fromTooling.contextHash, fromSdk.contextHash);
  assert.equal(fromTooling.createdAt, fromSdk.createdAt);
  assert.equal(fromTooling.revokedAt, fromSdk.revokedAt);
  // The two spell the enums differently by design — the tooling prints lowercase
  // for a terminal report, the SDK keeps the program's own casing — so compare
  // them case-insensitively rather than pretending one is wrong.
  assert.equal(fromTooling.kind, fromSdk.kind.toLowerCase());
  assert.equal(fromTooling.status, fromSdk.status.toLowerCase());
  assert.equal(PROOF_RECORD_LEN, 204);
});

/**
 * The deployer funding report.
 *
 * It gates a deployment window, so the case that matters is the one where it
 * cannot tell: an unreadable balance must never be reported as funded, and a
 * cluster that is not devnet must stop it before any balance is considered.
 */
test("funding is reported against the policy, and fails closed when unknown", async () => {
  const { execFileSync } = await import("node:child_process");
  const { startRpcServerProcess, REPO } = await import("./helpers.mjs");
  const { join } = await import("node:path");
  const script = join(REPO, "scripts", "report-deployer-funding.mjs");
  const address = "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV";

  const run = (url, args = []) => {
    try {
      return {
        code: 0,
        out: execFileSync("node", [script, address, ...args], {
          encoding: "utf8",
          env: { ...process.env, PPV_RPC_URL: url },
        }),
      };
    } catch (error) {
      return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
  };

  // Funded at exactly the policy minimum is funded: the bound is inclusive.
  let server = await startRpcServerProcess({ balances: { [address]: 2_000_000_000 } });
  try {
    const result = run(server.url);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /result {4}funded/);
    assert.match(result.out, /2\.0000 SOL/);
  } finally {
    server.close();
  }

  // One lamport short is short, and the shortfall is named.
  server = await startRpcServerProcess({ balances: { [address]: 1_999_999_999 } });
  try {
    const result = run(server.url);
    assert.equal(result.code, 1);
    assert.match(result.out, /UNDERFUNDED/);
    assert.match(result.out, /needs 1 more lamports/);
  } finally {
    server.close();
  }

  // An account with no balance at all, and a cluster that is not devnet: both
  // are refusals, never a pass.
  server = await startRpcServerProcess({});
  try {
    assert.equal(run(server.url).code, 1);
  } finally {
    server.close();
  }
  server = await startRpcServerProcess({
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    balances: { [address]: 50_000_000_000 },
  });
  try {
    const result = run(server.url);
    assert.equal(result.code, 1);
    assert.match(result.out, /mainnet-beta, which is not an authorized PPV cluster/);
  } finally {
    server.close();
  }
});
