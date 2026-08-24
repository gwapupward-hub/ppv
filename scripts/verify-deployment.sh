#!/usr/bin/env bash
set -euo pipefail

# Verifies every entry in deployments/<cluster>.json against the chain.
#
# Read-only. It signs nothing and needs no credentials, so anyone can run it —
# which is the point: a manifest nobody can independently check is not evidence.
#
# Reads through a second RPC when PPV_VERIFY_RPC_URL is set, so verification does
# not depend on the same node that served the deployment.
#
#   ./scripts/verify-deployment.sh
#   PPV_VERIFY_RPC_URL=https://your-second-provider ./scripts/verify-deployment.sh

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cluster="${PPV_CLUSTER:-devnet}"
manifest="deployments/${cluster}.json"
primary_rpc="${PPV_RPC_URL:-https://api.${cluster}.solana.com}"
second_rpc="${PPV_VERIFY_RPC_URL:-}"

[[ -f "${manifest}" ]] || {
  echo "${manifest} does not exist. PPV is not deployed to ${cluster}." >&2
  exit 1
}

expected_genesis="$(node -e "process.stdout.write(require('./${manifest}').genesisHash)")"
actual_genesis="$(solana genesis-hash --url "${primary_rpc}")"
[[ "${expected_genesis}" == "${actual_genesis}" ]] || {
  echo "Genesis hash mismatch: manifest ${expected_genesis}, cluster ${actual_genesis}" >&2
  exit 1
}

# Only the newest entry per program is live; earlier ones are history.
entries="$(node -e '
const manifest = require("./'"${manifest}"'");
const latest = new Map();
for (const entry of manifest.deployments) latest.set(entry.program, entry);
for (const entry of latest.values()) {
  console.log([entry.program, entry.programId, entry.programDataAddress, entry.upgradeAuthority].join(" "));
}
')"

failures=0

check_one() {
  local rpc="$1" label="$2" program="$3" program_id="$4" expected_data="$5" expected_authority="$6"
  local show executable data authority

  show="$(solana program show "${program_id}" --url "${rpc}" --output json 2>/dev/null)" || {
    echo "  ${label}: FAIL — no program account at ${program_id}"
    return 1
  }

  executable="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).authority !== undefined))" "${show}")"
  data="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).programdataAddress || '')" "${show}")"
  authority="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).authority || '')" "${show}")"

  local ok=0
  [[ "${executable}" == "true" ]] || { echo "  ${label}: FAIL — not an executable upgradeable program"; ok=1; }
  [[ "${data}" == "${expected_data}" ]] || { echo "  ${label}: FAIL — programData ${data}, manifest ${expected_data}"; ok=1; }
  if [[ "${authority}" != "${expected_authority}" ]]; then
    # An upgrade authority that does not match the manifest is a security
    # incident, not configuration drift.
    echo "  ${label}: FAIL — upgrade authority ${authority}, manifest ${expected_authority}"
    ok=1
  fi
  [[ "${ok}" == 0 ]] && echo "  ${label}: ok"
  return "${ok}"
}

while read -r program program_id program_data authority; do
  [[ -n "${program}" ]] || continue
  echo "${program} (${program_id})"
  check_one "${primary_rpc}" "primary RPC" "${program}" "${program_id}" "${program_data}" "${authority}" || failures=1
  if [[ -n "${second_rpc}" ]]; then
    check_one "${second_rpc}" "second RPC" "${program}" "${program_id}" "${program_data}" "${authority}" || failures=1
  fi
done <<< "${entries}"

if [[ -z "${second_rpc}" ]]; then
  echo
  echo "Note: verified through one RPC only. Set PPV_VERIFY_RPC_URL to a second"
  echo "provider for an independent read."
fi

[[ "${failures}" == 0 ]] || { echo; echo "Verification FAILED."; exit 1; }
echo
echo "All ${cluster} deployments match the manifest."
