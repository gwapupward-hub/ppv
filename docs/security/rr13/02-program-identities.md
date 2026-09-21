# Program identities — verified from the repository

Every value below was read from the repository at the frozen target,
`0190248f6199398dfe4ce632e513123cb00b0cb0`, not supplied by a prompt. The values are
unchanged from the previous target `02b5b5286fab95ce68a4ca53d8b7768a738a1013`: the
re-freeze moved no program source, configuration or evidence.

## Permanent program IDs

| Program | ID | `declare_id!` | `Anchor.toml` localnet | `Anchor.toml` devnet | `identity.mjs` |
| --- | --- | --- | --- | --- | --- |
| `ppv_core` | `9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU` | ✓ `lib.rs:27` | ✓ | ✓ | ✓ |
| `ppv_commerce` | `GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3` | ✓ `lib.rs:28` | ✓ | ✓ | ✓ |
| `ppv_escrow` | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` | ✓ `lib.rs:38` | ✓ | ✓ | ✓ |

All four sources agree for all three programs. No identity was regenerated,
replaced or rotated in preparing this package.

`scripts/test/custody-gate.test.mjs` asserts this agreement, and additionally
asserts that the build-only placeholder
`7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR` is absent from every identity and
deploy path.

## Committed devnet deployment evidence

### `ppv_escrow`

Record: `deployments/evidence/ppv-escrow-devnet-231dceb.json`
SHA-256: `7c74113405ec4a537aeb13a931c4c07c00bc476a8e4b899a5fbe2ac79ac15196` — verified.

| Fact | Value |
| --- | --- |
| Cluster / genesis | devnet / `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| ProgramData | `2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa` |
| Loader | `BPFLoaderUpgradeab1e11111111111111111111111` |
| Release commit | `231dceb91c141e1afe6e57ef48fafb199da5c678` |
| Deployment slot | 498656161 (finalized) |
| Upgrade authority | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` (Squads vault, 2-of-3) |
| Authority transfer | slot 498656235, finalized |
| Binary hash | `sha256:0acc61defeb2ee810cf3a4bc87f93f8ef457399fe6b52d170055ed7e0c96f9bf` |
| built == on-chain | **true** |
| IDL hash | `sha256:d8eb433e4674d5335294c2110dba9c3a36972b5b90e42abe32f495ca98c15dcb` |
| Program data length / padding | 587781 / 0 |

### `ppv_core`

Record: `deployments/evidence/ppv-core-devnet-861a8df.json`

| Fact | Value |
| --- | --- |
| ProgramData | `FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA` |
| Release commit | `861a8dfce9533f75494621b8a36e60e60447cc0c` |
| Deployment slot | 497437304 |
| Upgrade authority | `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX` (Squads, 2-of-3) |
| Binary hash | `sha256:91f95db407c3573eb1693bb52f86fc367113ea537b7628fc6ccc332cb727261e` |

`ppv_commerce` has no committed devnet release record at this commit.

## Canonical live custody evidence

Record: `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json`
SHA-256: `c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c` — verified.

This is the artifact that closed RR-6. Both expected hashes in the RR-13 brief
were recomputed from the committed blobs and matched exactly.

## Cluster configuration

`Anchor.toml` sets `provider.cluster = "Localnet"`.

**This is intentional and must not be changed.** Explicit deployment workflows
select their own cluster, and the deploy workflow refuses `ppv_escrow` unless
every frozen fact in `scripts/lib/identity.mjs` matches what the run was given.
A `Localnet` provider default is what keeps an ordinary `anchor test` from
addressing a live cluster. Repository evidence supports the setting; no change
was made.
