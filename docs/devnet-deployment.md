# Devnet deployment runbook

This runbook covers PPV Foundation on **Solana devnet only**. Mainnet is out of
scope for Foundation and is not covered here.

> **`ppv_core` is already released to devnet.** Its initial deployment is
> complete and its upgrade authority is the Squads vault. The initial-deployment
> procedure below does not apply to it and the workflow refuses to run it; a
> future Core change is an upgrade, described in
> [`ppv-core-upgrade-runbook.md`](ppv-core-upgrade-runbook.md). The release
> itself is recorded in
> [`releases/ppv-core-devnet-v1.md`](releases/ppv-core-devnet-v1.md).
>
> The procedure below is live for `ppv_commerce`, which has not been deployed.

Nothing in this document, and nothing committed to this repository, contains
signing material. Program keypairs, deployer keypairs, and upgrade-authority
keypairs live only in the operator secret store. This repository records public
keys and transaction signatures.

## Toolchain

Deployments must be produced with exactly these versions. They are the versions
CI verifies and the versions the committed `Cargo.lock` is resolved against.

| Tool       | Version  |
| ---------- | -------- |
| Anchor CLI | 0.30.1   |
| Solana CLI | 1.18.17  |
| Rust host  | 1.85.1   |
| Rust SBF   | 1.75.0 (platform-tools v1.41, shipped with Solana 1.18.17) |

```bash
sh -c "$(curl --proto '=https' --tlsv1.2 -sSfL https://release.anza.xyz/v1.18.17/install)"
cargo +1.79.0 install --git https://github.com/solana-foundation/anchor \
  --tag v0.30.1 anchor-cli --locked --force
anchor --version   # anchor-cli 0.30.1
solana --version   # solana-cli 1.18.17
```

Anchor 0.30.1's own locked dependencies predate Rust 1.80, so the CLI itself is
built with Rust 1.79.0. That toolchain is only used to build the CLI; the
programs are built with the host 1.85.1 toolchain and the SBF 1.75 toolchain.

## Readiness gate

Before anything below, run the preflight. It is fail-closed: a check it cannot
perform is a failure, not a skip.

```bash
npm run verify:devnet-readiness
```

See [devnet-release-readiness.md](devnet-release-readiness.md) for what it
checks, what the tests guarantee, and the manual blockers that must be complete
first.

## Local verification before any deployment

```bash
npm ci
cargo fmt --all -- --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked
npm test
npm run test:f1
```

`npm run test:f1` builds twice, asserts the two generated IDLs are
byte-identical, and runs the full `solana-test-validator` suite. It generates
**ephemeral** program keypairs under the git-ignored `target/deploy/` directory
and restores the repository's placeholder program IDs when it finishes. Those
ephemeral keys are never deployable and never leave the machine.

## Dependency policy

`Cargo.lock` is committed and authoritative. CI consumes it with `--locked` and
never regenerates or mutates it, so a drifting crates.io index cannot silently
change what is built or deployed.

Two independent constraints shape it:

1. Every manifest in the resolve graph must be parseable by the SBF toolchain's
   Cargo 1.75. Crates that adopted `edition2024` are not, and Cargo's MSRV-aware
   resolver cannot avoid them when a dependency omits or understates its own
   `rust-version`.
2. Host-side IDL generation runs `anchor-syn 0.30.1`, which calls
   `proc_macro2::Span::source_file()`. That method was removed in later
   proc-macro2 releases, so the proc-macro family must stay on Anchor 0.30.1's
   own baseline.

The non-arbitrary resolution for both is to hold the shared transitive graph at
the versions the pinned toolchain was released against — Anchor v0.30.1's
lockfile, falling back to Agave v1.18.17's lockfile. `scripts/regenerate-lockfile.sh`
applies exactly that rule and is the only supported way to move the lockfile.

## Controlled program identities

Core and Commerce are independently deployable and have separate keypairs and
separate upgrade authorities.

Program keypairs live in the **cloud secret manager** (Vault / AWS Secrets
Manager / GCP Secret Manager). They are generated on the operator machine,
written straight into the secret store, and pulled back only for the duration of
a build. They never enter Git, CI logs, build artifacts, an application bundle,
or a chat message.

```bash
# Generate into a directory that is not inside any repository.
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

solana-keygen new --no-bip39-passphrase --outfile "${work}/ppv_core-keypair.json"
solana-keygen new --no-bip39-passphrase --outfile "${work}/ppv_commerce-keypair.json"

# Push to the secret store, then record the public keys for the manifest.
# (Substitute your provider's CLI; the point is that the file is stored once and
# the local copy is destroyed by the trap above.)
vault kv put secret/ppv/devnet/ppv_core     keypair=@"${work}/ppv_core-keypair.json"
vault kv put secret/ppv/devnet/ppv_commerce keypair=@"${work}/ppv_commerce-keypair.json"

solana-keygen pubkey "${work}/ppv_core-keypair.json"
solana-keygen pubkey "${work}/ppv_commerce-keypair.json"
```

