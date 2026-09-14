import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ESCROW_CUSTODY_GOVERNANCE,
  ESCROW_PERMANENT_ID,
  ESCROW_PLACEHOLDER_ID,
} from "../lib/identity.mjs";
import { isProgramDerived } from "../lib/pubkey.mjs";
import { NON_CUSTODY_MEMBERS, NON_CUSTODY_VAULT } from "../verify-custody-governance.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The `ppv_escrow` custody gate, asserted rather than described.
 *
 * Until the Sprint 4 freeze this gate was enforced by *absence*: escrow was
 * missing from the deploy workflow, the release-record writer and
 * `[programs.devnet]`, so nothing in the repository could put it on a cluster.
 * That was a strong property and it is now gone — escrow has a permanent
 * identity, dedicated governance, and a deployment path.
 *
 * What replaces it is enforcement. Every fact a deployment depends on is frozen
 * in `scripts/lib/identity.mjs`, and the deploy workflow is required to check
 * the run against those frozen facts rather than against whatever a repository
 * variable happens to hold. These tests are that requirement, written so a pull
 * request that quietly removed a check would break.
 *
 * None of this authorizes a deployment. The gate in docs/deployment-gates.md
 * has requirements beyond governance — an independent security review among
 * them — and they are unmet.
 */

const read = (...parts) => readFileSync(join(REPO, ...parts), "utf8");

const DEPLOY = read(".github", "workflows", "deploy-devnet.yml");
const RECORD = read("scripts", "record-deployment.sh");
const ANCHOR = read("Anchor.toml");
const IDENTITY = read("scripts", "lib", "identity.mjs");
const ESCROW_LIB = read("programs", "ppv_escrow", "src", "lib.rs");

/** The `[programs.<cluster>]` section of Anchor.toml, or "" when absent. */
function anchorSection(cluster) {
  const heading = new RegExp(
    `^\\[programs\\.${cluster}\\]$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`,
    "m",
  );
  return ANCHOR.match(heading)?.[1] ?? "";
}

/* ------------------------------------------------------- the frozen facts */

test("the permanent escrow identity is frozen and is not the placeholder", () => {
  assert.equal(ESCROW_PERMANENT_ID, "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4");
  assert.notEqual(ESCROW_PERMANENT_ID, ESCROW_PLACEHOLDER_ID);
});

