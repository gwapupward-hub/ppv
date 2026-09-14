#!/usr/bin/env bash
set -euo pipefail

# Mutation qualification for the PPV randomized property suite (RR-8).
#
# scripts/mutation-qualify.sh proves the *host* suite detects injected defects.
# It says nothing about the randomized, model-based suite in tests/invariants/,
# which is the layer that attacks real custody against a real validator — and
# therefore the layer that would have to catch a milestone or bounty defect.
# A suite whose detection power is unmeasured cannot be the evidence that some
# other gap is closed.
#
# So this script breaks one defence at a time and requires *the property suite*
# to fail. Compile errors, host-test failures and deterministic-suite failures
# do not count: the run is configured to execute only
# tests/invariants/**/*.invariant.ts, so the only thing that can fail is
# randomized state-machine execution.
#
#   ./scripts/mutation-qualify-property.sh                     # all mutations
#   ./scripts/mutation-qualify-property.sh milestone-overpay   # one, by id
#
# Exit status is the verdict: 0 when the property suite detected every mutation
# and the clean suite is green afterwards.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MUTABLE_FILES=(
  programs/ppv_escrow/src/state/agreement.rs
  programs/ppv_escrow/src/state/milestone.rs
  programs/ppv_escrow/src/instructions/milestone.rs
)

if ! git diff --quiet -- "${MUTABLE_FILES[@]}"; then
  echo "The files this script mutates already have uncommitted changes." >&2
  echo "Commit or stash them first: a mutation run must start from a known tree." >&2
  exit 1
fi

# A budget big enough to reach the defect, small enough to run four times.
#
# A mutation the suite fails to detect because the run was too short is a false
# NO for the suite, so this is deliberately larger than a PR-tier run per seed.
# It is not a release budget and does not pretend to be: its job is to reach
# one specific broken state, not to qualify a release.
: "${PPV_MUTATION_SEQUENCES:=90}"
: "${PPV_MUTATION_ACTIONS:=28}"
: "${PPV_MUTATION_SEEDS:=20260912,20260913}"

expected_anchor="anchor-cli 0.30.1"
expected_solana="solana-cli 1.18.17"
export RUSTUP_TOOLCHAIN="${PPV_IDL_TOOLCHAIN:-nightly-2024-06-15}"

[[ "$(anchor --version)" == "${expected_anchor}" ]] || {
  echo "Expected ${expected_anchor}, found $(anchor --version)" >&2
  exit 1
}
[[ "$(solana --version)" == "${expected_solana}"* ]] || {
  echo "Expected ${expected_solana}, found $(solana --version)" >&2
  exit 1
}

workdir="$(mktemp -d)"
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

restore_mutations() {
  git checkout -- "${MUTABLE_FILES[@]}"
}

cleanup() {
  status=$?
  if [[ -n "${validator_pid}" ]]; then
    kill "${validator_pid}" 2>/dev/null || true
    wait "${validator_pid}" 2>/dev/null || true
  fi
  restore_mutations
  for source in "${id_sources[@]}"; do
    cp "${workdir}/ids/${source}" "${source}"
  done
  rm -rf "${workdir}"
  # Prove the restoration rather than assuming it. This harness substitutes
  # program ids *and* protocol source, so it is doubly the thing that has to
  # demonstrate it put everything back.
  if ! PPV_REPO_ROOT="$(pwd)" ./scripts/verify-devnet-readiness.sh --repo-only >/dev/null 2>&1; then
    echo >&2
    echo "The property mutation harness did not restore the permanent program identities." >&2
    exit 1
  fi
  if ! git diff --quiet -- "${MUTABLE_FILES[@]}"; then
    echo >&2
    echo "SECURITY: a mutation was left in the working tree. Do not commit this checkout." >&2
    git --no-pager diff --stat -- "${MUTABLE_FILES[@]}" >&2
    exit 1
  fi
  exit "${status}"
}
trap cleanup EXIT

provider_wallet="${HOME}/.config/solana/id.json"
if [[ ! -f "${provider_wallet}" ]]; then
  mkdir -p "$(dirname "${provider_wallet}")"
  solana-keygen new --silent --no-bip39-passphrase --outfile "${provider_wallet}"
fi

./scripts/prepare-ephemeral-program-ids.sh

wait_for_validator() {
  for _ in $(seq 1 60); do
    solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "solana-test-validator did not become ready" >&2
  return 1
}

