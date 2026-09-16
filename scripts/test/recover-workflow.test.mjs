import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The read-only recovery workflow, held to being read-only.
 *
 * This workflow exists to run one script against devnet and report what it
 * found. Everything dangerous it could grow into — a secret, a write scope, a
 * deployment command — would be a small edit away and would look reasonable in
 * a diff. So the properties that make it safe are asserted here rather than
 * described in its header, and a change that quietly removes one fails the
 * suite instead of shipping.
 *
 * The distinction worth keeping in mind while reading these: the workflow's own
 * prose necessarily *names* the things it must not do. Assertions about what it
 * executes therefore run against the YAML with comment lines stripped, and
 * assertions about what it documents run against the whole file.
 */

const PATH = join(".github", "workflows", "recover-escrow-evidence.yml");
const SOURCE = readFileSync(join(REPO, PATH), "utf8");

/** The workflow with comment lines removed: what it actually executes. */
const CODE = SOURCE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const AUDITED_SHA = "fbb81bf0d5c64588f1fe8712e9ff2c3af4707852";

/* ------------------------------------------------------------ permissions */

test("the workflow grants contents: read and nothing else", () => {
  assert.match(CODE, /^permissions:\n\s+contents:\s*read\s*$/m);
  // Exactly one permissions block, so a second cannot widen the first.
  assert.equal((CODE.match(/^permissions:/gm) ?? []).length, 1);
});

test("no write permission of any kind is granted", () => {
  // Every scope GitHub offers, checked for `write` — naming them individually
  // rather than pattern-matching `write` alone, so a new scope added in a
  // future edit is visible as an omission here rather than silently allowed.
  for (const scope of [
    "contents", "actions", "checks", "deployments", "id-token", "issues",
    "discussions", "packages", "pages", "pull-requests", "repository-projects",
    "security-events", "statuses", "attestations",
  ]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(`${scope}:\\s*write`),
      `the workflow grants ${scope}: write`,
    );
  }
  assert.doesNotMatch(CODE, /permissions:\s*write-all/);
});

/* --------------------------------------------------------------- secrets */

test("the workflow references no GitHub secret", () => {
  assert.doesNotMatch(CODE, /\$\{\{\s*secrets\./, "the workflow reads a repository secret");
  assert.doesNotMatch(CODE, /secrets:/, "the workflow passes secrets to something");
});

test("no deployment keypair or custody signer key is named", () => {
  for (const name of [
    "PPV_ESCROW_PROGRAM_KEYPAIR",
    "PPV_DEPLOYER_KEYPAIR",
    "PPV_CORE_PROGRAM_KEYPAIR",
    "PPV_COMMERCE_PROGRAM_KEYPAIR",
  ]) {
    assert.ok(!CODE.includes(name), `the workflow references ${name}`);
  }
  assert.doesNotMatch(CODE, /-keypair\.json/);
  assert.doesNotMatch(CODE, /secretKey|seed phrase|recovery phrase|mnemonic/i);
  assert.doesNotMatch(CODE, /(\d+,\s*){20,}\d+/, "a literal key array is in the workflow");
});

test("no environment holding deployment secrets is attached", () => {
  // An `environment:` key would hand this job the devnet secrets whether or not
  // it asked for them.
  assert.doesNotMatch(CODE, /^\s+environment:/m, "the job attaches a GitHub environment");
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
  ]) {
    assert.doesNotMatch(CODE, command, `the workflow invokes ${command}`);
  }
});

test("the initial deployment workflow is never invoked", () => {
  assert.doesNotMatch(CODE, /deploy-devnet/, "the workflow references the deployment workflow");
  assert.doesNotMatch(CODE, /workflow_call|uses:\s*\.\/\.github\/workflows/);
  // And it is dispatched by hand only: no push, schedule or event trigger.
  assert.match(CODE, /^on:\n\s+workflow_dispatch:/m);
  for (const trigger of ["push:", "pull_request:", "schedule:", "release:", "repository_dispatch:"]) {
    assert.ok(!CODE.includes(trigger), `the workflow triggers on ${trigger}`);
  }
});

