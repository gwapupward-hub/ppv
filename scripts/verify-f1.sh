#!/usr/bin/env bash
set -euo pipefail

expected_anchor="anchor-cli 0.30.1"
expected_solana="solana-cli 1.18.17"

# Anchor 0.30.1 builds the IDL by shelling out to `cargo +nightly` unless
# RUSTUP_TOOLCHAIN is set, and `anchor-syn 0.30.1` calls
# `proc_macro2::Span::source_file()` — an unstable API that later nightlies
# removed. An unpinned `nightly` therefore makes the IDL build fail on a date,
# not on a code change. Pin it to a nightly contemporary with Anchor 0.30.1 so
# the IDL is reproducible; override only to test a toolchain bump deliberately.
export RUSTUP_TOOLCHAIN="${PPV_IDL_TOOLCHAIN:-nightly-2024-06-15}"

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

workdir="$(mktemp -d)"

# `anchor keys sync` rewrites declare_id! and Anchor.toml with the ephemeral
# keys this script generates. Those IDs are not deployable and must never be
# committed, so the tracked files are restored on every exit path.
id_sources=(
  Anchor.toml
  programs/ppv_core/src/lib.rs
  programs/ppv_commerce/src/lib.rs
)
for source in "${id_sources[@]}"; do
  install -D "${source}" "${workdir}/ids/${source}"
done

restore_program_ids() {
  for source in "${id_sources[@]}"; do
    cp "${workdir}/ids/${source}" "${source}"
  done
  rm -rf "${workdir}"
}
trap restore_program_ids EXIT

# `anchor test` needs the provider wallet named in Anchor.toml to exist before it
# can fund it from the local validator's faucet. A clean CI runner has none. This
# identity only ever signs against solana-test-validator, is created outside the
# repository, and is never deployed anywhere.
provider_wallet="${HOME}/.config/solana/id.json"
if [[ ! -f "${provider_wallet}" ]]; then
  mkdir -p "$(dirname "${provider_wallet}")"
  solana-keygen new --silent --no-bip39-passphrase --outfile "${provider_wallet}"
fi

./scripts/prepare-ephemeral-program-ids.sh

anchor build

cp target/idl/ppv_core.json "${workdir}/ppv_core.json"
cp target/idl/ppv_commerce.json "${workdir}/ppv_commerce.json"

# The second build is incremental; comparing both generated IDLs catches
# nondeterministic schema output without paying for a second clean compile.
anchor build
cmp "${workdir}/ppv_core.json" target/idl/ppv_core.json
cmp "${workdir}/ppv_commerce.json" target/idl/ppv_commerce.json

anchor test --skip-build

sha256sum target/idl/ppv_core.json target/idl/ppv_commerce.json
echo "F1 local-validator verification passed"
