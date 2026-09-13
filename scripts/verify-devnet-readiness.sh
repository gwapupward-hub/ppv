#!/usr/bin/env bash
set -euo pipefail

# Deployment-readiness preflight for the first persistent PPV devnet deploy.
#
# Fail-closed: a check that cannot be performed is a failure, never a skip. A
# preflight that quietly passes when it could not look is worse than no
# preflight, because it produces confidence instead of information.
#
# Read-only. It reads files, versions and (optionally) a public RPC. It never
# writes to the repository, never signs anything, and never prints the contents
# of a keypair — only the public key derived from one.
#
# Usage
#   ./scripts/verify-devnet-readiness.sh                  # deployment-grade
#   ./scripts/verify-devnet-readiness.sh --repo-only      # repo + identity only
#
# Optional inputs (public values only):
#   PPV_CORE_PROGRAM_KEYPAIR_PATH      verify this keypair's pubkey matches
#   PPV_COMMERCE_PROGRAM_KEYPAIR_PATH  verify this keypair's pubkey matches
#   PPV_READINESS_RPC_URL              default https://api.devnet.solana.com
#   PPV_DEVNET_GENESIS_HASH            expected devnet genesis
#   PPV_SQUADS_VAULT_PDA               final upgrade authority
#   PPV_SQUADS_MEMBER_PUBKEYS          comma-separated member public keys
#   PPV_SQUADS_THRESHOLD               signatures required (>= 2)
#   PPV_REPO_ROOT                      tree to inspect (tests point this at a fixture)

repo_root="${PPV_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lib_dir="${script_dir}/lib"

mode="deployment-grade"
case "${1:-}" in
  --repo-only) mode="repo-only" ;;
  --deployment-grade | "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

CORE_ID="9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU"
COMMERCE_ID="GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3"
MIN_THRESHOLD="${PPV_MIN_SQUADS_THRESHOLD:-2}"
rpc_url="${PPV_READINESS_RPC_URL:-https://api.devnet.solana.com}"

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }
section() { printf '\n%s\n' "$1"; }

node_helper() {
  node --input-type=module -e "
    import { isAddress, isProgramDerived } from '${lib_dir}/pubkey.mjs';
    const [fn, value] = process.argv.slice(1);
    const result = fn === 'isAddress' ? isAddress(value) : isProgramDerived(value);
    process.stdout.write(String(result));
  " -- "$1" "$2"
}

git_in_repo() { git -C "${repo_root}" "$@"; }

# ---------------------------------------------------------------- repository
section "Repository"

if ! git_in_repo rev-parse --git-dir >/dev/null 2>&1; then
  fail "${repo_root} is not a git repository, so nothing here can be attributed to a commit"
else
  if [[ "${mode}" == "deployment-grade" ]]; then
    if [[ -n "$(git_in_repo status --porcelain)" ]]; then
      fail "working tree is dirty — the deployed binary would not be identified by any commit"
    else
      pass "working tree is clean"
    fi
  else
    pass "working tree state not checked (--repo-only)"
  fi

  if git_in_repo diff --quiet HEAD -- Cargo.lock 2>/dev/null; then
    pass "Cargo.lock matches the committed lockfile"
  else
    fail "Cargo.lock differs from HEAD — the authoritative lockfile must not be regenerated"
  fi

  tracked_keys="$(git_in_repo ls-files | grep -E '(-keypair\.json|(^|/)id\.json)$' || true)"
  if [[ -n "${tracked_keys}" ]]; then
    fail "signing material is tracked in git: ${tracked_keys}"
  else
    pass "no keypair JSON files are tracked"
  fi

  if git_in_repo check-ignore -q -- "example-keypair.json" 2>/dev/null; then
    pass ".gitignore covers *-keypair.json"
  else
    fail ".gitignore does not ignore *-keypair.json"
  fi

  # Content scan over tracked files only: an untracked scratch file is the
  # operator's business, a committed one is everybody's.
  secrets=0
  # Assembled at runtime rather than written out, so this file does not match
  # its own detector. The pattern the scan applies is unchanged; only its source
  # representation is split. A scanner that flags itself teaches everyone who
  # runs it to ignore the one result it produces.
  key_word="PRI""VATE"
  while IFS= read -r file; do
    [[ -f "${repo_root}/${file}" ]] || continue
    case "${file}" in *.png|*.jpg|*.gif|*.pdf|*.so) continue ;; esac
    if grep -qE "BEGIN [A-Z ]*${key_word} KEY|BEGIN OPENSSH ${key_word} KEY" "${repo_root}/${file}" 2>/dev/null; then
      fail "possible private key material in ${file}"
      secrets=$((secrets + 1))
    fi
    # A 64-element byte array is the shape of a Solana keypair file.
    if grep -qE '\[[[:space:]]*[0-9]{1,3}[[:space:]]*,([[:space:]]*[0-9]{1,3}[[:space:]]*,){60,}' "${repo_root}/${file}" 2>/dev/null; then
      fail "possible keypair byte array in ${file}"
      secrets=$((secrets + 1))
    fi
    if grep -qiE '(mnemonic|seed[ _-]?phrase|bip39[ _-]?passphrase)[[:space:]]*[:=][[:space:]]*["'"'"'][a-z ]{20,}' "${repo_root}/${file}" 2>/dev/null; then
      fail "possible seed phrase in ${file}"
      secrets=$((secrets + 1))
    fi
  done < <(git_in_repo ls-files)
  [[ "${secrets}" == 0 ]] && pass "no committed private key material found"
