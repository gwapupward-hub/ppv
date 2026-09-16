# PPV Escrow devnet release runbook

The ceremony that takes `ppv_escrow` from security-qualified to released. Every
step here is an operator action, and most of them cannot be performed by an
automated agent by design — the parts that matter are gated on private key
material held by people.

**Read this first:** the security qualification
([GO, Sprint 3.1](security/ppv-escrow-readiness-verdict.md)) is not permission
to deploy. It says the implementation earned a controlled deployment attempt.
Three prerequisites are open, and the first two are the first two steps below.

## What is deliberately not wired up

`ppv_escrow` is absent from `[programs.devnet]`, from `deploy-devnet.yml`'s
program choices, and from `record-deployment.sh`. That is not an oversight and
it is asserted by `scripts/test/custody-gate.test.mjs`.

**It stays that way until step 3.** Adding an escrow path to the deploy workflow
before a permanent identity exists would create a button that deploys to the
build-only placeholder `7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR` — an
address nobody chose, on a program that holds value. The wiring is part of the
identity freeze, in the same commit as the identity itself, so the button and
the address it points at come into existence together.

## Step 1 — the permanent identity

Generate exactly one permanent `ppv_escrow` program keypair, on a machine you
control, in the same kind of ceremony that produced Core's and Commerce's.

```bash
solana-keygen new --outfile ppv_escrow-keypair.json   # on the ceremony machine
solana-keygen pubkey ppv_escrow-keypair.json          # the only output that leaves it
```

**Never** print the key array, paste it into a chat or an issue, commit it, or
echo the seed phrase. The derived public address is the only thing that may
appear in a log, a document, a workflow input or a report.

Store the keypair as the repository secret `PPV_ESCROW_PROGRAM_KEYPAIR`, the way
`PPV_CORE_PROGRAM_KEYPAIR` and `PPV_COMMERCE_PROGRAM_KEYPAIR` already are. Keep
an offline backup: losing it means the program can never be upgraded again, and
the address can never be reused.

Record the public address. It is permanent. **Do not regenerate it because CI is
inconvenient** — every PPV account address derives from the program id, so a
second identity is a second protocol universe in which nothing that existed
before resolves.

## Step 2 — the dedicated custody multisig

The custody gate requires Escrow's upgrade authority to be a Squads multisig
**separate** from the one governing the non-custodial programs
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), so that compromising that
governance cannot reach the vault.

Create it with at least a 2-of-N threshold. `scripts/create-escrow-custody-multisig.mjs`
is the ceremony, and it is split so that its one irreversible step is a separate,
deliberate act:

```bash
export PPV_CUSTODY_CREATE_KEY=~/ppv-custody-createkey-keypair.json  # a path, never a key
node scripts/create-escrow-custody-multisig.mjs --preflight         # prove and derive
node scripts/create-escrow-custody-multisig.mjs --execute           # create it
```

`--preflight` requires the cluster's genesis hash to equal devnet's exactly,
requires the Squads V4 program to be present and executable, derives the multisig
and vault-0 addresses through the SDK's own PDA helpers, runs the offline safety
checks, and stops. It creates nothing. No argument, and any argument other than
`--execute`, also creates nothing.

`--execute` needs a funding signer at the path in `PPV_OPERATOR_KEYPAIR`, and
reuses the `createKey` written during preflight — so the multisig is created at
the address that was actually reviewed, not a fresh one. Neither variable ever
holds key material; both hold paths, and the script prints only public
addresses. After confirmation it reads the account back from the cluster and
compares the threshold, the member set and every permission mask against what
was intended, because a confirmed signature says a transaction landed, not that
it created what was meant.

Then prove the result satisfies policy before it is given authority over
anything:

```bash
PPV_RPC_URL=https://api.devnet.solana.com \
node scripts/verify-custody-governance.mjs \
  --multisig <MULTISIG> --vault <VAULT> \
  --threshold 2 --members <ADDR,ADDR,ADDR>
```

It is read-only and takes no key material, so it can be run by anyone, before
and after. It refuses, among others: a threshold of one, a member list with
duplicates, a vault on the ed25519 curve, a vault or multisig listed among its
own members, and the non-custodial vault reused as the custody vault.

