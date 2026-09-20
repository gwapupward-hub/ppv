# Devnet and Mainnet deployment runbook

Use this reference to prepare, rehearse, execute, or verify a Solana program deployment or upgrade. Adapt commands to the exact installed CLI and framework version; inspect `--help` before relying on flags.

## Release principles

- Deploy an identified artifact from an identified commit to an identified program on an identified cluster.
- Keep program identity, upgrade authority, fee payer, and application authority as separate concepts.
- Build once in the controlled release path; promote the same hashed artifact when the tooling and governance model allow it.
- Rehearse the full signing and governance path on Devnet, not just `anchor deploy` from a laptop.
- Make every step observable and reversible where possible. On Solana, “rollback” normally means another authorized upgrade and may not reverse migrated state.
- Never run Mainnet, authority-transfer, immutability, close, or multisig-execute steps without explicit target-specific authorization.

## Phase 0 — Release intent and authorization

Record:

- new deployment or upgrade;
- Devnet, Testnet, Mainnet, or local validator;
- program name and intended program ID;
- source repository, branch, exact commit, and release tag;
- requested release owner and approvers;
- expected user/state impact and maintenance behavior;
- upgrade authority and signing/governance path;
- rollback artifact and state-compatibility limits.

If any field is ambiguous, stop before creating or funding on-chain accounts.

## Phase 1 — Program identity matrix

Compare every source of program identity:

| Source | Expected evidence |
| --- | --- |
| Program source | `declare_id!` or native equivalent |
| `Anchor.toml` | Correct entry in the exact target-cluster section |
| Program keypair | Public key derived locally; never print keypair bytes |
| IDL/generated client | Metadata address or configured program ID |
| Frontend/backend/indexer | Environment-specific program ID |
| On-chain target | `solana program show` output for the selected RPC |
| Governance | Multisig vault/proposal targets the same program or ProgramData authority |

Any mismatch is a release blocker until explained. Do not “fix” identity by generating a new keypair during deployment. The program-ID keypair is permanent identity material; recover the approved source or deliberately approve a new address and all downstream changes.

Safe local checks include:

```bash
solana-keygen pubkey path/to/program-keypair.json
solana program show <PROGRAM_ID> --url <RPC_URL>
```

Never display or paste the JSON keypair contents.

## Phase 2 — Toolchain and repository provenance

Capture:

- `git rev-parse HEAD`, release tag, and clean/dirty status;
- Rust toolchain and Cargo lockfile;
- Solana/Agave CLI and platform-tools version;
- Anchor/AVM version or native/Pinocchio versions;
- Node and package-manager versions plus lockfile;
- CI workflow revision and build container digest;
- dependency advisory results.

Use project-local pins. Do not globally upgrade tools inside the release job unless the release explicitly includes that migration.

## Phase 3 — Build and test gates

The exact commands depend on the repository, but the release must cover:

- formatting and linting;
- Rust and client unit tests;
- instruction/integration tests;
- adversarial and invariant tests;
- IDL/generated-client drift check;
- program binary size and account-size checks;
- compute and loaded-account-data measurements;
- migration and rollback tests when state changes;
- dependency and secret scans.

Use LiteSVM or Mollusk for fast program execution tests and a local validator when RPC/validator behavior, cloned programs/accounts, or full clients matter. Devnet is the final rehearsal, not the first integration test.

## Phase 4 — Reproducible artifact

For Anchor projects that support it:

```bash
anchor build --verifiable
```

For any build path:

1. pin the builder/toolchain image and source commit;
2. produce the `.so`, IDL, generated clients, and migration artifacts;
3. calculate and record cryptographic hashes;
4. store artifacts immutably with the release record;
5. compare against a second controlled build when reproducibility is a release gate;
6. use `anchor verify` or the approved verification workflow after deployment.

Do not rebuild between final approval and broadcast unless the new artifact receives a new hash and approval.

## Phase 5 — On-chain target, authority, and funding

Using the explicit RPC URL:

- verify cluster/genesis context and current slot/health;
- inspect program owner, ProgramData address, last deployment slot, allocation, balance, and current upgrade authority;
- verify the upgrade authority equals the approved direct signer, PDA, or multisig vault;
- verify fee payer and deployer public keys;
- estimate program allocation/rent and transaction fees from the actual artifact size;
- keep a margin for program extension and congestion;
- verify the signing mechanism can authorize the exact payload without moving secrets into CI.

If the current authority is unknown, unavailable, or different from governance records, stop. A successful build cannot solve an authority mismatch.

## Phase 6 — Devnet rehearsal

Run a production-shaped rehearsal:

