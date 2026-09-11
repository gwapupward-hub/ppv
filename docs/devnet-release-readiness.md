# Devnet Release Readiness

The first persistent PPV devnet deployment is a one-way step: the permanent
program identities are already committed, and deploying at them fixes what every
PPV address in this protocol derives from. This page is the gate in front of it.

## Permanent identities

```text
ppv_core       9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU
ppv_commerce   GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3
```

These are not build placeholders and must never change. They appear in
`declare_id!`, in both `Anchor.toml` cluster tables, in the built IDLs, and in
`scripts/lib/identity.mjs`; every tool here compares all of them and treats any
disagreement as a hard failure rather than picking whichever it read first.

`anchor keys sync` must not be run against generated or arbitrary keys in a
working checkout. The only tool permitted to substitute an id is the F1 harness,
which generates throwaway keypairs under the ignored `target/deploy/`, syncs
them for a local-validator run, and restores the tracked files on every exit
path. `scripts/verify-devnet-readiness.sh` asserts the restoration was complete.

## The preflight

```bash
npm run verify:devnet-readiness              # deployment-grade
./scripts/verify-devnet-readiness.sh --repo-only
```

It is **fail-closed**: a check that cannot be performed is a failure, never a
skip. A preflight that quietly passes when it could not look produces confidence
instead of information, which is worse than no preflight.

Deployment-grade covers the repository (clean tree, unchanged `Cargo.lock`, no
tracked or committed signing material), the permanent identities, the exact
toolchain, the Squads authority, and the target cluster. `--repo-only` covers
the first two groups and says loudly that it does not authorize a deployment;
the deploy workflow runs it early, before any key is written to disk.

One boundary between the modes is deliberate and worth knowing before someone
"fixes" it: **`--repo-only` does not check the generated `target/idl/*.json`
address.** The F1 harness builds with ephemeral keypairs on purpose, so an IDL
left behind after an F1 run carries a throwaway address *by design* — checking
it in repo-only mode would make F1's own cleanup assertion fail on a file that
is behaving correctly. The permanent identities live in `declare_id!` and
`Anchor.toml`, and both are checked in both modes; the IDL address is checked at
deployment grade, and again by the workflow immediately after `anchor build`,
which is the authoritative place for it. A test pins this so the check cannot be
restored by accident.

### The check worth knowing about

A Squads vault is a program-derived address and is therefore **off** the ed25519
curve. An ordinary signer wallet is a public key and is **on** it. So "is this
configured upgrade authority a real multisig vault or somebody's hot wallet" is
a question about curve membership, answerable offline before anything reaches a
cluster — and both the preflight and the deploy workflow refuse an on-curve
authority. `scripts/lib/pubkey.mjs` implements it with no dependencies and is
cross-checked against `@solana/web3.js` in `scripts/test/pubkey.test.mjs`.

## What the tests guarantee

A deployment safety check is only worth having if violating the condition it
guards makes a test fail. `npm run test:release` runs 50+ cases that each break
exactly one thing and assert the specific refusal: wrong `declare_id!`, wrong
`Anchor.toml` id, localnet and devnet disagreeing, wrong IDL address, a tracked
keypair, a committed keypair byte array, a weakened `.gitignore`, a modified
`Cargo.lock`, a dirty tree, a missing or wrong toolchain, a signer wallet as the
authority, a threshold below policy, a member set that cannot meet its own
threshold, duplicate members, the wrong cluster genesis, an already-occupied
program address, and a supplied keypair that does not derive the committed id.

The workflow's own architecture is pinned the same way: manual-only triggers,
the protected `devnet` environment, one program per run, typed confirmation,
identity asserted before the build, cluster pinned before any key is fetched,
an occupied address refusing an initial deploy, the authority validated before
the handoff, the handoff verified on chain, evidence recorded and published, key
material destroyed on every exit path, and no secret reachable from a shell
line.

## The smoke suite

```bash
npm run test:devnet:smoke -- --identity-only   # no wallet needed
npm run test:devnet:smoke                      # adds the lifecycle phase
```

It refuses to run anywhere but devnet, and refuses mainnet by its own genesis
hash before anything else is considered — the lifecycle phase signs
transactions, and a smoke test that an environment variable can point at
mainnet is a loaded gun.

The identity phase reads each program straight from the chain: deployed,
executable, owned by the BPF upgradeable loader, at its permanent id, and held
by the configured Squads vault. An unexpected upgrade authority is reported as a
security failure, not configuration drift, and a *revoked* authority is refused
rather than treated as safe.

### Lifecycle coverage in this release

| Step | Status |
| --- | --- |
| proof creation | covered — `ppv_core` `create_proof` |
| agreement creation | covered — `ppv_commerce` `create_agreement` |
| proof submission | covered — proof creation plus the SDK deliverable reference |
| contract / proof binding | covered — canonical hashes vs the on-chain hashes |
| normalized reputation event | covered — SDK normalization over the emitted events |
| receipt / credential derivation | covered — SDK receipts and seal state |
| cancellation / refund | partial — `cancel_agreement` only |
| funding, approval, milestone release, settlement, dispute, bounty selection | **not in this release** — these need `ppv_escrow`, which is not part of the two programs being deployed |

The suite reports this table itself, so it cannot claim more coverage than it
checks. The escrow rows are not failures; they are steps whose program is not in
this deployment.

## Manual blockers

