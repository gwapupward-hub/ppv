# Deployment manifests

The canonical, load-bearing record of a release is the per-program JSON file in
[`evidence/`](evidence/README.md). This manifest is the per-cluster log that sits
alongside it: one entry per deployment, append-only, so a past binary can still
be identified and restored years later. Both are written from the chain by
read-only, signer-free tooling.

Each cluster PPV is deployed to gets one manifest file in this directory —
`devnet.json` for devnet. A manifest is the public, auditable record of what was
deployed, from which source, by which authority.

`devnet.json` does not exist until a controlled devnet deployment has actually
happened. An absent manifest means PPV is not deployed to that cluster; it never
means "deployed but undocumented".

## Rules

- **Public only.** A manifest records public keys, addresses, hashes, slots, and
  transaction signatures. It must never contain a private key, a seed phrase, an
  RPC URL with an embedded API key, or any other credential.
- **Append-only.** A redeploy appends a new entry to `deployments[]`. Past
  entries are never edited or removed — they are how a past binary is
  identified and restored.
- **One entry per program per deployment.** Core and Commerce are independently
  deployable, so they get independent entries even when deployed together.
- **Reproducible.** `gitCommit`, the toolchain versions, and `binaryHash` must
  be sufficient to rebuild the exact artifact that was deployed.
- **Honest about the build.** `verifiable` records whether the artifact came
  from `anchor build --verifiable`. Devnet deploys a plain `anchor build`, so it
  is `false` there: anyone with the pinned toolchain can still rebuild
  `gitCommit` and compare `binaryHash`, but a third party cannot reproduce the
  artifact from a container digest alone. Recording it is the point — a manifest
  must never imply a stronger guarantee than the build actually made.

## Schema

```jsonc
{
  "cluster": "devnet",
  "genesisHash": "<cluster genesis hash>",
  "deployments": [
    {
      "program": "ppv_core",                  // or "ppv_commerce"
      "programId": "<base58 program address>",
      "programDataAddress": "<base58 ProgramData account>",
      "upgradeAuthority": "<Squads V4 vault PDA — never a member key>",
      "upgradeAuthorityMembers": ["<base58 member public key>", "..."],
      "upgradeAuthorityThreshold": 2,
      "upgradeAuthorityKind": "squads-multisig",  // Squads V4 vault PDA
      "deployedSlot": 0,
      "deployedAt": "<UTC ISO-8601 timestamp>",
      "deploymentSignature": "<base58 transaction signature>",
      "gitCommit": "<full 40-char commit SHA the artifact was built from>",
      "toolchain": {
        "anchor": "0.30.1",
        "solana": "1.18.17",
        "rustHost": "1.85.1",
        "rustSbf": "1.75.0"
      },
      "verifiable": false,                    // true only for `anchor build --verifiable`
      "idlHash": "sha256:<hex of target/idl/<program>.json>",
      "binaryHash": "sha256:<hex of target/deploy/<program>.so>"
    }
  ],
  "smokeTests": [
    {
      "program": "ppv_core",
      "instruction": "create_proof",
      "signature": "<base58 transaction signature>",
      "note": "non-sensitive test data only"
    }
  ]
}
```

## Producing the hashes

```bash
sha256sum target/idl/ppv_core.json target/idl/ppv_commerce.json
sha256sum target/deploy/ppv_core.so target/deploy/ppv_commerce.so
```

Take the hashes from the same build that produced the deployed artifact, before
that artifact is uploaded. Rebuilding later from `gitCommit` with the pinned
toolchain must reproduce the same `binaryHash`.

## Verifying a manifest entry

```bash
./scripts/verify-deployment.sh
PPV_VERIFY_RPC_URL=https://<second-provider> ./scripts/verify-deployment.sh
```

Every live entry is checked against the chain: the program exists, is
executable, is owned by the BPF upgradeable loader, resolves to the recorded
ProgramData, is held by the recorded upgrade authority, and its deployment
signature is in transaction history without an error.

The reads are raw JSON-RPC. Not the Solana CLI — it expects a configured default
signer even for read-only commands, so building verification on it quietly
requires the ability to sign in order to look, which defeats the purpose of a
manifest anyone can check. Repeat the check against a second, independent RPC
provider: a manifest verified only through the node that served the deployment
is not independently verified.

See `docs/devnet-deployment.md` for the full deployment and rollback procedure.