1. use the approved Devnet program ID and authority pattern;
2. deploy through the same CI and multisig/custody roles where feasible;
3. capture artifact hash, proposal payload, transaction signatures, deployment slot, and post-deploy metadata;
4. wait for deployment visibility in the next slot before invoking the new version;
5. run smoke and negative tests against Devnet RPC;
6. exercise indexers, webhooks, SDKs, clients, monitoring, and alert routing;
7. test a rollback/redeploy of the previous compatible artifact or document why it is unsafe;
8. record every manual exception that Mainnet must eliminate.

Devnet success does not waive Mainnet review. Devnet can differ in feature set, traffic, data, RPC behavior, economic incentives, and operational stability.

## Phase 7 — Mainnet go/no-go gate

Require all applicable evidence:

- exact source commit approved and protected;
- clean controlled build and locked dependencies;
- final artifact and IDL hashes;
- program identity matrix reconciled;
- security review complete, with no unaccepted Critical/High finding;
- test matrix green and resource headroom measured;
- state migration and rollback plan rehearsed;
- Mainnet authority/governance path verified on-chain;
- deployer funded without exposing custody material;
- dedicated RPC and fallback path healthy;
- proposal bytes or exact command independently reviewed;
- monitoring, incident contacts, pause/recovery path, and communications ready;
- explicit final user/owner authorization for the Mainnet mutation.

Return `NO-GO` when evidence is missing in a way that can cause loss, loss of control, or an unverifiable deployment. Schedule pressure is not a control.

## Phase 8 — Controlled execution

Immediately before broadcast, recheck:

- cluster/RPC;
- commit and artifact hash;
- program ID and on-chain authority;
- fee payer/deployer public keys and balances;
- proposal or command payload;
- signer threshold and approvals;
- network health and operational coverage.

Use the framework-native or Solana CLI deployment command appropriate to the pinned version. Keep sanitized complete logs. Record transaction signatures and buffer addresses without exposing signer material.

If a deployment fails:

- preserve the first error and signature;
- determine whether a buffer or partial upload exists;
- verify on-chain program metadata before retrying;
- classify the failure as deterministic, authorization/funding, or transient landing/RPC;
- do not generate a new program keypair or blindly restart with different flags.

## Phase 9 — Post-deploy verification

After the next-slot visibility delay:

1. inspect `solana program show <PROGRAM_ID>` against the explicit Mainnet RPC;
2. record ProgramData address, deployment slot, data length, balance, owner, and authority;
3. dump or verify the on-chain binary using the approved verification tool;
4. verify the IDL and generated clients match the release artifact where applicable;
5. run narrow read-only checks first, then approved smoke transactions;
6. confirm events, logs, indexer/webhook processing, balances, and state changes;
7. verify client transaction readers support the emitted transaction versions;
8. monitor errors, compute, transaction landing, RPC health, and economic invariants during the release window;
9. publish or store the completed release record.

Do not report success solely because the deploy command exited zero.

## Authorities and multisig

- Use separate authorities for upgrades and protocol operations when their risks differ.
- Prefer production upgrade authority under an audited multisig/custody path rather than a hot developer key.
- Review the exact multisig instruction data, accounts, program ID, buffer, and authority transition before approval.
- Verify threshold, member public keys, roles/permissions, vault derivation, and target cluster.
- Treat proposal creation, approval, and execution as separate states. “Two approvals submitted” does not mean execution succeeded.
- If a buffer is used, verify its authority and hash before the upgrade; close it only after successful verification and separate authorization.
- Keep emergency procedures for lost/compromised members and governance deadlock.

Vendor-specific multisig or custody commands must come from the current official documentation and the installed SDK/CLI version. Never reconstruct a production payload from memory.

## Rollback and migrations

Solana has no automatic code rollback. A practical rollback requires:

- retained prior binary and its reproducible build record;
- available upgrade authority and functioning governance;
- enough ProgramData allocation and SOL;
- backward-compatible account state or a tested reverse/forward-fix migration;
- old clients/indexers able to operate against the restored ABI;
- an incident decision and exact payload ready.

If a data migration is irreversible, call it out explicitly. Consider feature flags, staged activation, versioned instructions, a pause gate, or a new program ID when an in-place rollback cannot be made safe.

## Release record template

```text
Release:
Environment / RPC class:
Repository / commit / tag:
Toolchain and builder digest:
Program name / ID:
ProgramData address:
Previous deployment slot:
New deployment slot:
Artifact SHA-256:
IDL/client hashes:
Program owner / loader:
Upgrade authority before / after:
Fee payer / deployer public keys:
Proposal IDs / transaction signatures / buffer:
Tests and security gates:
Verifiable-build result:
Smoke-test result:
Monitoring and reconciliation result:
Rollback artifact and compatibility:
Approvers / timestamp:
Residual risks:
```