It also refuses **shared signers** — members who also govern the non-custodial
programs — because two multisigs at different addresses held by the same people
fall to one compromise of those people. If that is a deliberate, accepted
arrangement, pass `--allow-shared-signers` and say so in the release record.

### Approved exception — one shared signer, devnet only

The devnet custody set overlaps the Core/Commerce governance by exactly one
signer, and this is deliberate:

- **One custody signer is intentionally shared with Core/Commerce governance:**
  `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`.
- **The other two custody signers are distinct:**
  `HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx` and
  `5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo`.
- **This exception is approved for devnet only.** It is not carried to mainnet,
  and it is not a precedent for a second shared signer.

What makes one overlap tolerable is arithmetic, not goodwill: at a 2-of-3
threshold, one shared key cannot reach the threshold by itself, so compromising
everyone who governs Core and Commerce still does not move the custody vault. A
*second* shared signer would end that property, which is why the verifier counts
them rather than checking for a name it recognises.

The approval is expressed per run, by passing `--allow-shared-signers`, and
never by changing the policy. `verify-custody-governance.mjs` still refuses this
exact member set by default, and
`scripts/test/custody-governance.test.mjs` asserts both halves — that it is
refused without the override and accepted with it — so the exception cannot
quietly become the default and be inherited by a mainnet ceremony.

The signers it compares against are in `NON_CUSTODY_MEMBERS`. That list is the
whole check: while it was empty the check passed for every configuration,
including one held entirely by the people who already govern Core and Commerce.
It now carries the three signers Core and Commerce were released under, and
`scripts/test/custody-governance.test.mjs` asserts both that it is populated and
that it agrees with `scripts/verify-devnet-release-approval.mjs`, so it cannot
quietly empty again.

Expected output: `PPV_CUSTODY_GOVERNANCE_VALID`. Anything else: **stop.**

## Step 3 — the identity and governance freeze — **DONE (Sprint 4)**

The freeze is committed. The public facts it recorded:

