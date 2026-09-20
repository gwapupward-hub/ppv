# Current Solana stack and freshness policy

Use this reference for version-sensitive architecture, implementation, decoding, testing, or deployment work. It is a dated orientation, not a permanent pin.

## Verified snapshot

Snapshot verified: **2026-09-19 UTC** from primary project documentation and release pages.

| Area | Observed current state | Engineering consequence |
| --- | --- | --- |
| Validator/CLI line | Anza's Agave release page marks `v4.2.2` stable (`Latest`). `v4.3.0-rc.0` is the Mainnet-Beta Upgrade Candidate (recommended for 10% adoption) and is also recommended for Testnet and Devnet, superseding the earlier `v4.3.0-beta.3`. `v4.4.0-alpha.3` is the current edge/alpha build and explicitly is not for production, superseding `v4.4.0-alpha.2`. | Do not put beta/alpha/RC binaries into a Mainnet release path because their version number is higher. An RC's adoption percentage is not a green light for 100% rollout. Match the project's compatibility matrix and cluster needs, and re-check the releases page before pinning — this line moves in days, not months. |
| Program runtime | Solana programs compile to sBPF. Loader-v3/BPF Loader Upgradeable remains the default for new deployments. A deployment or upgrade becomes effective in the next slot. | Include the one-slot visibility delay in smoke tests. Verify loader owner, ProgramData address, deployment slot, and upgrade authority after release. |
| Program frameworks | Official Solana docs present Anchor, Pinocchio, and native Rust. Anchor is the default choice for most teams; Pinocchio targets low overhead; native Rust carries the largest manual-validation burden. | Choose based on measured constraints and team risk, not fashion. |
| Anchor releases | Anchor's changelog includes `1.2.0` (2026-09-04), while the releases page also publishes maintained `0.32.2`, `0.31.2`, and `0.30.2` patches and may label the newest maintenance upload “Latest.” | Do not infer the correct dependency line from the badge alone. New work should evaluate 1.x; existing work should remain on its pinned compatible line unless migration is deliberate. Read the exact changelog. |
| Anchor security metadata | Anchor 1.2.0 adds a `security.json` template and optional on-chain security metadata support. | Treat metadata as discoverability/coordination support, not proof of security. Review generated content and governance before publishing. |
| Verifiable builds | Anchor supports containerized `anchor build --verifiable` and `anchor verify`. Current images use `quay.io/ottersec/anchor:<version>`. | Pin the image/toolchain, hash artifacts, and retain the exact source commit. A successful ordinary build is not reproducibility evidence. |
| Transactions | Legacy, v0, and v1 formats are supported. Transaction v1 is active on Mainnet, Devnet, and Testnet. V1 raises the maximum size to 4,096 bytes, uses up to 64 inline addresses, removes ALT support, and moves resource limits into message configuration. | RPC readers must opt into the actual transaction version. V1 builders must explicitly set compute-unit and loaded-account-data limits; old ComputeBudget instructions are ignored for v1 configuration. V1 priority fee is an absolute lamport amount, not micro-lamports per CU. |
| TypeScript | `@solana/kit` is the recommended SDK for new TypeScript work, with Wallet Standard and generated `@solana-program/*` clients. `@solana/web3.js` v1 and wallet-adapter are legacy but remain common. | Prefer Kit for new clients. Do not casually rewrite a mature web3.js client during a protocol release; migrate as its own tested change. |
| Token programs | The original Token Program and Token-2022/Token Extensions are both first-class. Token-2022 is a superset but its extensions change account sizing, transfer behavior, authority surfaces, and CPI accounts. | Bind the intended token program explicitly and validate every supported extension. “It is an SPL token” is not enough. |
| Testing | Current Anchor docs cover LiteSVM, Mollusk, and coverage-guided fuzzing, while `solana-test-validator` remains useful for validator/RPC behavior. | Use fast in-process tests for breadth and local-validator/Devnet tests for realism. No single harness covers the entire release risk. |
| Public RPC | Solana's public RPC endpoints are shared and not intended for production applications; they may rate-limit or block traffic. | Production needs dedicated capacity, rate-limit handling, observability, and preferably provider/region failover. |

## Refresh procedure

Before making a version or feature-activation claim:

1. Read the repository pins and lockfiles first.
2. Check the official stable release, its release date, channel label, security notes, and compatibility notes.
3. Check whether the relevant feature is active on the target cluster. Mainnet, Devnet, and Testnet can differ.
4. Check CLI `--help` for the installed project version before constructing a deployment command.
5. Record the source URL and verification date in the analysis or release record.
6. If primary sources disagree, report the disagreement and choose the conservative path.

Do not use third-party tutorials as the authority for current limits, program addresses, feature status, or release commands.

## Primary sources

- Solana program model and current limits: <https://solana.com/docs/core/programs>
- Solana program execution: <https://solana.com/docs/core/programs/program-execution>
- Solana deployment and loader model: <https://solana.com/docs/core/programs/program-deployment>
- Solana CLI deployment guide: <https://solana.com/docs/programs/deploying>
- Transactions and current formats: <https://solana.com/docs/core/transactions>
- Versioned transactions, including v1: <https://solana.com/docs/core/transactions/versioned-transactions>
- Fees: <https://solana.com/docs/core/fees>
- RPC and cluster behavior: <https://solana.com/docs/rpc>
- Solana TypeScript SDK guidance: <https://solana.com/docs/clients/official/javascript>
- Solana frontend SDK guidance: <https://solana.com/docs/frontend>
- Solana tokens and Token-2022 overview: <https://solana.com/docs/tokens>
- Token-2022 program documentation: <https://www.solana-program.com/docs/token-2022>
- Agave releases: <https://github.com/anza-xyz/agave/releases>
- Anchor documentation: <https://www.anchor-lang.com/docs>
- Anchor changelog: <https://www.anchor-lang.com/docs/updates/changelog>
- Anchor releases/source: <https://github.com/otter-sec/anchor/releases>
- Anchor account constraints: <https://www.anchor-lang.com/docs/references/account-constraints>
- Anchor verifiable builds: <https://www.anchor-lang.com/docs/references/verifiable-builds>
- Anchor security examples: <https://www.anchor-lang.com/docs/references/security-exploits>
- LiteSVM: <https://www.anchor-lang.com/docs/testing/litesvm>
- Mollusk: <https://www.anchor-lang.com/docs/testing/mollusk>
- Anchor fuzzing: <https://www.anchor-lang.com/docs/testing/fuzzing>
- Solana Improvement Documents: <https://github.com/solana-foundation/solana-improvement-documents>

## Compatibility questions to answer

Before recommending a change, answer:

- Which cluster and feature set must this build target?
- Which Agave/platform-tools line produced the last known-good artifact?
- Which Anchor line and client package line does the IDL expect?
- Does the client need to read or create v1 transactions?
- Are downstream RPCs, explorers, indexers, wallets, multisig tools, hardware signers, and custodians compatible with that message version and program update flow?
- Which token program and extensions are allowed?
- Can the old artifact be reproduced and redeployed if rollback is required?
