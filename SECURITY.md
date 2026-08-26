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

## Accepted dependency advisories

`npm audit` reports two advisories that are deliberately not fixed. Both reach
the tree only through `@solana/web3.js`, which is a devDependency here: it is
used by the Anchor integration suite and never by `@gwap/ppv-sdk`, whose
published `dist` has no runtime dependencies at all. Neither advisory affects
anything a consumer installs.

| Advisory | Path | Why it stands |
| --- | --- | --- |
| `bigint-buffer` — buffer overflow in `toBigIntLE()` (high) | `@solana/web3.js` → `bigint-buffer` | No fixed version exists at any release. The only escape is a `@solana/web3.js` major-line move, which is pinned to `1.95.8` for Anchor 0.30.1 compatibility. |
| `uuid` <11.1.1 — missing bounds check in v3/v5/v6 when `buf` is passed (moderate) | `@solana/web3.js` → `jayson` → `uuid` | `jayson` calls `v4` and passes no `buf`, so the vulnerable path is unreachable. An override would be a three-major jump on a transitive dependency for no change in exposure. |

Revisit both whenever `@solana/web3.js` is unpinned. Advisories that are
reachable, or that touch anything the SDK ships, are fixed rather than listed
here — `serialize-javascript` and `esbuild` were.

## Supported versions

Only the latest commit on the active foundation branch receives fixes during
pre-release development.

