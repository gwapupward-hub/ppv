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
  assert.match(CODE, /preflight_only:/, "there is no preflight_only input");
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

/* ---------------------------------------- the read-only preflight workflow */

/**
 * The preflight workflow may run on pull requests; the execute workflow may
 * not. That difference is only safe because this one provably cannot sign
 * anything, so the properties that make it read-only are asserted here rather
 * than described in its header.
 */
const PREFLIGHT_PATH = join(".github", "workflows", "verify-escrow-custody-preflight.yml");
const PREFLIGHT_SOURCE = readFileSync(join(REPO, PREFLIGHT_PATH), "utf8");
const PREFLIGHT = PREFLIGHT_SOURCE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

test("the preflight workflow never runs the harness in execute mode", () => {
  assert.ok(
    !PREFLIGHT.includes("--execute"),
    "the read-only workflow must not invoke the value-moving mode",
  );
  assert.match(PREFLIGHT, /run: node scripts\/devnet-escrow-custody\.mjs\n/);
});

test("the preflight workflow takes no secrets and attaches no environment", () => {
  assert.ok(!PREFLIGHT.includes("secrets."), "a read-only job needs no secret");
  assert.doesNotMatch(PREFLIGHT, /^\s+environment:/m);
  assert.ok(!PREFLIGHT.includes("PPV_CUSTODY_FUNDER"), "it must not read a funder keypair");
});

test("the preflight workflow grants contents: read and nothing else", () => {
  assert.match(PREFLIGHT, /^permissions:\n\s+contents:\s*read\s*$/m);
  for (const scope of [
    "contents", "actions", "checks", "deployments", "id-token", "issues",
    "packages", "pages", "pull-requests", "security-events", "statuses",
  ]) {
    assert.doesNotMatch(PREFLIGHT, new RegExp(`${scope}:\\s*write`));
  }
});

test("the preflight workflow is pinned to devnet with no endpoint input", () => {
  assert.match(PREFLIGHT, /PPV_CUSTODY_RPC_URL: https:\/\/api\.devnet\.solana\.com/);
  assert.doesNotMatch(PREFLIGHT, /mainnet/i);
  assert.doesNotMatch(PREFLIGHT, /rpc_url:|endpoint:/);
});

test("the preflight workflow cannot deploy or move an authority", () => {
  for (const forbidden of [
    "solana program deploy",
    "solana program upgrade",
    "set-upgrade-authority",
    "anchor deploy",
    "record-deployment",
  ]) {
    assert.ok(!PREFLIGHT.includes(forbidden), `the preflight workflow runs ${forbidden}`);
  }
});

test("the preflight workflow actually performs the live Squads decode", () => {
  // Without --live-squads the verifier compares declared facts to policy, which
  // is the thing RR-7 says is not enough.
  assert.match(PREFLIGHT, /--live-squads/);
  assert.match(PREFLIGHT, /--multisig GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46/);
  assert.match(PREFLIGHT, /--vault FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE/);
});

test("only the execute workflow is workflow_dispatch-only", () => {
  // Stated as a pair so the two files cannot converge: the preflight may run on
  // pull requests precisely because it cannot sign, and the execute workflow
  // may not, whatever it can or cannot do.
  const preflightOn = PREFLIGHT.match(/^on:\n([\s\S]*?)\n(?=\w)/m)[1];
  assert.match(preflightOn, /pull_request:/);
  const executeOn = CODE.match(/^on:\n([\s\S]*?)\n(?=\w)/m)[1];
  assert.doesNotMatch(executeOn, /pull_request:/);
});

/* ------------------------------ the closure and the check that supports it */

/**
 * RR-7 is closed for the custody multisig because the live decode happened and
 * keeps happening. If the check that re-establishes it were removed, the
 * register would be asserting a fact nothing checks any more — which is the
 * exact shape of the problem RR-7 described in the first place.
 *
 * So the two are tied together here: while the register claims the closure, the
 * preflight workflow must still perform the live decode on pull requests.
 */
