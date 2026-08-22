#!/usr/bin/env bash
set -euo pipefail

# These keys exist only inside the ignored target directory. They validate a
# clean build without putting deployable signing material in Git or CI logs.
mkdir -p target/deploy

for program in ppv_core ppv_commerce; do
  keypair="target/deploy/${program}-keypair.json"
  if [[ ! -f "${keypair}" ]]; then
    solana-keygen new \
      --silent \
      --no-bip39-passphrase \
      --outfile "${keypair}"
  fi
done

anchor keys sync
