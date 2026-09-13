import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  COMMERCE_ID,
  CORE_ID,
  CORE_PROGRAM_DATA,
  MEMBERS,
  REPO,
  VAULT_PDA,
  deployedCoreFixture,
  startRpcServerProcess,
} from "./helpers.mjs";

/**
 * Guards on the two scripts that produce and check deployment evidence.
 *
 * Both are run for real here, against a deterministic JSON-RPC endpoint on
 * loopback. The endpoint matters as much as the cases: these scripts used to
 * read the chain through the Solana CLI, which wants a default signer even to
 * read, and that is what turned a successful PPV Core deployment into a failed
 * workflow run. Pointing them at a stub endpoint proves they need nothing but
 * an endpoint — and it keeps every negative case below deterministic, instead
 * of depending on devnet being reachable and in the right state.
 *
 * The cases are the ones where a wrong value would otherwise be written down
 * and believed later: a threshold that policy forbids, and an artifact or
 * manifest naming an address that is not the permanent identity.
 */

const FIXTURE_CLUSTER = "release-test-fixture";
const FIXTURE_MANIFEST = join(REPO, "deployments", `${FIXTURE_CLUSTER}.json`);
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** The deploy signature the fixtures record and the stub cluster confirms. */
const DEPLOY_SIG = "3".repeat(64);

function run(script, env = {}) {
  return spawnSync("bash", [join(REPO, "scripts", script)], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, ...env },
  });
}

/**
 * Runs one of the scripts against a stub cluster in its own process.
 *
 * Out of process because these tests use `spawnSync`, which blocks this
 * process's event loop — an in-process stub server would never answer the
 * script it is serving.
 */
async function runAgainstChain(script, { env = {}, ...chain }) {
  const server = await startRpcServerProcess(chain);
  try {
    return run(script, { PPV_RPC_URL: server.url, ...env });
  } finally {
    server.close();
  }
}

/** A stub devnet on which PPV Core is deployed exactly as its record says. */
function liveCore(overrides = {}) {
  const fixture = deployedCoreFixture(overrides);
  return {
    accounts: fixture.accounts,
    signatures: { [DEPLOY_SIG]: { slot: 497437304, err: null, confirmationStatus: "finalized" } },
  };
}

const recordEnv = (overrides = {}) => ({
  PPV_PROGRAM: "ppv_core",
  PPV_DEPLOY_SIGNATURE: DEPLOY_SIG,
  PPV_UPGRADE_AUTHORITY_MEMBERS: MEMBERS.join(","),
  PPV_UPGRADE_AUTHORITY_THRESHOLD: "2",
  PPV_CLUSTER: FIXTURE_CLUSTER,
  ...overrides,
});

test("recording refuses a threshold policy forbids", () => {
  for (const threshold of ["1", "0", "one"]) {
    const result = run("record-deployment.sh", recordEnv({ PPV_UPGRADE_AUTHORITY_THRESHOLD: threshold }));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /policy requires at least 2/);
  }
});

test("recording refuses an artifact that does not name the permanent identity", () => {
  const idlDir = join(REPO, "target", "idl");
  const deployDir = join(REPO, "target", "deploy");
  mkdirSync(idlDir, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  const idl = join(idlDir, "ppv_core.json");
  const binary = join(deployDir, "ppv_core.so");
  try {
    writeFileSync(idl, JSON.stringify({ address: COMMERCE_ID }));
    writeFileSync(binary, "not a real program");
    const result = run("record-deployment.sh", recordEnv());
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Built ppv_core IDL names .*, permanent id is/);
  } finally {
    rmSync(idl, { force: true });
    rmSync(binary, { force: true });
  }
});

test("recording refuses anything that looks like signing material", () => {
  const result = run(
    "record-deployment.sh",
    recordEnv({ PPV_UPGRADE_AUTHORITY_MEMBERS: "[12,34,56]" }),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /looks like a keypair, not public data/);
});

