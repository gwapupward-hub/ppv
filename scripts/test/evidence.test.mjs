import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { COMMERCE_ID, CORE_ID, MEMBERS, REPO, VAULT_PDA, makeStubs } from "./helpers.mjs";

/**
 * Guards on the two scripts that produce and check deployment evidence.
 *
 * Both are run for real here, with a stub CLI on PATH where they reach for one.
 * The cases are the ones where a wrong value would otherwise be written down
 * and believed later: a threshold that policy forbids, and an artifact or
 * manifest naming an address that is not the permanent identity.
 */

const FIXTURE_CLUSTER = "release-test-fixture";
const FIXTURE_MANIFEST = join(REPO, "deployments", `${FIXTURE_CLUSTER}.json`);
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

function run(script, env = {}, stubBin) {
  return spawnSync("bash", [join(REPO, "scripts", script)], {
    encoding: "utf8",
    cwd: REPO,
    env: {
      ...process.env,
      PATH: stubBin ? `${stubBin}:${process.env.PATH}` : process.env.PATH,
      ...env,
    },
  });
}

const recordEnv = (overrides = {}) => ({
  PPV_PROGRAM: "ppv_core",
  PPV_DEPLOY_SIGNATURE: "5".repeat(64),
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

test("verification refuses a manifest that records a program at the wrong address", () => {
  // The failure this catches: evidence that looks complete and describes a
  // program nobody in this protocol controls.
  const stub = makeStubs({ genesis: GENESIS, existingPrograms: { [CORE_ID]: VAULT_PDA } });
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
              programDataAddress: `${CORE_ID}Data`,
              upgradeAuthority: VAULT_PDA,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = run("verify-deployment.sh", { PPV_CLUSTER: FIXTURE_CLUSTER }, stub);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /manifest records ppv_core at 11111111111111111111111111111112, permanent id is/,
    );
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});

test("verification refuses an upgrade authority that is not the recorded one", () => {
  const stub = makeStubs({ genesis: GENESIS, existingPrograms: { [CORE_ID]: MEMBERS[0] } });
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
              programDataAddress: `${CORE_ID}Data`,
              // The chain will report MEMBERS[0]; the manifest says the vault.
              upgradeAuthority: VAULT_PDA,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const result = run("verify-deployment.sh", { PPV_CLUSTER: FIXTURE_CLUSTER }, stub);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /upgrade authority .*, manifest/);
    assert.match(`${result.stdout}${result.stderr}`, /Verification FAILED/);
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});

test("verification refuses a cluster whose genesis is not the manifest's", () => {
  const stub = makeStubs({ genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
  try {
    writeFileSync(
      FIXTURE_MANIFEST,
      `${JSON.stringify({ cluster: FIXTURE_CLUSTER, genesisHash: GENESIS, deployments: [] }, null, 2)}\n`,
    );
    const result = run("verify-deployment.sh", { PPV_CLUSTER: FIXTURE_CLUSTER }, stub);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /Genesis hash mismatch/);
  } finally {
    rmSync(FIXTURE_MANIFEST, { force: true });
  }
});
