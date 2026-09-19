# Deployment Gates

## Gate F0 — repository foundation

- Three independent programs compile.
- Rust formatting, host tests, TypeScript type checking, and SDK tests pass.
- Placeholder program IDs are clearly labeled.
- Threat model and canonicalization v1 are committed.

## Gate F1 — local validator

- `anchor build` passes from a clean checkout.
- Full local-validator tests pass for every authority, stale-version, replay,
  expiry, terminal-state, and signature-clearing path.
- Generated IDLs are reviewed and reproducible.
- CI uses ephemeral ignored program keypairs and never prints or persists their
  secret material.
- `Cargo.lock` is committed and authoritative. CI consumes it with `--locked`
  and never regenerates or mutates it. Moving it is a deliberate act performed
  by `scripts/regenerate-lockfile.sh` and reviewed as a diff.
- Every toolchain the build touches is pinned by version, including the nightly
  Anchor 0.30.1 uses for IDL generation. An unpinned toolchain makes the gate
  fail on a date rather than on a code change, which is not a gate.

Run the complete gate with `npm run test:f1`. Passing F1 proves build and state
machine behavior only. It does not authorize deployment.

## Gate F1b — security invariants

- The model-based property suite holds `PPV-P1` … `PPV-P10` across randomized
  valid and invalid instruction sequences, asserted after every attempted
  action, on the same local-validator architecture F1 uses.
- The gate proves its own budget: it counts the operations it actually
  attempted and fails below the tier floor. Each seed runs against its own
  local validator — one instance does not survive the release budget on a
  hosted runner — so the floor is asserted over the summed coverage of every
  seed, and a seed that produced no coverage fails the gate.
- The suite proves its own reach: it fails if the run never funded, completed,
  settled or cancelled an agreement, never attacked a terminal one, and never
  refused a wrong-relationship account.
- Every real counterexample has a permanent deterministic regression under
  `tests/invariants/regression/`.

Run the PR budget with `npm run test:invariants:pr` (CI runs it after F1) and
the release budget with `npm run test:invariants:release`. Passing it proves the
escrow state machine survived randomized attack at the stated budget. It
authorizes nothing, and it does not move the custody gate below.

## Gate F2 — devnet design partners

- Controlled program keypairs replace placeholders.
- Devnet upgrade authorities and program IDs are documented.
- Indexer consumes CPI events idempotently and reconciles against chain state.
  `@gwap/ppv-indexer` does this; `scripts/replay-agreement.mts` is the
  reconciliation check to run against a deployed program.
- GWAP uses PPV internally for real, non-sensitive agreements.
- No private document is stored in plaintext.

## Gate F3 — agreement production candidate

- Independent Solana security review completed.
- All critical and high findings remediated and re-reviewed.
- Product UI states exactly what a timestamp proves and does not prove.
- Operational monitoring and incident response are tested.

## Custody gate — `ppv_escrow`

**CUSTODY GATE: CLOSED.**

`ppv_escrow` holds value. It passes F0 and F1 like any other program in the
workspace, and that authorizes nothing beyond a local validator.

Until Sprint 4 this gate was enforced by *absence*: escrow was missing from
`[programs.devnet]`, from `.github/workflows/deploy-devnet.yml` and from
`scripts/record-deployment.sh`, so no path could deploy it by accident. The
Sprint 4 freeze ended that. Escrow now has a permanent identity, a dedicated
custody multisig, and a deployment path — so the gate is now enforced by
**checks rather than by absence**, and it is worth being precise about what
that buys and what it costs.

What it buys: every fact a deployment depends on is frozen in
`scripts/lib/identity.mjs` and verified at run time against the run's own
inputs — the program id, the keypair-derived address, the cluster's genesis
hash, the custody vault, the member set, the threshold, and two independent
approvals bound to the exact release commit. `verify_only` defaults to true.

What it costs: an operator with the deploy secrets and two custody approvals can
now reach a deployment, where previously no configuration could. That is a real
reduction in margin, and it is why the requirements below are unchanged rather
than relaxed. **Governance was one requirement of several. Satisfying it did not
open the gate.**

**Readiness verdict:
[PPV ESCROW DEVNET DEPLOYMENT READINESS: GO](security/ppv-escrow-readiness-verdict.md)**
(Sprint 3.1). That GO authorises a separately controlled deployment sprint and
nothing else. **The custody gate below is closed independently of it and a GO
does not open it** — the requirements here, including an independent security
review and a separate multisig, are unmet and unchanged.

