import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The live custody workflow, held to the properties that make it safe to have.
 *
 * This is the only PPV workflow that signs value-moving transactions against a
 * deployed program. Every dangerous thing it could grow into is a small edit
 * away and would read as reasonable in a diff: a `schedule:` so runs happen
 * regularly, a `pull_request:` so changes are tested, an `rpc_url` input so it
 * can be pointed somewhere else, a `deploy` step "while we're here". So those
 * properties are asserted here, and a change that removes one fails the suite
 * rather than shipping.
 *
 * As in `recover-workflow.test.mjs`: the workflow's prose necessarily *names*
 * the things it must not do, so assertions about what it executes run against
 * the YAML with comment lines stripped, and assertions about what it documents
 * run against the whole file.
 */

const PATH = join(".github", "workflows", "devnet-escrow-custody-validation.yml");
const SOURCE = readFileSync(join(REPO, PATH), "utf8");
const CODE = SOURCE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/* ----------------------------------------------------------- the triggers */

test("the workflow is workflow_dispatch and nothing else", () => {
  const on = CODE.match(/^on:\n([\s\S]*?)\n(?=\w)/m)?.[1];
  assert.ok(on, "the workflow has no `on:` block");
  assert.match(on, /^\s{2}workflow_dispatch:/m);
  for (const trigger of [
    "push",
    "pull_request",
    "pull_request_target",
    "schedule",
    "release",
    "issue_comment",
    "repository_dispatch",
    "workflow_call",
    "workflow_run",
  ]) {
    assert.doesNotMatch(
      on,
      new RegExp(`^\\s{2}${trigger}:`, "m"),
      `the custody run must never be triggered by ${trigger}`,
    );
  }
});

test("there is no scheduled execution", () => {
  assert.doesNotMatch(CODE, /cron/i, "a custody run must not happen on a clock");
});

test("the run is named as live devnet custody validation", () => {
  assert.match(SOURCE, /^name: Live DEVNET custody validation \(ppv_escrow\)$/m);
});

test("a live run requires an explicit confirmation and is not the default", () => {
  assert.match(CODE, /confirm:\n\s+description: Type ppv_escrow/);
  assert.match(CODE, /required: true/);
  // preflight_only defaults to true: dispatching with everything left alone
  // reads the chain and sends nothing.
  const preflight = CODE.match(/preflight_only:\n([\s\S]*?)\n\s{4}\w|preflight_only:\n([\s\S]*)$/);
  assert.ok(preflight, "there is no preflight_only input");
  assert.match(CODE, /preflight_only:[\s\S]*?default: true/);
  assert.match(CODE, /if: \$\{\{ !inputs\.preflight_only \}\}/);
});

/* --------------------------------------------------------- the cluster */

test("there is no RPC endpoint input; the cluster is fixed to devnet", () => {
  assert.match(CODE, /PPV_CUSTODY_RPC_URL: https:\/\/api\.devnet\.solana\.com/);
  assert.doesNotMatch(
    CODE,
    /rpc_url:|endpoint:|cluster:/,
    "an endpoint input is the one thing that could point this at another cluster",
  );
});

test("no mainnet endpoint appears anywhere in the workflow", () => {
  assert.doesNotMatch(CODE, /mainnet/i);
});

/* ------------------------------------------------------------ permissions */

test("the workflow grants contents: read and nothing else", () => {
  assert.match(CODE, /^permissions:\n\s+contents:\s*read\s*$/m);
  assert.equal((CODE.match(/^permissions:/gm) ?? []).length, 1);
});

test("no write permission of any kind is granted", () => {
  for (const scope of [
    "contents", "actions", "checks", "deployments", "id-token", "issues",
    "discussions", "packages", "pages", "pull-requests", "repository-projects",
    "security-events", "statuses", "attestations",
  ]) {
    assert.doesNotMatch(CODE, new RegExp(`${scope}:\\s*write`), `grants ${scope}: write`);
  }
  assert.doesNotMatch(CODE, /permissions:\s*write-all/);
});

/* -------------------------------------------------- what it must not run */

test("the workflow cannot deploy, upgrade, or move an authority", () => {
  for (const forbidden of [
    "solana program deploy",
    "solana program write-buffer",
    "solana program upgrade",
    "solana program close",
    "solana program set-upgrade-authority",
    "set-upgrade-authority",
    "anchor deploy",
    "anchor upgrade",
    "record-deployment",
    "collect-deployment-evidence",
  ]) {
    assert.ok(
      !CODE.includes(forbidden),
      `the custody workflow runs ${forbidden}, which is outside what it may do`,
    );
  }
});

test("it holds no program keypair and no deployer keypair", () => {
  for (const secret of [
    "PPV_ESCROW_PROGRAM_KEYPAIR",
    "PPV_CORE_PROGRAM_KEYPAIR",
    "PPV_COMMERCE_PROGRAM_KEYPAIR",
    "PPV_DEPLOYER_KEYPAIR",
  ]) {
    assert.ok(!CODE.includes(secret), `the custody workflow references ${secret}`);
  }
});

test("the only PPV secret it takes is the disposable funder", () => {
  const secrets = [...CODE.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(secrets)], ["PPV_CUSTODY_FUNDER_KEYPAIR"]);
});

test("the funder keypair is removed whatever happens", () => {
  assert.match(CODE, /- name: Remove the funder keypair\n\s+if: always\(\)\n\s+run: rm -f/);
});

test("the funder secret is never echoed", () => {
  // `printf '%s' "$VAR" > file` and not `echo`, because a shell that traces
  // commands would put the key in the log.
  assert.doesNotMatch(CODE, /echo\s+"?\$\{?\{?\s*secrets\./);
  assert.doesNotMatch(CODE, /echo .*PPV_CUSTODY_FUNDER_SECRET/);
  assert.match(CODE, /printf '%s' "\$\{PPV_CUSTODY_FUNDER_SECRET\}"/);
});

/* --------------------------------------------------- what it must run */

test("the deterministic suite runs before anything is signed", () => {
  const releaseTests = CODE.indexOf("npm run test:release");
  const liveRun = CODE.indexOf("devnet-escrow-custody.mjs --execute");
  assert.ok(releaseTests > -1, "the offline harness suite must run");
  assert.ok(liveRun > -1, "the live run step must exist");
  assert.ok(
    releaseTests < liveRun,
    "the offline refusals must be exercised before the live run, not after it",
  );
});

test("a read-only preflight runs before the live run", () => {
  const preflight = CODE.indexOf("run: node scripts/devnet-escrow-custody.mjs\n");
  const liveRun = CODE.indexOf("devnet-escrow-custody.mjs --execute");
  assert.ok(preflight > -1 && preflight < liveRun);
});

test("the published artifact is scanned for key material first", () => {
  const scan = CODE.indexOf("Refuse to publish an artifact containing key material");
  const upload = CODE.indexOf("upload-artifact");
  assert.ok(scan > -1 && upload > -1 && scan < upload);
  assert.match(CODE, /secretKey\|secret_key\|privateKey\|private_key\|keypair\|mnemonic\|seedPhrase/);
});

test("one custody run at a time, and a run is never cancelled mid-flight", () => {
  assert.match(CODE, /group: devnet-escrow-custody-validation/);
  assert.match(CODE, /cancel-in-progress: false/);
});
