# PPV Commerce devnet release runbook

Everything a release needs that a machine can prepare has been prepared. What
remains is the part that must not be automatable: two independent Squads members
signing a release message with their own keys, and a human dispatching the
deployment. This is the order to do it in.

> **`ppv_core` is already released.** Nothing here touches it. Its initial
> deployment is retired and the deploy workflow refuses it outright — see
> [`ppv-core-upgrade-runbook.md`](ppv-core-upgrade-runbook.md).

| | |
| --- | --- |
| Program | `ppv_commerce` |
| Permanent ID | `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3` |
| Cluster | devnet (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) |
| Final upgrade authority | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` — the same Squads 2-of-3 vault that holds Core |

## 1. Confirm the candidate and get the message to sign

On a clean checkout of the commit you intend to deploy:

```bash
node scripts/prepare-release-candidate.mjs ppv_commerce
```

It refuses to print anything until the tree is clean, the commit is a full sha,
all five sources of the program's identity agree, and the program has no release
record yet. Every failure is a reason not to collect signatures — approvals are
bound to one commit, and a wrong character wastes them.

It prints the exact UTF-8 bytes, their length and their sha256. **Any new commit
invalidates the approvals.** If code has to change after signing, start again
from here.

## 2. Confirm the permanent keypair, on the release machine

Only the operator can do this, because it needs the secret:

```bash
PPV_COMMERCE_PROGRAM_KEYPAIR_PATH=<path> ./scripts/verify-devnet-readiness.sh
```

It derives and compares the **public** key only, and never reads or prints the
file's contents. If the derived address is not
`GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3`, **stop**: that is an identity or
secret-store mismatch, not a tooling problem. Do not generate a replacement key.
The program id is the namespace every `ppv_commerce` account derives from;
replacing it creates a different protocol in which every existing address
resolves to nothing.

## 3. Fund the deployer

```bash
node scripts/report-deployer-funding.mjs <deployer-pubkey>
```

Policy is 2 SOL. Do this well before the deployment window: the workflow fails
closed on a short balance, and a devnet faucet is rate-limited, so discovering it
mid-deployment is the expensive way.

## 4. Collect two approvals

Two **distinct** configured Squads members each sign the exact bytes from step 1
and return a detached Ed25519 signature as canonical standard padded base64.
See [`devnet-release-approval.md`](devnet-release-approval.md) for the mechanics
and for everything the workflow checks.

## 5. Verify-only run

Dispatch `deploy-devnet.yml` with:

| input | value |
| --- | --- |
| `program` | `ppv_commerce` |
| `confirm` | `ppv_commerce` |
| `verify_only` | `true` |
| `approver_1` / `signature_1` | first approval |
| `approver_2` / `signature_2` | second approval |

This runs every pre-deployment check and stops before deploying. It proves the
typed confirmation, the release identity, the pinned toolchain, the devnet
genesis, the permanent keypair's derived address, both approvals, the unoccupied
address, the Squads vault and threshold policy, the deployer balance, and the
built binary and IDL identity.

**Do not proceed unless this run is completely green.**

## 6. The one real deployment

The same dispatch with `verify_only: false`, the same commit, the same
approvals. The workflow deploys with a temporary deployer authority and
**immediately** transfers upgrade authority to the Squads vault, verifies the
live authority, records evidence, and destroys the temporary signing material on
every exit path.

## 7. If the deploy succeeds but the authority transfer fails

**Stop. Do not rerun the initial deployment.** The permanent address is now
occupied, and the initial-deployment path must never run against an occupied
permanent address.

```bash
node scripts/verify-deployed-program.mjs --inspect GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3
```

That reports the deployment state, ProgramData and the live upgrade authority
without signing anything. Preserve it, then recover the authority alone — never
by redeploying. Sprint 1 established this pattern: when a deployment succeeds
and the paperwork fails, repair the paperwork.

## 8. Record the evidence

The chain now knows everything; write it down from there rather than from
intent:

```bash
PPV_PROGRAM=ppv_commerce \
PPV_RELEASE_COMMIT=<the release sha> \
PPV_DEPLOY_SIGNATURE=<base58> \
PPV_AUTHORITY_TRANSFER_SIGNATURE=<base58> \
PPV_UPGRADE_AUTHORITY_MEMBERS=58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV,2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN,BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ \
PPV_UPGRADE_AUTHORITY_THRESHOLD=2 \
  node scripts/collect-deployment-evidence.mjs \
    deployments/evidence/ppv-commerce-devnet-<sha7>.json
```

This refuses to write a record whose rebuild of the release commit is not
byte-identical to the bytes the loader is holding. **A mismatch is a stop, not a
retry**: do not redeploy, do not upgrade, do not mint a new identity — report
both hashes and investigate provenance.

Then verify what it wrote and commit it:

```bash
node scripts/verify-deployed-program.mjs deployments/evidence/ppv-commerce-devnet-<sha7>.json
```

Committing that record is what retires the initial deployment: the deploy
workflow refuses `ppv_commerce` from then on, off a file rather than a network
call. Delete `deployments/release-candidates/ppv_commerce.json` in the same
commit.

## 9. Live verification and smoke

```bash
npm run test:devnet:smoke -- --identity-only
```

Once Commerce has a record, the smoke suite requires it on chain, reads and
decodes its live `Agreement` accounts, checks its SDK targeting, and asserts the
two programs are separable — distinct ids, event authorities and account
discriminators. Coverage rows that read "NOT TESTABLE UNTIL COMMERCE" become
live checks automatically; nothing needs editing.

For the live two-party lifecycle and the Core↔Commerce linkage, supply a funded
devnet wallet:

```bash
PPV_SMOKE_WALLET=<path to a funded, disposable devnet keypair> \
  npm run test:devnet:smoke
```

That carries one agreement to executed through two distinct accepting parties,
timestamps its terms in Core with the agreement as the proof's context, and
reconstructs the combined history — checking it is unchanged under duplicate and
reversed delivery. Use a disposable wallet and no real assets.

`.github/workflows/verify-devnet-deployment.yml` then verifies every committed
record on demand and weekly, with no signing material of any kind.

## What is still not live after this

`ppv_escrow`. Funding, approval, milestone release, settlement, refund, disputes
and bounties remain **NOT TESTABLE UNTIL ESCROW**, and the custody gate in
[`deployment-gates.md`](deployment-gates.md) stays closed. Core and Commerce hold
no value, and this release does not change that.
