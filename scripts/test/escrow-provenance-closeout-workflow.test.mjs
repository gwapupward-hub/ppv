import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ESCROW_CUSTODY_GOVERNANCE, PERMANENT_PROGRAM_IDS } from "../lib/identity.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The provenance-closeout workflow, held to being read-only — and to keeping
 * the two commits it juggles apart.
 *
 * This workflow builds a release commit and writes a release record. Both of
 * those are one small edit away from something that deploys, and the record it
 * writes is the document every later verification trusts. So the properties
 * that make it safe, and the ones that make its output honest, are asserted
 * here rather than described in its header.
 *
 * As with the recovery workflow: the file's own prose necessarily *names* the
 * things it must not do, so assertions about what it executes run against the
 * YAML with comment lines stripped, and assertions about what it documents run
 * against the whole file.
 */

const PATH = join(".github", "workflows", "escrow-provenance-closeout.yml");
const SOURCE = readFileSync(join(REPO, PATH), "utf8");

/** The workflow with comment lines removed: what it actually executes. */
const CODE = SOURCE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/**
 * One step legitimately names secret material: the scanner that checks the
 * artifact for it before upload. Its pattern list is data, not a reference to
 * anything the job holds — so the "nothing secret is named" assertions run
 * against the workflow with that step removed, and a separate test pins the
 * scanner down so the carve-out cannot be used to hide a real reference.
 */
const SCANNER_STEP = "Confirm the closeout carries no secret material";

