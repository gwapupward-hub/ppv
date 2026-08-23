#!/usr/bin/env bash
set -euo pipefail

# Regenerates the committed Cargo.lock deterministically.
#
# CI never runs this. CI consumes the committed lockfile with `--locked`, so a
# drifting crates.io index can never silently change what gets built or
# deployed. Run this by hand when a dependency genuinely has to move, then
# commit the resulting Cargo.lock and re-run ./scripts/verify-f1.sh.
#
# The rule
# --------
# Hold the shared transitive graph at the versions the pinned toolchain was
# released against: Anchor v0.30.1's own Cargo.lock, falling back to Agave
# v1.18.17's for crates Anchor does not lock. Nothing here is hand-picked — the
# script downloads both upstream lockfiles and applies that single rule until it
# reaches a fixpoint.
#
# Why the rule is necessary
# -------------------------
# Two independent constraints, neither of which Cargo's MSRV-aware resolver can
# satisfy on its own:
#
#   1. `anchor build` compiles the programs with the Solana 1.18.17
#      platform-tools toolchain, which ships Cargo/rustc 1.75.0. Every manifest
#      in the resolve graph must be parseable by Cargo 1.75, and crates that
#      adopted `edition2024` are not. MSRV-aware resolution cannot avoid them
#      when a dependency omits or understates its own `rust-version` — the live
#      example is blake3 1.8.7 -> digest 0.11 -> block-buffer 0.12.1.
#
#   2. Host-side IDL generation runs `anchor-syn 0.30.1`, which calls
#      `proc_macro2::Span::source_file()`. That method was removed in later
#      proc-macro2 releases, so the proc-macro family has to stay on Anchor
#      0.30.1's baseline regardless of MSRV.
#
# The rule also resolves the serde conflict at its source. A fresh resolve picks
# bitflags 2.13.1 for solana-program's `bitflags = "^2.4.2"`; bitflags >= 2.10
# depends on `serde_core`, and `serde_core 1.0.228` requires
# `serde_derive =1.0.228` while `serde 1.0.195` requires `serde_derive =1.0.195`.
# Those are mutually unsatisfiable, which is why pinning serde alone fails.
# Agave v1.18.17 locks bitflags 2.4.2, which has no serde_core edge at all.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

curl --proto '=https' --tlsv1.2 -sSfL \
  https://raw.githubusercontent.com/solana-foundation/anchor/v0.30.1/Cargo.lock \
  -o "${work}/anchor.lock"
curl --proto '=https' --tlsv1.2 -sSfL \
  https://raw.githubusercontent.com/anza-xyz/agave/v1.18.17/Cargo.lock \
  -o "${work}/agave.lock"

# MSRV-aware resolution keeps most of the graph off versions the SBF Cargo 1.75
# cannot even parse. It is passed here rather than committed to .cargo/config.toml
# so it only shapes deliberate regeneration — it must never be able to quietly
# change what a build or a deploy resolves.
resolver_msrv=(--config 'resolver.incompatible-rust-versions="fallback"')

rm -f Cargo.lock
cargo "${resolver_msrv[@]}" generate-lockfile

# solana-program is pinned explicitly: the workspace only constrains it through
# anchor-lang's `^1.17.3`, and it must match the Solana CLI the programs are
# built and deployed with.
cargo "${resolver_msrv[@]}" update -p solana-program --precise 1.18.17

WORK="${work}" python3 - <<'PY'
import os, re, subprocess

work = os.environ["WORK"]


def parse(path):
    packages = {}
    for block in open(path).read().split("[[package]]"):
        name = re.search(r'^name = "(.+)"', block, re.M)
        version = re.search(r'^version = "(.+)"', block, re.M)
        if name and version:
            packages.setdefault(name.group(1), set()).add(version.group(1))
    return packages


def order(version):
    return tuple(int(part) for part in re.findall(r"\d+", version)[:3])


def track(version):
    # Crates below 1.0 break compatibility on the minor, so 0.x.y lines are
    # tracked separately; 1.0+ lines are tracked by major.
    parts = order(version)
    return parts[:1] if parts and parts[0] > 0 else parts[:2]


anchor = parse(f"{work}/anchor.lock")
agave = parse(f"{work}/agave.lock")

applied = []
changed = True
while changed:
    changed = False
    for name, versions in sorted(parse("Cargo.lock").items()):
        baseline = anchor.get(name) or agave.get(name)
        if not baseline:
            continue
        for version in sorted(versions, key=order):
            candidates = [
                candidate
                for candidate in baseline
                if track(candidate) == track(version) and order(candidate) < order(version)
            ]
            if not candidates:
                continue
            target = max(candidates, key=order)
            # Some moves are only reachable once an earlier one has landed, so
            # failures are expected and the loop simply runs again.
            result = subprocess.run(
                ["cargo", "update", "-p", f"{name}@{version}", "--precise", target],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                applied.append(f"{name} {version} -> {target}")
                changed = True

# Documented exceptions: an upstream-baseline version that a later compiler
# release broke outright. Each entry names the breakage and moves to the patch
# release that fixes exactly it, never further.
exceptions = [
    # ahash 0.7.6 gates on `feature(stdsimd)`, which rustc removed. 0.7.8 is the
    # patch release that drops it and is otherwise API-identical.
    ("ahash", "0.7.6", "0.7.8"),
]
for name, current, target in exceptions:
    subprocess.run(
        ["cargo", "update", "-p", f"{name}@{current}", "--precise", target],
        capture_output=True,
        text=True,
    )

print(f"aligned {len(applied)} package versions to the upstream baseline")
PY

echo "Cargo.lock regenerated. Commit it, then run ./scripts/verify-f1.sh."