The program's instruction surface, its real state graph, and its token-program
scope are documented in
[security/ppv-escrow-surface.md](security/ppv-escrow-surface.md). Every security
claim made about it and the evidence for that claim are in
[security/ppv-escrow-attack-matrix.md](security/ppv-escrow-attack-matrix.md),
with what remains unresolved in
[security/ppv-escrow-residual-risk.md](security/ppv-escrow-residual-risk.md).

## Current state — `ppv_escrow` on devnet

Read this before anything else on this page. Anything elsewhere in this
document that describes `ppv_escrow` as undeployed, or its custody vault as an
*intended future* authority, is **historical** — true when it was written,
false now, and kept only so the sequence of events stays legible.

| | |
| --- | --- |
| Escrow deployed | YES — devnet, 2026-09-15 |
| Program ID | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` |
| ProgramData | `2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa` |
| Upgrade authority | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` (custody vault) |
| Authority transfer | FINALIZED |
| Deployment provenance | CLOSED — `deployments/evidence/ppv-escrow-devnet-231dceb.json` |
| Live devnet read-only preflight | PASS — https://github.com/gwapupward-hub/ppv/actions/runs/35053809296 |
| Live devnet custody validation | ATTEMPTED — NOT COMPLETED (the custody matrix executed in run 35465469908; history reconstruction did not complete, so `CANONICAL_LIVE_CUSTODY_EVIDENCE=NONE`) |
| Independent security review (RR-13) | OPEN |
| Legal review | OPEN |
| **Custody gate** | **CLOSED** |
| Mainnet authorized | NO |

Deployed and provenance-closed is not custody-verified. The deployment proved
that the reviewed bytes are the bytes the loader holds and that the dedicated
custody vault holds the upgrade authority. It proved nothing about how the
program behaves with real tokens in it. The gate stays closed.

### Live devnet custody validation

Deployment established identity: the bytes the loader holds are the reviewed
bytes, and the account that can replace them is the dedicated custody vault.
Neither fact says anything about what the program does with tokens in it, and
until this sprint the repository had no way to find out — every custody claim it
makes is proved against a model, a local validator, or the source.

`scripts/devnet-escrow-custody.mjs` is the harness that closes that gap. It puts
disposable, economically worthless Classic SPL Token units through real
per-agreement vaults on devnet and asserts, as arithmetic over observed
balances rather than as transaction statuses:

- funding moves exactly the agreement amount into the vault the protocol derives;
- settlement, refund, milestone release and dispute concession each move exactly
  the remaining amount to exactly the party the protocol names, with every other
  watched account moving by zero;
- every unauthorized signer, wrong destination, wrong mint, double payment,
  post-terminal mutation, foreign milestone, foreign proof and self-directed
  concession is refused **and leaves the state and every balance unchanged**;
- the events the deployed program emits reconstruct each lifecycle family, and
  the reconstruction agrees with live account state.

The run is `workflow_dispatch` only
(`.github/workflows/devnet-escrow-custody-validation.yml`): never on push, never
on a pull request, never on a schedule, and with no endpoint input. The harness
refuses any cluster that is not devnet, by genesis hash, before a keypair is
loaded or an instruction is built. Its evidence lands in
`deployments/validation/` and can hold public facts only — the generator fails
rather than redacts if anything key-shaped reaches it.

**Status: the preflight has run; the custody suite has not.**

The read-only half — `verify-escrow-custody-preflight.yml` — runs on every pull
request that touches the harness, the Squads decoder, the governance verifier or
the evidence records, and it passes against live devnet. It establishes the
cluster, that `ppv_escrow` is executable and loader-owned at its permanent id,
that ProgramData resolves to `2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa`,
that the upgrade authority is the custody vault, that the deployed bytes hash to
the reviewed binary, and — decoded out of the Squads V4 multisig account rather
than declared — a threshold of 2, exactly the three recorded members, mask 7
each, and a vault index 0 that derives to
`FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE`. That is what closed **RR-7** for
the custody multisig.

