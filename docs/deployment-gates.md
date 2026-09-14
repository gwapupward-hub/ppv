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
  `ESCROW_CUSTODY_GOVERNANCE`. The vault is the *intended future* upgrade
  authority; **no authority has been transferred**, because escrow is not
  deployed.

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
| Escrow deployed | NO |
| Escrow authority transferred | NO |
| Independent security review | NOT DONE (RR-13) |
| Legal review | NOT DONE |
| **Custody gate** | **CLOSED** |
| Mainnet authorized | NO |
