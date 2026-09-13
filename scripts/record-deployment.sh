#!/usr/bin/env bash
set -euo pipefail

# Records one deployed program into deployments/<cluster>.json.
#
# Public data only. This script reads the chain and the build output; it never
# touches a keypair, and it refuses to run if you hand it a path to one. Chain
# reads go through JSON-RPC rather than the Solana CLI, because the CLI wants a
# configured default signer even for read-only commands — which is exactly what
# failed on the runner that deployed PPV Core, after the deployment itself had
# already succeeded.
#
# Run it once per program, immediately after `solana program deploy`, from the
# same checkout and build output that produced the artifact.
#
#   PPV_PROGRAM=ppv_core \
#   PPV_DEPLOY_SIGNATURE=<base58 signature from the deploy> \
#   PPV_UPGRADE_AUTHORITY_MEMBERS=<comma-separated Squads member pubkeys> \
#   PPV_UPGRADE_AUTHORITY_THRESHOLD=2 \
#   ./scripts/record-deployment.sh
#
# PPV_VERIFIABLE defaults to false, matching the plain `anchor build` the devnet
# runbook uses. Set it to true only for an `anchor build --verifiable` artifact.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cluster="${PPV_CLUSTER:-devnet}"
rpc_url="${PPV_RPC_URL:-https://api.${cluster}.solana.com}"
program="${PPV_PROGRAM:?set PPV_PROGRAM to ppv_core or ppv_commerce}"
signature="${PPV_DEPLOY_SIGNATURE:?set PPV_DEPLOY_SIGNATURE to the deploy transaction signature}"
members="${PPV_UPGRADE_AUTHORITY_MEMBERS:?set PPV_UPGRADE_AUTHORITY_MEMBERS to the Squads member public keys}"
threshold="${PPV_UPGRADE_AUTHORITY_THRESHOLD:?set PPV_UPGRADE_AUTHORITY_THRESHOLD to the Squads threshold}"
# Devnet uses a plain `anchor build`. Set PPV_VERIFIABLE=true only when the
# artifact really came from `anchor build --verifiable`, so the manifest never
# claims a reproducibility property the build did not have.
verifiable="${PPV_VERIFIABLE:-false}"

case "${verifiable}" in
  true | false) ;;
  *) echo "PPV_VERIFIABLE must be true or false" >&2; exit 1 ;;
esac

case "${program}" in
  ppv_core | ppv_commerce) ;;
  *) echo "PPV_PROGRAM must be ppv_core or ppv_commerce" >&2; exit 1 ;;
esac

# Evidence must never claim a weaker authority than policy allows. A threshold
# of one is a single key that can replace the program.
if ! [[ "${threshold}" =~ ^[0-9]+$ ]] || (( threshold < 2 )); then
  echo "PPV_UPGRADE_AUTHORITY_THRESHOLD is '${threshold}'; policy requires at least 2." >&2
  exit 1
fi

# Refuse anything that looks like signing material rather than an address.
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

# The built artifact must name the permanent identity, or the manifest would
# record a deployment of something else under this program's name.
declare -A PERMANENT_IDS=(
  [ppv_core]="9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU"
  [ppv_commerce]="GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3"
)
if [[ "${program_id}" != "${PERMANENT_IDS[${program}]}" ]]; then
  echo "Built ${program} IDL names ${program_id}, permanent id is ${PERMANENT_IDS[${program}]}." >&2
  exit 1
fi

# The chain is the authority for what is actually deployed. Read it directly.
state="$(node scripts/query-chain.mjs program "${program_id}" "${rpc_url}")"
field() { node -e "process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]] ?? ''))" "${state}" "$1"; }
exists="$(field exists)"
executable="$(field executable)"
owner="$(field owner)"
program_data="$(field programDataAddress)"
authority="$(field upgradeAuthority)"
slot="$(field lastDeploySlot)"

# Recorded evidence must describe an executable program under the upgradeable
# loader. Anything else is not the thing this manifest claims it is.
if [[ "${exists}" != "true" || "${executable}" != "true" ]]; then
  echo "${program_id} is not an executable program account on ${cluster}." >&2
  exit 1
fi
if [[ "${owner}" != "BPFLoaderUpgradeab1e11111111111111111111111" ]]; then
  echo "${program_id} is owned by ${owner}, not the BPF upgradeable loader." >&2
  exit 1
fi
if [[ -z "${program_data}" || -z "${authority}" || -z "${slot}" ]]; then
  echo "Could not resolve complete upgradeable-program metadata for ${program_id}." >&2
  exit 1
fi

# The deployment signature is part of the evidence, so it is checked rather than
# copied down: a signature that is absent or failed does not identify a deploy.
signature_state="$(node scripts/query-chain.mjs signature "${signature}" "${rpc_url}")"
if [[ "${signature_state}" == "null" ]]; then
  echo "Deployment signature ${signature} is not in ${cluster} transaction history." >&2
  exit 1
fi
signature_error="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).err))" "${signature_state}")"
if [[ "${signature_error}" != "null" ]]; then
  echo "Deployment signature ${signature} is recorded with error ${signature_error}." >&2
  exit 1
fi

genesis="$(node scripts/query-chain.mjs genesis "${rpc_url}")"
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
MEMBERS="${members}" THRESHOLD="${threshold}" VERIFIABLE="${verifiable}" \
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
  upgradeAuthorityKind: "squads-multisig",
  upgradeAuthorityMembers: env.MEMBERS.split(",").map((m) => m.trim()).filter(Boolean),
  upgradeAuthorityThreshold: Number(env.THRESHOLD),
  deployedSlot: Number(env.SLOT),
  deployedAt: new Date().toISOString(),
  deploymentSignature: env.SIGNATURE,
  gitCommit: env.COMMIT,
  toolchain: { anchor: "0.30.1", solana: "1.18.17", rustHost: "1.85.1", rustSbf: "1.75.0" },
  // Devnet deploys a plain `anchor build`, not `anchor build --verifiable`, so
  // the artifact is not reproducible by a third party from a container digest
  // alone. Recorded rather than assumed: gitCommit plus binaryHash still pin
  // exactly what was deployed for anyone with the pinned toolchain.
  verifiable: env.VERIFIABLE === "true",
  // The address recorded inside the IDL itself, so evidence pins the interface
  // as well as the binary. (No apostrophes in this block: it is inside a
  // single-quoted node -e script.)
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
echo
echo "Confirm the authority above is the Squads vault PDA, then commit ${manifest}."
