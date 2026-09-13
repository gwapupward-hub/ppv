#!/usr/bin/env bash
set -euo pipefail

# Verifies every entry in deployments/<cluster>.json against public chain state.
# All reads use raw JSON-RPC; no wallet, default signer or keypair is required.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

declare -A PERMANENT_IDS=(
  [ppv_core]="9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU"
  [ppv_commerce]="GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3"
)
UPGRADEABLE_LOADER="BPFLoaderUpgradeab1e11111111111111111111111"

cluster="${PPV_CLUSTER:-devnet}"
manifest="deployments/${cluster}.json"
primary_rpc="${PPV_RPC_URL:-https://api.${cluster}.solana.com}"
second_rpc="${PPV_VERIFY_RPC_URL:-}"

[[ -f "${manifest}" ]] || {
  echo "${manifest} does not exist. PPV has no recorded ${cluster} deployment evidence." >&2
  exit 1
}

expected_genesis="$(node -e "process.stdout.write(require('./${manifest}').genesisHash)")"
actual_genesis="$(node scripts/query-solana-rpc.mjs genesis unused "${primary_rpc}")"
[[ "${expected_genesis}" == "${actual_genesis}" ]] || {
  echo "Genesis hash mismatch: manifest ${expected_genesis}, cluster ${actual_genesis}" >&2
  exit 1
}

entries="$(node -e '
const manifest = require("./'"${manifest}"'");
const latest = new Map();
for (const entry of manifest.deployments) latest.set(entry.program, entry);
for (const entry of latest.values()) {
  console.log([entry.program, entry.programId, entry.programDataAddress, entry.upgradeAuthority, entry.deploymentSignature].join(" "));
}
')"

failures=0

check_one() {
  local rpc="$1" label="$2" program="$3" program_id="$4" expected_data="$5" expected_authority="$6" signature="$7"
  local state exists executable owner data authority signature_state signature_error ok=0

  state="$(node scripts/query-solana-rpc.mjs program "${program_id}" "${rpc}")" || {
    echo "  ${label}: FAIL — RPC query failed"
    return 1
  }
  exists="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).exists))" "${state}")"
  executable="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).executable))" "${state}")"
  owner="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).owner || '')" "${state}")"
  data="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).programDataAddress || '')" "${state}")"
  authority="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).authority || '')" "${state}")"

  [[ "${exists}" == "true" ]] || { echo "  ${label}: FAIL — no program account at ${program_id}"; ok=1; }
  [[ "${executable}" == "true" ]] || { echo "  ${label}: FAIL — account is not executable"; ok=1; }
  [[ "${owner}" == "${UPGRADEABLE_LOADER}" ]] || { echo "  ${label}: FAIL — owner ${owner}, expected ${UPGRADEABLE_LOADER}"; ok=1; }
  [[ "${data}" == "${expected_data}" ]] || { echo "  ${label}: FAIL — programData ${data}, manifest ${expected_data}"; ok=1; }
  [[ "${authority}" == "${expected_authority}" ]] || { echo "  ${label}: FAIL — upgrade authority ${authority}, manifest ${expected_authority}"; ok=1; }

  signature_state="$(node scripts/query-solana-rpc.mjs signature "${signature}" "${rpc}")" || {
    echo "  ${label}: FAIL — could not read deployment signature"
    ok=1
    signature_state="null"
  }
  if [[ "${signature_state}" == "null" ]]; then
    echo "  ${label}: FAIL — deployment signature not found"
    ok=1
  else
    signature_error="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).err))" "${signature_state}")"
    [[ "${signature_error}" == "null" ]] || { echo "  ${label}: FAIL — deployment signature error ${signature_error}"; ok=1; }
  fi

  [[ "${ok}" == 0 ]] && echo "  ${label}: ok"
  return "${ok}"
}

while read -r program program_id program_data authority signature; do
  [[ -n "${program}" ]] || continue
  echo "${program} (${program_id})"

  expected_permanent="${PERMANENT_IDS[${program}]:-}"
  if [[ -z "${expected_permanent}" ]]; then
    echo "  manifest: FAIL — ${program} is not a known PPV program"
    failures=1
  elif [[ "${program_id}" != "${expected_permanent}" ]]; then
    echo "  manifest: FAIL — manifest records ${program} at ${program_id}, permanent id is ${expected_permanent}"
    failures=1
  fi

  check_one "${primary_rpc}" "primary RPC" "${program}" "${program_id}" "${program_data}" "${authority}" "${signature}" || failures=1
  if [[ -n "${second_rpc}" ]]; then
    second_genesis="$(node scripts/query-solana-rpc.mjs genesis unused "${second_rpc}")"
    if [[ "${second_genesis}" != "${expected_genesis}" ]]; then
      echo "  second RPC: FAIL — genesis ${second_genesis}, expected ${expected_genesis}"
      failures=1
    else
      check_one "${second_rpc}" "second RPC" "${program}" "${program_id}" "${program_data}" "${authority}" "${signature}" || failures=1
    fi
  fi
done <<< "${entries}"

if [[ -z "${second_rpc}" ]]; then
  echo
  echo "Note: verified through one RPC only. Set PPV_VERIFY_RPC_URL to a second provider for an independent read."
fi

[[ "${failures}" == 0 ]] || { echo; echo "Verification FAILED."; exit 1; }
echo
echo "All ${cluster} deployments match the manifest."
