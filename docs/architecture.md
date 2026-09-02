# PPV Foundation Architecture

## Trust boundary

```text
ppv_core                         ppv_commerce
proof timestamps                 exact-version agreements
no value custody                 no value custody
wallet authority                 bilateral wallet authority
independent program ID           independent program ID
```

The programs share a workspace and SDK, not state or upgrade authority. A
future `ppv_commerce -> ppv_core` CPI may anchor executed agreement facts after
the core CPI interface is frozen. `ppv_core` must never depend on commerce.

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

## State transitions

```text
Pending --both current signatures--> Executed
Pending --revision---------------> Pending (version + 1, signatures cleared)
Pending --either party cancels----> Cancelled
```

Executed and Cancelled are terminal in this release. Expiry is evaluated from
`expires_at`; no permissionless instruction rewrites expired accounts.

## Off-chain responsibilities

- Canonicalize and hash documents locally.
- Encrypt private documents before storage. Encryption is not included until a
  wallet-compatible scheme receives dedicated cryptographic review.
- Store private ciphertext in access-controlled, deletable object storage.
- Treat chain state as truth and indexed database records as a cache.
- Resolve GNS names separately and label historical claims accurately.

## Upgrade model

Local and devnet placeholders are not deployment identities. Every deployed
program receives its own controlled keypair and upgrade authority. Commerce
must move to a separate Squads multisig before any future fund-moving module is
considered.


## Events

Both programs emit their lifecycle facts through Anchor event CPI
(`emit_cpi!`). Every agreement event names both parties, and every proof
event names the proof id and kind, so an indexer can attribute an event
without reading the account. The discriminators are pinned in each crate's
unit tests and in `sdk/test/reputation-chain-events.test.ts`.

Events are facts (`AgreementExecuted`, `ProofRevoked`), never judgements.
Reputation interpretation lives in GwapScore, downstream of the normalized
contracts in `sdk/src/reputation/`; see
[reputation-events-v1.md](reputation-events-v1.md).