test("verification refuses a manifest that records a program at the wrong address", async () => {
  // The failure this catches: evidence that looks complete and describes a
  // program nobody in this protocol controls.
  try {
    writeFileSync(
      FIXTURE_MANIFEST,
      `${JSON.stringify(
        {
          cluster: FIXTURE_CLUSTER,
          genesisHash: GENESIS,
          deployments: [
            {
              program: "ppv_core",
              // Not the permanent ppv_core identity.
              programId: "11111111111111111111111111111112",
              programDataAddress: CORE_PROGRAM_DATA,
              upgradeAuthority: VAULT_PDA,
              deploymentSignature: DEPLOY_SIG,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = await runAgainstChain("verify-deployment.sh", {
      ...liveCore(),
      env: { PPV_CLUSTER: FIXTURE_CLUSTER },
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /manifest records ppv_core at 11111111111111111111111111111112, permanent id is/,
    );
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});

test("verification refuses an upgrade authority that is not the recorded one", async () => {
  try {
    writeFileSync(
      FIXTURE_MANIFEST,
      `${JSON.stringify(
        {
          cluster: FIXTURE_CLUSTER,
          genesisHash: GENESIS,
          deployments: [
            {
              program: "ppv_core",
              programId: CORE_ID,
              programDataAddress: CORE_PROGRAM_DATA,
              // The chain will report MEMBERS[0]; the manifest says the vault.
              upgradeAuthority: VAULT_PDA,
              deploymentSignature: DEPLOY_SIG,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = await runAgainstChain("verify-deployment.sh", {
      ...liveCore({ authority: MEMBERS[0] }),
      env: { PPV_CLUSTER: FIXTURE_CLUSTER },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /upgrade authority .*, manifest/);
    assert.match(`${result.stdout}${result.stderr}`, /Verification FAILED/);
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});

test("verification refuses a cluster whose genesis is not the manifest's", async () => {
  try {
    writeFileSync(
      FIXTURE_MANIFEST,
      `${JSON.stringify({ cluster: FIXTURE_CLUSTER, genesisHash: GENESIS, deployments: [] }, null, 2)}\n`,
    );
    const result = await runAgainstChain("verify-deployment.sh", {
      genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      env: { PPV_CLUSTER: FIXTURE_CLUSTER },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Genesis hash mismatch/);
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});

/**
 * The recording path, run end to end against a stub cluster.
 *
 * This is the case that was never covered and that therefore broke: recording
 * evidence for a deployment that really happened, on a machine with no wallet.
 * It runs in a scratch git repository because the script refuses a dirty tree —
 * a rule worth keeping, since `gitCommit` in the manifest would otherwise name
 * a commit that is not what was built.
 */
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "ppv-record-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO, ".gitignore"), join(root, ".gitignore"));
  mkdirSync(join(root, "deployments"), { recursive: true });
  mkdirSync(join(root, "target", "idl"), { recursive: true });
  mkdirSync(join(root, "target", "deploy"), { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { root, commit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim() };
}

test("recording a real deployment needs an endpoint and nothing else", async () => {
  const { root, commit } = scratchRepo();
  const binary = Buffer.from("ppv_core release artifact");
  writeFileSync(join(root, "target", "idl", "ppv_core.json"), JSON.stringify({ address: CORE_ID }));
  writeFileSync(join(root, "target", "deploy", "ppv_core.so"), binary);

  const server = await startRpcServerProcess(liveCore({ binary }));
  try {
    const record = spawnSync("bash", [join(root, "scripts", "record-deployment.sh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, ...recordEnv(), PPV_RPC_URL: server.url },
    });
    assert.equal(record.status, 0, `${record.stdout}${record.stderr}`);
    assert.match(record.stdout, new RegExp(`programData: ${CORE_PROGRAM_DATA}`));
    assert.match(record.stdout, new RegExp(`authority: +${VAULT_PDA}`));

    const manifest = JSON.parse(readFileSync(join(root, "deployments", `${FIXTURE_CLUSTER}.json`), "utf8"));
    assert.equal(manifest.genesisHash, GENESIS);
    assert.equal(manifest.deployments.length, 1);
    const entry = manifest.deployments[0];
    assert.equal(entry.programId, CORE_ID);
    assert.equal(entry.programDataAddress, CORE_PROGRAM_DATA);
    assert.equal(entry.upgradeAuthority, VAULT_PDA);
    assert.equal(entry.upgradeAuthorityThreshold, 2);
    assert.equal(entry.gitCommit, commit);
    assert.equal(entry.deployedSlot, 497437304);

    // What it wrote must be what verification accepts, or the two halves of the
    // evidence path do not agree and neither one means anything.
    const verify = spawnSync("bash", [join(root, "scripts", "verify-deployment.sh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, PPV_CLUSTER: FIXTURE_CLUSTER, PPV_RPC_URL: server.url },
    });
    assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
    assert.match(verify.stdout, /primary RPC: ok/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recording refuses a deployment signature the chain does not confirm", async () => {
  const { root } = scratchRepo();
  const binary = Buffer.from("ppv_core release artifact");
  writeFileSync(join(root, "target", "idl", "ppv_core.json"), JSON.stringify({ address: CORE_ID }));
  writeFileSync(join(root, "target", "deploy", "ppv_core.so"), binary);

  for (const [label, signatures, expected] of [
    ["absent", {}, /is not in .* transaction history/],
    [
      "failed",
      { [DEPLOY_SIG]: { slot: 1, err: { InstructionError: [0, "Custom"] } } },
      /is recorded with error/,
    ],
  ]) {
    const server = await startRpcServerProcess({ ...liveCore({ binary }), signatures });
    try {
      const result = spawnSync("bash", [join(root, "scripts", "record-deployment.sh")], {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, ...recordEnv(), PPV_RPC_URL: server.url },
      });
      assert.notEqual(result.status, 0, `a ${label} signature must not be recorded as evidence`);
      assert.match(result.stderr, expected);
    } finally {
      server.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("recording refuses a program the chain does not report as executable", async () => {
  const { root } = scratchRepo();
  const binary = Buffer.from("ppv_core release artifact");
  writeFileSync(join(root, "target", "idl", "ppv_core.json"), JSON.stringify({ address: CORE_ID }));
  writeFileSync(join(root, "target", "deploy", "ppv_core.so"), binary);

  const server = await startRpcServerProcess({ ...liveCore({ binary }), accounts: {} });
  try {
    const result = spawnSync("bash", [join(root, "scripts", "record-deployment.sh")], {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, ...recordEnv(), PPV_RPC_URL: server.url },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not an executable program account/);
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
