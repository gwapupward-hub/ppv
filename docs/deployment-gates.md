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

## Gate F2 — devnet design partners

- Controlled program keypairs replace placeholders.
- Devnet upgrade authorities and program IDs are documented.
- Indexer consumes CPI events idempotently and reconciles against chain state.
- GWAP uses PPV internally for real, non-sensitive agreements.
- No private document is stored in plaintext.

## Gate F3 — agreement production candidate

- Independent Solana security review completed.
- All critical and high findings remediated and re-reviewed.
- Product UI states exactly what a timestamp proves and does not prove.
- Operational monitoring and incident response are tested.

## Custody gate — `ppv_escrow`

`ppv_escrow` holds value. It passes F0 and F1 like any other program in the
workspace, and that authorizes nothing beyond a local validator. It is
deliberately absent from `[programs.devnet]` in `Anchor.toml`, from
`.github/workflows/deploy-devnet.yml`, and from `scripts/record-deployment.sh`,
so no existing path can deploy it by accident.

Before any cluster deployment of `ppv_escrow`:

- Independent Solana security review of the custody path, with all critical and
  high findings remediated and re-reviewed.
- Deliberate vulnerability testing performed on every guard, per
  [security-model.md](security-model.md): each guard removed in turn, the
  corresponding negative test confirmed to fail, then restored.
- Fuzzing of the state machine and the custody accounting.
- An upgrade authority held by a multisig separate from the non-custodial
  programs, so a compromise of one cannot reach the other.
- Legal review of the settlement and (once implemented) dispute paths.
- The accepted limitations in [security-model.md](security-model.md) — stranded
  donations, no refund, no expiry — either resolved or explicitly signed off.

Invoices, milestones, disputes, refunds, fees, and mainnet value transfer remain
outside this release. Passing the Foundation gates does not approve custody.