The value-moving half is **ATTEMPTED — NOT COMPLETED**, and the reason has
moved. Run [35465469908](https://github.com/gwapupward-hub/ppv/actions/runs/35465469908)
executed the whole custody behaviour matrix against the deployed program —
ordinary escrow, cancellation, refund, both dispute outcomes, milestones,
bounty, proof submission, approval and rejection, a live CPI into `ppv_core`,
the foreign-proof relationship negative and its cleanup, and the proof-backed
final settlement — with every completed funded scenario vault back to zero. It
then stopped in Phase 12, the *read-only* history reconstruction, because the
RPC provider answered `getTransaction` with HTTP 429.

So agreements were created, vaults existed, and tokens did enter and leave PPV
custody. What is missing is narrower, and it is what this gate turns on:

> **No complete custody matrix has been independently reconstructed from chain
> state, so no canonical validation record exists.**

`scripts/recover-devnet-escrow-custody-evidence.mjs` and
`.github/workflows/devnet-escrow-custody-recovery.yml` exist to close that
read-only, from run 35465469908's public diagnostic, without repeating a single
value-moving transaction. Until that recovery runs and reports `RECOVERY=PASS`,
this row stays as it is.

`deployments/validation/README.md` lists each attempt and where it stopped. An
aborted attempt is neither a custody PASS nor a custody FAIL; none of them is a
finding about the deployed program.

The blocking causes are fixed and separately tested — full-history checkout,
funder-secret parsing, bounded read-side rate-limit handling, and a dedicated
devnet RPC endpoint replacing the shared public one. What remains is one
authorized execution. Until a run completes and its evidence is committed under
`deployments/validation/`, the correct reading of every custody-behaviour claim
in this repository is the one it already carries, and **RR-6** stays open.

**A passing run would not open this gate.** It would close the coverage rows in
the smoke suite's table and could close RR-6 and RR-7. The gate's remaining
requirements — an independent Solana security review (**RR-13**) and legal
review — are untouched by it, which is why they are listed separately below.

Before any cluster deployment of `ppv_escrow`:

- Independent Solana security review of the custody path, with all critical and
  high findings remediated and re-reviewed.
- Deliberate vulnerability testing performed on every guard, per
  [security-model.md](security-model.md): each guard removed in turn, the
  corresponding negative test confirmed to fail, then restored.
- Fuzzing of the state machine and the custody accounting. Partially met:
  `npm run test:invariants:release` is the `SECURITY_INVARIANTS_GREEN` gate and
  attacks the ordinary-escrow custody path with randomized valid and invalid
  instruction sequences, asserting `PPV-P1` … `PPV-P10` after every attempted
  action. It covers `fund`, `mark_completed`, `settle` and `cancel` only;
  disputes, refunds, milestones, bounties, proofs and cross-program composition
  are still unfuzzed. See [property-testing.md](property-testing.md).
- ~~An upgrade authority held by a multisig separate from the non-custodial
  programs, so a compromise of one cannot reach the other.~~ **MET** (Sprint 4,
  RR-11). A dedicated Squads V4 2-of-3 exists on devnet:
  multisig `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46`, vault
  `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE`. Recorded in
  `ESCROW_CUSTODY_GOVERNANCE`. The vault **is** the live upgrade authority of
  the deployed `ppv_escrow` program: the transfer was executed on devnet on
  2026-09-15 and is finalized, and `deployments/evidence/ppv-escrow-devnet-231dceb.json`
  records both the deployment and the authority-transfer signatures.

  *Historical note.* Until the Sprint 4 deployment this bullet said the vault
  was the *intended future* authority and that no authority had been
  transferred. That was true when written and is no longer true; it is kept
  here as history so the sequence of events stays legible, not as a statement
  about the present.

  **Approved exception — one shared signer, devnet only.** One custody signer is
  intentionally shared with Core/Commerce governance
  (`BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`). The other two custody
  signers are distinct. This exception is approved for devnet only. One shared
  key cannot reach a 2-of-3 threshold by itself, which is what makes it
  tolerable; a second would end that property, so
  `verify-custody-governance.mjs` counts overlaps and still refuses this member
  set by default. The exception is taken per run with `--allow-shared-signers`
  and is never the verifier's default.
- Legal review of the settlement and (once implemented) dispute paths.
- The accepted limitations in [security-model.md](security-model.md) — stranded
  donations, no refund, no expiry — either resolved or explicitly signed off.

Invoices, milestones, disputes, refunds, fees, and mainnet value transfer remain
outside this release. Passing the Foundation gates does not approve custody.

**Status after Sprint 4's freeze:**

| | |
| --- | --- |
| Permanent Escrow identity | ESTABLISHED (`7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4`) |
| Dedicated custody governance | ESTABLISHED (devnet) |
| Escrow deployed | YES — devnet, 2026-09-15, run 34940712181 |
| Escrow authority transferred | YES — to the custody vault `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Independent security review | NOT DONE (RR-13) |
| Legal review | NOT DONE |
| **Custody gate** | **CLOSED** |
| Mainnet authorized | NO |