| | |
| --- | --- |
| `ESCROW_PERMANENT_ID` | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` |
| Custody multisig | `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46` |
| Custody vault (index 0) | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Threshold | 2-of-3 |
| Members | `HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx`, `5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo`, `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ` |
| Permissions | Initiate + Vote + Execute (mask 7) each |
| Creation tx | `PAr6UEy3Am4HDjZFLwWKCiG3jVMh2pE9vCfKxAq3SACyFs9wwheGCwLDRV57kE7GHZPyCJEqQBJByR1574spqR5` |
| Network | devnet |

*Historical, at the time of the freeze.* The vault was then the **intended
future** upgrade authority, no authority had been transferred, and
`ppv_escrow` was absent from `DEVNET_DEPLOYED_PROGRAMS` for exactly that
reason.

**Current.** `ppv_escrow` is deployed to devnet and the vault **is** its live
upgrade authority; the transfer is finalized and recorded in
`deployments/evidence/ppv-escrow-devnet-231dceb.json`. The custody gate remains
closed on its remaining requirements — independent security review (RR-13) and
legal review — neither of which deployment touched.

One thing this freeze changed that is worth stating plainly: the custody gate
used to be enforced by escrow's *absence* from every deployment path, and it is
now enforced by *checks*. See
[deployment-gates.md](deployment-gates.md#custody-gate--ppv_escrow) for what
that buys and what it costs.

What the commit contained:

1. `scripts/lib/identity.mjs` — set `ESCROW_PERMANENT_ID` to the public address
   from step 1, set `ESCROW_CUSTODY_GOVERNANCE` to the vault, threshold and
   members from step 2, add `ppv_escrow` to `PERMANENT_PROGRAM_IDS`, and remove
   it from `UNRELEASED_PROGRAMS`.
2. `programs/ppv_escrow/src/lib.rs` — `declare_id!` to the permanent address.
3. `Anchor.toml` — the permanent address in both `[programs.localnet]` and
   `[programs.devnet]`.
4. `deploy-devnet.yml` — add `ppv_escrow` to the program choices and a step that
   fetches `PPV_ESCROW_PROGRAM_KEYPAIR`, mirroring the Core and Commerce steps.
5. `record-deployment.sh` — accept `ppv_escrow`.
6. `scripts/test/custody-gate.test.mjs` — update the assertions that currently
   require escrow's absence, so they assert the released state instead.

`scripts/test/escrow-identity.test.mjs` enforces that this is all-or-nothing:
setting the constant without `declare_id!` fails, changing `declare_id!` without
the constant fails, and setting the constant to the placeholder fails. A
half-entered freeze cannot be committed.

`scripts/test/escrow-freeze-tampering.test.mjs` proves that enforcement is real
rather than self-confirming. It copies the repository, mutates exactly one
source — the program id, `Anchor.toml`, `declare_id!`, the multisig, the vault,
the threshold, a removed member, a duplicated member, a second shared signer, a
removed workflow check, the exception documentation — and requires the suite to
go red for each. A check that reads a value and compares it to itself passes in
every world, including the one where someone changed both; these tests are what
distinguish the two.

## Step 4 — release candidate and full qualification

```bash
node scripts/prepare-release-candidate.mjs ppv_escrow
```

Then the complete suite on that exact commit — `cargo fmt`, `cargo test
--workspace --locked`, `cargo clippy`, `npm ci`, `npm test`, `npm run
build:sdk`, both invariant tiers, the Anchor local-validator suite, and both
mutation qualifications. Required: zero invariant violations, every mutation
detected.

## Step 5 — fresh approvals

Two distinct Squads members sign the exact bytes the candidate prints, for the
exact release commit. **Approvals from Sprint 3, 3.1, Core or Commerce do not
carry forward, and neither does an approval for a different commit.** Any change
to the tree invalidates them.

## Step 6 — verify-only preflight

Dispatch `deploy-devnet.yml` in verify-only mode. It must confirm devnet genesis
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, the permanent id, the keypair's
public address, the release commit, valid approvals, a funded deployer, and —
the one that matters most here — **that the permanent address is unoccupied**.

If an account already exists at the permanent id: **stop.** Do not deploy. Work
out whether it is an earlier partial deployment, an unauthorized one, or a
configuration error. Never regenerate the identity to get past it.

## Step 7 — deploy, exactly once

Dispatch the deployment. Only `ppv_escrow`. Not Core, not Commerce.

## Step 8 — transfer authority immediately

The deployer must not remain the upgrade authority for any longer than the
transaction takes. Transfer to the custody vault from step 2, then verify it
**from chain** rather than from CLI output.

> **If the deploy succeeds and the transfer fails, that is a CRITICAL PARTIAL
> DEPLOYMENT.** Stop. Record the live authority exactly as it is. Do not rerun
> the initial deployment, do not regenerate the identity, and do not delete
> anything. Recovery operates on the program that is already deployed.

## Step 9 — provenance and evidence

Rebuild from the release commit with the pinned toolchain, extract the on-chain
binary, and compare SHA-256 hashes. They must be equal — not "same source", not
"same build command". Then write the canonical record to
`deployments/evidence/ppv-escrow-devnet-<release-sha>.json`.

`scripts/verify-deployed-program.mjs` verifies **every** committed record rather
than a named one, so the escrow record is verified from the moment it lands, by
anyone, with no key material.

## Step 10 — live custody validation

Disposable wallets, minimal amounts, devnet only. Ordinary escrow, a milestone
contract and a bounty, each to a terminal state; plus the negative cases —
unauthorized settle, wrong recipient, wrong mint, duplicate settle,
post-terminal mutation — each confirmed to move no custody and mutate no state.

If any live custody test fails: **keep the custody gate closed**, stop, and
record the exact failing transaction.

## Step 11 — close the release

Only after everything above is green: freeze the release record, retire the
initial-deploy path so an occupied permanent address fails closed, and open the
custody gate **for this verified release only**.

The gate does not open at deployment. It opens after the binary is matched, the
authority is verified from chain, and live custody has been proven.

## Stop conditions

Any of these means stop, not work around: permanent identity mismatch, wrong
network, mainnet as a target, an occupied address before the expected
deployment, an approval bound to a different commit, an invalid governance
configuration, a deployer without enough SOL, a binary mismatch, an upgrade
authority that is not the custody vault, unauthorized value movement, a double
payout, a payout to the wrong recipient, terminal-state resurrection, or any
secret appearing in a log.
