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
| — | — | `02b5b5286fab95ce68a4ca53d8b7768a738a1013` | initial freeze | — |

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