start_validator() {
  local ledger="$1"
  solana-test-validator --reset --quiet --ledger "${ledger}" >/dev/null 2>&1 &
  validator_pid=$!
  wait_for_validator || return 1
  solana --url http://127.0.0.1:8899 airdrop 100 \
    "$(solana-keygen pubkey "${provider_wallet}")" >/dev/null
}

stop_validator() {
  [[ -n "${validator_pid}" ]] || return 0
  kill "${validator_pid}" 2>/dev/null || true
  wait "${validator_pid}" 2>/dev/null || true
  validator_pid=""
  for _ in $(seq 1 30); do
    solana --url http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo "a previous solana-test-validator is still serving 127.0.0.1:8899" >&2
  return 1
}

apply_mutation() {
  python3 - "$1" <<'PY'
import sys, pathlib

AGREEMENT = pathlib.Path("programs/ppv_escrow/src/state/agreement.rs")
MILESTONE = pathlib.Path("programs/ppv_escrow/src/state/milestone.rs")
INSTRUCTION = pathlib.Path("programs/ppv_escrow/src/instructions/milestone.rs")

MUTATIONS = {
    # Lifecycle finality, milestone-specific: an already-released tranche may
    # be released again. The vault pays twice for one piece of work.
    "milestone-double-release": (
        MILESTONE,
        """        require!(
            self.state == MilestoneState::Approved,
            EscrowError::MilestoneBadState
        );
        Ok(())
    }

    pub fn record_submitted""",
        """        require!(
            matches!(self.state, MilestoneState::Approved | MilestoneState::Settled),
            EscrowError::MilestoneBadState
        );
        Ok(())
    }

    pub fn record_submitted""",
    ),
    # Destination binding: a tranche may be paid to any token account of the
    # right mint, including the attacker's.
    "milestone-recipient": (
        INSTRUCTION,
        """        constraint = seller_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
        constraint = seller_token_account.owner == agreement.counterparty
            @ EscrowError::DestinationNotOwnedBySeller,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,
    pub settlement_proof: Option<Account<'info, Proof>>,""",
        """        constraint = seller_token_account.mint == agreement.mint @ EscrowError::MintMismatch,
    )]
    pub seller_token_account: Account<'info, TokenAccount>,
    pub settlement_proof: Option<Account<'info, Proof>>,""",
    ),
    # Custody conservation: a tranche pays out everything the vault still
    # owes rather than its own allocation.
    "milestone-overpay": (
        INSTRUCTION,
        "    let amount = ctx.accounts.milestone.amount;",
        "    let amount = ctx.accounts.agreement.remaining();",
    ),
    # Bounty lifecycle finality: a sponsor may replace the winner after
    # naming one, redirecting every later payout.
    "bounty-winner-replacement": (
        AGREEMENT,
        """        require!(
            !self.has_counterparty(),
            EscrowError::CounterpartyAlreadyAssigned
        );
""",
        "",
    ),
}

mutation_id = sys.argv[1]
path, old, new = MUTATIONS[mutation_id]
text = path.read_text()
count = text.count(old)
if count != 1:
    sys.stderr.write(f"mutation {mutation_id}: anchor matched {count} times, expected 1\n")
    sys.exit(2)
path.write_text(text.replace(old, new, 1))
PY
}

ALL_IDS=(milestone-double-release milestone-recipient milestone-overpay bounty-winner-replacement)
declare -A CLASS=(
  [milestone-double-release]="milestone lifecycle finality (PPV-M3)"
  [milestone-recipient]="destination binding (PPV-M4 / PPV-P4)"
  [milestone-overpay]="custody conservation (PPV-P1 / PPV-M2)"
  [bounty-winner-replacement]="bounty lifecycle finality (PPV-B1)"
)
declare -A DESCRIPTION=(
  [milestone-double-release]="an already-settled tranche may be released again"
  [milestone-recipient]="a tranche may be paid to any account of the right mint"
  [milestone-overpay]="a tranche pays out everything the vault still owes"
  [bounty-winner-replacement]="a bounty sponsor may replace the winner after naming one"
)