function withoutStep(code, name) {
  const lines = code.split("\n");
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`));
  assert.notEqual(start, -1, `the workflow has no step named ${name}`);
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() !== "" && lines[end].search(/\S/) <= indent)) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/** What the job executes, minus the artifact scanner. */
const CODE_LESS_SCANNER = withoutStep(CODE, SCANNER_STEP);

const DEPLOYED_SOURCE_SHA = "231dceb91c141e1afe6e57ef48fafb199da5c678";
const EVIDENCE_TOOLING_SHA = "1b9d4c1abaa33645477312007ac84829693faf79";
const BINARY_SHA256 = "0acc61defeb2ee810cf3a4bc87f93f8ef457399fe6b52d170055ed7e0c96f9bf";
const IDL_SHA256 = "d8eb433e4674d5335294c2110dba9c3a36972b5b90e42abe32f495ca98c15dcb";

/* ------------------------------------------------------------ permissions */

test("the workflow grants contents: read and nothing else", () => {
  assert.match(CODE, /^permissions:\n\s+contents:\s*read\s*$/m);
  // Exactly one permissions block, so a second cannot widen the first.
  assert.equal((CODE.match(/^permissions:/gm) ?? []).length, 1);
});

test("no write permission of any kind is granted", () => {
  // Every scope GitHub offers, checked for `write` — named individually rather
  // than pattern-matching `write` alone, so a scope added in a future edit is
  // visible as an omission here rather than silently allowed.
  for (const scope of [
    "contents", "actions", "checks", "deployments", "id-token", "issues",
    "discussions", "packages", "pages", "pull-requests", "repository-projects",
    "security-events", "statuses", "attestations",
  ]) {
    assert.doesNotMatch(CODE, new RegExp(`${scope}:\\s*write`), `the workflow grants ${scope}: write`);
  }
  assert.doesNotMatch(CODE, /permissions:\s*write-all/);
});

/* --------------------------------------------------------------- secrets */

test("the workflow references no GitHub secret", () => {
  assert.doesNotMatch(CODE, /\$\{\{\s*secrets\./, "the workflow reads a repository secret");
  assert.doesNotMatch(CODE, /secrets:/, "the workflow passes secrets to something");
});

test("no environment holding deployment secrets is attached", () => {
  // An `environment:` key would hand this job the devnet secrets — the program
  // keypair and the deployer — whether or not it asked for them.
  assert.doesNotMatch(CODE, /^\s+environment:/m, "the job attaches a GitHub environment");
});

test("no keypair or signing material is named", () => {
  for (const name of [
    "PPV_ESCROW_PROGRAM_KEYPAIR",
    "PPV_DEPLOYER_KEYPAIR",
    "PPV_CORE_PROGRAM_KEYPAIR",
    "PPV_COMMERCE_PROGRAM_KEYPAIR",
  ]) {
    assert.ok(!CODE.includes(name), `the workflow references ${name}`);
  }
  assert.doesNotMatch(CODE, /-keypair\.json/);
  assert.doesNotMatch(CODE, /solana-keygen|solana config set/);
  assert.doesNotMatch(CODE_LESS_SCANNER, /secretKey|seed phrase|recovery phrase|mnemonic/i);
  assert.doesNotMatch(CODE_LESS_SCANNER, /(\d+,\s*){20,}\d+/, "a literal key array is in the workflow");
});

test("the one step that names secret material only scans for it", () => {
  // The carve-out above is only safe if that step is what it claims to be: a
  // scanner that reads the artifact and exits non-zero on a match. It takes no
  // input, holds no value, and cannot be the place a reference hides.
  const removed = CODE.length - CODE_LESS_SCANNER.length;
  assert.ok(removed > 0, "the scanner step was not found, so the carve-out removed nothing");
  const step = CODE.slice(CODE.indexOf(`- name: ${SCANNER_STEP}`), CODE.indexOf(`- name: ${SCANNER_STEP}`) + removed);
  assert.doesNotMatch(step, /\$\{\{\s*(secrets|inputs)\./, "the scanner takes an input");
  assert.doesNotMatch(step, /^\s+env:/m, "the scanner is handed environment values");
  assert.match(step, /process\.exit\(1\)/, "the scanner does not fail on a match");
  assert.match(step, /readdirSync\("closeout"\)/, "the scanner does not read the artifact directory");
});

/* ----------------------------------------------------- no chain mutation */

test("no Solana deployment or authority command is invoked", () => {
  for (const command of [
    /solana program deploy/,
    /solana program write-buffer/,
    /solana program close/,
    /solana program extend/,
    /set-upgrade-authority/,
    /solana transfer/,
    /solana airdrop/,
    /anchor deploy/,
    /anchor upgrade/,
    /anchor idl (init|upgrade|set-authority)/,
    /sendTransaction/,
    /signTransaction/,
    /partialSign/,
  ]) {
    assert.doesNotMatch(CODE, command, `the workflow invokes ${command}`);
  }
  // `anchor build` is the one anchor subcommand it may run.
  const anchorCalls = [...CODE.matchAll(/anchor\s+([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(anchorCalls)], ["build"], `the workflow runs anchor ${anchorCalls.join(", ")}`);
});

test("the deployment workflow is never invoked and the trigger is manual only", () => {
  assert.doesNotMatch(CODE, /deploy-devnet/, "the workflow references the deployment workflow");
  assert.doesNotMatch(CODE, /workflow_call|uses:\s*\.\/\.github\/workflows/);
  assert.match(CODE, /^on:\n\s+workflow_dispatch:/m);
  for (const trigger of ["push:", "pull_request:", "schedule:", "release:", "repository_dispatch:"]) {
    assert.ok(!CODE.includes(trigger), `the workflow triggers on ${trigger}`);
  }
});

test("no repository mutation command is invoked", () => {
  for (const command of [
    /git push/,
    /git commit/,
    /git tag/,
    /gh release/,
    /gh pr/,
    /gh issue/,
    /gh api.*-X\s*(POST|PATCH|PUT|DELETE)/,
  ]) {
    assert.doesNotMatch(CODE, command, `the workflow mutates the repository: ${command}`);
  }
  // Checkout must not leave credentials behind for a later step to use.
  assert.match(CODE, /persist-credentials:\s*false/);
  // The git commands it does run only read or lay out a worktree.
  // `(?<![-\w])` so `cargo install --git https://...` is not read as a git call.
  const gitCalls = [...CODE.matchAll(/(?<![-\w])git\s+(?:-C\s+\S+\s+)?([a-z-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(gitCalls)].sort(),
    ["cat-file", "checkout", "rev-parse", "worktree"],
    `the workflow runs unexpected git subcommands: ${gitCalls.join(", ")}`,
  );
});

/* ------------------------------------- the two commits stay distinguishable */

test("both commits are pinned, in full, and are not each other", () => {
  assert.match(CODE, new RegExp(`DEPLOYED_SOURCE_SHA:\\s*${DEPLOYED_SOURCE_SHA}`));
  assert.match(CODE, new RegExp(`EVIDENCE_TOOLING_SHA:\\s*${EVIDENCE_TOOLING_SHA}`));
  assert.notEqual(DEPLOYED_SOURCE_SHA, EVIDENCE_TOOLING_SHA);
  for (const sha of [DEPLOYED_SOURCE_SHA, EVIDENCE_TOOLING_SHA]) {
    assert.match(sha, /^[0-9a-f]{40}$/);
  }
  // Both are asserted at runtime rather than merely checked out.
  assert.match(CODE, /Refusing to run: HEAD is \$\{head\}, expected \$\{EVIDENCE_TOOLING_SHA\}/);
  assert.match(CODE, /the release worktree is at \$\{release_head\}, expected \$\{DEPLOYED_SOURCE_SHA\}/);
  assert.match(CODE, /fetch-depth:\s*0/);
});

test("the release source is built in its own tree, never in the tooling tree", () => {
  assert.match(CODE, /git worktree add --quiet --detach "\$\{RELEASE_TREE\}" "\$\{DEPLOYED_SOURCE_SHA\}"/);
  assert.match(CODE, /RELEASE_TREE:\s*release-source/);
  // The build runs inside that worktree and nowhere else.
  assert.match(CODE, /working-directory:\s*\$\{\{\s*env\.RELEASE_TREE\s*\}\}/);
  assert.match(CODE, /cargo clean/, "the rebuild does not start from a clean tree");
});

test("the collector that runs is the tooling one, and that is proved not assumed", () => {
  // The specific way this job could produce a plausible lie: run the release
  // source's own older collector, which cannot record recovery provenance, and
  // emit a record indistinguishable from one written by its own deployment.
  assert.match(CODE, /if \[\[ "\$\{tooling_collector\}" == "\$\{release_collector\}" \]\]/);
  assert.match(CODE, /grep -q "PPV_EVIDENCE_RECOVERY_COMMIT" scripts\/collect-deployment-evidence\.mjs/);
  assert.match(CODE, /if \[\[ -e "\$\{RELEASE_TREE\}\/scripts\/recover-escrow-evidence\.mjs" \]\]/);
  assert.match(CODE, /COLLECTORS_DISTINCT=YES/);
});

test("the separation the workflow asserts is true of these commits", async () => {
  // The runtime checks above are only meaningful if the pinned commits really
  // differ in the ways they test for. Asserted here against the repository so
  // a future re-pin that breaks the premise fails locally.
  const { execFileSync } = await import("node:child_process");
  const show = (sha, path) => execFileSync("git", ["show", `${sha}:${path}`], { cwd: REPO, encoding: "utf8" });

  const releaseCollector = show(DEPLOYED_SOURCE_SHA, "scripts/collect-deployment-evidence.mjs");
  const toolingCollector = show(EVIDENCE_TOOLING_SHA, "scripts/collect-deployment-evidence.mjs");
  assert.notEqual(releaseCollector, toolingCollector, "the two commits carry the same collector");
  assert.ok(toolingCollector.includes("PPV_EVIDENCE_RECOVERY_COMMIT"));
  assert.ok(!releaseCollector.includes("PPV_EVIDENCE_RECOVERY_COMMIT"));
  assert.ok(toolingCollector.includes("PPV_BUILD_DIR"), "the tooling collector cannot read a foreign build dir");

  // The recovery tooling does not exist at the release commit.
  assert.throws(
    () => show(DEPLOYED_SOURCE_SHA, "scripts/recover-escrow-evidence.mjs"),
    "the release source contains the recovery tooling",
  );
});

test("the record names the deployed source and the recovery commit separately", () => {
  assert.match(CODE, /PPV_RELEASE_COMMIT:\s*\$\{\{\s*env\.DEPLOYED_SOURCE_SHA\s*\}\}/);
  assert.match(CODE, /PPV_EVIDENCE_RECOVERY_COMMIT:\s*\$\{\{\s*env\.EVIDENCE_TOOLING_SHA\s*\}\}/);
  // The artifacts are read out of the release worktree by the tooling here.
  assert.match(CODE, /PPV_BUILD_DIR:\s*release-source\/target/);
  // And never from `git rev-parse HEAD`, which is the tooling commit.
  assert.doesNotMatch(CODE, /PPV_RELEASE_COMMIT:.*(github\.sha|rev-parse)/);
});

/* --------------------------------------------------- the rebuild is pinned */

test("the rebuild must reproduce the deployed program exactly", () => {
  assert.match(CODE, new RegExp(`EXPECTED_BINARY_SHA256:\\s*${BINARY_SHA256}`));
  assert.match(CODE, new RegExp(`EXPECTED_IDL_SHA256:\\s*${IDL_SHA256}`));
  assert.match(CODE, new RegExp(`EXPECTED_PROGRAM_ID:\\s*${PERMANENT_PROGRAM_IDS.ppv_escrow}`));
  assert.match(CODE, /SOURCE_REBUILD_MATCH=NO/);
  assert.match(CODE, /if \[\[ "\$\{failed\}" -ne 0 \]\]/);
});

test("the build toolchain is pinned to the release toolchain", () => {
  assert.match(CODE, /rustup toolchain install 1\.79\.0 --profile minimal/);
  assert.match(CODE, /rustup toolchain install nightly-2024-06-15 --profile minimal/);
  assert.match(CODE, /release\.anza\.xyz\/v1\.18\.17\/install/);
  assert.match(CODE, /--tag v0\.30\.1 anchor-cli --locked --force/);
  assert.match(CODE, /RUSTUP_TOOLCHAIN=nightly-2024-06-15 anchor build/);
});

/* ------------------------------------------------------------ fail closed */

test("UNKNOWN is failure and no step swallows one", () => {
  assert.doesNotMatch(CODE, /\|\|\s*true/, "a command swallows its failure");
  assert.doesNotMatch(CODE, /continue-on-error:\s*true/);
  // The recovery's exit code is preserved rather than reinterpreted.
  assert.match(CODE, /exit "\$\{code\}"/);
  assert.match(CODE, /ONCHAIN_PROGRAM_VERIFICATION=NOT_PROVEN/);
  // A missing or duplicated signature stops the job before a record is written.
  assert.match(CODE, /no transaction proved the authority transfer/);
  assert.match(CODE, /one signature is recorded as both the deploy and the transfer/);
  // Only the reporting and upload steps may run after a failure, and neither
  // can turn the job green.
  const conditions = [...CODE.matchAll(/^\s+if:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(conditions)].sort(), ["always()", "failure()"]);
});

test("the signature values are never read back through a status-losing eval", () => {
  // `eval "$(node ...)"` reports eval's status, not node's, so a refusal would
  // have produced empty signatures and carried on.
  assert.doesNotMatch(CODE, /eval\s+"\$\(/, "a checker's exit status is discarded by eval");
  assert.match(CODE, /appendFileSync\(process\.env\.GITHUB_OUTPUT/);
});

/* ------------------------------------------ what the record is built from */

test("governance comes from the frozen record, not from a previous report", () => {
  assert.match(CODE, /import \{ ESCROW_CUSTODY_GOVERNANCE \} from "\.\/scripts\/lib\/identity\.mjs"/);
  assert.match(CODE, /PPV_UPGRADE_AUTHORITY_MEMBERS:\s*\$\{\{\s*steps\.governance\.outputs\.members\s*\}\}/);
  assert.match(CODE, /PPV_UPGRADE_AUTHORITY_THRESHOLD:\s*\$\{\{\s*steps\.governance\.outputs\.threshold\s*\}\}/);
  // No transcribed custody literal: the vault and members appear nowhere in the
  // workflow, so they cannot drift from the frozen record.
  for (const value of [ESCROW_CUSTODY_GOVERNANCE.vault, ...ESCROW_CUSTODY_GOVERNANCE.members]) {
    assert.ok(!CODE.includes(value), `the workflow hardcodes custody value ${value}`);
  }
  // Likewise the signatures: read from the live recovery, never pasted in.
  assert.match(CODE, /PPV_DEPLOY_SIGNATURE:\s*\$\{\{\s*steps\.recover\.outputs\.deploy_signature\s*\}\}/);
  assert.match(CODE, /PPV_AUTHORITY_TRANSFER_SIGNATURE:\s*\$\{\{\s*steps\.recover\.outputs\.transfer_signature\s*\}\}/);
});

test("the only project scripts it runs are the three signer-free readers", () => {
  const nodeCalls = [...CODE.matchAll(/node\s+(?:--[\w=-]+\s+)*(scripts\/[\w./-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(nodeCalls)].sort(),
    [
      "scripts/collect-deployment-evidence.mjs",
      "scripts/recover-escrow-evidence.mjs",
      "scripts/verify-deployed-program.mjs",
    ],
    `the workflow runs other project scripts: ${nodeCalls.join(", ")}`,
  );
  assert.match(CODE, /--rpc "\$\{RPC_URL\}"/);
  assert.match(CODE, /RPC_URL:\s*https:\/\/api\.devnet\.solana\.com/);
});

test("the three scripts it runs are themselves read-only", () => {
  // The workflow's safety is only as good as what it runs.
  for (const name of [
    "recover-escrow-evidence.mjs",
    "collect-deployment-evidence.mjs",
    "verify-deployed-program.mjs",
  ]) {
    const script = readFileSync(join(REPO, "scripts", name), "utf8");
    for (const pattern of [/sendTransaction/, /signTransaction/, /Keypair/, /secretKey/, /-keypair\.json/]) {
      assert.doesNotMatch(script, pattern, `${name} is not read-only: ${pattern}`);
    }
  }
});

test("the evidence tooling installs no third-party code", () => {
  // `cargo install anchor-cli` is the build toolchain, in the build step; the
  // evidence tooling itself must stay dependency-free, which is what lets this
  // job carry no npm supply chain at all.
  assert.doesNotMatch(CODE, /npm ci|npm install|yarn|pnpm/);
  assert.match(CODE, /node_modules is present/);
});

/* --------------------------------------------------- the published artifact */

test("the artifact is the closeout directory and is checked for key material", () => {
  assert.match(CODE, /name:\s*ppv-escrow-provenance-closeout/);
  assert.match(CODE, /path:\s*closeout\//);
  // Never the build tree: `anchor build` leaves an unused ephemeral program
  // keypair under target/, which must not be published.
  assert.doesNotMatch(CODE, /path:\s*(release-source|target|\.)\s*$/m);
  assert.match(CODE, /closeout artifact carries no key material/);
  assert.match(CODE, /if:\s*always\(\)/);
});

test("the record path is the canonical one for this release", () => {
  assert.match(CODE, /RECORD_PATH:\s*deployments\/evidence\/ppv-escrow-devnet-231dceb\.json/);
  assert.match(CODE, /node scripts\/verify-deployed-program\.mjs "\$\{RECORD_PATH\}"/);
});

/* ----------------------------------------------------------- documentation */

test("the workflow documents why each guarantee holds", () => {
  // Against the full source, comments included: an operator reading the file
  // should find the reasoning, not just the switches.
  assert.match(SOURCE, /permissions: contents: read/);
  assert.match(SOURCE, /No `environment:` key/);
  assert.match(SOURCE, /signer-free/);
  assert.match(SOURCE, /UNKNOWN is failure/);
  assert.match(SOURCE, /built nothing that is deployed/);
});
