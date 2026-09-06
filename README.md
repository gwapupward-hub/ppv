# PPV Foundation

Private proofs, exact-version agreements, and a token escrow kernel for GWAP OS,
implemented as three separately deployable Solana programs.

## Scope

- `ppv_core`: wallet-authorized proof timestamps and permanent revocation
  markers. Non-custodial.
- `ppv_commerce`: bilateral agreement creation, revision, signing, execution,
  and cancellation. Non-custodial.
- `ppv_escrow`: the custody kernel — `initialize_agreement`, `fund`,
  `mark_completed`, `settle` over `Open → Funded → Completed → Settled`, with a
  vault and vault authority derived per agreement; `submit_proof`,
  `approve_proof` and `reject_proof` for agreement-bound evidence; and `cancel`,
  `open_dispute`, `resolve_dispute` and `refund` for the ways an agreement ends
  other than payment; and milestone contracts, which escrow one budget and
  release it in tranches. **Local validator only.**
- `@gwap/ppv-sdk`: frozen canonicalization v1 and SHA-256 helpers shared by
  every client; the versioned reputation contracts (`ReputationEventV1`,
  `PpvReceiptV1`, seal states, credential eligibility); decoders for the
  programs' `emit_cpi!` events; and dependency-free PDA derivation, account
  decoding, and deterministic receipt reconstruction for the escrow kernel.
  PPV records facts; GwapScore interprets them.
- `@gwap/ppv-indexer`: rebuilds an agreement's whole lifecycle from a public RPC
  endpoint and the SDK — no GWAP database and no privileged access. Run it with
  `npm run replay`.

Not included: invoices, third-party arbitration, protocol fees,
document encryption, GNS authority, or any mainnet deployment. Disputes are
resolved by concession only — the party who would lose signs away its own claim
— because an arbiter is a trusted third party and the protocol has not yet
decided who may be one.

`ppv_escrow` is the only program that holds value, and it is deliberately absent
from `[programs.devnet]` and from the devnet deploy workflow. That exclusion is
a security boundary, not an unfinished checkbox: custody deploys only after the
custody gate in [docs/deployment-gates.md](docs/deployment-gates.md) — signed
terms binding, legal policy, invariant tests, fuzzing, and external audit — is
complete.

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
8. Every escrow instruction checks both who is signing and whether the action is
   legal in the current state. Either check alone is insufficient.
9. Each escrow agreement has its own vault authority. There is no global
   authority whose compromise would reach more than one agreement's funds.
10. Custody state is never read as protocol state. A vault balance does not fund
    an agreement; an authorized `fund()` that moved exactly the agreed amount
    does.
11. Protocol state is written only after the token transfer succeeds, and every
    emitted event describes a transition that actually committed.

## Important product claim

A PPV proof demonstrates that a particular wallet committed to particular
bytes no later than a Solana-confirmed time. It does **not** independently prove
authorship, originality, legal ownership, or copyright registration.

## Local verification

Prerequisites: Rust 1.85.1, Anchor 0.30.1, Solana CLI 1.18.17, and Node 22+.

```bash
npm ci
npm test                                          # typecheck + SDK and indexer tests
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked
npm run test:f1                                   # the complete F1 gate
```

Two read-only tools work against any cluster, and need only a program id:

```bash
npm run derive:addresses -- --program <ID> --creator <WALLET> --id 42
npm run replay -- --rpc <RPC_URL> --program <ID> --creator <WALLET> --id 42
```

`npm run test:f1` is the gate: it pins the toolchains, generates ephemeral
program keypairs under the ignored `target/deploy/`, builds twice and asserts the
two generated IDLs are byte-identical, checks that the keypair, `declare_id!`,
`Anchor.toml` and the IDL all name the same program id, then starts a
`solana-test-validator`, deploys both programs from their own keypairs, and runs
the full adversarial suite. It restores the committed placeholder ids on every
exit path, so ephemeral ids can never reach a commit.

`Cargo.lock` is committed and authoritative; CI consumes it with `--locked` and
never regenerates it. To move a dependency, run
`./scripts/regenerate-lockfile.sh`, commit the result, and re-run the gate.

The IDs currently committed in `Anchor.toml` and `declare_id!` are build-only
placeholders. Before any deployment, generate controlled program keypairs, run
`anchor keys sync`, rebuild, and record the resulting IDs in the deployment
manifest. Never deploy these placeholder IDs.

## Documentation

- [Architecture](docs/architecture.md)
- [State machines](docs/state-machines.md)
- [Invariants](docs/invariants.md)
- [Address derivation](docs/pdas.md)
- [Protocol events](docs/events.md)
- [Receipts](docs/receipts.md)
- [Indexing](docs/indexing.md)
- [Escrow security model and attack matrix](docs/security-model.md)
- [Threat model](docs/threat-model.md)
- [Canonicalization v1](docs/canonicalization-v1.md)
- [Reputation events v1](docs/reputation-events-v1.md)
- [Deployment gates](docs/deployment-gates.md)
- [Devnet deployment runbook](docs/devnet-deployment.md)
- [Deployment manifests](deployments/README.md)
- [Future arbiter policy gate](docs/arbiter-policy.md)
- [Security policy](SECURITY.md)
