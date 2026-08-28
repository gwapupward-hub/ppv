# Devnet deployment runbook

This runbook covers PPV Foundation on **Solana devnet only**. Mainnet is out of
scope. PPV uses its own `ppv_governance` program and canonical Vault PDA for
upgrade authority; there is no external multisig dependency.

Nothing committed to this repository contains private signing material. Program
keypairs and the deployer keypair remain in the protected operator secret store.
Only public program IDs, governance member addresses, PDAs, transaction
signatures and artifact hashes are recorded.

## Pinned toolchain

| Tool | Version |
|---|---|
| Anchor CLI | 0.30.1 |
| Solana CLI | 1.18.17 |
| Rust host | 1.85.1 |
| Rust SBF | 1.75.0 via Solana 1.18.17 platform tools |
| Node | 22 |

Local gate:

```bash
npm ci
npm test
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked
npm run test:f1
```

F1 generates ignored ephemeral identities for `ppv_governance`, `ppv_core`, and
`ppv_commerce`, builds twice, compares all generated IDLs, validates identity
alignment, deploys to a local validator, and runs the protocol/governance tests.
Ephemeral keys are never valid deployment identities.

## Permanent program identities

The three programs have separate permanent keypairs:

- `PPV_GOVERNANCE_PROGRAM_KEYPAIR`
- `PPV_CORE_PROGRAM_KEYPAIR`
- `PPV_COMMERCE_PROGRAM_KEYPAIR`

The private JSON values remain environment secrets. Their public addresses are
safe to commit and must match all of these surfaces before deployment:

1. the corresponding secret-backed keypair;
2. `declare_id!` in `programs/<program>/src/lib.rs`;
3. both matching entries in `Anchor.toml`;
4. the generated IDL address.

Do not generate substitute keypairs merely to make the identity gate pass.
Program identities are permanent once first deployed.

## Native governance model

`ppv_governance` creates two canonical accounts:

```text
Governance PDA = PDA(["governance"], ppv_governance_program_id)
Vault PDA      = PDA(["vault", Governance PDA], ppv_governance_program_id)
```

The Governance account stores:

- 2–8 unique member public keys;
- threshold, always at least 2;
- minimum execution delay in slots;
- proposal lifetime in slots;
- governance treasury/spill destination;
- governance epoch and next proposal id.

The Vault PDA has no private key. After bootstrap it is the upgrade authority for
`ppv_governance`, `ppv_core`, and `ppv_commerce`. Program upgrades can then occur
only through approved governance proposals executed by `ppv_governance` with
PDA signer seeds.

A reconfiguration proposal uses the same threshold/delay mechanism. Successful
reconfiguration increments the governance epoch so proposals approved under an
older member configuration become non-executable.

## Protected GitHub environment

The `devnet` environment must require human approval before secrets are released
to the deployment job.

### Environment secrets

- `PPV_GOVERNANCE_PROGRAM_KEYPAIR`
- `PPV_CORE_PROGRAM_KEYPAIR`
- `PPV_COMMERCE_PROGRAM_KEYPAIR`
- `PPV_DEPLOYER_KEYPAIR`

### Public environment variables

- `PPV_DEVNET_GENESIS_HASH`
- `PPV_GOVERNANCE_MEMBER_PUBKEYS` — comma-separated public addresses
- `PPV_GOVERNANCE_THRESHOLD`
- `PPV_GOVERNANCE_MIN_DELAY_SLOTS`
- `PPV_GOVERNANCE_PROPOSAL_LIFETIME_SLOTS`
- `PPV_GOVERNANCE_TREASURY`

There is intentionally **no manually configured Vault PDA variable**. The
workflow derives the Governance and Vault PDAs from the committed governance
program ID and verifies the live governance account before any authority
handoff.

## Bootstrap order

### 1. Deploy native governance first

Run the protected `Deploy devnet` workflow with:

```text
program = ppv_governance
confirm = ppv_governance
```

The workflow:

1. loads only the selected governance program keypair and deployer keypair;
2. proves the secret-backed program address matches committed source/config;
3. builds with the pinned toolchain;
4. refuses a program address that already exists in this initial-deployment
   path;
