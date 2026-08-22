# Private Proof Vault (PPV) — Solana Protocol

Canonical Solana workspace for GWAP Private Proof Vault.

## Security boundary

- `ppv_core` is a non-custodial evidence registry. It never holds user funds.
- `ppv_commerce` contains agreements, invoices, and later escrow. Commerce may depend on Core; Core must never depend on Commerce.
- Mainnet escrow is intentionally gated behind fuzzing, invariant testing, external audit, legal review, and capped rollout.

## Founding Beta sequence

1. Prove — private proof creation and verification.
2. Agree — exact-version agreements and wallet signatures.
3. Get Paid — invoices and direct atomic settlement.
4. Protect Deals — escrow only after the security gate.

## Toolchain

Anchor `0.30.1`; Solana `1.18.17` is the pinned compatibility baseline for this workspace. Program IDs currently committed are build-only placeholders. CI synchronizes ephemeral keypairs for tests. Deployment IDs and authorities must be generated and assigned deliberately before devnet/mainnet deployment.

## Privacy rule

On-chain accounts contain hashes, wallet authorities, timestamps, revocation state, and other verification facts. Plaintext private artifacts do not belong on-chain or in application analytics/logs.
