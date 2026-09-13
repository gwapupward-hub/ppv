# PPV Commerce devnet readiness

Assessed at the close of the PPV Core devnet release. This is a preflight
assessment, not a deployment: nothing here deploys PPV Commerce, and nothing
here touches PPV Escrow.

| Program | `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3` |
| --- | --- |
| Cluster | Solana devnet (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`) |
| Intended upgrade authority | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` — the same Squads 2-of-3 vault that holds Core |

## Result

| Area | Status |
| --- | --- |
| Identity | READY |
| Build | READY |
| Tests | READY |
| Security | READY |
| Multisig | READY |
| Program address | READY |
| Funding | BLOCKED — operator action |
| Release workflow | READY |
| Manual dependencies | BLOCKED — operator action |
| **Sprint 2 verdict** | **GO, conditional on two operator actions** |

Both blockers are operator actions on secret material that no automated process
can or should perform: funding the deployer wallet, and confirming the permanent
program keypair is in the secret store. Neither is repository work. There is no
code, test, identity, workflow or security blocker remaining.

## What was checked

**Identity — READY.** `declare_id!` in `programs/ppv_commerce/src/lib.rs`,
`[programs.localnet]` and `[programs.devnet]` in `Anchor.toml`, and
`scripts/lib/identity.mjs` all name `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3`,
and `scripts/verify-devnet-readiness.sh --repo-only` passes. The built IDL's
`address` field is checked against the same value by `scripts/record-deployment.sh`
before any evidence is written, and by the deploy workflow before it builds.

**Build — READY.** `npm run test:f1` builds the workspace twice with the pinned
toolchain and compares the IDLs, so the build is deterministic in the property
that matters for a release. It is green in CI.

**Tests — READY.** `cargo fmt --all -- --check`, `cargo test --workspace
--locked`, `cargo clippy --workspace --all-targets --locked`, `npm run
typecheck`, `npm test`, `npm run build:sdk` and `npm run test:release` all pass.
The Anchor local-validator suite passes in CI.

**Security — READY.** `npm run test:invariants:pr` (PPV-P1 … PPV-P10) passes in
CI on every pull request. The release-tier budget is wired to the weekly
schedule and to `workflow_dispatch` on the CI workflow, and **has not been run
in this sprint** — run it deliberately before the deployment rather than relying
on the PR budget.

**Multisig — READY.** The vault is a real off-curve address — a program-derived
address, not a wallet any single key can sign for — and it is already proven in
practice: it holds PPV Core's upgrade authority on devnet today. The deploy
workflow refuses an on-curve authority and refuses a threshold below two before
it hands anything over. The 2-of-3 threshold itself is taken from configuration
rather than decoded from the multisig account; see the corresponding limitation
in [ppv-core-devnet-v1.md](ppv-core-devnet-v1.md).

**Program address — READY.** Read live from devnet at 2026-09-13T05:42:55Z
([run 34740973693](https://github.com/gwapupward-hub/ppv/actions/runs/34740973693)):

```json
{
  "programId": "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3",
  "exists": false,
  "owner": null,
  "upgradeAuthority": null
}
```

The address is unoccupied. `.github/workflows/verify-devnet-deployment.yml`
reports this on every run, so read it again immediately before deploying — an
occupied address is a stop, and the preflight and the deploy workflow both
refuse one independently.

**Release workflow — READY.** `.github/workflows/deploy-devnet.yml` requires two
independent cryptographic Squads-member approvals bound to the program id and
the release commit, defaults to `verify_only`, refuses an occupied address, and
now reads public chain state through JSON-RPC. That last change is what makes
this READY rather than BLOCKED: as it stood, Commerce's deployment would have
hit the same signer-dependent verification that turned Core's successful
deployment into a failed run with no evidence.

## The two operator actions

**Funding.** The deployer wallet must hold at least 2 SOL on devnet
(`MIN_DEPLOYER_LAMPORTS`, 2,000,000,000 lamports) before the run. The workflow
checks this and fails closed if the balance is short or unreadable, but it
cannot fund the wallet, and devnet faucet limits mean topping up is not
instantaneous. Fund it before scheduling the deployment, not during it.

**Permanent keypair.** `secrets.PPV_COMMERCE_PROGRAM_KEYPAIR` must be the
permanent keypair whose public key is
`GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3`. The repository cannot verify
this — it holds no signing material by design — so the operator confirms it by
running `scripts/verify-devnet-readiness.sh` on the release machine with
`PPV_COMMERCE_PROGRAM_KEYPAIR_PATH` set. That check derives and compares the
public key only; it never reads or prints the file's contents. The deploy
workflow asserts the same thing from the secret before it builds.

Never resolve a mismatch here with `anchor keys sync` or by generating a new
keypair. The program id is the namespace every `ppv_commerce` account derives
from; replacing it does not migrate anything, it creates a different protocol.

## Also required before the run

- Environment variables on the `devnet` environment: `PPV_SQUADS_VAULT_PDA`,
  `PPV_SQUADS_MEMBER_PUBKEYS`, `PPV_SQUADS_THRESHOLD`, `PPV_DEVNET_GENESIS_HASH`.
  These are already set — they were used for Core.
- Secrets on the `devnet` environment: `PPV_COMMERCE_PROGRAM_KEYPAIR`,
  `PPV_DEPLOYER_KEYPAIR`.
- Two Squads-member approval signatures over the Commerce release identity, as
  `docs/devnet-release-approval.md` describes.
- A `verify_only: true` run first. It exercises every gate and stops before
  deploying.

## Explicitly out of scope

PPV Escrow is not deployed and is not part of this assessment. Its custody gate
is closed, and Commerce readiness must not be read as authorising any Escrow
work. `ppv_escrow` remains absent from `[programs.devnet]` and from the deploy
workflow's program choices.