fi

# ------------------------------------------------------------------ identity
section "Permanent program identities"

check_identity() {
  local program="$1" expected="$2" lib="${repo_root}/programs/$1/src/lib.rs"

  if [[ ! -f "${lib}" ]]; then
    fail "${program}: ${lib} not found"
    return
  fi

  local declared
  declared="$(sed -n 's/^declare_id!("\(.*\)");$/\1/p' "${lib}")"
  if [[ "${declared}" != "${expected}" ]]; then
    fail "${program}: declare_id! is ${declared:-<none>}, expected ${expected}"
  else
    pass "${program}: declare_id! is the permanent id"
  fi

  # Both cluster tables must name it, and they must agree. A localnet/devnet
  # split is how a program gets built against one id and deployed at another.
  local ids
  mapfile -t ids < <(sed -n "s/^${program} = \"\(.*\)\"$/\1/p" "${repo_root}/Anchor.toml")
  if [[ "${#ids[@]}" -lt 2 ]]; then
    fail "${program}: Anchor.toml must name the id under both localnet and devnet"
  elif [[ "$(printf '%s\n' "${ids[@]}" | sort -u | wc -l)" -ne 1 ]]; then
    fail "${program}: Anchor.toml cluster ids disagree: ${ids[*]}"
  elif [[ "${ids[0]}" != "${expected}" ]]; then
    fail "${program}: Anchor.toml id is ${ids[0]}, expected ${expected}"
  else
    pass "${program}: Anchor.toml localnet and devnet both name the permanent id"
  fi

  # The generated IDL is a build artifact, not a tracked identity, and it is
  # only meaningful in deployment-grade mode. The F1 harness deliberately builds
  # with ephemeral keypairs, so an IDL left in the ignored `target/` after an F1
  # run carries a throwaway address by design — checking it in --repo-only mode
  # would make F1's own cleanup assertion fail on a file that is behaving
  # correctly. What the permanent identities live in is `declare_id!` and
  # `Anchor.toml`, and those are checked in both modes.
  if [[ "${mode}" == "deployment-grade" ]]; then
    local idl="${repo_root}/target/idl/${program}.json"
    if [[ -f "${idl}" ]]; then
      local idl_id
      idl_id="$(node -e "process.stdout.write(require('${idl}').address)")"
      if [[ "${idl_id}" != "${expected}" ]]; then
        fail "${program}: built IDL address is ${idl_id}, expected ${expected} (a stale IDL from an F1 run will do this — rebuild or remove target/idl)"
      else
        pass "${program}: built IDL address matches"
      fi
    fi
  fi
}

check_identity ppv_core "${CORE_ID}"
check_identity ppv_commerce "${COMMERCE_ID}"

# Optional: prove a supplied permanent keypair really is the committed identity.
# Only the derived public key is ever read or printed.
check_keypair() {
  local program="$1" expected="$2" path="$3"
  [[ -n "${path}" ]] || return 0
  if [[ ! -f "${path}" ]]; then
    fail "${program}: keypair path ${path} does not exist"
    return
  fi
  if ! command -v solana-keygen >/dev/null 2>&1; then
    fail "${program}: keypair supplied but solana-keygen is unavailable to verify it"
    return
  fi
  local actual
  actual="$(solana-keygen pubkey "${path}")"
  if [[ "${actual}" != "${expected}" ]]; then
    fail "${program}: supplied keypair is ${actual}, expected ${expected}"
  else
    pass "${program}: supplied keypair derives the permanent id"
  fi
}