test("RR-7's closure is backed by a check that still runs", () => {
  const register = readFileSync(
    join(REPO, "docs", "security", "ppv-escrow-residual-risk.md"),
    "utf8",
  );
  const rr7 = register.match(/### RR-7 — [^\n]*/)?.[0] ?? "";
  if (!/CLOSED/.test(rr7)) return; // Nothing to support.

  assert.match(
    PREFLIGHT,
    /--live-squads/,
    "RR-7 is recorded as closed, but the preflight workflow no longer performs the live decode",
  );
  const on = PREFLIGHT.match(/^on:\n([\s\S]*?)\n(?=\w)/m)[1];
  assert.match(
    on,
    /pull_request:/,
    "RR-7 is recorded as closed, but the live decode no longer runs on pull requests",
  );
  assert.match(
    register,
    /squads_live_decode=read-from-chain/,
    "the closure must cite the verifier output that established it",
  );
  assert.match(
    register,
    /actions\/runs\/\d+/,
    "the closure must cite the run that established it",
  );
});

test("RR-7's closure is scoped, not blanket", () => {
  const register = readFileSync(
    join(REPO, "docs", "security", "ppv-escrow-residual-risk.md"),
    "utf8",
  );
  const rr7 = register.match(/### RR-7 —[\s\S]*?(?=\n### )/)?.[0] ?? "";
  if (!/CLOSED/.test(rr7)) return;
  // Core/Commerce governance is still verified from declared facts, and this
  // repository records no multisig address for its vault, so there is nothing
  // to decode. A closure that did not say so would overstate itself.
  assert.match(rr7, /B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX/);
  assert.match(rr7, /What this does not close/);
});

/* ------------------------------------------------------- the funder preflight */

/**
 * The funder is checked before the matrix starts, not discovered mid-run.
 *
 * Two failures are cheap at the start and expensive late. A missing secret
 * costs nothing if it stops the job before anything exists. A funder too thin
 * for the full matrix, if it is only discovered partway through, can stop the
 * run between a `fund` and its settlement — which leaves tokens in a vault,
 * violates the accounting rule that every test vault ends at zero, and burns an
 * authorization that has to be granted again before another run.
 */
test("the funder is checked before the live run, not during it", () => {
  const preflight = CODE.indexOf("- name: Funder preflight");
  const liveRun = CODE.indexOf("- name: Live custody run");
  assert.ok(preflight > -1, "there is no funder preflight step");
  assert.ok(liveRun > -1, "there is no live custody run step");
  assert.ok(preflight < liveRun, "the funder preflight must come first");
});

test("a missing funder secret stops the job before anything is created", () => {
  assert.match(CODE, /if \[ -z "\$\{PPV_CUSTODY_FUNDER_SECRET:-\}" \]; then/);
  assert.match(CODE, /PPV_CUSTODY_FUNDER_KEYPAIR is not configured/);
});

test("the funder preflight enforces a balance floor", () => {
  assert.match(CODE, /getBalance/);
  assert.match(CODE, /lamports < 1e9/, "the floor must be asserted, not merely reported");
  assert.match(CODE, /needs at least 1 SOL/);
});

test("the funder preflight prints the public address and nothing else about it", () => {
  assert.match(CODE, /funder public address: \$\{funder\.publicKey\.toBase58\(\)\}/);
  assert.match(CODE, /funder devnet balance/);
  // The secret must never reach a log, directly or through an error object
  // carrying the input it failed to parse.
  assert.ok(!/console\.log\([^)]*secretKey/.test(CODE));
  assert.ok(!/console\.error\("::error::funder preflight failed:", error\)/.test(CODE));
  assert.match(CODE, /error\?\.message \?\? "unknown error"/);
});

test("the live run step no longer carries the secret in its environment", () => {
  // It reads the file the preflight wrote. Narrowing the env is free and means
  // one fewer step in which the value could be echoed by a future edit.
  const liveRun = CODE.slice(
    CODE.indexOf("- name: Live custody run"),
    CODE.indexOf("- name: Remove the funder keypair"),
  );
  assert.ok(liveRun.length > 0);
  assert.ok(
    !liveRun.includes("PPV_CUSTODY_FUNDER_SECRET"),
    "the live run step must not take the secret; it takes the path",
  );
  assert.match(liveRun, /PPV_CUSTODY_FUNDER: \$\{\{ runner\.temp \}\}\/custody-funder\.json/);
});

test("the keypair file is still removed whatever happens", () => {
  const remove = CODE.indexOf("- name: Remove the funder keypair");
  const preflight = CODE.indexOf("- name: Funder preflight");
  assert.ok(remove > preflight, "cleanup must follow the step that writes the file");
  assert.match(CODE, /- name: Remove the funder keypair\n\s+if: always\(\)\n\s+run: rm -f/);
});
