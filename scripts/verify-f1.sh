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

validator_pid=""

cleanup() {
  status=$?
  if [[ -n "${validator_pid}" ]]; then
    kill "${validator_pid}" 2>/dev/null || true
    wait "${validator_pid}" 2>/dev/null || true
  fi
  for source in "${id_sources[@]}"; do
    cp "${workdir}/ids/${source}" "${source}"
  done
  rm -rf "${workdir}"

  # Prove the restoration rather than assuming it. This harness is the only
  # thing permitted to substitute a program id in a working checkout, so it is
  # also the thing that has to demonstrate it put the permanent ones back — a
  # leftover ephemeral id committed by mistake would point the whole protocol
  # at an address nobody holds the keypair for.
  if ! PPV_REPO_ROOT="$(pwd)" ./scripts/verify-devnet-readiness.sh --repo-only >/dev/null 2>&1; then
    echo >&2
    echo "F1 did not restore the permanent program identities cleanly." >&2
    echo "Run ./scripts/verify-devnet-readiness.sh --repo-only to see what differs," >&2
    echo "and do not commit this checkout until it passes." >&2
    exit 1
  fi
  exit "${status}"
}
trap cleanup EXIT

# The provider wallet named in Anchor.toml has to exist before anything can be
# funded or deployed, and a clean runner has none. This identity only ever signs
# against solana-test-validator, is created outside the repository, and is never
# deployed anywhere.
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

# Assert the three places a program id lives agree before anything is deployed.
# A binary compiled against one id and loaded at another fails every instruction
# with DeclaredProgramIdMismatch, which reads like a protocol bug and is not one.
for program in ppv_core ppv_commerce; do
  keypair_id="$(solana-keygen pubkey "target/deploy/${program}-keypair.json")"
  declared_id="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' "programs/${program}/src/lib.rs")"
  manifest_id="$(sed -n "s/^${program} = \"\(.*\)\"$/\1/p" Anchor.toml | head -1)"
  idl_id="$(node -e "process.stdout.write(require('./target/idl/${program}.json').address)")"

  if [[ "${keypair_id}" != "${declared_id}" ]] ||
     [[ "${keypair_id}" != "${manifest_id}" ]] ||
     [[ "${keypair_id}" != "${idl_id}" ]]; then
    echo "Program id mismatch for ${program}:" >&2
    echo "  keypair:     ${keypair_id}" >&2
    echo "  declare_id!: ${declared_id}" >&2
    echo "  Anchor.toml: ${manifest_id}" >&2
    echo "  IDL address: ${idl_id}" >&2
    exit 1
  fi
done

# Run the suite against a validator this script owns, and let `anchor test`
# deploy the programs from their own keypairs. That is the same path a devnet
# deployment takes, so the gate exercises it. Letting `anchor test` start its own
# validator instead injects the binaries at the Anchor.toml addresses through
# `--bpf-program`, which cannot be run at all where IPv6 is unavailable because
# Anchor's port check tests an IPv6 bind.
solana-test-validator --reset --quiet --ledger "${workdir}/test-ledger" &
validator_pid=$!

wait_for_validator() {
  for _ in $(seq 1 60); do
    if solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "solana-test-validator did not become ready" >&2
  return 1
}
wait_for_validator

solana --url http://127.0.0.1:8899 airdrop 100 \
  "$(solana-keygen pubkey "${provider_wallet}")" >/dev/null

anchor test --skip-build --skip-local-validator

sha256sum target/idl/ppv_core.json target/idl/ppv_commerce.json
echo "F1 local-validator verification passed"
echo "Permanent identity restoration is asserted by the cleanup trap below."
