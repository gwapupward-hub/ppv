# Deployment Gates

## Gate F0 — repository foundation

- Three independent programs compile: `ppv_governance`, `ppv_core`, and
  `ppv_commerce`.
- Rust formatting, host tests, TypeScript type checking, and SDK tests pass.
- Placeholder program IDs are clearly labeled.
- Threat model and canonicalization v1 are committed.

## Gate F1 — local validator

- `anchor build` passes from a clean checkout.
- Full local-validator tests pass for protocol state machines and native
  governance approval/reconfiguration paths.
- Generated IDLs for all three programs are byte-stable across repeated builds.
- CI uses ephemeral ignored program keypairs and never prints or persists their
  secret material.
- Keypair, `declare_id!`, `Anchor.toml`, and IDL addresses match for all three
  programs before validator deployment.
- `Cargo.lock` is committed and authoritative. CI consumes it with `--locked`
  and never silently resolves dependencies.
- Every build toolchain is pinned, including the nightly Anchor 0.30.1 uses for
  IDL generation.

Run the complete gate with `npm run test:f1`. Passing F1 proves build and state
machine behavior only. It does not authorize deployment.

## Gate G1 — native governance bootstrap

Before Core or Commerce may receive a devnet upgrade authority:

- A permanent `ppv_governance` program identity is committed and backed up.
- `ppv_governance` is deployed through the protected `devnet` environment.
- Governance is initialized with at least two unique members and threshold >= 2.
- The live Governance PDA and Vault PDA are derived from the committed program
  ID rather than copied from an external service.
- Live members, threshold, execution delay, proposal lifetime and treasury match
  the protected environment configuration.
- `ppv_governance` transfers its own upgrade authority to its Vault PDA and the
  result is independently verified on-chain.

## Gate F2 — devnet design partners

- Controlled permanent program keypairs replace placeholders.
- Core and Commerce upgrade authorities equal the verified PPV Vault PDA.
- Deployment manifests record `upgradeAuthorityKind: ppv-native-governance` and
  the governance program ID.
- No single governance member can approve an upgrade alone.
- Indexer consumes CPI events idempotently and reconciles against chain state.
- GWAP uses PPV internally for real, non-sensitive agreements.
- No private document is stored in plaintext.

## Gate G2 — first governed upgrade

Before relying on native governance for production-candidate code:

- Stage an upgrade buffer with the PPV Vault PDA as buffer authority.
- Create an upgrade proposal naming the exact target program and buffer.
- Prove a below-threshold proposal cannot execute.
- Prove duplicate approvals do not increase the approval count.
- Prove execution cannot occur before the configured delay.
- Execute one controlled devnet upgrade after threshold and verify the deployed
  binary hash and unchanged Vault PDA authority.
- Exercise a governance reconfiguration and prove older-epoch proposals become
  non-executable.

## Gate F3 — production candidate

- Independent Solana security review covers `ppv_governance` and every program
  whose upgrade authority it controls.
- All critical and high findings are remediated and re-reviewed.
- Operational monitoring and incident response are tested.
- Production/mainnet governance parameters are separately approved; devnet
  parameters are not promoted by assumption.

## Custody gate

Invoices, settlement, escrow, disputes, fees, and mainnet value transfer are
outside this release. They require separate architecture, tests, legal review,
and audit approval. Passing Foundation or governance gates does not approve
custody.