requested=("$@")
[[ ${#requested[@]} -eq 0 ]] && requested=("${ALL_IDS[@]}")

export PPV_ANCHOR_TEST_GLOB="tests/invariants/**/*.invariant.ts"
export PPV_INVARIANT_SEQUENCES="${PPV_MUTATION_SEQUENCES}"
export PPV_INVARIANT_ACTIONS="${PPV_MUTATION_ACTIONS}"
export PPV_INVARIANT_SEEDS="${PPV_MUTATION_SEEDS}"
export PPV_INVARIANT_SEED=""
export PPV_INVARIANT_PATH=""
# The reach floors are a release-qualification gate, not a mutation gate: a
# mutated run stops at the first violation and would fail them for the wrong
# reason, reporting "budget" where the answer is "detected".
export PPV_INVARIANT_MIN_OPERATIONS=1

echo "PPV randomized property-suite mutation qualification (RR-8)"
echo "  suite      : anchor test — tests/invariants/**/*.invariant.ts only"
echo "  budget     : ${PPV_MUTATION_SEQUENCES} sequences x <=${PPV_MUTATION_ACTIONS} actions, seeds ${PPV_MUTATION_SEEDS}"
echo "  mutations  : ${#requested[@]}"
echo

undetected=()
report="${workdir}/report.md"
: > "${report}"

run_property_suite() {
  local log="$1"
  start_validator "${workdir}/ledger" || return 99
  set +e
  anchor test --skip-build --skip-local-validator > "${log}" 2>&1
  local status=$?
  set -e
  stop_validator
  rm -rf "${workdir}/ledger"
  return "${status}"
}

# One clean build up front; each mutation rebuilds only what it changed.
anchor build

for id in "${requested[@]}"; do
  printf '  %-26s %s\n' "${id}" "${DESCRIPTION[${id}]:-unknown mutation}"
  apply_mutation "${id}"

  if ! anchor build >"${workdir}/build-${id}.log" 2>&1; then
    echo "                             MUTATION DID NOT COMPILE — not a qualification" >&2
    tail -n 20 "${workdir}/build-${id}.log" >&2
    undetected+=("${id} (did not compile)")
    restore_mutations
    continue
  fi

  log="${workdir}/run-${id}.log"
  if run_property_suite "${log}"; then
    printf '                             UNDETECTED — the property suite passed a broken program\n'
    undetected+=("${id}")
  else
    status=$?
    if (( status == 99 )); then
      echo "                             validator did not start; this is not a result" >&2
      undetected+=("${id} (no validator)")
      restore_mutations
      continue
    fi
    # The evidence: which invariant, which seed, and the shortest sequence
    # fast-check could shrink the counterexample to.
    seed="$(grep -m1 -oE 'seed +: [0-9]+' "${log}" | grep -oE '[0-9]+' || echo unknown)"
    invariant="$(grep -m1 -oE 'PPV-[A-Z0-9]+' "${log}" || echo unknown)"
    flavour="$(grep -m1 -oE 'agreement type +: [a-z]+' "${log}" | awk '{print $NF}' || echo unknown)"
    minimized="$(sed -n 's/^ *\[[0-9]\+\] //p' "${log}" | head -8)"
    printf '                             DETECTED [%s]\n' "${CLASS[${id}]}"
    printf '                               seed %s, %s agreement, first violation %s\n' \
      "${seed}" "${flavour}" "${invariant}"
    printf '%s\n' "${minimized}" | sed 's/^/                                 /'
    {
      printf '### %s\n\n' "${id}"
      printf -- '- defect: %s\n' "${DESCRIPTION[${id}]}"
      printf -- '- class: %s\n' "${CLASS[${id}]}"
      printf -- '- detected by the randomized property suite: yes\n'
      printf -- '- seed: %s\n' "${seed}"
      printf -- '- agreement type: %s\n' "${flavour}"
      printf -- '- first violated invariant: %s\n' "${invariant}"
      printf -- '- minimized sequence:\n\n```\n%s\n```\n\n' "${minimized}"
    } >> "${report}"
  fi
  restore_mutations
done

echo
if [[ ${#undetected[@]} -gt 0 ]]; then
  echo "PROPERTY MUTATION QUALIFICATION FAILED — undetected: ${undetected[*]}" >&2
  echo "Improve the model, the generator or the assertions. Do not make the" >&2
  echo "mutation easier to detect." >&2
  exit 1
fi

# The suite must be green on the restored source, or "it detected the mutation"
# could just mean "it fails on everything".
echo "  clean rerun (no mutation)"
anchor build >/dev/null 2>&1
if ! run_property_suite "${workdir}/run-clean.log"; then
  echo "CLEAN PROPERTY SUITE FAILED after reverting every mutation" >&2
  tail -n 40 "${workdir}/run-clean.log" >&2
  exit 1
fi
echo "                             green"

echo
cat "${report}"
echo "PROPERTY_MUTATION_QUALIFICATION_PASSED (${#requested[@]} mutations, all detected by the randomized suite)"