Copy the keypairs into `target/deploy/` only for the duration of the build, then
run:

```bash
anchor keys sync
```

`anchor keys sync` rewrites `declare_id!` in both programs and the `[programs.*]`
tables in `Anchor.toml`. Commit those public IDs. Then rebuild and re-run the
full F1 suite against the synchronized IDs before deploying.

## Upgrade authority

Foundation devnet uses a **Squads V4 multisig** as the upgrade authority for
both programs. Never the default local `~/.config/solana/id.json` on a shared
machine, and never a key that has ever been pasted into a chat, an issue, a CI
log, or an artifact.

Set up the vault before the first deployment:

1. Create a Squads V4 multisig on devnet with the intended signer set and
   threshold.
2. Record the **vault PDA** — that address, not any member key, is the destination
   of the immediate post-deployment upgrade-authority transfer.
3. Record the member public keys and the threshold alongside it. Public keys
   only; a member's private key never leaves its own wallet.

Every later upgrade is proposed against the vault and executed once the
threshold approves, so no single operator can replace program bytecode alone.

Record only public keys. The authority must stay identical for the whole
lifetime of a program ID; changing it is an upgrade-authority migration and
needs its own change record and manifest entry.

## Deploying

```bash
solana config set --url https://api.devnet.solana.com
solana config get                      # confirm the RPC URL before every deploy
solana cluster-version
solana genesis-hash                    # record this in the manifest

anchor build
solana program deploy \
  --keypair "${work}/deployer.json" \
  --program-id "${work}/ppv_core-keypair.json" \
  --upgrade-authority "${work}/deployer.json" \
  --url https://api.devnet.solana.com \
  target/deploy/ppv_core.so

# A Squads vault PDA cannot sign the checked transfer form. The deployer signs
# this one-time unchecked transfer to the public PDA, then immediately verifies it.
solana program set-upgrade-authority <PPV_CORE_PROGRAM_ID> \
  --keypair "${work}/deployer.json" \
  --upgrade-authority "${work}/deployer.json" \
  --new-upgrade-authority "$PPV_SQUADS_VAULT_PDA" \
  --skip-new-upgrade-authority-signer-check \
  --url https://api.devnet.solana.com
solana program show <PPV_CORE_PROGRAM_ID> --url https://api.devnet.solana.com
```

`solana program deploy --upgrade-authority` expects a signer, so passing a Squads
PDA directly is invalid. The supported path is to deploy with the deployer as a
temporary authority, transfer authority to the Squads vault PDA immediately, and
fail the run unless the live account reports that exact PDA. Repeat for
`ppv_commerce`. Deploy the two programs separately; a failure in one must never
block or roll back the other.

### Devnet deploys a non-verifiable build

That is a plain `anchor build`, not `anchor build --verifiable`. The verifiable
build runs the compile inside a pinned Docker image so a third party can
reproduce the artifact from a container digest; requiring Docker on every
operator machine is not worth it for a design-partner cluster.

What is lost is third-party reproducibility from the digest alone. What is not
lost is what the manifest is for: `gitCommit`, the pinned toolchain table above,
and `binaryHash` still identify exactly what was deployed, and anyone with that
toolchain can rebuild the commit and compare the hash.

The manifest records this as `"verifiable": false` rather than leaving it to be
inferred — `record-deployment.sh` writes `false` unless you set
`PPV_VERIFIABLE=true`. **Revisit before any production candidate:** a mainnet or
production-candidate deployment should be verifiable, and F3's independent
security review is the right place to require it.

Never run a deployment from an ordinary push workflow. Deployment is either a
manual operator action or a GitHub Actions job bound to the mandatory `devnet`
environment with environment-scoped secrets and variables. Native GitHub
required-reviewer protection is unavailable for this repository configuration;
two distinct configured Squads members must instead provide the cryptographic
release approvals defined in [PPV Devnet Release Approval](devnet-release-approval.md).

## Deploying through protected CI

`.github/workflows/deploy-devnet.yml` is the supported alternative to deploying
by hand. It is `workflow_dispatch` only — there is deliberately no `push`,
`pull_request` or `schedule` trigger, because a deployment must never be a side
effect of merging code.

The workflow is only as protected as the environment behind it. Before using it,
configure a `devnet` environment in repository settings:

1. **Settings → Environments → New environment → `devnet`.**
2. **Environment secrets** (never repository-level, so no other workflow can
   read them):
   - `PPV_CORE_PROGRAM_KEYPAIR` — the permanent JSON keypair for `ppv_core`.
   - `PPV_COMMERCE_PROGRAM_KEYPAIR` — the permanent JSON keypair for `ppv_commerce`.
   - `PPV_DEPLOYER_KEYPAIR` — the funded devnet deployer.
3. **Environment variables** (public values):
   - `PPV_SQUADS_VAULT_PDA` — the Squads V4 vault PDA that becomes the upgrade
     authority.
   - `PPV_SQUADS_MEMBER_PUBKEYS` — comma-separated public member addresses for
     the deployment manifest.
   - `PPV_SQUADS_THRESHOLD` — the multisig approval threshold recorded in the
     deployment manifest.
   - `PPV_DEVNET_GENESIS_HASH` — devnet's genesis hash. The job refuses to
     deploy if the cluster it reaches does not match.
4. **Independent release approval** — before every dispatch, obtain detached
   Ed25519 signatures from two distinct configured Squads members over the exact
   release message defined in [PPV Devnet Release Approval](devnet-release-approval.md).
   Supply the two public keys and signatures through the manual dispatch fields.
   The workflow rejects unknown or duplicate approvers, invalid signatures,
   program-ID or commit mismatch, and any Vault, member-set, or threshold drift.
5. **Verification-only dispatch** — `verify_only` defaults to `true`. In this
   mode the job performs the complete pre-deployment chain, including the
   protected-environment checks, permanent-identity build, approval verification,
   unoccupied-address check, and final-authority validation, then stops before
   any program deployment or authority transfer. Use this mode to validate the
   release configuration. Set `verify_only` to `false` only for an authorized
   deployment after the exact program-and-commit approvals have been obtained.

Deploy one program per run: pick it from the dropdown and retype its name to
confirm. The job requires the permanent keypair to match the already-committed
`declare_id!` and `Anchor.toml` identity, builds without rewriting IDs, refuses an
address that already exists, deploys with the deployer as a temporary authority,
transfers authority immediately to the Squads vault PDA, verifies the live
executable program and authority, records and verifies `deployments/devnet.json`,
uploads that public manifest as workflow evidence, and destroys keypair material
on every exit path including failure. Only public keys are ever printed.

The workflow selects exactly one of the two program-key secrets from the
`program` input, so `ppv_core` and `ppv_commerce` cannot accidentally share an
identity and no secret replacement is required between runs. Program identities
are permanent: replacing either secret is permitted only before its first deploy,
or as recovery of the same backed-up keypair—not as routine rotation. If you
would rather the keypairs never live in GitHub at all, deploy by hand from the
operator machine instead; both paths are supported and produce the same
manifest.

## Recording and verifying a deployment

```bash
# `solana program deploy` prints only the program id, not the deploy signature,
# so read it back from the chain. The program account's newest signature is the
# deploy — `set-upgrade-authority` does not touch that account — so this is
# correct whether you run it before or after the authority transfer.
signature="$(solana transaction-history <PPV_CORE_PROGRAM_ID> \
  --url https://api.devnet.solana.com --limit 1 --output json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].signature))')"

# Once per program, immediately after the deploy, from the same checkout.
PPV_PROGRAM=ppv_core \
PPV_DEPLOY_SIGNATURE="${signature}" \
PPV_UPGRADE_AUTHORITY_MEMBERS=<pubkey,pubkey,...> \
PPV_UPGRADE_AUTHORITY_THRESHOLD=2 \
  ./scripts/record-deployment.sh

# Read-only, needs no credentials, anyone can run it.
PPV_VERIFY_RPC_URL=https://<second-provider> ./scripts/verify-deployment.sh
```

`record-deployment.sh` reads the chain and the build output, appends an entry to
`deployments/devnet.json`, and refuses to run against a dirty working tree —
otherwise `gitCommit` would not identify what was deployed. It never touches a
keypair.

`verify-deployment.sh` re-checks every live entry against the chain, through a
second RPC when you give it one. A manifest nobody can independently check is
not evidence.

## Post-deployment verification

Do not verify a deployment with the Solana CLI. It expects a configured default
signer even for read-only commands, so on a machine without a wallet — a CI
runner, or anyone auditing the release from outside — it fails. That is not a
hypothetical: it is what turned PPV Core's successful deployment into a failed
workflow run with no evidence attached to it.

