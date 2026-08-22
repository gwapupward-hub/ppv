#!/usr/bin/env bash
set -euo pipefail

expected_anchor="anchor-cli 0.30.1"
expected_solana="solana-cli 1.18.17"

actual_anchor="$(anchor --version)"
actual_solana="$(solana --version)"

[[ "${actual_anchor}" == "${expected_anchor}" ]] || {
  echo "Expected ${expected_anchor}, found ${actual_anchor}" >&2
  exit 1
}
[[ "${actual_solana}" == "${expected_solana}"* ]] || {
  echo "Expected ${expected_solana}, found ${actual_solana}" >&2
  exit 1
}

./scripts/prepare-ephemeral-program-ids.sh

anchor build

idl_snapshot="$(mktemp -d)"
trap 'rm -rf "${idl_snapshot}"' EXIT

cp target/idl/ppv_core.json "${idl_snapshot}/ppv_core.json"
cp target/idl/ppv_commerce.json "${idl_snapshot}/ppv_commerce.json"

# The second build is incremental; comparing both generated IDLs catches
# nondeterministic schema output without paying for a second clean compile.
anchor build
cmp "${idl_snapshot}/ppv_core.json" target/idl/ppv_core.json
cmp "${idl_snapshot}/ppv_commerce.json" target/idl/ppv_commerce.json

anchor test --skip-build

sha256sum target/idl/ppv_core.json target/idl/ppv_commerce.json
echo "F1 local-validator verification passed"
