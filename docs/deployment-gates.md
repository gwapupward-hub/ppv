# Deployment Gates

## Gate F0 — repository foundation

- Two independent programs compile.
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

## Custody gate

Invoices, settlement, escrow, disputes, fees, and mainnet value transfer are
outside this release. They require separate architecture, tests, legal review,
and audit approval. Passing Foundation gates does not approve custody.
