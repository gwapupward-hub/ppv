#!/usr/bin/env bash
set -euo pipefail

# Records one deployed PPV program into deployments/<cluster>.json.
#
# Public data only. This script reads the chain and the build output; it never
# touches a keypair, and it refuses arguments that look like signing material.
#
#   PPV_PROGRAM=ppv_core \
#   PPV_DEPLOY_SIGNATURE=<base58 signature from the deploy> \
#   PPV_GOVERNANCE_PROGRAM_ID=<public ppv_governance program id> \
#   PPV_GOVERNANCE_MEMBER_PUBKEYS=<comma-separated member pubkeys> \
#   PPV_GOVERNANCE_THRESHOLD=2 \
#   ./scripts/record-deployment.sh
#
# PPV_VERIFIABLE defaults to false, matching the plain `anchor build` the devnet
# runbook uses. Set it to true only for an `anchor build --verifiable` artifact.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cluster="${PPV_CLUSTER:-devnet}"
rpc_url="${PPV_RPC_URL:-https://api.${cluster}.solana.com}"
program="${PPV_PROGRAM:?set PPV_PROGRAM to ppv_governance, ppv_core or ppv_commerce}"
signature="${PPV_DEPLOY_SIGNATURE:?set PPV_DEPLOY_SIGNATURE to the deploy transaction signature}"
governance_program_id="${PPV_GOVERNANCE_PROGRAM_ID:?set PPV_GOVERNANCE_PROGRAM_ID to the public ppv_governance program id}"
members="${PPV_GOVERNANCE_MEMBER_PUBKEYS:?set PPV_GOVERNANCE_MEMBER_PUBKEYS to governance member public keys}"
threshold="${PPV_GOVERNANCE_THRESHOLD:?set PPV_GOVERNANCE_THRESHOLD to the governance threshold}"
verifiable="${PPV_VERIFIABLE:-false}"

case "${verifiable}" in
  true | false) ;;
  *) echo "PPV_VERIFIABLE must be true or false" >&2; exit 1 ;;
esac

case "${program}" in
  ppv_governance | ppv_core | ppv_commerce) ;;
  *) echo "PPV_PROGRAM must be ppv_governance, ppv_core or ppv_commerce" >&2; exit 1 ;;
esac

# Refuse anything that looks like signing material rather than public metadata.
for value in "${signature}" "${governance_program_id}" "${members}" "${threshold}"; do
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

# `solana program show` is the authority for what is actually on chain.
show="$(solana program show "${program_id}" --url "${rpc_url}" --output json)"
program_data="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).programdataAddress)" "${show}")"
authority="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).authority)" "${show}")"
slot="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).lastDeploySlot))" "${show}")"

genesis="$(solana genesis-hash --url "${rpc_url}")"
idl_hash="$(sha256sum "${idl}" | cut -d' ' -f1)"
binary_hash="$(sha256sum "${binary}" | cut -d' ' -f1)"
commit="$(git rev-parse HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. gitCommit would not identify what was deployed." >&2
  exit 1
fi

[[ -f "${manifest}" ]] || printf '{\n  "cluster": "%s",\n  "genesisHash": "%s",\n  "deployments": [],\n  "smokeTests": []\n}\n' "${cluster}" "${genesis}" > "${manifest}"

MANIFEST="${manifest}" PROGRAM="${program}" PROGRAM_ID="${program_id}" \
PROGRAM_DATA="${program_data}" AUTHORITY="${authority}" SLOT="${slot}" \
GENESIS="${genesis}" SIGNATURE="${signature}" COMMIT="${commit}" \
IDL_HASH="${idl_hash}" BINARY_HASH="${binary_hash}" \
GOVERNANCE_PROGRAM_ID="${governance_program_id}" MEMBERS="${members}" \
THRESHOLD="${threshold}" VERIFIABLE="${verifiable}" \
node -e '
const fs = require("node:fs");
const env = process.env;
const manifest = JSON.parse(fs.readFileSync(env.MANIFEST, "utf8"));

if (manifest.genesisHash !== env.GENESIS) {
  throw new Error(
    `Genesis hash mismatch: manifest has ${manifest.genesisHash}, cluster reports ${env.GENESIS}. ` +
    "You are pointed at a different cluster than the manifest records.",
  );
}

// Append-only. A redeploy adds an entry; it never edits or removes one, because
// past entries are how a past binary is identified and restored.
manifest.deployments.push({
  program: env.PROGRAM,
  programId: env.PROGRAM_ID,
  programDataAddress: env.PROGRAM_DATA,
  upgradeAuthority: env.AUTHORITY,
  upgradeAuthorityKind: "ppv-native-governance",
  governanceProgramId: env.GOVERNANCE_PROGRAM_ID,
  upgradeAuthorityMembers: env.MEMBERS.split(",").map((m) => m.trim()).filter(Boolean),
  upgradeAuthorityThreshold: Number(env.THRESHOLD),
  deployedSlot: Number(env.SLOT),
  deployedAt: new Date().toISOString(),
  deploymentSignature: env.SIGNATURE,
  gitCommit: env.COMMIT,
  toolchain: { anchor: "0.30.1", solana: "1.18.17", rustHost: "1.85.1", rustSbf: "1.75.0" },
  verifiable: env.VERIFIABLE === "true",
  idlHash: `sha256:${env.IDL_HASH}`,
  binaryHash: `sha256:${env.BINARY_HASH}`,
});

fs.writeFileSync(env.MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
'

echo "Recorded ${program} in ${manifest}:"
echo "  programId:   ${program_id}"
echo "  programData: ${program_data}"
echo "  authority:   ${authority}"
echo "  governance:  ${governance_program_id}"
echo "  slot:        ${slot}"
echo
echo "Confirm the authority above is the canonical PPV governance vault PDA, then commit ${manifest}."
