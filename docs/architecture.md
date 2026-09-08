# PPV Foundation Architecture

## Trust boundary

```text
ppv_core                ppv_commerce              ppv_escrow
proof timestamps        exact-version agreements  token custody
no value custody        no value custody          holds value
wallet authority        bilateral wallet auth.    per-agreement PDA authority
independent program ID  independent program ID    independent program ID
```

The programs share a workspace and SDK, not state or upgrade authority. A
future `ppv_commerce -> ppv_core` CPI may anchor executed agreement facts after
the core CPI interface is frozen. `ppv_core` must never depend on commerce.

Custody is isolated in its own program on purpose. `ppv_core` and `ppv_commerce`
are non-custodial and can be deployed and upgraded on that basis; folding
`fund`/`settle` into `ppv_commerce` would place value behind the upgrade
authority of a program that never held any, and would make every future
negotiation change a change to custody code. `ppv_escrow` must never become a
dependency of either non-custodial program.

## Program: ppv_core

### ProofRecord

- PDA: `["proof", authority, proof_id]`
- Created by: `authority`
- Modified by: `authority`, revocation only
- Closed by: nobody
- Immutable: authority, proof ID, content hash, context hash, kind, creation
  time
- Mutable: status and revocation time

`proof_id` is a client-generated 16-byte random identifier. Including the
authority in the seeds prevents another wallet from reserving the same ID.

`content_hash` is SHA-256 over canonical plaintext bytes. `context_hash` is an
optional SHA-256 commitment to private metadata or a manifest; all zeroes means
no context commitment.

## Program: ppv_commerce

### Agreement

- PDA: `["agreement", party_a, agreement_id]`
- Created by: `party_a`
- Modified by: `party_a` or `party_b`, subject to instruction-specific guards
- Closed by: nobody
- Immutable: parties, agreement ID, creation time
- Versioned: content hash and terms hash

The Solana transaction signature authorizes the instruction data containing
the exact version and hash. `SignatureRecord` preserves the signer wallet,
version, hash, and chain time. GNS names are deliberately absent from authority
logic and may be resolved by GWAP OS for display.

## Program: ppv_escrow

The Phase 1 custody kernel. Four instructions, one lifecycle, no optional paths.

### Agreement

- PDA: `["agreement", creator, agreement_id_le_u64]`
- Created by: `creator` (the buyer)
- Modified by: `creator` (funding), `counterparty` (completion), either party
  (settlement) — each only from the one state that permits it
- Closed by: nobody
- Immutable: parties, agreement id, type, mint, vault, amount, terms hash
- Mutable: state and the four transition timestamps

### Custody

```text
Agreement #42                         Agreement #43
├── Agreement PDA #42                 ├── Agreement PDA #43
└── Vault authority #42               └── Vault authority #43
    └── Token vault #42                   └── Token vault #43
```

Both custody accounts derive from the agreement address, so one agreement's
funds are reachable only through that agreement. There is no global vault
authority.

The vault is created by an explicit CPI rather than Anchor's `init` + `token::`
constraints, because that codegen pulls in `anchor_spl::token_2022`, whose
dependency tree pins a different `solana-program` than this workspace deploys
with. The hand-written path reproduces the one subtlety `init` handles for free:
an address that already holds lamports is allocated and assigned rather than
created, so nobody can block an agreement by pre-funding its vault address.

Custody accounting is asserted, not assumed. Each transfer is followed by a
reload and a check that the balance moved by exactly `amount`, and the state is
written only afterwards. Details in [security-model.md](security-model.md);
the full lifecycle table is in [state-machines.md](state-machines.md).

## State transitions

```text
Pending --both current signatures--> Executed
Pending --revision---------------> Pending (version + 1, signatures cleared)
Pending --either party cancels----> Cancelled
```

Executed and Cancelled are terminal in this release. Expiry is evaluated from
`expires_at`; no permissionless instruction rewrites expired accounts.

Escrow custody runs a separate machine in a separate program:

```text
Open --fund()--> Funded --mark_completed()--> Completed --settle()--> Settled
```

Negotiation state and custody state are never merged into one enum. See
[state-machines.md](state-machines.md).

## Contracts and custody

`ppv_escrow` never reads a `ppv_commerce` account. The two are bound by a
cryptographic commitment — the same `terms_hash` on both — which
`verifyTermsBinding` re-checks along with the contract's execution state,
parties, and signatures. Verifying it on chain would mean coupling custody to
another program's layout and upgrade authority for no gain the commitment does
not already provide. See [contracts.md](contracts.md).

## Reconstruction

```text
ppv_escrow events (emit_cpi!)
        │
        ▼
@gwap/ppv-indexer   extraction → receipts → projection
        │
        ▼
Agreement lifecycle  identical for anyone with an RPC endpoint
```

`@gwap/ppv-indexer` rebuilds an agreement's whole history from a public RPC
endpoint and the SDK — no GWAP database, no privileged access. It is the
executable form of the protocol's success criterion, and
`scripts/replay-agreement.mts` runs it against any cluster. See
[indexing.md](indexing.md).

## Off-chain responsibilities

- Canonicalize and hash documents locally.
- Encrypt private documents before storage. Encryption is not included until a
  wallet-compatible scheme receives dedicated cryptographic review.
- Store private ciphertext in access-controlled, deletable object storage.
- Treat chain state as truth and indexed database records as a cache. Where the
  two disagree, `@gwap/ppv-indexer` decides.
- Resolve GNS names separately and label historical claims accurately.

## Upgrade model

Local and devnet placeholders are not deployment identities. Every deployed
program receives its own controlled keypair and upgrade authority.

`ppv_escrow` is not deployed to any cluster. It carries a build-only placeholder
id, is absent from `[programs.devnet]` and from the devnet deploy workflow, and
reaches a cluster only after the custody gate in
[deployment-gates.md](deployment-gates.md). Its upgrade authority must be a
Squads multisig separate from the non-custodial programs, so that a compromise
of one authority cannot reach value held by the other.


## Events

All three programs emit their lifecycle facts through Anchor event CPI
(`emit_cpi!`). Every agreement event names both parties, every proof event names
the proof id and kind, and every escrow event names the state transition it
committed, so an indexer can attribute an event without reading the account. The
discriminators are pinned in each crate's unit tests and in
`sdk/test/reputation-chain-events.test.ts` and `sdk/test/escrow-events.test.ts`.

An Anchor discriminator is derived from the name alone, with no program id in
the input, so two programs that pick the same name emit byte-identical prefixes
over incompatible bodies. No two PPV programs share one:
`scripts/test/discriminators.test.mjs` reads every program in the workspace and
fails on any pair, for events and accounts alike.

Identity is still the pair (program id, discriminator); consumers decode through
`decodeEventForProgram`. A collision-free namespace is defence in depth, not a
licence to key on the prefix. See [events.md](events.md).

Events are facts (`AgreementExecuted`, `ProofRevoked`), never judgements.
Reputation interpretation lives in GwapScore, downstream of the normalized
contracts in `sdk/src/reputation/`; see
[reputation-events-v1.md](reputation-events-v1.md).
