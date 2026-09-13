#!/usr/bin/env bash
set -euo pipefail

# Records one deployed program into deployments/<cluster>.json.
#
# Public data only. Chain reads go through raw JSON-RPC and never depend on a
# Solana CLI signer or keypair. Run this from the checkout/build that produced
# the artifact, or set PPV_GIT_COMMIT to the exact release commit when
# recovering evidence for an already-finalized deployment.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cluster="${PPV_CLUSTER:-devnet}"
rpc_url="${PPV_RPC_URL:-https://api.${cluster}.solana.com}"
program="${PPV_PROGRAM:?set PPV_PROGRAM to ppv_core or ppv_commerce}"
signature="${PPV_DEPLOY_SIGNATURE:?set PPV_DEPLOY_SIGNATURE to the deploy transaction signature}"
members="${PPV_UPGRADE_AUTHORITY_MEMBERS:?set PPV_UPGRADE_AUTHORITY_MEMBERS to the Squads member public keys}"
threshold="${PPV_UPGRADE_AUTHORITY_THRESHOLD:?set PPV_UPGRADE_AUTHORITY_THRESHOLD to the Squads threshold}"
verifiable="${PPV_VERIFIABLE:-false}"
commit="${PPV_GIT_COMMIT:-$(git rev-parse HEAD)}"

case "${verifiable}" in
  true | false) ;;
  *) echo "PPV_VERIFIABLE must be true or false" >&2; exit 1 ;;
esac

case "${program}" in
  ppv_core | ppv_commerce) ;;
  *) echo "PPV_PROGRAM must be ppv_core or ppv_commerce" >&2; exit 1 ;;
esac

if ! [[ "${threshold}" =~ ^[0-9]+$ ]] || (( threshold < 2 )); then
  echo "PPV_UPGRADE_AUTHORITY_THRESHOLD is '${threshold}'; policy requires at least 2." >&2
  exit 1
fi

for value in "${signature}" "${members}" "${threshold}"; do
  if [[ "${value}" == *"["* ]] || [[ -f "${value}" ]]; then
    echo "Refusing to run: an argument looks like a keypair, not public data." >&2
    exit 1
  fi
done

manifest="deployments/${cluster}.json"
idl="target/idl/${program}.json"
binary="target/deploy/${program}.so"

for required in "${idl}" "${binary}"; do
  [[ -f "${required}" ]] || {
    echo "Missing ${required}. Build before recording a deployment." >&2
    exit 1
  }
done

program_id="$(node -e "process.stdout.write(require('./${idl}').address)")"

declare -A PERMANENT_IDS=(
  [ppv_core]="9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU"
  [ppv_commerce]="GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3"
)
if [[ "${program_id}" != "${PERMANENT_IDS[${program}]}" ]]; then
  echo "Built ${program} IDL names ${program_id}, permanent id is ${PERMANENT_IDS[${program}]}." >&2
  exit 1
fi

state="$(node scripts/query-solana-rpc.mjs program "${program_id}" "${rpc_url}")"
exists="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).exists))" "${state}")"
executable="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).executable))" "${state}")"
owner="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).owner || '')" "${state}")"
program_data="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).programDataAddress || '')" "${state}")"
authority="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).authority || '')" "${state}")"
slot="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).lastDeploySlot ?? ''))" "${state}")"

if [[ "${exists}" != "true" || "${executable}" != "true" || "${owner}" != "BPFLoaderUpgradeab1e11111111111111111111111" ]]; then
  echo "${program_id} is not an executable upgradeable-loader program." >&2
  exit 1
fi
if [[ -z "${program_data}" || -z "${authority}" || -z "${slot}" ]]; then
  echo "Could not resolve complete upgradeable-program metadata for ${program_id}." >&2
  exit 1
fi

signature_state="$(node scripts/query-solana-rpc.mjs signature "${signature}" "${rpc_url}")"
if [[ "${signature_state}" == "null" ]]; then
  echo "Deployment signature ${signature} was not found in transaction history." >&2
  exit 1
fi
signature_error="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).err))" "${signature_state}")"
if [[ "${signature_error}" != "null" ]]; then
  echo "Deployment signature ${signature} has on-chain error ${signature_error}." >&2
  exit 1
fi

genesis="$(node scripts/query-solana-rpc.mjs genesis unused "${rpc_url}")"
idl_hash="$(sha256sum "${idl}" | cut -d' ' -f1)"
binary_hash="$(sha256sum "${binary}" | cut -d' ' -f1)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Refusing to record ambiguous deployment evidence." >&2
  exit 1
fi

mkdir -p "$(dirname "${manifest}")"
[[ -f "${manifest}" ]] || printf '{\n  "cluster": "%s",\n  "genesisHash": "%s",\n  "deployments": [],\n  "smokeTests": []\n}\n' "${cluster}" "${genesis}" > "${manifest}"

MANIFEST="${manifest}" PROGRAM="${program}" PROGRAM_ID="${program_id}" \
PROGRAM_DATA="${program_data}" AUTHORITY="${authority}" SLOT="${slot}" \
GENESIS="${genesis}" SIGNATURE="${signature}" COMMIT="${commit}" \
IDL_HASH="${idl_hash}" BINARY_HASH="${binary_hash}" \
MEMBERS="${members}" THRESHOLD="${threshold}" VERIFIABLE="${verifiable}" \
node -e '
const fs = require("node:fs");
const env = process.env;
const manifest = JSON.parse(fs.readFileSync(env.MANIFEST, "utf8"));
if (manifest.genesisHash !== env.GENESIS) {
  throw new Error(`Genesis hash mismatch: manifest has ${manifest.genesisHash}, cluster reports ${env.GENESIS}.`);
}
manifest.deployments.push({
  program: env.PROGRAM,
  programId: env.PROGRAM_ID,
  programDataAddress: env.PROGRAM_DATA,
  upgradeAuthority: env.AUTHORITY,
  upgradeAuthorityKind: "squads-multisig",
  upgradeAuthorityMembers: env.MEMBERS.split(",").map((m) => m.trim()).filter(Boolean),
  upgradeAuthorityThreshold: Number(env.THRESHOLD),
  deployedSlot: Number(env.SLOT),
  deployedAt: new Date().toISOString(),
  deploymentSignature: env.SIGNATURE,
  gitCommit: env.COMMIT,
  toolchain: { anchor: "0.30.1", solana: "1.18.17", rustHost: "1.85.1", rustSbf: "1.75.0" },
  verifiable: env.VERIFIABLE === "true",
  idlAddress: env.PROGRAM_ID,
  idlHash: `sha256:${env.IDL_HASH}`,
  binaryHash: `sha256:${env.BINARY_HASH}`,
});
fs.writeFileSync(env.MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
'

echo "Recorded ${program} in ${manifest}:"
echo "  programId:   ${program_id}"
echo "  programData: ${program_data}"
echo "  authority:   ${authority}"
echo "  slot:        ${slot}"
