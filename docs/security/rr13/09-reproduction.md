# Reproduction guide for an independent reviewer

Everything in Part 1 runs from a clean clone with **no deployer key, no custody
signer, no funder key and no private RPC credential**.

## Part 1 — static and local reproduction (no secrets, no network beyond package registries)

### 0. Clone the exact review target

`main` is ahead of the frozen target. Check out the target explicitly — do not
review `main`.

```bash
git clone https://github.com/gwapupward-hub/ppv.git
cd ppv
git checkout 0190248f6199398dfe4ce632e513123cb00b0cb0
git status --porcelain          # must print nothing
```

If you prefer to work from a newer `main`, first satisfy yourself that nothing
security-sensitive moved:

```bash
for t in programs sdk indexer tests scripts deployments; do
  echo "$t $(git rev-parse 0190248:$t) $(git rev-parse main:$t)"
done
```

Each line's two hashes must match. [00-scope.md](00-scope.md) records the
expected values.

### 0b. Verify this package against its manifest

Run from the **repository root**, not from the package directory — every path
in the manifest is repository-root-relative.

```bash
sha256sum -c docs/security/rr13/MANIFEST.sha256
```

All entries must report `OK`. The manifest covers the package documents, the
reviewed program source, the build and identity configuration, the canonical
evidence, the security documentation this package cites, and both mutation
harnesses. It does not hash itself.

### 1. Toolchain

```bash
rustup toolchain install 1.85.1
rustup component add rustfmt clippy --toolchain 1.85.1
# Solana CLI 1.18.17 and Anchor CLI 0.30.1 for the validator tiers
```

### 2. Verify the committed evidence hashes yourself

```bash
sha256sum deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json
# c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c

sha256sum deployments/evidence/ppv-escrow-devnet-231dceb.json
# 7c74113405ec4a537aeb13a931c4c07c00bc476a8e4b899a5fbe2ac79ac15196
```

### 3. Host tier — no validator, no network

```bash
cargo fmt --all -- --check
cargo test --workspace --locked          # expect 76 passing
cargo clippy --workspace --all-targets --locked
```

Clippy emits ~25 warnings, all `unexpected cfg condition` from Anchor's macros
plus one duplicated `#![cfg(test)]` attribute in a test-only module. None are
security-relevant; CI does not run `-D warnings`.

### 4. Release and tooling tier

```bash
npm ci
npm run build          # REQUIRED FIRST — four tests import sdk/dist
npm run test:release   # expect 800 pass, 1 skipped, 0 fail
```

> Running `test:release` before `build` fails four tests with
> `ERR_MODULE_NOT_FOUND` on `sdk/dist/index.js`. That is a harness ordering
> artifact, not a defect. `npm test` builds first.

### 5. Full typecheck and SDK/indexer suites

```bash
npm test               # typecheck + sdk + indexer + release + generators
```

### 6. Local validator tier

```bash
npm run test:f1              # double build, IDL comparison, validator tests
npm run test:anchor          # tests/escrow.ts, tests/integration/
```

### 7. Property suite

```bash
npm run test:invariants:pr        # PR tier
npm run test:invariants:release   # release tier, longer
```

### 8. Mutation qualification — the highest-value reproduction

```bash
./scripts/mutation-qualify.sh            # deterministic suite, 7 classes
./scripts/mutation-qualify-property.sh   # property suite, 4 mutations
```

Both refuse to start from a dirty tree, restore every mutation, prove the
restoration, and fail loudly if a mutation survives. Exit status is the verdict.

### 9. Read-only release preflight

```bash
python3 .claude/skills/senior-solana-protocol-engineer/scripts/release_preflight.py . --cluster devnet
```

Read-only: does not build, sign, contact an RPC endpoint, or mutate the tree.
Treat its output as leads, not as an audit certificate.

## Part 2 — optional live read-only verification (requires an RPC endpoint)

**Not required for the review.** Needs only a public devnet RPC URL — no
deployer, custody, or funder key.

```bash
solana account 7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4 --url devnet
solana program show 7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4 --url devnet
```

Confirm against [02-program-identities](02-program-identities.md): ProgramData
`2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa`, loader
`BPFLoaderUpgradeab1e11111111111111111111111`, upgrade authority
`FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE`.

Public devnet RPC is aggressively rate-limited; `indexer/src/rpc.ts` tolerates a
bounded run of HTTP 429 (initial + 4 retries, 500/1000/2000/4000 ms, jittered,
`Retry-After` honoured to an 8 s cap) and treats every other status as final.

## What the reviewer must NOT be asked to do

* Send any transaction.
* Rerun the custody matrix. It sends ~70 value-moving transactions to re-learn
  what the chain already records. Use the committed evidence.
* Rerun custody recovery.
* Hold any signer, deployer, funder or custody key.
* Supply a private RPC credential for Part 1.

## Current target amendment — 2026-09-21

The checkout commands earlier in this document reproduce the **original**
RR13-001 finding target. For review work after the independently verified
remediation, use the new frozen target:

```bash
git clone https://github.com/gwapupward-hub/ppv.git
cd ppv
git checkout e574c69570979081e34e0358673c62f87ba9220d
git status --porcelain
sha256sum -c docs/security/rr13/MANIFEST.sha256
```

The manifest command is authoritative only after the post-merge re-freeze
reconciliation is finalized; see
[18-rr13-001-post-merge-refreeze.md](18-rr13-001-post-merge-refreeze.md).
