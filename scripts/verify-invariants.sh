#!/usr/bin/env bash
set -euo pipefail

# PPV security-invariant gate (Lesson 12).
#
# Runs the model-based property suite in tests/invariants/ against a local
# validator this script owns, on the same architecture as scripts/verify-f1.sh:
# ephemeral program ids under the ignored target/ directory, a real
# `anchor build`, real deploys from those keypairs, and fail-closed restoration
# of the permanent identities on every exit path.
#
# It is a separate entry point from F1 rather than a flag on it because the two
# gates answer different questions and carry different budgets. F1 proves the
# build is reproducible and the deterministic suite passes; this proves the
# custody state machine survives randomized attack. F1 owns the double-build
# IDL determinism check and is not repeated here.
#
# Tiers (PPV_INVARIANT_TIER, default "pr"):
#   pr       100 sequences x <=20 actions, three fixed CI seeds
#   release  larger sequence count, more seeds, longer sequences
#   seed     one explicit PPV_INVARIANT_SEED, for replaying a counterexample
#
# Every budget knob is overridable by exporting the matching
# PPV_INVARIANT_* variable before calling this script.

expected_anchor="anchor-cli 0.30.1"
expected_solana="solana-cli 1.18.17"

# Same pin, same reason as verify-f1.sh: anchor-syn 0.30.1 calls an unstable
# proc-macro2 API that later nightlies removed, so an unpinned nightly makes the
# IDL build fail on a date rather than on a code change.
export RUSTUP_TOOLCHAIN="${PPV_IDL_TOOLCHAIN:-nightly-2024-06-15}"

tier="${PPV_INVARIANT_TIER:-pr}"

case "${tier}" in
  pr)
    : "${PPV_INVARIANT_SEQUENCES:=100}"
    : "${PPV_INVARIANT_ACTIONS:=20}"
    : "${PPV_INVARIANT_SEEDS:=20260912,20260913,20260914}"
    : "${PPV_INVARIANT_MIN_OPERATIONS:=2000}"
    ;;
  release)
    : "${PPV_INVARIANT_SEQUENCES:=200}"
    : "${PPV_INVARIANT_ACTIONS:=32}"
    : "${PPV_INVARIANT_SEEDS:=20260912,20260913,20260914,20260915,20260916}"
    : "${PPV_INVARIANT_MIN_OPERATIONS:=12000}"
    ;;
  seed)
    if [[ -z "${PPV_INVARIANT_SEED:-}" ]]; then
      echo "PPV_INVARIANT_SEED must be set for the seed tier." >&2
      echo "Example: PPV_INVARIANT_SEED=20260912 npm run test:invariants:seed" >&2
      exit 1
    fi
    : "${PPV_INVARIANT_SEQUENCES:=100}"
    : "${PPV_INVARIANT_ACTIONS:=20}"
    # A replay reproduces one counterexample. Holding it to the PR tier's
    # budget floor would fail the replay for spending less than a full gate.
    : "${PPV_INVARIANT_MIN_OPERATIONS:=1}"
    ;;
  *)
    echo "Unknown PPV_INVARIANT_TIER '${tier}' (expected pr, release or seed)." >&2
    exit 1
    ;;
esac

export PPV_INVARIANT_SEQUENCES PPV_INVARIANT_ACTIONS PPV_INVARIANT_MIN_OPERATIONS
export PPV_INVARIANT_SEED="${PPV_INVARIANT_SEED:-}"
export PPV_INVARIANT_PATH="${PPV_INVARIANT_PATH:-}"
export PPV_INVARIANT_SEEDS="${PPV_INVARIANT_SEEDS:-}"
export PPV_ANCHOR_TEST_GLOB="tests/invariants/**/*.invariant.ts"

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
# keys this script generates. Those ids are not deployable and must never be
# committed, so the tracked files are restored on every exit path.
id_sources=(
  Anchor.toml
  programs/ppv_core/src/lib.rs
  programs/ppv_commerce/src/lib.rs
  programs/ppv_escrow/src/lib.rs
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

  # Prove the restoration rather than assuming it, exactly as F1 does. This
  # harness substitutes program ids in a working checkout, so it is also the
  # thing that has to demonstrate it put the permanent ones back.
  if ! PPV_REPO_ROOT="$(pwd)" ./scripts/verify-devnet-readiness.sh --repo-only >/dev/null 2>&1; then
    echo >&2
    echo "The invariant gate did not restore the permanent program identities cleanly." >&2
    echo "Run ./scripts/verify-devnet-readiness.sh --repo-only to see what differs," >&2
    echo "and do not commit this checkout until it passes." >&2
    exit 1
  fi
  exit "${status}"
}
trap cleanup EXIT

# Same local-only provider identity F1 uses: created outside the repository,
# only ever signs against solana-test-validator, never deployed anywhere.
provider_wallet="${HOME}/.config/solana/id.json"
if [[ ! -f "${provider_wallet}" ]]; then
  mkdir -p "$(dirname "${provider_wallet}")"
  solana-keygen new --silent --no-bip39-passphrase --outfile "${provider_wallet}"
fi

./scripts/prepare-ephemeral-program-ids.sh

anchor build

# The three places a program id lives must agree before anything is deployed.
for program in ppv_core ppv_commerce ppv_escrow; do
  keypair_id="$(solana-keygen pubkey "target/deploy/${program}-keypair.json")"
  declared_id="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' "programs/${program}/src/lib.rs")"
  manifest_id="$(sed -n "s/^${program} = \"\(.*\)\"$/\1/p" Anchor.toml | head -1)"

  if [[ "${keypair_id}" != "${declared_id}" ]] || [[ "${keypair_id}" != "${manifest_id}" ]]; then
    echo "Program id mismatch for ${program}:" >&2
    echo "  keypair:     ${keypair_id}" >&2
    echo "  declare_id!: ${declared_id}" >&2
    echo "  Anchor.toml: ${manifest_id}" >&2
    exit 1
  fi
done

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

echo "PPV security invariants — tier ${tier}"
echo "  sequences per seed : ${PPV_INVARIANT_SEQUENCES}"
echo "  actions per seq    : <= ${PPV_INVARIANT_ACTIONS}"
echo "  seeds              : ${PPV_INVARIANT_SEED:-${PPV_INVARIANT_SEEDS}}"
echo "  minimum operations : ${PPV_INVARIANT_MIN_OPERATIONS}"

anchor test --skip-build --skip-local-validator

echo "SECURITY_INVARIANTS_GREEN (tier ${tier})"
echo "Permanent identity restoration is asserted by the cleanup trap below."
