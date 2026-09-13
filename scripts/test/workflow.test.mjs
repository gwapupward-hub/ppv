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

test("two independent cryptographic approvals bind the verified release identity before deployment", () => {
  for (const input of ["approver_1", "signature_1", "approver_2", "signature_2"]) {
    assert.match(WORKFLOW, new RegExp(`\\n\\s+${input}:\\n\\s+description: .+\\n\\s+required: true\\n\\s+type: string`));
  }
  assert.match(WORKFLOW, /- name: Assert committed identity and build\n\s+id: release_identity/);
  assert.match(WORKFLOW, /echo "program_id=\$\{keypair_id\}" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.match(WORKFLOW, /PPV_RELEASE_PROGRAM_ID: \$\{\{ steps\.release_identity\.outputs\.program_id \}\}/);
  assert.match(WORKFLOW, /PPV_RELEASE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(WORKFLOW, /PPV_RELEASE_APPROVER_1: \$\{\{ inputs\.approver_1 \}\}/);
  assert.match(WORKFLOW, /PPV_RELEASE_SIGNATURE_1: \$\{\{ inputs\.signature_1 \}\}/);
  assert.match(WORKFLOW, /PPV_RELEASE_APPROVER_2: \$\{\{ inputs\.approver_2 \}\}/);
  assert.match(WORKFLOW, /PPV_RELEASE_SIGNATURE_2: \$\{\{ inputs\.signature_2 \}\}/);
  assert.match(WORKFLOW, /node scripts\/verify-devnet-release-approval\.mjs/);
  assert.ok(
    stepIndex("Assert committed identity and build") < stepIndex("Verify independent devnet release approvals") &&
      stepIndex("Verify independent devnet release approvals") < stepIndex("Refuse an existing program address"),
    "approval must bind the asserted identity before a deployable address is considered",
  );
});

test("verify-only is the default and cannot reach a persistent deployment action", () => {
  assert.match(
    WORKFLOW,
    /verify_only:\n\s+description: "Run all devnet release checks but stop before deployment"\n\s+required: false\n\s+default: true\n\s+type: boolean/,
  );
  assert.match(WORKFLOW, /- name: Stop after verification\n\s+if: \$\{\{ inputs\.verify_only \}\}/);
  assert.match(WORKFLOW, /VERIFY-ONLY: all pre-deployment checks passed\./);
  assert.match(WORKFLOW, /No program deployment or authority transfer was attempted\./);

  const stop = stepIndex("Stop after verification");
  const deploy = stepIndex("Deploy with the deployer as temporary authority");
  assert.ok(
    stepIndex("Validate the configured final upgrade authority") < stop &&
      stop < deploy,
    "verify-only must run every pre-deployment check before persistent work is skipped",
  );

  for (const name of [
    "Deploy with the deployer as temporary authority",
    "Transfer upgrade authority to Squads",
    "Verify on chain and record the deployment",
    "Upload public deployment evidence",
  ]) {
    const index = stepIndex(name);
    const body = lines.slice(index, index + 8).join("\\n");
    assert.match(
      body,
      /if: \$\{\{ !inputs\.verify_only \}\}/,
      `${name} must be skipped in verify-only mode`,
    );
  }
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

/**
 * Static invariants of the read-only verification workflow.
 *
 * Its whole value is a negative property — that nothing in it can change the
 * chain, and that it needs no signing material to run. A property like that
 * does not survive on good intentions: it survives because adding a deploy
 * step, a keypair or a secret reference to the file fails a test here.
 */
/**
 * The executable part of a workflow: comments removed.
 *
 * These assertions are about what the file can *do*, and a comment explaining
 * that the workflow must never run `solana program deploy` is not an instance
 * of running it. Matching the raw text would make the safety documentation
 * fail the safety test, which teaches people to delete the documentation.
 */
function executable(yaml) {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const VERIFY_WORKFLOW = executable(
  readFileSync(join(REPO, ".github", "workflows", "verify-devnet-deployment.yml"), "utf8"),
);

test("verification contains no command that can mutate the chain", () => {
  const forbidden = [
    /solana\s+program\s+(deploy|write|upgrade|close|set-upgrade-authority|extend)/,
    /solana\s+(transfer|airdrop|send-transaction|sign)/,
    /set-upgrade-authority/,
    /anchor\s+(deploy|upgrade|idl\s+(init|upgrade|set-authority))/,
    /solana-keygen\s+new/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(VERIFY_WORKFLOW, pattern, `verification must not contain ${pattern}`);
  }
});

test("verification needs no secret, no keypair and no protected environment", () => {
  assert.doesNotMatch(VERIFY_WORKFLOW, /secrets\./, "verification must not read a repository secret");
  assert.doesNotMatch(VERIFY_WORKFLOW, /environment:\s*devnet/, "verification must not hold deploy credentials");
  assert.doesNotMatch(VERIFY_WORKFLOW, /keypair/i, "verification must not touch a keypair");
  assert.match(VERIFY_WORKFLOW, /^permissions:\n\s+contents: read$/m);
});

test("verification is separate from deployment and can run unattended", () => {
  // Separate file, separate concurrency group: a verification run must never
  // queue behind, or cancel, a deployment.
  assert.doesNotMatch(VERIFY_WORKFLOW, /group: deploy-devnet/);
  assert.match(VERIFY_WORKFLOW, /group: verify-devnet-deployment/);
  assert.match(VERIFY_WORKFLOW, /schedule:/);
  assert.match(VERIFY_WORKFLOW, /workflow_dispatch:/);
});

test("verification pins the devnet endpoint and the expected Squads vault", () => {
  assert.match(VERIFY_WORKFLOW, /PPV_RPC_URL: https:\/\/api\.devnet\.solana\.com/);
  assert.match(VERIFY_WORKFLOW, /PPV_SQUADS_VAULT_PDA: B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX/);
  assert.doesNotMatch(VERIFY_WORKFLOW, /mainnet/);
});

/**
 * Static invariants of the one-time evidence recovery workflow.
 *
 * It rebuilds a release and reads the chain. It must be able to do neither more
 * nor less than that.
 */
const RECOVERY_WORKFLOW = executable(
  readFileSync(join(REPO, ".github", "workflows", "recover-ppv-core-devnet-evidence.yml"), "utf8"),
);

test("evidence recovery cannot deploy, sign, or reach a secret", () => {
  for (const pattern of [
    /solana\s+program\s+(deploy|write|upgrade|close|set-upgrade-authority)/,
    /set-upgrade-authority/,
    /anchor\s+deploy/,
    /solana-keygen/,
    /secrets\./,
  ]) {
    assert.doesNotMatch(RECOVERY_WORKFLOW, pattern, `recovery must not contain ${pattern}`);
  }
  assert.match(RECOVERY_WORKFLOW, /^permissions:\n\s+contents: read$/m);
});

test("evidence recovery pins the exact deployed release commit", () => {
  assert.match(RECOVERY_WORKFLOW, /PPV_RELEASE_COMMIT: 861a8dfce9533f75494621b8a36e60e60447cc0c/);
  assert.match(RECOVERY_WORKFLOW, /ref: \$\{\{ env\.PPV_RELEASE_COMMIT \}\}/);
  // The rebuild is checked against the checkout, so a moved ref cannot quietly
  // produce a record describing a different source.
  assert.match(RECOVERY_WORKFLOW, /Checked out \$\{actual_commit\}, expected \$\{PPV_RELEASE_COMMIT\}/);
});

test("a released program can never be initially deployed again", () => {
  // PPV Core's initial deployment is complete. The refusal reads a committed
  // file first, so it holds even when the RPC call that follows it does not.
  assert.match(WORKFLOW, /for record in deployments\/evidence\/\*\.json/);
  assert.match(WORKFLOW, /Its initial deployment is COMPLETE/);
  assert.ok(
    WORKFLOW.indexOf("deployments/evidence/*.json") < WORKFLOW.indexOf("query-chain.mjs program"),
    "the committed-record refusal must not depend on a chain read succeeding",
  );
});

test("an unreadable chain is not treated as a free address", () => {
  assert.match(WORKFLOW, /Refusing to deploy on an unknown state/);
  assert.match(WORKFLOW, /if \[\[ "\$\{exists\}" != "false" \]\]/);
});

test("post-deployment verification reads public state without a signer", () => {
  // The failure this encodes: the Solana CLI wants a default signer even to
  // read, so a deployment that worked reported failure and left no evidence.
  const verifyStep = WORKFLOW.slice(stepIndexOffset("Verify on chain and record the deployment"));
  assert.doesNotMatch(verifyStep.slice(0, 2000), /solana (program show|account)\b/);
  assert.match(WORKFLOW, /node scripts\/query-chain\.mjs program/);
});

/** Character offset of a step's `- name:` line, for slicing one step out. */
function stepIndexOffset(name) {
  const offset = WORKFLOW.indexOf(`- name: ${name}`);
  assert.notEqual(offset, -1, `workflow has no step named '${name}'`);
  return offset;
}