check_keypair ppv_core "${CORE_ID}" "${PPV_CORE_PROGRAM_KEYPAIR_PATH:-}"
check_keypair ppv_commerce "${COMMERCE_ID}" "${PPV_COMMERCE_PROGRAM_KEYPAIR_PATH:-}"

# ----------------------------------------------------------------- toolchain
if [[ "${mode}" == "deployment-grade" ]]; then
  section "Toolchain"

  require_version() {
    local label="$1" command="$2" expected="$3" actual
    if ! command -v "${command}" >/dev/null 2>&1; then
      fail "${label}: ${command} is not installed"
      return
    fi
    actual="$("${command}" --version 2>/dev/null | head -1)"
    if [[ "${actual}" != "${expected}"* ]]; then
      fail "${label}: found '${actual}', expected '${expected}'"
    else
      pass "${label}: ${expected}"
    fi
  }

  require_version "Anchor CLI" anchor "anchor-cli 0.30.1"
  require_version "Solana CLI" solana "solana-cli 1.18.17"

  if command -v rustup >/dev/null 2>&1; then
    installed="$(rustup toolchain list 2>/dev/null || true)"
    for toolchain in 1.85.1 nightly-2024-06-15; do
      if grep -q "^${toolchain}" <<< "${installed}"; then
        pass "Rust toolchain ${toolchain} installed"
      else
        fail "Rust toolchain ${toolchain} is not installed"
      fi
    done
  else
    fail "rustup is not installed, so the pinned toolchains cannot be verified"
  fi

  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")"
  if [[ "${node_major}" == "22" ]]; then
    pass "Node 22.x"
  else
    fail "Node major version is ${node_major:-<unknown>}, expected 22"
  fi
fi

# --------------------------------------------------------- upgrade authority
if [[ "${mode}" == "deployment-grade" ]]; then
  section "Upgrade authority (Squads)"

  vault="${PPV_SQUADS_VAULT_PDA:-}"
  members="${PPV_SQUADS_MEMBER_PUBKEYS:-}"
  threshold="${PPV_SQUADS_THRESHOLD:-}"

  if [[ -z "${vault}" ]]; then
    fail "PPV_SQUADS_VAULT_PDA is not set"
  elif [[ "$(node_helper isAddress "${vault}")" != "true" ]]; then
    fail "PPV_SQUADS_VAULT_PDA is not a valid address"
  elif [[ "$(node_helper isProgramDerived "${vault}")" != "true" ]]; then
    # A Squads vault is a program-derived address and is therefore off the
    # ed25519 curve. An on-curve address is somebody's wallet, which means one
    # key could upgrade the program alone.
    fail "PPV_SQUADS_VAULT_PDA is on the ed25519 curve — that is a signer wallet, not a multisig vault"
  else
    pass "PPV_SQUADS_VAULT_PDA is a program-derived address"
  fi

  if [[ -z "${threshold}" ]]; then
    fail "PPV_SQUADS_THRESHOLD is not set"
  elif ! [[ "${threshold}" =~ ^[0-9]+$ ]]; then
    fail "PPV_SQUADS_THRESHOLD is not an integer"
  elif (( threshold < MIN_THRESHOLD )); then
    fail "PPV_SQUADS_THRESHOLD is ${threshold}; policy requires at least ${MIN_THRESHOLD}"
  else
    pass "PPV_SQUADS_THRESHOLD is ${threshold} (>= ${MIN_THRESHOLD})"
  fi

  if [[ -z "${members}" ]]; then
    fail "PPV_SQUADS_MEMBER_PUBKEYS is not set"
  else
    # Normalize once, then check the normalized list. Trimming with a stream
    # filter instead would delete the separators along with the padding and
    # collapse every member into one value, which reads as "no duplicates".
    normalized=()
    IFS=',' read -r -a raw_members <<< "${members}"
    for member in "${raw_members[@]}"; do
      member="${member//[[:space:]]/}"
      [[ -n "${member}" ]] && normalized+=("${member}")
    done

    member_count="${#normalized[@]}"
    members_ok=1

    for member in "${normalized[@]}"; do
      if [[ "$(node_helper isAddress "${member}")" != "true" ]]; then
        fail "Squads member '${member}' is not a valid address"
        members_ok=0
      fi
      if [[ -n "${vault}" && "${member}" == "${vault}" ]]; then
        fail "Squads member list contains the vault PDA itself"
        members_ok=0
      fi
    done

    if [[ "${member_count}" -eq 0 ]]; then
      fail "PPV_SQUADS_MEMBER_PUBKEYS contains no public keys"
      members_ok=0
    elif [[ "$(printf '%s\n' "${normalized[@]}" | sort -u | wc -l)" -ne "${member_count}" ]]; then
      fail "Squads member list contains duplicates"
      members_ok=0
    fi

    if [[ "${threshold}" =~ ^[0-9]+$ ]] && (( member_count < threshold )); then
      fail "Squads has ${member_count} members but a threshold of ${threshold}, which can never be met"
      members_ok=0
    fi

    if [[ "${members_ok}" == 1 && "${member_count}" -gt 0 ]]; then
      pass "Squads member set: ${member_count} distinct public keys"
    fi
  fi
