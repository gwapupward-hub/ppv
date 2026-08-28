# Security Policy

PPV Foundation and its native governance layer are pre-production software. They
have not completed an independent security audit and must not custody real value.

## Reporting

Report suspected vulnerabilities privately to the GWAP maintainers. Do not put
private keys, seed phrases, recovery material, deployment credentials, or other
secret signing material in public issues or chat.

Include:

- affected program, instruction, or SDK function;
- required signer and account conditions;
- a minimal reproduction;
- worst credible impact;
- whether upgrade authority, preserved evidence, agreements, or funds could be
  affected.

## Non-negotiable deployment rules

- No mainnet deployment before an independent Solana security audit.
- No escrow or token custody in this Foundation release.
- No program keypair or deployer key in Git, CI logs, application bundles, or
  shared chat.
- `ppv_governance` is the only approved governance implementation for PPV once
  this architecture is adopted; no external multisig dependency is required.
- Native governance must contain at least two unique members and a threshold of
  at least two. One-key governance is rejected on-chain.
- `ppv_governance`, `ppv_core`, and `ppv_commerce` must report the canonical PPV
  Vault PDA as upgrade authority after bootstrap.
- A first governed upgrade must be exercised on devnet before the governance
  layer is trusted for any production candidate.
- The independent audit must include `ppv_governance`, especially proposal
  approval, reconfiguration, PDA signing, and upgradeable-loader integration.
- Critical and high audit findings require remediation and auditor re-review.

## Governance key handling

Governance member private keys remain in their respective wallets and are never
stored in the PPV repository. The on-chain Governance account stores only public
member addresses and policy parameters. The Vault PDA has no private key.

Permanent program keypairs remain operator secrets. Their public program IDs are
committed to the repository only after the secret-backed public addresses have
been independently verified.

## Supported versions

Only the latest commit on the active Foundation branch receives fixes during
pre-release development.
