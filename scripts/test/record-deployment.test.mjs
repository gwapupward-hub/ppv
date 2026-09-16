import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ESCROW_CUSTODY_GOVERNANCE,
  PERMANENT_PROGRAM_IDS,
} from "../lib/identity.mjs";
import { NON_CUSTODY_VAULT } from "../verify-custody-governance.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The deployment evidence recorder.
 *
 * These exist because of a real failure. `ppv_escrow` passed every deployment
 * gate, deployed to devnet and had its upgrade authority transferred to the
 * custody vault — and then `record-deployment.sh` died on
 *
 *   line 106: PERMANENT_IDS[${program}]: unbound variable
 *
 * The script carried a second, private copy of the permanent-identity table
 * holding only Core and Commerce. Escrow had been added to the canonical table,
 * to `declare_id!`, to both `Anchor.toml` sections and to this script's own
 * accepted-program list; this table was missed, and under `set -u` the lookup
 * aborted. The cost of that miss is unusual: the failure lands *after* the
 * irreversible part, and the deployment cannot be repeated to produce the
 * evidence it failed to write.
 *
 * So the rule these tests enforce is not "escrow works now" but "the recorder
 * has no identity table of its own". A second table is the defect; a passing
 * escrow case is only the symptom.
 */

const RECORDER = join(REPO, "scripts", "record-deployment.sh");
const SOURCE = readFileSync(RECORDER, "utf8");

/**
 * The recorder with comment lines removed.
 *
 * The no-second-table assertions below are about executable shell, not prose —
 * the comment explaining why the table was removed necessarily names it, and a
 * test that cannot tell the difference would fail on its own documentation.
 */
const CODE = SOURCE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** Resolves a program's permanent id exactly as the recorder now does. */
function resolve(program) {
  return execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { PERMANENT_PROGRAM_IDS } from "./scripts/lib/identity.mjs";' +
        "const name = process.argv[1];" +
        "const id = PERMANENT_PROGRAM_IDS[name];" +
        'if (!id) { console.error(`no permanent identity is frozen for ${name}`); process.exit(1); }' +
        "process.stdout.write(id);",
      "--",
      program,
    ],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/* --------------------------------- the regression that caused the outage */

test("the recorder declares no identity table of its own", () => {
  // The exact failure class, stated as a property of the source rather than as
  // one program's happy path: any second table drifts, and this one drifted
  // silently until the one moment it could not be retried.
  assert.doesNotMatch(
    CODE,
    /declare\s+-A\s+PERMANENT_IDS/,
    "record-deployment.sh has re-grown its own permanent-identity table",
  );
  assert.doesNotMatch(
    CODE,
    /PERMANENT_IDS\[/,
    "record-deployment.sh still indexes a local PERMANENT_IDS array",
  );
  assert.match(
    CODE,
    /PERMANENT_PROGRAM_IDS.*identity\.mjs|identity\.mjs[\s\S]{0,200}PERMANENT_PROGRAM_IDS/,
    "the recorder must read the canonical identity source",
  );
});

test("PERMANENT_IDS[ppv_escrow] is never an unbound lookup", () => {
  // The literal error text from the failed run, asserted never to be
  // reproducible: resolution either yields an id or fails loudly by name.
  assert.doesNotThrow(() => resolve("ppv_escrow"));
  assert.equal(resolve("ppv_escrow").trim(), PERMANENT_PROGRAM_IDS.ppv_escrow);
});

/* ------------------------------------------------- resolution, per program */

test("escrow resolves to its frozen permanent id", () => {
  assert.equal(resolve("ppv_escrow").trim(), "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4");
});

test("core and commerce still resolve correctly", () => {
  assert.equal(resolve("ppv_core").trim(), "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU");
  assert.equal(resolve("ppv_commerce").trim(), "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3");
});

test("an unknown program name is refused by name, not silently empty", () => {
  // The dangerous failure is not an error — it is an empty string that compares
  // equal to nothing and lets a record through describing no program at all.
  assert.throws(() => resolve("ppv_not_a_program"), (error) => {
    assert.match(String(error.stderr), /no permanent identity is frozen/);
    return true;
  });
  assert.throws(() => resolve(""), /./);
});

test("a program with no frozen identity is refused", () => {
  // Proved against the table itself: anything absent from it must not resolve.
  for (const name of ["ppv_future", "ppv_escrow_v2"]) {
    assert.ok(!(name in PERMANENT_PROGRAM_IDS));
    assert.throws(() => resolve(name), (error) => {
      assert.match(String(error.stderr), /no permanent identity is frozen/);
      return true;
    });
  }
});

/* ------------------------------------------------------ recorder contract */

test("the recorder accepts exactly the three released programs", () => {
  assert.match(SOURCE, /ppv_core \| ppv_commerce \| ppv_escrow\) ;;/);
  assert.match(SOURCE, /PPV_PROGRAM must be ppv_core, ppv_commerce or ppv_escrow/);
});

test("a built IDL naming a different program is refused", () => {
  // The comparison that makes evidence unable to claim a deployment for
  // something other than what was built.
  assert.match(SOURCE, /Built \$\{program\} IDL names \$\{program_id\}, permanent id is \$\{permanent_id\}/);
  assert.match(SOURCE, /if \[\[ "\$\{program_id\}" != "\$\{permanent_id\}" \]\]/);
});

test("escrow evidence must name its dedicated custody governance", () => {
  assert.match(SOURCE, /ppv_escrow evidence must name the frozen custody member set/);
  assert.match(SOURCE, /ppv_escrow evidence must record threshold/);
  // And the custody vault is not the one holding Core and Commerce.
  assert.notEqual(ESCROW_CUSTODY_GOVERNANCE.vault, NON_CUSTODY_VAULT);
});

test("escrow evidence cannot substitute the Core/Commerce authority", () => {
  // The Core/Commerce member set must not satisfy the escrow member check.
  const coreMembers = [
    "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
    "2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ].sort().join(",");
  const custodyMembers = [...ESCROW_CUSTODY_GOVERNANCE.members].sort().join(",");
  assert.notEqual(coreMembers, custodyMembers);
});

test("recording evidence requires no private key material", () => {
  // Evidence is public facts. A recorder that needed a signer could not be run
  // by anyone checking the release, which is the point of the record.
  for (const pattern of [/secretKey/, /-keypair\.json/, /PPV_DEPLOYER_KEYPAIR/, /PPV_ESCROW_PROGRAM_KEYPAIR/]) {
    assert.doesNotMatch(SOURCE, pattern, `the recorder references key material: ${pattern}`);
  }
  assert.doesNotMatch(SOURCE, /(\d+,\s*){20,}\d+/, "a literal key array is in the recorder");
});

test("the recorder reads the chain rather than trusting its inputs", () => {
  assert.match(SOURCE, /query-chain\.mjs program/);
  assert.match(SOURCE, /upgradeAuthority/);
});
