# Devnet deployment runbook

This runbook covers PPV Foundation on **Solana devnet only**. Mainnet is out of
scope for Foundation and is not covered here.

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
2. Record the **vault PDA** — that address, not any member key, is the upgrade
   authority passed to `solana program deploy`.
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

anchor build --verifiable
solana program deploy \
  --program-id "${work}/ppv_core-keypair.json" \
  --upgrade-authority "$PPV_SQUADS_VAULT_PDA" \
  --url https://api.devnet.solana.com \
  target/deploy/ppv_core.so
```

Repeat for `ppv_commerce`. Deploy the two programs separately; a failure in one
must never block or roll back the other.

Never run a deployment from an ordinary push workflow. Deployment is either a
manual operator action or a GitHub Actions job bound to a protected `devnet`
environment with required reviewers and environment-scoped secrets.

## Deploying through protected CI

`.github/workflows/deploy-devnet.yml` is the supported alternative to deploying
by hand. It is `workflow_dispatch` only — there is deliberately no `push`,
`pull_request` or `schedule` trigger, because a deployment must never be a side
effect of merging code.

The workflow is only as protected as the environment behind it. Before using it,
configure a `devnet` environment in repository settings:

1. **Settings → Environments → New environment → `devnet`.**
2. **Required reviewers** — at least one, and not the person who dispatches the
   run. Without this the job is just an ordinary workflow holding credentials,
   which is what this runbook forbids.
3. **Environment secrets** (never repository-level, so no other workflow can
   read them):
   - `PPV_PROGRAM_KEYPAIR` — the JSON keypair for the program being deployed.
   - `PPV_DEPLOYER_KEYPAIR` — the funded devnet deployer.
4. **Environment variables** (public values):
   - `PPV_SQUADS_VAULT_PDA` — the Squads V4 vault PDA that becomes the upgrade
     authority.
   - `PPV_DEVNET_GENESIS_HASH` — devnet's genesis hash. The job refuses to
     deploy if the cluster it reaches does not match.

Deploy one program per run: pick it from the dropdown and retype its name to
confirm. The job syncs ids, builds, asserts the built id matches the deployment
keypair, deploys with the vault as upgrade authority, prints `solana program
show` plus the artifact hashes, and destroys the keypair material on every exit
path including failure. Only public keys are ever printed.

Because the keypairs are held as environment secrets, rotating them is a
settings change, not a code change. If you would rather they never live in
GitHub at all, deploy by hand from the operator machine instead — both paths are
supported and produce the same manifest.

## Recording and verifying a deployment

```bash
# Once per program, immediately after the deploy, from the same checkout.
PPV_PROGRAM=ppv_core \
PPV_DEPLOY_SIGNATURE=<signature> \
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

For each program:

```bash
solana program show <PROGRAM_ID> --url https://api.devnet.solana.com
solana account <PROGRAM_ID> --url https://api.devnet.solana.com --output json
```

Confirm:

- the account is `executable: true` and owned by `BPFLoaderUpgradeab1e11111111111111111111111`
- the ProgramData address matches what `solana program show` reports
- the upgrade authority equals the intended public key
- the deployed slot and the deployment signature are recorded

Then repeat the account read through a **second, independent RPC provider** so
the verification does not depend on the same node that served the deployment.

## Deployment manifest

Every deployment appends a record to `deployments/devnet.json`. The manifest is
public and must never contain secrets. See `deployments/README.md` for the
schema and the field-by-field meaning.

## Rollback and redeploy

Upgradeable programs are not rolled back by deleting them; they are redeployed
with a known-good artifact.

1. Check out the git commit named in the manifest entry you want to restore.
2. Rebuild with the pinned toolchain and confirm the binary hash matches the
   manifest's `binaryHash` for that entry.
3. `solana program deploy --program-id <PROGRAM_ID> --upgrade-authority ...`
   with the rebuilt artifact.
4. Append a new manifest entry. Never edit or delete a past entry.

If a program must be taken out of service entirely, close it with
`solana program close <PROGRAM_ID> --bypass-warning` — this is irreversible and
permanently burns the program ID. It requires an explicit operator decision.

## Operational health check

```bash
solana program show <CORE_ID>     --url "$SOLANA_RPC_URL"
solana program show <COMMERCE_ID> --url "$SOLANA_RPC_URL"
```

Healthy means: both accounts executable, both upgrade authorities unchanged from
the manifest, and the GwapOS PPV surface able to fetch a known proof account.
An upgrade authority that does not match the manifest is a security incident,
not a configuration drift.

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
