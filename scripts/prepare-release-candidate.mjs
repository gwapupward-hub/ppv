#!/usr/bin/env node
/**
 * Freezes a release candidate and prints the exact bytes the approvers sign.
 *
 * A deployment is authorised by two independent Ed25519 signatures over one
 * exact message. That message names the program, its permanent id, the git
 * commit and the cluster — so an approval is a statement about one specific set
 * of bytes, and cannot be replayed onto a different commit or a different
 * program. Getting the message wrong by one character produces signatures the
 * deploy workflow will reject, after the approvers have already signed.
 *
 * This exists so nobody has to assemble that message by hand. It checks that
 * every source of the program's identity agrees, that the tree is clean, and
 * that the program has not already been released, and only then prints the
 * message. Every check is a reason not to collect signatures yet.
 *
 *   node scripts/prepare-release-candidate.mjs ppv_commerce
 *
 * It reads the repository and the git index. It never reads a keypair, never
 * signs anything, and never touches the network.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PERMANENT_PROGRAM_IDS } from "./lib/identity.mjs";
import { releaseMessage } from "./verify-devnet-release-approval.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();

const failures = [];
const checks = [];
function check(ok, description, detail = "") {
  checks.push({ ok, description, detail });
  if (!ok) failures.push(description);
}

/** Every place the repository states this program's identity. They must agree. */
function identitySources(program) {
  const sources = {};
  sources["declare_id!"] = (
    readFileSync(join(REPO, "programs", program, "src", "lib.rs"), "utf8").match(
      /^declare_id!\("(.+)"\);$/m,
    ) ?? []
  )[1];

  // Anchored at line start: Anchor.toml's own comments mention
  // `[programs.devnet]` in prose, and matching that text instead of the section
  // heading would read the identity out of a comment.
  const anchorToml = readFileSync(join(REPO, "Anchor.toml"), "utf8");
  for (const section of ["localnet", "devnet"]) {
    const heading = new RegExp(`^\\[programs\\.${section}\\]$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m");
    const block = (anchorToml.match(heading) ?? [])[1] ?? "";
    sources[`Anchor.toml [programs.${section}]`] = (
      block.match(new RegExp(`^${program} = "(.+)"$`, "m")) ?? []
    )[1];
  }

  sources["scripts/lib/identity.mjs"] = PERMANENT_PROGRAM_IDS[program];

  const approvalTooling = readFileSync(join(REPO, "scripts", "verify-devnet-release-approval.mjs"), "utf8");
  sources["release approval tooling"] = (
    approvalTooling.match(new RegExp(`${program}: "(.+)",`)) ?? []
  )[1];

  const idl = join(REPO, "target", "idl", `${program}.json`);
  if (existsSync(idl)) {
    sources["built IDL (target/idl)"] = JSON.parse(readFileSync(idl, "utf8")).address;
  }
  return sources;
}

/** A program with a committed devnet release record has already been deployed. */
function alreadyReleased(program) {
  const dir = join(REPO, "deployments", "evidence");
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const record = JSON.parse(readFileSync(join(dir, entry), "utf8"));
    if (record.cluster === "devnet" && record.program === program) return entry;
  }
  return null;
}

function main() {
  const [program] = process.argv.slice(2);
  const expectedId = PERMANENT_PROGRAM_IDS[program];
  if (!expectedId) {
    process.stderr.write(
      `usage: prepare-release-candidate.mjs <${Object.keys(PERMANENT_PROGRAM_IDS).join("|")}>\n`,
    );
    process.exit(2);
  }

  const commit = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain");

  check(
    dirty === "",
    "the working tree is clean",
    dirty === "" ? commit : "uncommitted changes would not be part of the signed commit",
  );
  check(/^[0-9a-f]{40}$/.test(commit), "HEAD is a full 40-character commit sha", commit);

  const sources = identitySources(program);
  for (const [where, value] of Object.entries(sources)) {
    check(value === expectedId, `${where} names the permanent ${program} id`, value ?? "(not found)");
  }
  if (!sources["built IDL (target/idl)"]) {
    checks.push({
      ok: null,
      description: "built IDL not present in this checkout",
      detail: "the deploy workflow builds and checks it; run `anchor build` to check it here",
    });
  }

  const released = alreadyReleased(program);
  check(
    released === null,
    `${program} has no committed devnet release record`,
    released ? `already released — see deployments/evidence/${released}` : "not yet released",
  );

  const candidatePath = join("deployments", "release-candidates", `${program}.json`);
  const candidateExists = existsSync(join(REPO, candidatePath));
  check(candidateExists, `${program} is declared a release candidate`, candidatePath);
  if (candidateExists) {
    const candidate = JSON.parse(readFileSync(join(REPO, candidatePath), "utf8"));
    check(candidate.programId === expectedId, "the candidate record names the permanent id", candidate.programId);
    check(candidate.cluster === "devnet", "the candidate record targets devnet", candidate.cluster);
  }

  process.stdout.write(`Release candidate for ${program}\n\n`);
  const width = Math.max(...checks.map((c) => c.description.length));
  for (const { ok, description, detail } of checks) {
    const mark = ok === null ? "note" : ok ? "ok  " : "FAIL";
    process.stdout.write(`  ${mark}  ${description.padEnd(width)}  ${detail}\n`);
  }

  if (failures.length > 0) {
    process.stdout.write(`\nresult=not-ready\n`);
    process.stderr.write(
      `\n${failures.length} check(s) failed. Do not collect approvals for this commit.\n`,
    );
    process.exit(1);
  }

  const message = releaseMessage({ program, programId: expectedId, commit });
  const bytes = Buffer.from(message, "utf8");
  process.stdout.write(
    [
      "",
      "Exact message to sign — UTF-8, no trailing newline:",
      "",
      "----------8<----------",
      message,
      "----------8<----------",
      "",
      `  byte length     ${bytes.length}`,
      `  sha256(message) ${createHash("sha256").update(bytes).digest("hex")}`,
      "",
      "Two distinct configured Squads members must each sign these exact bytes and",
      "return a detached Ed25519 signature as canonical standard padded base64.",
      "Approvals are bound to this commit: any new commit invalidates them.",
      "",
      "See docs/devnet-release-approval.md for how to produce and check a signature.",
      "",
      "result=ready-for-approvals",
      "",
    ].join("\n"),
  );
}

main();