fi

# -------------------------------------------------------------------- devnet
if [[ "${mode}" == "deployment-grade" ]]; then
  section "Devnet"

  expected_genesis="${PPV_DEVNET_GENESIS_HASH:-}"
  # Chain reads go through JSON-RPC rather than the Solana CLI. The CLI wants a
  # configured default signer even for read-only commands, so a preflight built
  # on it fails on exactly the machines that most need to run it.
  if [[ -z "${expected_genesis}" ]]; then
    fail "PPV_DEVNET_GENESIS_HASH is not set, so the target cluster cannot be pinned"
  else
    actual_genesis="$(node "${script_dir}/query-chain.mjs" genesis "${rpc_url}" 2>/dev/null || true)"
    if [[ -z "${actual_genesis}" ]]; then
      fail "could not read a genesis hash from ${rpc_url}"
    elif [[ "${actual_genesis}" != "${expected_genesis}" ]]; then
      fail "genesis ${actual_genesis} at ${rpc_url} is not the configured devnet genesis"
    else
      pass "${rpc_url} is the configured devnet cluster"
    fi

    # An occupied address is only a problem for a program whose initial
    # deployment has not happened. A program with a committed devnet release
    # record is *supposed* to be occupied — PPV Core is — and treating that as a
    # failure would make this preflight permanently red and block the release of
    # every other program. Released means: verify it, do not redeploy it.
    for entry in "ppv_core:${CORE_ID}" "ppv_commerce:${COMMERCE_ID}"; do
      program="${entry%%:*}"
      program_id="${entry##*:}"

      released=""
      for record in "${repo_root}"/deployments/evidence/*.json; do
        [[ -f "${record}" ]] || continue
        recorded="$(node -e "
          const r = require(process.argv[1]);
          process.stdout.write(r.cluster === 'devnet' ? String(r.program) : '');
        " "${record}" 2>/dev/null || true)"
        [[ "${recorded}" == "${program}" ]] && released="${record}"
      done

      state="$(node "${script_dir}/query-chain.mjs" program "${program_id}" "${rpc_url}" 2>/dev/null || true)"
      if [[ -z "${state}" ]]; then
        fail "${program}: could not read ${program_id} from ${rpc_url}"
        continue
      fi
      occupied="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).exists))" "${state}")"
      authority="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).upgradeAuthority ?? ''))" "${state}")"

      if [[ -n "${released}" ]]; then
        if [[ "${occupied}" != "true" ]]; then
          fail "${program} has a release record (${released}) but no program at ${program_id}"
        else
          pass "${program} is already released at ${program_id} (authority ${authority:-unknown}) — verify, never redeploy"
        fi
      elif [[ "${occupied}" == "true" ]]; then
        fail "${program} already exists at ${program_id} (authority ${authority:-unknown}) — initial deployment must not overwrite it"
      else
        pass "${program} address ${program_id} is unoccupied and ready for initial deployment"
      fi
    done
  fi
fi

# -------------------------------------------------------------------- result
echo
if [[ "${failures}" -ne 0 ]]; then
  echo "NOT READY — ${failures} check(s) failed." >&2
  exit 1
fi

if [[ "${mode}" == "repo-only" ]]; then
  cat <<'NOTE'
Repository and identity checks passed.

This is NOT deployment-grade verification: the toolchain, Squads authority and
devnet cluster were not checked. Run without --repo-only on the release machine
before deploying.
NOTE
  exit 0
fi

echo "READY — every deployment-readiness check passed."