5. deploys with the deployer as temporary upgrade authority;
6. initializes the canonical Governance and Vault PDAs using the protected
   public policy variables;
7. reads the governance state back from devnet and verifies members, threshold,
   delay, proposal lifetime and treasury;
8. transfers `ppv_governance`'s own upgrade authority to its Vault PDA;
9. verifies the live authority and records public deployment evidence;
10. destroys temporary keypair files on every exit path.

Governance initialization is deliberately part of the same protected run. Do not
leave a newly deployed singleton governance program uninitialized for later.

### 2. Deploy Core

After governance is live and verified, synchronize Core's permanent public ID and
run:

```text
program = ppv_core
confirm = ppv_core
```

The job independently re-verifies native governance, deploys Core with temporary
deployer authority, immediately transfers authority to the derived Vault PDA,
and fails unless the chain reports that exact authority.

### 3. Deploy Commerce

Repeat with:

```text
program = ppv_commerce
confirm = ppv_commerce
```

Core and Commerce are separate runs so failure of one cannot create ambiguous
evidence for the other.

## Deployer funding

GitHub Actions does not eliminate Solana deployment costs. The public address
corresponding to `PPV_DEPLOYER_KEYPAIR` must hold enough devnet SOL for the
selected deployment. The workflow prints only the deployer public address and
its devnet balance before deployment.

Do not rotate a permanent program keypair because a deployer is underfunded.
Fund the deployer and retry using the same program identity.

## Deployment evidence

Each successful run appends public evidence to `deployments/devnet.json` and
records:

- program ID and ProgramData address;
- canonical Vault PDA upgrade authority;
- `upgradeAuthorityKind: "ppv-native-governance"`;
- `governanceProgramId`;
- governance members and threshold;
- deployment slot and transaction signature;
- git commit and pinned toolchain;
- IDL and binary SHA-256 hashes;
- whether the build was verifiable.

Devnet currently uses a normal `anchor build`, so `verifiable` is recorded as
`false`. Production-candidate/mainnet policy must revisit reproducible builds.

Run:

```bash
./scripts/verify-deployment.sh
```

and, when available, repeat with an independent RPC via `PPV_VERIFY_RPC_URL`.
An upgrade-authority mismatch is a security incident, not ordinary configuration
drift.

## Governed upgrades after bootstrap

An upgrade is no longer signed directly by an operator wallet. The controlled
flow is:

1. build and hash the candidate program artifact;
2. create a Solana upgrade buffer for that artifact;
3. hand buffer authority to the canonical PPV Vault PDA;
4. create an `Upgrade` governance proposal containing the **exact target program
   address and exact buffer address**;
5. governance members approve on-chain;
6. wait until the configured execution delay has elapsed;
7. execute `execute_upgrade`; execution is permissionless once the proposal is
   valid, approved, mature and unexpired;
8. verify the live binary/ProgramData state and that upgrade authority remains
   the same Vault PDA;
9. append deployment/upgrade evidence without rewriting history.

The first governed upgrade must be exercised on devnet before native governance
is trusted for any production candidate.

## Governance changes

Member, threshold, delay, lifetime, or treasury changes are never direct admin
writes. A member creates a reconfiguration proposal, members approve it, and the
proposal executes only after threshold and delay requirements are satisfied.
Execution increments the governance epoch, invalidating proposals created under
the previous configuration.

## Post-deployment checks

For each controlled program:

```bash
solana program show <PROGRAM_ID> --url https://api.devnet.solana.com
solana account <PROGRAM_ID> --url https://api.devnet.solana.com --output json
```

Confirm:

- the program is executable and upgradeable-loader owned;
- ProgramData matches the manifest;
- upgrade authority equals the canonical PPV Vault PDA;
- no deployer/member wallet remains direct upgrade authority;
- deployment signature, hashes and source commit are recorded.

## Mainnet boundary

This native governance implementation does **not** become production-ready merely
because it works on devnet. Before any production/mainnet candidate:

- independently audit `ppv_governance`, including its loader CPI and PDA signing;
- complete the Gate G2 governed-upgrade exercise;
- remediate and re-review all critical/high findings;
- deliberately choose production governance members/threshold/timelock;
- require production-grade reproducible build evidence.