test("the custody governance record is complete", () => {
  const g = ESCROW_CUSTODY_GOVERNANCE;
  assert.notEqual(g, null, "no custody governance is frozen");
  assert.equal(g.multisig, "GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46");
  assert.equal(g.vault, "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE");
  assert.equal(g.threshold, 2);
  assert.equal(g.network, "devnet");
  assert.equal(g.vaultIndex, 0);
  assert.equal(g.permissionMask, 7);
  assert.deepEqual([...g.members], [
    "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
    "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ]);
  assert.match(g.creationTx, /^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
});

test("the custody governance is genuinely separate from the non-custodial one", () => {
  const g = ESCROW_CUSTODY_GOVERNANCE;
  // Separate addresses…
  assert.notEqual(g.vault, NON_CUSTODY_VAULT);
  assert.notEqual(g.multisig, NON_CUSTODY_VAULT);
  // …and separate enough people. Exactly one signer overlaps, which cannot
  // reach a 2-of-3 threshold alone; a second would end that property and is the
  // thing this assertion exists to catch.
  const overlap = g.members.filter((member) => NON_CUSTODY_MEMBERS.includes(member));
  assert.deepEqual(overlap, [...g.sharedSignersWithNonCustody]);
  assert.equal(overlap.length, 1, "more than one custody signer governs Core and Commerce");
  assert.ok(overlap.length < g.threshold, "shared signers alone satisfy the custody threshold");
  assert.equal(g.sharedSignerExceptionScope, "devnet");
});

test("the vault and multisig are program-derived, not wallets", () => {
  assert.ok(isProgramDerived(ESCROW_CUSTODY_GOVERNANCE.vault));
  assert.ok(isProgramDerived(ESCROW_CUSTODY_GOVERNANCE.multisig));
  // A member is a person's key and must be on the curve — an off-curve member
  // is a PDA nobody can sign for.
  for (const member of ESCROW_CUSTODY_GOVERNANCE.members) {
    assert.ok(!isProgramDerived(member), `${member} is not a signer key`);
  }
});

/* ------------------------------------------- every identity source agrees */

test("every committed identity source names the permanent id", () => {
  assert.match(ESCROW_LIB, new RegExp(`declare_id!\\("${ESCROW_PERMANENT_ID}"\\)`));
  assert.match(anchorSection("localnet"), new RegExp(`ppv_escrow = "${ESCROW_PERMANENT_ID}"`));
  assert.match(anchorSection("devnet"), new RegExp(`ppv_escrow = "${ESCROW_PERMANENT_ID}"`));
  assert.match(IDENTITY, new RegExp(`ppv_escrow: "${ESCROW_PERMANENT_ID}"`));
});

test("the build-only placeholder is gone from every identity and deploy path", () => {
  for (const [name, source] of [
    ["programs/ppv_escrow/src/lib.rs", ESCROW_LIB],
    ["Anchor.toml", ANCHOR],
    ["deploy-devnet.yml", DEPLOY],
  ]) {
    assert.ok(!source.includes(ESCROW_PLACEHOLDER_ID), `${name} still carries the placeholder`);
  }
  // identity.mjs keeps the constant, because a name for the thing that must
  // never be deployed is how the other checks stay expressible.
  assert.match(IDENTITY, /ESCROW_PLACEHOLDER_ID = "7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR"/);
});

/* ------------------------------------------------ the deployment path gate */

test("escrow is selectable only alongside the full set of frozen checks", () => {
  const options = DEPLOY.match(/options:\s*\[([^\]]*)\]/);
  assert.ok(options, "deploy-devnet.yml declares no program choices");
  const choices = options[1].split(",").map((entry) => entry.trim());
  assert.deepEqual(choices, ["ppv_core", "ppv_commerce", "ppv_escrow"]);
});

test("the deploy workflow resolves escrow governance from the frozen record", () => {
  // Not from repository variables: a variable holds whatever it was last set
  // to, and the one this repository already has holds Core and Commerce's
  // vault. Handing that to escrow is precisely the failure the gate prevents.
  assert.match(DEPLOY, /Resolve the governance for this program/);
  assert.match(DEPLOY, /ESCROW_CUSTODY_GOVERNANCE/);
  assert.match(DEPLOY, /The custody vault equals the non-custodial vault/);

  // And the authority-consuming steps read the resolved value rather than the
  // variables directly, or the resolution would be decorative.
  for (const consumer of [
    "PPV_SQUADS_VAULT_PDA: \\$\\{\\{ steps.governance.outputs.vault \\}\\}",
    "UPGRADE_AUTHORITY: \\$\\{\\{ steps.governance.outputs.vault \\}\\}",
    "EXPECTED_AUTHORITY: \\$\\{\\{ steps.governance.outputs.vault \\}\\}",
  ]) {
    assert.match(DEPLOY, new RegExp(consumer), `a consumer still reads the raw variable`);
  }
  assert.ok(
    !/UPGRADE_AUTHORITY: \$\{\{ vars\.PPV_SQUADS_VAULT_PDA \}\}/.test(DEPLOY),
    "an authority consumer still reads vars.PPV_SQUADS_VAULT_PDA directly",
  );
});

test("the deploy workflow requires the keypair to be the frozen escrow id", () => {
  assert.match(DEPLOY, /Escrow keypair \$\{keypair_id\} is not the frozen permanent id/);
  assert.match(DEPLOY, /No permanent ppv_escrow identity is frozen. Refusing to deploy/);
});

test("the deploy workflow runs the custody verifier before escrow may proceed", () => {
  assert.match(DEPLOY, /node scripts\/verify-custody-governance\.mjs/);
  // The devnet exception is taken explicitly, at this one call site.
  assert.match(DEPLOY, /--allow-shared-signers/);
});

test("the genesis hash and verify_only gates are still in force", () => {
  assert.match(DEPLOY, /Genesis hash \$\{actual\} does not match the configured devnet genesis/);
  assert.match(DEPLOY, /VERIFY-ONLY: all pre-deployment checks passed/);
  assert.match(DEPLOY, /default: true/, "verify_only must default to true");
});

test("release approvals are bound to the exact release commit", () => {
  const approval = read("scripts", "verify-devnet-release-approval.mjs");
  assert.match(approval, /PPV_RELEASE_COMMIT must be an exact 40-character Git commit SHA/);
  assert.match(approval, /does not match the checked-out Git commit/);
  // And escrow approvals are checked against the custody set, not Core's.
  assert.match(approval, /export function policyFor/);
  assert.match(approval, /EXPECTED_CUSTODY_VAULT_PDA = "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE"/);
});

test("the release-record writer accepts escrow only with the custody governance", () => {
  assert.match(RECORD, /ppv_core \| ppv_commerce \| ppv_escrow\) ;;/);
  assert.match(RECORD, /ppv_escrow evidence must name the frozen custody member set/);
  assert.match(RECORD, /ppv_escrow evidence must record threshold/);
});

/* ----------------------------------------------------------- still closed */

test("no escrow keypair is committed anywhere in the repository", () => {
  const ignored = read(".gitignore");
  assert.match(ignored, /\*-keypair\.json/, "keypair files must stay ignored");
  assert.doesNotMatch(
    IDENTITY,
    /ppv_escrow[^\n]*keypair/i,
    "identity tooling references an escrow keypair",
  );
});

test("the custody gate is still documented as closed on its remaining requirements", () => {
  // Governance was one requirement of several. The gate document must not read
  // as though satisfying it opened the gate.
  const gates = read("docs", "deployment-gates.md");
  assert.match(gates, /Custody gate — `ppv_escrow`/);
  assert.match(gates, /independent Solana security review/i);
  assert.match(gates, /CUSTODY GATE: CLOSED/);
});

test("the devnet-only shared-signer exception is documented where the gate is read", () => {
  // The exception is the one place this configuration departs from the stated
  // policy. An undocumented exception is indistinguishable from a policy that
  // was quietly loosened, so the record has to exist and has to say all three
  // things: that one signer is shared, that the other two are not, and that
  // the approval covers devnet only.
  const gates = read("docs", "deployment-gates.md");
  assert.match(gates, /\*\*Approved exception — one shared signer, devnet only\.\*\*/);
  assert.match(gates, /One custody signer is\s+intentionally shared with Core\/Commerce governance/);
  assert.match(gates, /other two custody\s+signers are distinct/);
  assert.match(gates, /approved for devnet only/);
  assert.ok(
    gates.includes(ESCROW_CUSTODY_GOVERNANCE.sharedSignersWithNonCustody[0]),
    "the shared signer is not named in the gate document",
  );
});
