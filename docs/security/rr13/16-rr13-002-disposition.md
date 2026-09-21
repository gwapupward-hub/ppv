# RR13-002 — disposition

`RR13_002_STATUS = OPEN_INFORMATIONAL`

**Nothing in this document is a remediation.** It is a written disposition,
recorded during the RR13-001 sprint so the advisory position is not carried in
anyone's head. Dependency remediation is a separate pull request, after
RR13-001.

## What was reported

`npm audit` on this repository's workspace, re-run at the head of the RR13-001
remediation branch rather than quoted from the finding:

| Severity | Count |
| --- | --- |
| Critical | **0** |
| High | **9** |
| Moderate | **6** |
| Low | 0 |
| **Total** | **15** |

The advisories, and what pulls them in:

| Package | Severity | Reached through |
| --- | --- | --- |
| `bigint-buffer` | high | `@solana/web3.js`, `@solana/buffer-layout-utils` |
| `@solana/buffer-layout-utils` | high | `@solana/spl-token` |
| `@solana/spl-token` | high | direct dev dependency, `@sqds/multisig` |
| `@solana/web3.js` | high | direct dev dependency |
| `@sqds/multisig` | high | direct dev dependency |
| `toml` | high | `@coral-xyz/anchor` |
| `@coral-xyz/anchor` | high | direct dev dependency |
| `js-yaml` | high | transitive |
| `serialize-javascript` | high | `mocha` |
| `esbuild` | moderate | `tsx` |
| `jayson` | moderate | `@solana/web3.js` |
| `stream-json` | moderate | `jayson` |
| `uuid` | moderate | `jayson` |
| `mocha` | moderate | direct dev dependency |
| `tsx` | moderate | direct dev dependency |

## What is and is not established

* **No deployed-program exploit is established.** Every package above is a
  JavaScript dependency. The deployed artifacts are the three Rust programs;
  none of this code runs on chain, and none of it is in the trust path of a
  validator executing `ppv_escrow`.
* **The exposure that is real is tooling exposure.** These packages run in CI,
  in the local-validator suite, and in the operator scripts that build and sign
  custody transactions. A compromised builder or a malformed RPC response
  handled by a vulnerable parser is a developer-machine and
  transaction-construction concern, which is a real concern — it is simply not
  the same concern as a program defect.
* **The advisory review is incomplete.** `npm audit` covers the JavaScript tree
  only. The **RustSec / Anchor / Agave** advisory review over `Cargo.lock`,
  `anchor-lang 0.30.1`, `anchor-spl 0.30.1` and `solana-program 1.18.17` has
  **not** been performed and is still required. Until it is, no statement of
  the form "the dependency position is understood" is available.
* **Upgrading is not free here.** `solana-program` is pinned to the 1.18.17 the
  programs are built and deployed with, and `Cargo.toml` documents why the
  pin cannot simply move. Any dependency sprint has to treat toolchain
  reproducibility as a constraint, not an afterthought.

## Why it is not mixed into RR13-001

A dependency bump changes the build inputs of the artifact under independent
review. RR13-001 changes program source and is already a target-invalidating
amendment; folding an unrelated build-input change into the same commit would
make the delta the reviewer has to examine larger and less legible, for no
security gain.

**Exception, stated in advance:** if a specific advisory were shown to affect
the RR13-001 fix itself, it would be handled inside that pull request and said
so explicitly. None was: the fix is Rust program code, and no advisory above
touches the Rust toolchain.

## Next action

A separate pull request that (a) completes the RustSec / Anchor / Agave review
over `Cargo.lock` and the pinned toolchain, and (b) resolves the JavaScript
advisories that can be resolved without breaking the `solana-program 1.18.17`
pin or the 0.30.1 Anchor toolchain — recording, for each one that cannot be,
why.
