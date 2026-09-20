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

F-01 … F-05 are documentation-only. Remediating them touches `docs/**` and one
comment plus one test-file scope in `scripts/`. Under the table above:

* the `docs/**` edits are **non-invalidating**;
* the `scripts/lib/identity.mjs` **comment** edit touches an invalidating path.
  It changes no value, no derivation and no behaviour — but the path is listed
  precisely so that "it's only a comment" is not a judgement call made in
  passing. It should be carried in a clearly-labelled remediation PR, and the
  resulting SHA recorded above as an amendment before handoff.

This is why the audit-freeze PR was **not** opened at this commit: the
remediation must land first, so the reviewer receives one coherent target
rather than a target plus an erratum.