test("no repository mutation command is invoked", () => {
  for (const command of [/git push/, /git commit/, /git tag/, /gh release/, /gh pr/, /gh api.*-X\s*(POST|PATCH|PUT|DELETE)/]) {
    assert.doesNotMatch(CODE, command, `the workflow mutates the repository: ${command}`);
  }
  // Checkout must not leave credentials behind for a later step to use.
  assert.match(CODE, /persist-credentials:\s*false/);
});

/* -------------------------------------------------------- what it runs */

test("the only project command it runs is the recovery script", () => {
  const nodeCalls = [...CODE.matchAll(/node\s+(?:--[\w=-]+\s+)*(scripts\/[\w./-]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(nodeCalls)],
    ["scripts/recover-escrow-evidence.mjs"],
    `the workflow runs other project scripts: ${nodeCalls.join(", ")}`,
  );
  assert.match(CODE, /--rpc https:\/\/api\.devnet\.solana\.com/);
  assert.match(CODE, /--json/);
});

test("setup installs nothing and the job proves it", () => {
  assert.doesNotMatch(CODE, /npm ci|npm install|yarn|pnpm|cargo install/);
  // The recovery script imports only node:crypto and dependency-free locals, so
  // an installed package would mean it had grown a dependency unnoticed.
  assert.match(CODE, /node_modules is present/);
});

test("the script's exit code stays authoritative", () => {
  // The failure mode this guards is a recovery that reports UNKNOWN and a job
  // that goes green anyway.
  assert.match(CODE, /exit "\$\{code\}"/);
  assert.doesNotMatch(CODE, /\|\|\s*true/, "a command swallows its failure");
  assert.doesNotMatch(CODE, /continue-on-error:\s*true/);
  // The artifact upload is the one step allowed to run after a refusal.
  assert.match(CODE, /if:\s*always\(\)/);
});

/* -------------------------------------------------- the pinned commit */

test("the workflow refuses any commit other than the audited one", () => {
  assert.match(CODE, new RegExp(`AUDITED_SHA:\\s*${AUDITED_SHA}`));
  assert.match(CODE, /Refusing to run: HEAD is \$\{head\}, expected \$\{AUDITED_SHA\}/);
  assert.match(CODE, /if \[\[ "\$\{head\}" != "\$\{AUDITED_SHA\}" \]\]/);
  // And a ref that cannot produce that commit stops before anything runs.
  assert.match(CODE, /is not reachable from this ref/);
  assert.match(CODE, /fetch-depth:\s*0/);
});

test("the audited sha is a full 40-character commit id", () => {
  assert.match(AUDITED_SHA, /^[0-9a-f]{40}$/);
  const declared = CODE.match(/AUDITED_SHA:\s*([0-9a-f]{40})/);
  assert.ok(declared, "the workflow declares no audited sha");
  assert.equal(declared[1], AUDITED_SHA);
});

test("the recovery script it pins is itself read-only", () => {
  // The workflow's safety is only as good as what it runs.
  const script = readFileSync(join(REPO, "scripts", "recover-escrow-evidence.mjs"), "utf8");
  for (const pattern of [/sendTransaction/, /signTransaction/, /Keypair/, /secretKey/, /-keypair\.json/]) {
    assert.doesNotMatch(script, pattern, `the recovery script is not read-only: ${pattern}`);
  }
});

test("the workflow documents why each guarantee holds", () => {
  // Against the full source, comments included: an operator reading the file
  // should find the reasoning, not just the switches.
  assert.match(SOURCE, /permissions: contents: read/);
  assert.match(SOURCE, /No `environment:` key/);
  assert.match(SOURCE, /signs nothing/);
  assert.match(SOURCE, /do not convert UNKNOWN into success/i);
});
