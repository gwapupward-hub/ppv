import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * Lockfile invariants the toolchain depends on but no build catches locally.
 *
 * `anchor build` generates the IDL by compiling the programs with
 * `--features idl-build` on a pinned nightly. That pulls in `anchor-syn`, whose
 * IDL path calls `proc_macro2::Span::source_file()` — an unstable API that
 * later proc-macro2 releases removed. So the *locked* proc-macro2 version is
 * part of the build toolchain, not an implementation detail of a transitive
 * dependency.
 *
 * Nothing else notices. `cargo test`, `cargo clippy` and `cargo build` all pass
 * on a proc-macro2 that has dropped the API, because none of them compile
 * anchor-syn's IDL module. The failure appears only in the Anchor CI job, as a
 * compile error inside a crate nobody edited:
 *
 *     error[E0599]: no method named `source_file` found for struct
 *                   `proc_macro2::Span`
 *
 * That is what happened when adding `ppv_escrow` regenerated the lockfile and
 * carried proc-macro2 from 1.0.79 to 1.0.107 as a side effect.
 */

const LOCK = readFileSync(join(REPO, "Cargo.lock"), "utf8");

function lockedVersions(name) {
  const pattern = new RegExp(
    String.raw`\[\[package\]\]\s*\nname = "${name}"\s*\nversion = "([^"]+)"`,
    "g",
  );
  return [...LOCK.matchAll(pattern)].map((match) => match[1]);
}

/**
 * proc-macro2 versions confirmed to expose `Span::source_file()`.
 *
 * Confirmed by reading the vendored crate source, not by reading a changelog:
 * `proc-macro2-1.0.79/src/lib.rs` defines `pub fn source_file`. Adding a
 * version here means someone checked the same way *and* watched the Anchor CI
 * job go green on it — a passing `cargo test` proves nothing about this.
 */
const PROC_MACRO2_KNOWN_GOOD = ["1.0.79"];

test("the lockfile pins a proc-macro2 that can still build the IDL", () => {
  const versions = lockedVersions("proc-macro2");
  assert.equal(versions.length, 1, "expected exactly one locked proc-macro2");
  assert.ok(
    PROC_MACRO2_KNOWN_GOOD.includes(versions[0]),
    `Cargo.lock pins proc-macro2 ${versions[0]}, which is not known to expose ` +
      `Span::source_file(). anchor-syn 0.30.1 calls it while building the IDL, ` +
      `so this breaks 'anchor build' — and only 'anchor build'. Either pin one ` +
      `of ${PROC_MACRO2_KNOWN_GOOD.join(", ")}, or verify the new version ` +
      `defines 'pub fn source_file' and that the Anchor CI job passes, then ` +
      `add it here.`,
  );
});

test("no dependency drags proc-macro2 forward again", () => {
  // The forcing function, recorded because the version pin alone does not
  // explain itself: bytemuck's `derive` feature (which anchor-lang turns on)
  // pulls bytemuck_derive, and bytemuck_derive 1.10.2+ requires syn 3, which
  // requires proc-macro2 >= 1.0.91. `cargo update -p proc-macro2 --precise`
  // then fails outright rather than quietly leaving the build broken, which is
  // the good case; this test covers the bad one, where a regenerated lockfile
  // takes the whole chain forward at once.
  assert.deepEqual(
    lockedVersions("syn").filter((version) => version.startsWith("3.")),
    [],
    "syn 3.x is in the lockfile, which forces proc-macro2 >= 1.0.91 and breaks " +
      "the IDL build. Pin bytemuck_derive back to a 1.5.x release, which uses syn 2.",
  );
});

test("anchor-spl's floor on bytemuck is respected", () => {
  // spl-token 4.0.3, via anchor-spl 0.30.1, requires bytemuck ^1.16.1 — which
  // is why the lockfile cannot simply match main's 1.15.0 here. Pinned so a
  // future attempt to close that gap fails with the reason attached.
  const [bytemuck] = lockedVersions("bytemuck");
  const [major, minor] = bytemuck.split(".").map(Number);
  assert.equal(major, 1);
  assert.ok(
    minor >= 16,
    `bytemuck ${bytemuck} is below the ^1.16.1 that spl-token 4.0.3 requires`,
  );
});
