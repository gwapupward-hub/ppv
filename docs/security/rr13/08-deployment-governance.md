# Deployment and governance — read-only review

Every fact here was read from committed repository evidence. **No transaction
was sent, no custody validation was rerun, no recovery was rerun, and no
authority was touched** in preparing this package.

## Toolchain

| Component | Version | Pinned in |
| --- | --- | --- |
| Rust (host) | 1.85.1 | `rust-toolchain.toml` |
| Rust (SBF) | 1.75.0 | deployment evidence `toolchain.rustSbf` |
| Solana / Agave | 1.18.17 | `Anchor.toml`, `Cargo.lock` |
| Anchor CLI | 0.30.1 | `Anchor.toml` |
| `anchor-lang` | `=0.30.1` (features: `event-cpi`) | `Cargo.toml` |
| `anchor-spl` | `=0.30.1` (`default-features = false`, `token` only) | `Cargo.toml` |
| `solana-program` | 1.18.17 | `Cargo.lock` |
| `spl-token` | 4.0.3 | `Cargo.lock` |
| `borsh` | 0.9.3 | `Cargo.lock` (transitive) |
| Node | 22.x | CI |
| npm | 10.x | CI |
| `@coral-xyz/anchor` | 0.30.1 | `package-lock.json` |
| `@solana/web3.js` | 1.95.8 | `package-lock.json` |
| `@solana/spl-token` | 0.4.9 | `package-lock.json` |
| `@sqds/multisig` | 2.1.4 | `package-lock.json` |
| `fast-check` | 3.23.2 | `package-lock.json` |
| TypeScript | 5.7.3 | `package-lock.json` |

Exact-pinned (`=`) for the Anchor crates. Lockfiles present and authoritative:
CI asserts the committed lockfile is the one used, and that a build does not
rewrite `Cargo.lock`.

### Security requirement vs optional modernization

| | |
| --- | --- |
| **Security requirement** | none identified from repository evidence |
| **Optional modernization** | the `solana-program` 1.18 line and Anchor 0.30.1 are behind current upstream releases |

The 1.18.17 pin is load-bearing: `spl-token-2022 v3` pulls `solana-zk-token-sdk`,
which pins `solana-program =1.18.26`, and the two cannot both hold. Moving the
line is a migration with its own compatibility, reproducibility and rollback
analysis. **Do not treat it as hygiene.** Advisory status against these exact
versions is unverified — see [07-known-risks](07-known-risks.md).

## Reproducibility

| Property | Evidence |
| --- | --- |
| Built binary == on-chain binary | `binaryHashesMatch: true` |
| Binary hash | `sha256:0acc61defeb2ee810cf3a4bc87f93f8ef457399fe6b52d170055ed7e0c96f9bf` |
| IDL hash | `sha256:d8eb433e4674d5335294c2110dba9c3a36972b5b90e42abe32f495ca98c15dcb` |
| Double-build IDL comparison | `npm run test:f1` builds twice and compares |
| ProgramData padding | 0 |
| Verification method | `raw-solana-json-rpc-read-only` |

## Governance

### `ppv_escrow` custody multisig — Squads V4, devnet

| Field | Value |
| --- | --- |
| Multisig | `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46` |
| Vault (upgrade authority, index 0) | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Threshold | 2 of 3 |
| Members | `HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx`, `5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo`, `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ` |
| Permissions | Initiate + Vote + Execute (mask 7) |
| Time lock | 0 |
| Creation tx | `PAr6UEy3Am4HDjZFLwWKCiG3jVMh2pE9vCfKxAq3SACyFs9wwheGCwLDRV57kE7GHZPyCJEqQBJByR1574spqR5` |

Vault and multisig are asserted program-derived (off-curve); every member is
asserted **not** program-derived. `MIN_SQUADS_THRESHOLD = 2` — the point at
which no single compromised key can push an upgrade.

### `ppv_core` governance

Upgrade authority `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`, Squads
multisig, threshold 2. Distinct from the custody vault, asserted.

### Shared signer

Exactly one member, `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`, sits in both
custody and non-custody governance. Asserted as data so the count can be
checked; `overlap.length < threshold` is a test, not a claim. Scope: devnet.

## Gate state

| Gate | State |
| --- | --- |
| Deployment provenance | CLOSED |
| Custody behaviour reconstructed from chain (RR-6) | CLOSED |
| Escrow custody governance (RR-7) | CLOSED, scoped to the Escrow custody multisig |
| Independent security review (RR-13) | **OPEN** |
| Legal review | **OPEN** |
| **Custody gate** | **CLOSED** |
| **Mainnet authorized** | **NO** |

Deployed and provenance-closed is not custody-verified, and a closed RR-6 does
not open the custody gate.
