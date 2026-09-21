# Change control for the audit target

## The rule

Once the audit target is frozen and handed to an independent reviewer, **any
change to the paths below invalidates or amends the target**. The target is not
moved silently while review is underway.

### Target-invalidating paths

| Path | Why |
| --- | --- |
| `programs/**` | the reviewed bytecode's source |
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `Anchor.toml` | change the artifact or its reproducibility |
| `sdk/src/escrow/**`, `sdk/src/core/**`, `sdk/src/canonical.ts`, `sdk/src/programs.ts` | security-critical encoders, decoders, PDA derivation |
| `indexer/src/events.ts`, `indexer/src/replay.ts`, `indexer/src/projections.ts` | event interpretation and lifecycle reconstruction |
| `scripts/lib/identity.mjs` | program identity and governance record |
| `scripts/lib/custody-runner.mjs`, `scripts/devnet-escrow-custody.mjs`, `scripts/recover-devnet-escrow-custody-evidence.mjs` | custody transaction lifecycle |
| `.github/workflows/deploy-devnet.yml` and any deployment/authority workflow | deployment authority |
| `deployments/evidence/**`, `deployments/validation/**` | the evidence the review rests on |

### Non-invalidating paths

| Path | Condition |
| --- | --- |
| `docs/**` | provided no invariant, scope or evidence claim changes meaning |
| `docs/security/rr13/**` | amendments are appended and dated, never rewritten in place |
| `tests/**`, `scripts/test/**` | **additive only** — a new test may be added; changing or removing one changes what "green" meant |
| `.claude/**`, `CLAUDE.md`, `README.md` | tooling and prose |

## Procedure when an invalidating change is needed mid-review

1. **Stop.** Do not push to the frozen branch.
2. Record the reason, the exact paths, and the severity that motivated it.
3. Decide explicitly, with the reviewer:
   * **Amend** — the reviewer accepts a new target SHA and re-reviews the delta;
     or
   * **Defer** — the change waits until the review returns.
4. If amending: re-run the full ladder, re-hash the package, issue a new
   `AUDIT_TARGET_SHA`, and append an amendment record to this file. Never edit
   a prior target's facts.
5. Notify the reviewer **before** they resume, not after.

## Amendment record

