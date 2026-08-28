# PPV Foundation Architecture

## Trust boundary

```text
ppv_governance                  ppv_core                         ppv_commerce
native multisig                 proof timestamps                 exact-version agreements
proposal approvals              no value custody                 no value custody
vault PDA authority             wallet authority                 bilateral wallet authority
independent program ID          independent program ID           independent program ID
```

The three programs share an Anchor workspace, not mutable application state.
`ppv_governance` owns the deterministic vault PDA that becomes upgrade authority
for Governance, Core and Commerce. Core and Commerce never implement multisig
logic themselves and never depend on an external governance provider.

## Program: ppv_governance

### Governance

- PDA: `["governance"]`
- Stores: up to 8 member public keys, threshold, proposal delay, proposal
  lifetime, treasury, epoch and next proposal id.
- Minimum configuration: 2 members and threshold 2. A one-key governance setup
  is rejected by the program.
- Reconfiguration is itself proposal-controlled.
- Every successful reconfiguration increments `epoch`; pending proposals from a
  previous epoch become non-executable.

### GovernanceVault

- PDA: `["vault", governance]`
- Has no private key.
- Becomes the upgrade authority for all PPV programs.
- Signs upgradeable-loader instructions only through `invoke_signed` after an
  on-chain proposal reaches threshold and its delay has elapsed.

### Proposal

- PDA: `["proposal", governance, proposal_id_le]`
- Actions: program upgrade or governance reconfiguration.
- Approvals are one-bit-per-member, preventing duplicate votes.
- Execution is permissionless after the approval threshold and delay are met.
- Proposals expire and cannot execute after cancellation, execution, expiry, or
  a governance epoch change.

For an upgrade proposal the exact **target program** and **buffer account** are
committed before approval. Execution verifies the target ProgramData address,
upgradeable-loader ownership, configured treasury and canonical vault PDA before
performing the loader CPI.

## Program: ppv_core

### ProofRecord

- PDA: `["proof", authority, proof_id]`
- Created by: `authority`
- Modified by: `authority`, revocation only
- Closed by: nobody
- Immutable: authority, proof ID, content hash, context hash, kind, creation time
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

The Solana transaction signature authorizes the instruction data containing the
exact version and hash. `SignatureRecord` preserves the signer wallet, version,
hash and chain time. GNS names are deliberately absent from authority logic and
may be resolved by GWAP OS for display.

## Agreement state transitions

```text
Pending --both current signatures--> Executed
Pending --revision---------------> Pending (version + 1, signatures cleared)
Pending --either party cancels----> Cancelled
```

Executed and Cancelled are terminal in this release. Expiry is evaluated from
`expires_at`; no permissionless instruction rewrites expired accounts.

## Upgrade model

Deployment identities are permanent keypairs held outside Git. The initial
bootstrap order is:

1. Deploy and initialize `ppv_governance`.
2. Derive its canonical Governance PDA and Vault PDA from the committed program
   ID and verify the live member/threshold configuration.
3. Transfer `ppv_governance`'s own upgrade authority to its Vault PDA.
4. Deploy Core and Commerce separately and immediately transfer each upgrade
   authority to the same verified Vault PDA.

After bootstrap, a program upgrade requires a staged loader buffer whose
authority is the PPV Vault PDA, an approved `Upgrade` proposal naming that exact
program and buffer, threshold approval, and execution after the configured delay.
No individual member key can replace program bytecode alone.

## Off-chain responsibilities

- Canonicalize and hash documents locally.
- Encrypt private documents before storage once the wallet-compatible encryption
  design receives dedicated cryptographic review.
- Store private ciphertext in access-controlled, deletable object storage.
- Treat chain state as truth and indexed database records as a cache.
- Resolve GNS names separately and label historical claims accurately.
- Build upgrade buffers deterministically and publish their hashes before
  governance approval.