Everything below is a human action. None of it can be automated around, and the
tooling here deliberately fails rather than proceeding without it.

| Item | Required for |
| --- | --- |
| Squads V4 multisig created | the final upgrade authority |
| 2-of-3 signer set confirmed | `PPV_SQUADS_THRESHOLD >= 2` |
| Squads Vault PDA recorded | `PPV_SQUADS_VAULT_PDA` |
| GitHub `devnet` environment created | the workflow's protection |
| Two distinct Squads-member signatures for the exact program and commit | independent approval of each deploy; see [release-approval policy](devnet-release-approval.md) |
| `PPV_CORE_PROGRAM_KEYPAIR` secret | deploying at the permanent id |
| `PPV_COMMERCE_PROGRAM_KEYPAIR` secret | deploying at the permanent id |
| `PPV_DEPLOYER_KEYPAIR` secret | paying for and signing the deploy |
| `PPV_SQUADS_VAULT_PDA` variable | the authority handoff |
| `PPV_SQUADS_MEMBER_PUBKEYS` variable | deployment evidence |
| `PPV_SQUADS_THRESHOLD` variable | policy enforcement |
| `PPV_DEVNET_GENESIS_HASH` variable | pinning the cluster |
| Deployer funded with devnet SOL | the deploy transaction |

**Never** paste a private key, seed phrase, or keypair JSON into an issue, a
pull request, a chat message, a log, or a source file. Every tool here takes
*paths* and *public keys*; the only thing ever printed from a keypair is the
public key derived from it.

## Release gate progression

A devnet release moves through named gates, in order. Each one is a fact
somebody can check, not a feeling, and none of them may be assumed from the one
before it.

```text
AUDIT
  -> IDENTITY_VERIFIED
  -> TESTS_GREEN
  -> ARTIFACTS_LOCKED
  -> MULTISIG_VERIFIED
  -> VERIFY_ONLY_GREEN
  -> SECURITY_INVARIANTS_GREEN
  -> AUTHORIZED
  -> DEVNET_DEPLOYED
  -> VERIFIED
```

| Gate | What proves it |
| --- | --- |
| `AUDIT` | Independent review of the paths being released, with critical and high findings remediated and re-reviewed. |
| `IDENTITY_VERIFIED` | `./scripts/verify-devnet-readiness.sh --repo-only` — the permanent ids agree in `declare_id!`, both `Anchor.toml` cluster tables, and `scripts/lib/identity.mjs`. |
| `TESTS_GREEN` | `npm test`, `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked`, `cargo fmt --all -- --check`, and `npm run test:f1`. |
| `ARTIFACTS_LOCKED` | `Cargo.lock` and `package-lock.json` committed and unmodified by the build; IDLs reproducible across two builds. |
| `MULTISIG_VERIFIED` | Deployment-grade `npm run verify:devnet-readiness` — Squads vault off-curve, threshold within policy, member set able to meet it. |
| `VERIFY_ONLY_GREEN` | The deploy workflow run with `verify_only=true` completing the full pre-deployment chain without deploying. |
| `SECURITY_INVARIANTS_GREEN` | `npm run test:invariants:release` — the model-based property suite holds `PPV-P1` … `PPV-P10` across the release budget. See [property-testing.md](property-testing.md). |
| `AUTHORIZED` | Two distinct Squads-member signatures over the exact release message for this program **and this commit**, per [devnet-release-approval.md](devnet-release-approval.md). |
| `DEVNET_DEPLOYED` | The workflow run with `verify_only=false`, and its recorded deployment evidence. |
| `VERIFIED` | `./scripts/verify-deployment.sh` against a second, independent RPC provider, plus the identity phase of the smoke suite. |

`SECURITY_INVARIANTS_GREEN` sits after `VERIFY_ONLY_GREEN` and before
`AUTHORIZED` on purpose. It is the last thing checked about the *code* before
anyone signs an approval bound to a commit, so the property run and the
signatures describe the same tree.

### Approvals are bound to a commit, not to a release

Repository contents change. An approval signed over an earlier commit is
**historical evidence about that commit** and nothing more; it does not carry
forward. After any merge that touches program sources, build inputs, gates or
this documentation:

1. Rerun the full deterministic CI and F1.
2. Run `npm run test:invariants:release`.
3. Confirm the permanent identities are unchanged
   (`./scripts/verify-devnet-readiness.sh --repo-only`).
4. Obtain **fresh** release approvals bound to the new merged commit.
5. Rerun the workflow with `verify_only=true`.
6. Only then consider explicit deployment authorization.

Reusing an old commit-bound approval is not permitted, and the workflow refuses
it: it takes `commit` from its own checked-out `github.sha` and compares it
against the signed message.

## Order of operations

1. Complete the manual blockers above.
2. On the release machine: `npm run verify:devnet-readiness` → **READY**.
3. Obtain two distinct Squads-member signatures over the exact `ppv_core`
   release message and run the workflow with the default `verify_only=true`.
4. After that verification passes, set `verify_only=false` for the authorized
   `ppv_core` deployment and confirm the recorded evidence.
5. Obtain two-member approval for `ppv_commerce`, repeat the verification-only
   run, then perform its separately authorized deployment.
6. `npm run test:devnet:smoke -- --identity-only`.
7. `./scripts/verify-deployment.sh` with `PPV_VERIFY_RPC_URL` set to a second,
   independent provider.
8. Only then, with a funded throwaway wallet, the full smoke suite.
