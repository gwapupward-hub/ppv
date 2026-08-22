# Security Policy

PPV Foundation is pre-deployment software. It has not been externally audited
and must not custody real value.

## Reporting

Report a suspected vulnerability privately to the GWAP maintainers. Do not put
exploit details, private keys, signatures, recovery material, or production
credentials in a public issue.

Include:

- affected program, instruction, or SDK function;
- required signer and account conditions;
- a minimal reproduction;
- worst credible impact;
- whether funds, identity claims, or preserved evidence could be affected.

## Non-negotiable deployment rules

- No mainnet deployment before an independent Solana security audit.
- No escrow or token custody in this foundation release.
- No program keypair or upgrade key in Git, CI logs, application bundles, or
  shared chat.
- Devnet deployment authority must be a hardware-backed or multisig-controlled
  key before design-partner use.
- Mainnet upgrade authority, if deployment is later approved, must be a Squads
  multisig with a documented emergency process.
- Critical and high audit findings require remediation and auditor re-review.

## Supported versions

Only the latest commit on the active foundation branch receives fixes during
pre-release development.

