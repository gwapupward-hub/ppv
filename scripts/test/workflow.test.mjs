import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * Static invariants of the devnet deploy workflow.
 *
 * These are text assertions over the workflow file rather than a simulated run:
 * the workflow cannot be executed here, and the properties that matter are
 * structural — which triggers exist, which checks precede the handoff, whether
 * a secret can reach a shell line. A reviewer can confirm each one by reading
 * the same file. What they buy is that deleting a protection breaks a test
 * instead of passing silently, which is the only reason a safety check is worth
 * having.
 */

const WORKFLOW = readFileSync(join(REPO, ".github", "workflows", "deploy-devnet.yml"), "utf8");
const lines = WORKFLOW.split("\n");

/** The index of a step's `- name:` line, for ordering assertions. */
function stepIndex(name) {
  const index = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(index, -1, `workflow has no step named '${name}'`);
  return index;
}

test("deployment is manual only", () => {
  // A deployment must never be a side effect of merging code.
  assert.match(WORKFLOW, /^on:\n\s+workflow_dispatch:/m);
  const triggers = WORKFLOW.slice(WORKFLOW.indexOf("\non:"), WORKFLOW.indexOf("\npermissions:"));
  for (const forbidden of ["push:", "pull_request:", "schedule:", "release:", "repository_dispatch:"]) {
    assert.doesNotMatch(triggers, new RegExp(`\\n\\s+${forbidden}`), `${forbidden} must not trigger a deploy`);
  }
});

test("the job runs in the protected devnet environment", () => {
  // Without the environment, this is an ordinary job holding credentials.
  assert.match(WORKFLOW, /^\s+environment: devnet$/m);
  assert.match(WORKFLOW, /^permissions:\n\s+contents: read$/m);
  assert.match(WORKFLOW, /group: deploy-devnet/);
  assert.match(WORKFLOW, /cancel-in-progress: false/);
});

test("exactly one program is deployed per run, and it must be typed twice", () => {
  assert.match(WORKFLOW, /options: \[ppv_core, ppv_commerce\]/);
  assert.match(WORKFLOW, /inputs\.program \}\}" != "\$\{\{ inputs\.confirm \}\}/);
  assert.ok(
    stepIndex("Confirm the program name") < stepIndex("Assert committed identity and build"),
    "confirmation must come before anything is built",
  );
});

test("committed identity is asserted against the permanent keypair before building", () => {
  assert.match(WORKFLOW, /keypair_id="\$\(solana-keygen pubkey "target\/deploy\/\$\{program\}-keypair\.json"\)"/);
  assert.match(WORKFLOW, /declared_id="\$\(sed -n 's\/\^declare_id!/);
  assert.match(WORKFLOW, /anchor_ids\[0\]/);
  assert.match(WORKFLOW, /Permanent keypair \$\{keypair_id\} does not match committed/);
  // The built IDL must name the same id, or the artifact and the address differ.
  assert.match(WORKFLOW, /Built IDL id \$\{idl_id\} does not match keypair/);
  // And the build must not have rewritten either committed identity file.
  assert.match(WORKFLOW, /git diff --exit-code -- Anchor\.toml "programs\/\$\{program\}\/src\/lib\.rs"/);
});

test("the cluster is pinned by genesis hash before any key is fetched", () => {
  assert.match(WORKFLOW, /Genesis hash \$\{actual\} does not match the configured devnet genesis/);
  assert.ok(
    stepIndex("Confirm the CLI is targeting devnet") < stepIndex("Fetch ppv_core signing material"),
    "the cluster must be confirmed before signing material is written to disk",
  );
});

test("an occupied address stops an initial deployment", () => {
  assert.match(WORKFLOW, /already exists\. This initial-deployment workflow will not upgrade it/);
  assert.ok(
    stepIndex("Refuse an existing program address") <
      stepIndex("Deploy with the deployer as temporary authority"),
    "the existence check must precede the deploy",
  );
});

test("the final upgrade authority is validated before it is handed anything", () => {
  const validate = stepIndex("Validate the configured final upgrade authority");
  assert.ok(
    validate < stepIndex("Transfer upgrade authority to Squads"),
    "the authority must be validated before the transfer, not after",
  );
  // A threshold of one means a single compromised key can upgrade the program.
  assert.match(WORKFLOW, /AUTHORITY_THRESHOLD < 2/);
  assert.match(WORKFLOW, /policy requires at least 2/);
  // A Squads vault is a PDA and therefore off-curve; a wallet is not.
  assert.match(WORKFLOW, /isProgramDerived/);
  assert.match(WORKFLOW, /Refusing to hand the upgrade authority to a signer wallet/);
});

test("the deployer is only ever a temporary authority", () => {
  assert.match(WORKFLOW, /--upgrade-authority "\$\{\{ steps\.keys\.outputs\.work \}\}\/deployer\.json"/);
  assert.match(WORKFLOW, /solana program set-upgrade-authority/);
  assert.match(WORKFLOW, /--new-upgrade-authority "\$\{UPGRADE_AUTHORITY\}"/);
  assert.ok(
    stepIndex("Deploy with the deployer as temporary authority") <
      stepIndex("Transfer upgrade authority to Squads"),
  );
});

test("the handoff is verified on chain and an exact mismatch fails the run", () => {
  assert.match(WORKFLOW, /Authority handoff failed: expected \$\{EXPECTED_AUTHORITY\}, got \$\{actual_authority\}/);
  assert.match(WORKFLOW, /BPFLoaderUpgradeab1e11111111111111111111111/);
  assert.match(WORKFLOW, /Program account is not an executable upgradeable-loader program/);
  assert.ok(
    stepIndex("Transfer upgrade authority to Squads") <
      stepIndex("Verify on chain and record the deployment"),
  );
});

test("evidence is recorded, verified and published", () => {
  assert.match(WORKFLOW, /\.\/scripts\/record-deployment\.sh/);
  assert.match(WORKFLOW, /\.\/scripts\/verify-deployment\.sh/);
  assert.match(WORKFLOW, /path: deployments\/devnet\.json/);
  assert.match(WORKFLOW, /if-no-files-found: error/);
  // Evidence must not claim a weaker authority than policy allows.
  assert.match(WORKFLOW, /Refusing to record a deployment with threshold/);
});

test("signing material is destroyed on every exit path", () => {
  const destroy = stepIndex("Destroy signing material");
  const body = lines.slice(destroy, destroy + 8).join("\n");
  assert.match(body, /if: always\(\)/, "cleanup must run even when an earlier step failed");
  assert.match(body, /rm -rf .*target\/deploy\/\*-keypair\.json/);
});

test("no secret can reach a shell line", () => {
  // Secrets are passed through `env:` so the runner masks them and no shell
  // line can echo one. An interpolation inside a `run:` block would put the
  // value in the command itself, where a failure trace can print it.
  const offenders = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes("${{ secrets."))
    .filter(({ line }) => !/^\s+[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/.test(line));
  assert.deepEqual(
    offenders.map((o) => `${o.index + 1}: ${o.line.trim()}`),
    [],
    "secrets must only appear as env: values",
  );
  assert.ok(WORKFLOW.includes("${{ secrets."), "the test would be vacuous with no secrets at all");
});

test("the preflight runs inside the workflow, not only on a developer's machine", () => {
  assert.match(WORKFLOW, /\.\/scripts\/verify-devnet-readiness\.sh --repo-only/);
});
