# PPV Core upgrade runbook (devnet)

PPV Core's **initial deployment is complete**. There is no second initial
deployment. Every future change to the program on devnet is an upgrade, and an
upgrade is authorised and executed by the Squads multisig — not by this
repository's CI, and not by any single key.

- Core initial deploy — **COMPLETE**
- Core redeploy — **INVALID**. `.github/workflows/deploy-devnet.yml` refuses
  `ppv_core` outright, off the committed release record, before it looks at the
  chain at all.
- Core future change — **UPGRADE PATH ONLY**, through the vault below.

| | |
| --- | --- |
| Program | `9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU` |
| ProgramData | `FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA` |
| Upgrade authority | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` (Squads vault PDA) |
| Multisig | `ESFGq4U2XjMtVTigLPtp4bkx9cpSVmTw39YW84wKts33`, threshold 2 of 3 |

Sprint 1 deliberately stops at a written runbook. Automating the upgrade is its
own piece of work, and an upgrade path that is automated before it is understood
is worse than one that is executed carefully by hand.

## What an upgrade proposal must bind

An upgrade is a claim that a specific set of bytes should replace another
specific set of bytes on a specific cluster. The proposal is not reviewable
unless it names all of them, so every one of these is recorded in the proposal
before any signature is collected:

| Field | Where it comes from |
| --- | --- |
| Program id | The permanent identity. It never changes. |
| Cluster | Devnet, pinned by genesis hash `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. |
| Candidate git SHA | The full 40-character commit being proposed. |
| Candidate binary SHA-256 | `sha256sum target/deploy/ppv_core.so` from a clean build of that commit with the pinned toolchain. |
| Candidate IDL SHA-256 | `sha256sum target/idl/ppv_core.json` from the same build. |
| Current on-chain binary SHA-256 | Read from the chain, not from the last release document. |
| Current on-chain IDL / interface | The released record's `idlHash`, plus a statement of what changes for existing integrators. |
| Current upgrade authority | Read from the chain. It must still be the Squads vault. |
| Release approvals | At least two independent approvals over the candidate identity, as `scripts/verify-devnet-release-approval.mjs` checks them. |

Read the current on-chain state with the tooling in this repository rather than
transcribing it from the previous release document. The point of the comparison
is to catch the case where the chain does not hold what the last document says
it holds:

```bash
node scripts/verify-deployed-program.mjs deployments/evidence/ppv-core-devnet-861a8df.json
node scripts/verify-deployed-program.mjs --inspect 9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU
```

## Procedure

1. **Verify the current release first.** If the live program is not what the
   committed record says, stop. An upgrade proposed on top of an unexplained
   state is an upgrade nobody can reason about.
2. **Build the candidate** from a clean checkout of the candidate SHA with the
   pinned toolchain (Anchor 0.30.1, Solana 1.18.17, Rust host 1.85.1, SBF
   1.75.0), and record its binary and IDL hashes.
3. **Collect approvals** over the candidate identity, and verify them with
   `scripts/verify-devnet-release-approval.mjs`. Approvals bind the program id
   and the candidate commit, so an approval cannot be replayed onto different
   bytes.
4. **Write the buffer.** `solana program write-buffer` produces a buffer account
   holding the candidate bytes; set its buffer authority to the Squads vault.
   Confirm the buffer's contents hash to the candidate binary SHA-256 *before*
   proposing anything.
5. **Propose the upgrade in Squads** as a `bpf_loader_upgradeable::upgrade`
   instruction naming the program, the ProgramData account, the buffer, and the
   vault as the upgrade authority.
6. **Reach threshold.** Two of the three members must approve. No member may
   both propose and constitute the second approval.
7. **Execute from Squads.** The vault signs the upgrade; no individual key ever
   holds upgrade authority, at any point in this procedure.
8. **Re-verify and re-record.** Run the evidence collector against the upgraded
   program and commit the new record, then run
   `.github/workflows/verify-devnet-deployment.yml`. A release whose evidence is
   not committed is the situation this runbook exists to prevent repeating.

## Rules that do not bend

- **The upgrade authority stays with Squads.** No step in any procedure may
  transfer it to an individual key, "temporarily" or otherwise.
- **Never `anchor keys sync` against generated keys** in a checkout that will be
  built for a release. It rewrites `declare_id!`, and a program id is the
  namespace every PPV account derives from — replacing one does not migrate
  anything, it creates a distinct protocol universe in which every existing
  address resolves to nothing.
- **Never generate a new permanent identity to solve a tooling problem.** If the
  tooling is wrong, fix the tooling.
- **Mainnet is not authorised.** Every live path in this repository fails closed
  on any cluster whose genesis hash is not devnet's.
- **A binary mismatch is a stop, not a retry.** If a rebuild of the recorded
  commit does not equal the bytes on chain, do not redeploy, do not upgrade, and
  do not mint a new identity. Report both hashes and investigate provenance.