| Date | Old SHA | New SHA | Reason | Paths |
| --- | --- | --- | --- | --- |
| 2026-09-20 | — | `02b5b5286fab95ce68a4ca53d8b7768a738a1013` | initial freeze | — |
| 2026-09-20 | `02b5b528…` | **unchanged** | `main` advanced to `bd99f2419ae0becdd52e5cb05d01cc79ce8dc26b` via #45 (this package) and #44 (`.claude/skills/**`). Both are non-invalidating paths. Verified by tree hash: `programs/`, `sdk/`, `indexer/`, `tests/`, `scripts/` and `deployments/` are identical across `02b5b52`, `1c24aaa` and `bd99f24`, as are all six root build/identity files. CI green on the combined head (run 35498756470, four of four jobs). **The target was not moved.** | `docs/security/rr13/**`, `.claude/skills/**` |
| 2026-09-20 | `02b5b528…` | **unchanged** | Package reconciliation: `00-scope.md` now distinguishes `FROZEN_RR13_SECURITY_TARGET` from `CURRENT_REPOSITORY_HEAD`; `MANIFEST.sha256` re-rooted (see below). Documentation only; no claim about the target changed meaning. | `docs/security/rr13/**` |
| 2026-09-21 | `02b5b5286fab95ce68a4ca53d8b7768a738a1013` | **`0190248f6199398dfe4ce632e513123cb00b0cb0`** | Pre-audit remediation of internal findings F-01 through F-05 (#47, squash-merged). `scripts/lib/identity.mjs` is a target-invalidating path and its commentary changed, so the target is **re-frozen** at the merge commit. `SECURITY_BEHAVIOR_CHANGED=NO` — evidence below. | invalidating: `scripts/lib/identity.mjs` (commentary only). non-invalidating: `docs/**`, `scripts/test/attack-matrix.test.mjs`, `scripts/test/escrow-current-state-docs.test.mjs`, `scripts/test/coverage-docs.test.mjs` (new, additive) |

### Re-freeze of 2026-09-21 — the evidence

`OLD_AUDIT_TARGET_SHA` `02b5b5286fab95ce68a4ca53d8b7768a738a1013`
`NEW_AUDIT_TARGET_SHA` `0190248f6199398dfe4ce632e513123cb00b0cb0`
`REASON` Pre-audit remediation of internal findings F-01 through F-05.
`TARGET_INVALIDATING_PATH` `scripts/lib/identity.mjs`
`SECURITY_BEHAVIOR_CHANGED` **NO**

The new SHA was read off `main` after the merge, not predicted. #47 was
**squash-merged**, so its head `76ba5e28…` is not an ancestor of `main` and is
not the target; GitHub's tentative merge SHA is not the target either. Only the
commit that exists on `main` is.

**1. Every security-sensitive subtree is the same git tree object.** Not "no
diff shown" — the same object id, which a change that merely looks equivalent
cannot produce:

| Subtree | `02b5b52` | `0190248` |
| --- | --- | --- |
| `programs/` | `1c3d2411ebbe06d2bc6645c1a38dc0db494bf64b` | identical |
| `sdk/` | `b258cc9ff6afb4ebb5013217faff45a1b61ee4c8` | identical |
| `indexer/` | `e2697bd31f59d39ec30262824915089f29a01944` | identical |
| `tests/` | `84ee89320c0bcbc64de9624b8dda585eb9c8f000` | identical |
| `deployments/` | `f06ac1a89e882893a4bc8ad5173b493f5bd6e2ae` | identical |
| `.github/` | `5fba144e9f9c3d04ed51da58bba44a7df7773638` | identical |

**2. All six root build and identity files are byte-identical:**
`Anchor.toml`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`,
`rust-toolchain.toml`.

**3. The one invalidating path carries commentary only.** Stripping block and
line comments from `scripts/lib/identity.mjs` at both commits yields
byte-identical text, 42 lines of code. No constant, derivation, program id,
authority or threshold moved.

**4. The guards were re-run against the merged tree**, not merely against the
branch: `escrow-freeze-tampering` 19/19, `escrow-current-state-docs` 9/9,
`attack-matrix` 8/8, `coverage-docs` 7/7, `custody-gate` 21/21.

**5. Post-merge CI on the exact new target is green** — run 35560538644, all
four required jobs: Solana programs (host), SDK, Anchor local validator
(including the double build with IDL comparison and the PPV-P1…P10 suite), and
the full property-suite mutation qualification.

A note on method, since it is the point of this table: the new SHA sat as
`PENDING MERGE` until the merge existed. Writing a predicted SHA would have
been the same class of defect the remediation was fixing — a document asserting
something the repository had not yet made true.

### Note on the manifest re-rooting

The first manifest mixed two roots: package documents relative to
`docs/security/rr13/`, everything else relative to the repository root. The
documented command therefore verified 14 of 70 entries and reported the other
56 unreadable. Worse, run from the repository root instead, the bare
`README.md` entry resolved to the **repository's** root `README.md` rather than
the package's, and reported a checksum mismatch on a file the manifest was
never attesting — a false tamper signal on a correct package.

Every path is now repository-root-relative and the manifest is verified from
the repository root. No attested content changed as a result of the re-rooting
itself; the hashes that moved are those of the two documents edited in this
reconciliation.

## Note on the findings in this package

F-01 … F-05 were documentation-only and are **resolved**. Remediating them
touched `docs/**`, three files under `scripts/test/`, and one comment block in
`scripts/lib/identity.mjs`. Under the table above:

* the `docs/**` and `scripts/test/**` edits are **non-invalidating**;
* the `scripts/lib/identity.mjs` **comment** edit touched an invalidating path.
  It changed no value, no derivation and no behaviour — but the path is listed
  precisely so that "it's only a comment" is not a judgement call made in
  passing. It was carried in a clearly-labelled remediation PR (#47), and the
  resulting SHA is recorded above as the 2026-09-21 amendment.

That sequencing was the point: the remediation landed first, so the reviewer
receives one coherent target rather than a target plus an erratum. F-06 … F-09
remain open, and are described in
[06-test-and-evidence-map](06-test-and-evidence-map.md) and
[finding-register](finding-register.md) rather than closed by documentation.
