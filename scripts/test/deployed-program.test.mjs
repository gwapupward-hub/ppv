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
