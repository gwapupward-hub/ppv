# PPV Core — devnet release v1

> **PPV Core's initial devnet deployment is complete. The initial-deployment
> workflow must not be rerun against this occupied permanent program address.**
> A future change to PPV Core on devnet is an upgrade through the Squads vault.
> See [`docs/ppv-core-upgrade-runbook.md`](../ppv-core-upgrade-runbook.md).

| | |
| --- | --- |
| Program | `ppv_core` |
| Cluster | Solana devnet |
| Genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program ID | `9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU` |
| ProgramData | `FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA` |
| Program owner | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Release commit | `861a8dfce9533f75494621b8a36e60e60447cc0c` |
| Deployment transaction | `3A1fMmAZiBfjKb9ijUW81KaqEyZqEtT7vha2Ms2hZanxhjcDaJn4wKJvEwSkDJBK3Co7eJnTyn6wvc2iXaYaAxAp` |
| Deployment slot | 497437304 (finalized) |
| Authority-transfer transaction | `5TX9vvX5ktHE19mDZw5VXkNajZESrPxQZGqxQ26B5pzrLhuVPELTaB8KTsKXCUmpvNzv9FCj2JpHR8Re3jiuTwgj` |
| Authority-transfer slot | 497437312 (finalized) |
| Final upgrade authority | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` (Squads vault PDA) |
| Squads multisig | `ESFGq4U2XjMtVTigLPtp4bkx9cpSVmTw39YW84wKts33` |
| Threshold | 2 of 3 |
| Built binary SHA-256 | `91f95db407c3573eb1693bb52f86fc367113ea537b7628fc6ccc332cb727261e` |
| On-chain binary SHA-256 | `91f95db407c3573eb1693bb52f86fc367113ea537b7628fc6ccc332cb727261e` |
| Binary match | **MATCH** — 246,640 bytes, byte-identical, no loader padding |
| IDL SHA-256 | `e645f974739868f8c793b29ab1be9bd654bfe4fc1d95b0e35895cd51018c093f` |
| Release date | 2026-09-13 |

Squads members:

- `58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV`
- `2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN`
- `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`

Toolchain: Anchor 0.30.1, Solana 1.18.17, Rust host 1.85.1, Rust SBF 1.75.0.
The devnet artifact is a plain `anchor build`, not `anchor build --verifiable`:
anyone with the pinned toolchain can rebuild the release commit and reproduce
`binaryHash`, but a third party cannot reproduce it from a container digest
alone. That is recorded rather than assumed, because a release document must
never imply a stronger guarantee than the build actually made.

## How this release was verified

The canonical record is
[`deployments/evidence/ppv-core-devnet-861a8df.json`](../../deployments/evidence/ppv-core-devnet-861a8df.json).

```bash
node scripts/verify-deployed-program.mjs deployments/evidence/ppv-core-devnet-861a8df.json
```

That command needs an RPC endpoint and nothing else — no wallet, no default
signer, no keypair, no Solana CLI. Anyone can run it, now or years from now, and
it is what `.github/workflows/verify-devnet-deployment.yml` runs on demand and
weekly.

| Workflow | Run | Purpose |
| --- | --- | --- |
| `deploy-devnet.yml` | [34725816827](https://github.com/gwapupward-hub/ppv/actions/runs/34725816827) | Deployed the program and transferred authority to Squads. Reported failure afterwards, in the evidence step only. |
| `recover-ppv-core-devnet-evidence.yml` | [34740388499](https://github.com/gwapupward-hub/ppv/actions/runs/34740388499) | Rebuilt the exact release commit, read live chain state, compared the bytes, and produced the record. |
| `verify-devnet-deployment.yml` | on demand and weekly | Re-verifies the record against the chain. |

The recovery run's verdict, in full:

```
PPV_CORE_DEVNET_VERIFIED
program_id=9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU
program_data=FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA
release_commit=861a8dfce9533f75494621b8a36e60e60447cc0c
binary_hash=sha256:91f95db407c3573eb1693bb52f86fc367113ea537b7628fc6ccc332cb727261e
upgrade_authority=B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX
deployment_signature=3A1fMmAZiBfjKb9ijUW81KaqEyZqEtT7vha2Ms2hZanxhjcDaJn4wKJvEwSkDJBK3Co7eJnTyn6wvc2iXaYaAxAp
result=verified
```

## Why the deployment run reported failure

The deployment itself succeeded: the program uploaded, and the upgrade authority
transferred to the Squads vault, both finalized. The run then failed in the step
that was supposed to write the evidence down, because that step read the chain
through the Solana CLI — which expects a configured default signer even for
read-only commands, and a GitHub runner has none.

So the release existed with no record of itself. That is the defect this release
closeout repairs: verification of public state must not require the ability to
sign, and it no longer does anywhere on the release path.

The binary comparison is the gate the release turns on. The loader allocates
ProgramData larger than the program it holds, so the account's tail is padding;
verification compares exactly `binaryLength` bytes against the release artifact
and separately proves the remainder is zero, rather than trimming trailing bytes
and hoping the result means something.

## Live smoke verification

`scripts/devnet-smoke.mjs --identity-only` runs against the deployed program and
reports coverage in explicit classes. The following are **LIVE VERIFIED** on
devnet:

- devnet cluster identity (genesis hash)
- `ppv_core` at its permanent program id
- the program account is executable
- the program is owned by the BPF upgradeable loader
- ProgramData resolves, exists, and is loader-owned
- the upgrade authority is the Squads vault
- the deployed bytes equal the release artifact
- live `ppv_core` program accounts read back and decode through the declared
  `ProofRecord` layout
- SDK proof-PDA derivation and instruction targeting resolve to the permanent
  Core id, with Anchor's discriminator for `create_proof`

**LOCAL-VALIDATOR VERIFIED**, and not claimed as live: contract/proof binding,
normalized reputation events, and receipt/credential derivation.

**NOT RUN — needs a funded devnet wallet:** `create_proof` and `revoke_proof` as
real devnet transactions. Core supports both independently of Escrow, so this is
a wallet-funding step rather than a protocol limitation. Run
`npm run test:devnet:smoke` with `PPV_SMOKE_WALLET` pointed at a funded devnet
keypair to execute them.

## What is not live

| | |
| --- | --- |
| `ppv_commerce` | Not deployed. Agreement creation, signature and cancellation are **NOT TESTABLE UNTIL COMMERCE**. See [`ppv-commerce-devnet-readiness.md`](ppv-commerce-devnet-readiness.md). |
| `ppv_escrow` | Not deployed, and not authorised to be. Its custody gate is closed. Funding, approval, milestone release, settlement, refund, disputes and bounties are **NOT TESTABLE UNTIL ESCROW**. |

`ppv_core` holds no value. It records proofs: `create_proof` and `revoke_proof`
over a `ProofRecord` PDA. Nothing in this release moves funds, and nothing in it
can.

## Known limitations

- The artifact is not a container-reproducible `--verifiable` build (above).
- Verification is through one RPC endpoint by default. Set
  `PPV_VERIFY_RPC_URL` to a second, independent provider for a genuinely
  independent read; a release verified only through the node that served the
  deployment is not independently verified.
- The two live Core lifecycle transactions have not been executed on devnet,
  because doing so requires a funded wallet this release process does not hold.
- There is no on-chain IDL account. The interface is pinned by `idlHash` in the
  record, not published to the chain.
- **The 2-of-3 threshold is not read from the Squads multisig account.** What is
  verified on chain is that the live upgrade authority is
  `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`, and that this address is off
  the ed25519 curve — so it is a program-derived address and not a wallet any
  single key can sign for. The threshold and the member list are recorded from
  configuration; the repository's tooling refuses to record or hand authority to
  a threshold below two, but it does not decode `ESFGq4U2XjMtVTigLPtp4bkx9cpSVmTw39YW84wKts33`
  to confirm the multisig's own state. Decoding Squads account layout is a
  separate piece of work and is deliberately not guessed at here.
- Upgrades are documented, not automated. `docs/ppv-core-upgrade-runbook.md` is
  a procedure to follow, and a future sprint owns automating it.
