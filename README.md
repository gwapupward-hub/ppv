# PPV Foundation

Private proofs and exact-version agreements for GWAP OS, implemented as two
separately deployable Solana programs.

## Foundation scope

This branch intentionally contains only the smallest non-custodial protocol
surface:

- `ppv_core`: wallet-authorized proof timestamps and permanent revocation
  markers.
- `ppv_commerce`: bilateral agreement creation, revision, signing, execution,
  and cancellation.
- `@gwap/ppv-sdk`: frozen canonicalization v1 and SHA-256 helpers shared by
  every client, plus the versioned reputation contracts (`ReputationEventV1`,
  `PpvReceiptV1`, seal states, credential eligibility) and the decoder for the
  programs' `emit_cpi!` events. PPV records facts; GwapScore interprets them.

Not included: invoices, token transfers, escrow, milestones, disputes,
arbitration, protocol fees, document encryption, GNS authority, mainnet
deployment, or any instruction that holds user funds.

That exclusion is a security boundary, not an unfinished checkbox. Custody
returns only after its signed-terms binding, legal policy, invariant tests,
fuzzing, and external audit gates are complete.

## Security properties

1. Every mutable action requires the wallet authority recorded on-chain.
2. Proof and agreement PDAs include the creating wallet, preventing a different
   wallet from front-running a client-generated ID.
3. A revision must name the version it expects to replace, preventing silent
   last-write-wins negotiation races.
4. Every revision clears both signatures. A signature can never survive a
   content change.
5. A signature instruction restates both the version and content hash the
   wallet saw. A stale screen produces a clean transaction failure.
6. Evidence accounts cannot be closed. Revocation adds history; it does not
   erase it.
7. No GNS name is treated as an authority. Wallets sign; names remain an
   optional presentation-layer upgrade.

## Important product claim

A PPV proof demonstrates that a particular wallet committed to particular
bytes no later than a Solana-confirmed time. It does **not** independently prove
authorship, originality, legal ownership, or copyright registration.

## Local verification

Prerequisites: Rust 1.85.1, Anchor 0.30.1, Solana CLI 1.18.17, and Node 22+.

```bash
npm ci
npm test                                          # typecheck + SDK tests
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked
npm run test:f1                                   # the complete F1 gate
```

`npm run test:f1` is the gate: it pins the toolchains, generates ephemeral
program keypairs under the ignored `target/deploy/`, builds twice and asserts the
two generated IDLs are byte-identical, checks that the keypair, `declare_id!`,
`Anchor.toml` and the IDL all name the same program id, then starts a
`solana-test-validator`, deploys both programs from their own keypairs, and runs
the full adversarial suite. It restores the committed program ids on every
exit path, so ephemeral ids can never reach a commit.

`Cargo.lock` is committed and authoritative; CI consumes it with `--locked` and
never regenerates it. To move a dependency, run
`./scripts/regenerate-lockfile.sh`, commit the result, and re-run the gate.

The IDs committed in `Anchor.toml` and `declare_id!` are the controlled program
identities:

| Program        | Program ID                                     |
| -------------- | ---------------------------------------------- |
| `ppv_core`     | `ENBkdfjFLD8sjcBFDzwD1BJ437ummEeJPdw6osowuaPm` |
| `ppv_commerce` | `DXzqLJYm4xgBfXpATxE9CaNauHoKcmKqDjYc2o4kNPgA` |

They are no longer placeholders, so do not regenerate them: a program identity is
permanent once deployed. Deploying still requires the matching keypairs from the
operator secret store and follows
[the devnet runbook](docs/devnet-deployment.md) — committing an ID is not a
deployment, and `deployments/devnet.json` remains the only record that one
happened.

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Canonicalization v1](docs/canonicalization-v1.md)
- [Reputation events v1](docs/reputation-events-v1.md)
- [Deployment gates](docs/deployment-gates.md)
- [Devnet deployment runbook](docs/devnet-deployment.md)
- [Deployment manifests](deployments/README.md)
- [Future arbiter policy gate](docs/arbiter-policy.md)
- [Security policy](SECURITY.md)