```bash
# Reconstructs the canonical record from public chain state plus the build
# output, and refuses to write one whose rebuild is not byte-identical to the
# bytes the loader is holding.
PPV_PROGRAM=ppv_core \
PPV_RELEASE_COMMIT=<40-char sha> \
PPV_DEPLOY_SIGNATURE=<base58> \
PPV_AUTHORITY_TRANSFER_SIGNATURE=<base58> \
PPV_UPGRADE_AUTHORITY_MEMBERS=<pubkey,pubkey,...> \
PPV_UPGRADE_AUTHORITY_THRESHOLD=2 \
  node scripts/collect-deployment-evidence.mjs deployments/evidence/<program>-devnet-<sha7>.json

# Re-checks that record against the chain. Needs an endpoint and nothing else.
node scripts/verify-deployed-program.mjs deployments/evidence/<program>-devnet-<sha7>.json

# The same check through a second, independent provider, so verification does
# not depend on the node that served the deployment.
PPV_VERIFY_RPC_URL=https://<second-provider> \
  node scripts/verify-deployed-program.mjs deployments/evidence/<program>-devnet-<sha7>.json
```

Commit the record. It is not documentation: the deploy workflow refuses to
initially deploy any program that has one, the preflight stops treating that
program's address as a blocker, and the smoke suite starts demanding it on
chain. `.github/workflows/verify-devnet-deployment.yml` re-runs the verification
weekly and on demand.

To look at live state without a record — before a first deployment, or while
investigating:

```bash
node scripts/verify-deployed-program.mjs --inspect <PROGRAM_ID>
```

## Deployment manifest

Every deployment appends a record to `deployments/devnet.json`. The manifest is
public and must never contain secrets. See `deployments/README.md` for the
schema and the field-by-field meaning.

## Rollback and redeploy

Upgradeable programs are not rolled back by deleting them; they are redeployed
with a known-good artifact. For a program whose upgrade authority is the Squads
vault — which is every released program — a rollback is an upgrade, and it goes
through [`ppv-core-upgrade-runbook.md`](ppv-core-upgrade-runbook.md) like any
other. No individual key holds the authority to perform one.

1. Check out the git commit named in the record you want to restore.
2. Rebuild with the pinned toolchain and confirm the binary hash matches that
   record's `binaryHash`.
3. Propose the upgrade in Squads with a buffer holding those bytes, reach the
   2-of-3 threshold, and execute from the vault.
4. Write and commit a new record. Never edit or delete a past one.

If a program must be taken out of service entirely, close it with
`solana program close <PROGRAM_ID> --bypass-warning` — this is irreversible and
permanently burns the program ID. It requires an explicit operator decision.

## Operational health check

```bash
node scripts/verify-deployed-program.mjs deployments/evidence/ppv-core-devnet-861a8df.json
npm run test:devnet:smoke -- --identity-only
```

Healthy means: every released program executable and loader-owned, every upgrade
authority unchanged from its record, the deployed bytes still equal to the
release artifact, and live program accounts still decoding through the declared
layout. An upgrade authority that does not match the record is a security
incident, not configuration drift — and so is a binary that no longer matches.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `failed to select a version for serde_derive` | The lockfile was regenerated without the baseline pins | Do not add ad-hoc `--precise` flags. Run `./scripts/regenerate-lockfile.sh` and commit the result. |
| `feature 'edition2024' is required` during `anchor build` | A crate newer than the SBF Cargo 1.75 entered the graph | Same fix — the baseline rule excludes those versions. |
| `no method named 'source_file'` building the IDL | proc-macro2 drifted past Anchor 0.30.1's baseline | Same fix. |
| `anchor build` output differs between runs | Toolchain mismatch | Confirm `anchor --version` and `solana --version` match the table above. |
| Deploy fails with insufficient funds | Deployer under-funded | Devnet deploys need roughly 2-4 SOL per program; top up and retry. Partial deploys resume via the write buffer. |
| Deploy fails mid-upload | Transient RPC | Retry the same command; `solana program deploy` resumes from the existing buffer. Do not generate a new program keypair. |

## Known limitations

- Foundation is non-custodial. There is no escrow, invoicing, token transfer,
  dispute, or fee logic, and none may be added under this gate.
- A PPV timestamp proves that a wallet committed to a specific sequence of bytes
  at a chain-confirmed time. It does not prove authorship, ownership,
  originality, copyright registration, or legal validity.
- Document content is never uploaded. Only hashes reach the chain.
- Devnet state is not durable. Devnet is periodically reset and program accounts
  and history can disappear; devnet deployments are for design partners only.

## Gates

Passing this runbook satisfies **F2** only for the deployment mechanics. See
`docs/deployment-gates.md` for the full F2 and F3 criteria, including the
independent security review that F3 requires before any production candidate.
