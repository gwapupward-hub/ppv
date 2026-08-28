# PPV Foundation

Private proofs, exact-version agreements, and native upgrade governance for GWAP
OS, implemented as three separately deployable Solana programs.

## Foundation scope

This branch intentionally contains the smallest non-custodial protocol surface:

- `ppv_governance`: native threshold governance and the canonical Vault PDA that
  controls PPV program upgrades.
- `ppv_core`: wallet-authorized proof timestamps and permanent revocation
  markers.
- `ppv_commerce`: bilateral agreement creation, revision, signing, execution,
  and cancellation.
- `@gwap/ppv-sdk`: frozen canonicalization v1 and SHA-256 helpers shared by
  every client.

Not included: invoices, token transfers, escrow, milestones, disputes,
arbitration, protocol fees, document encryption, GNS authority, mainnet
deployment, or any instruction that holds user funds.

That exclusion is a security boundary, not an unfinished checkbox. Custody
returns only after its signed-terms binding, legal policy, invariant tests,
fuzzing, and external audit gates are complete.

## Native governance

PPV does not depend on an external multisig provider. `ppv_governance` owns a
program-derived Vault PDA with no private key. Governance stores 2–8 unique
member public keys, a threshold of at least 2, an execution delay, proposal
lifetime, treasury, and governance epoch.

Program upgrades follow this path:

```text
member proposes exact program + buffer
             ↓
unique member approvals
             ↓
threshold reached
             ↓
execution delay elapsed
             ↓
ppv_governance invokes Solana's upgradeable loader
             ↓
Vault PDA signs with canonical PDA seeds
```

Governance reconfiguration uses the same proposal/approval path. A successful
reconfiguration increments the governance epoch, making pending proposals from
the previous configuration non-executable.

## Security properties

1. Every mutable Core/Commerce action requires the wallet authority recorded
   on-chain.
2. Proof and agreement PDAs include the creating wallet, preventing another
   wallet from reserving a client-generated ID.
3. A revision must name the version it expects to replace.
4. Every revision clears both signatures.
5. A signature instruction restates both the version and content hash the wallet
   saw.
6. Evidence accounts cannot be closed. Revocation adds history; it does not
   erase it.
7. No GNS name is treated as an authority. Wallets sign; names are presentation.
8. Native governance rejects one-key control: at least two unique members and a
   threshold of at least two are mandatory.
9. Upgrade proposals bind approval to one exact program and one exact loader
   buffer.
10. Governance, Core, and Commerce transfer upgrade authority to the same
    deterministic PPV Vault PDA after bootstrap.

## Important product claim

A PPV proof demonstrates that a particular wallet committed to particular bytes
no later than a Solana-confirmed time. It does **not** independently prove
authorship, originality, legal ownership, or copyright registration.

## Local verification

Prerequisites: Rust 1.85.1, Anchor 0.30.1, Solana CLI 1.18.17, and Node 22+.

```bash
npm ci
npm test
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked
npm run test:f1
```

`npm run test:f1` generates ephemeral program identities under ignored
`target/deploy/`, builds twice, compares all three generated IDLs, verifies that
keypair/`declare_id!`/`Anchor.toml`/IDL identities agree, starts a local validator,
deploys the programs, and runs the Foundation and governance test suites. It
restores committed placeholder IDs on every exit path.

`Cargo.lock` is committed and authoritative; CI consumes it with `--locked`.
Dependency movement is deliberate and reviewed.

The program IDs currently committed are build-only placeholders until permanent
secret-backed keypair addresses are synchronized. Never deploy a placeholder
identity.

## Controlled devnet bootstrap

The protected devnet order is:

1. synchronize and commit the permanent `ppv_governance` public program ID;
2. deploy and initialize native governance;
3. verify the live Governance and Vault PDAs plus policy configuration;
4. transfer Governance's own upgrade authority to the Vault PDA;
5. synchronize/deploy Core and Commerce separately;
6. transfer each upgrade authority to the same verified Vault PDA;
7. record and independently verify deployment evidence.

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Canonicalization v1](docs/canonicalization-v1.md)
- [Deployment gates](docs/deployment-gates.md)
- [Devnet deployment runbook](docs/devnet-deployment.md)
- [Deployment manifests](deployments/README.md)
- [Future arbiter policy gate](docs/arbiter-policy.md)
- [Security policy](SECURITY.md)
