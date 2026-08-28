# Deployment manifests

Each cluster PPV is deployed to gets one manifest file in this directory —
`devnet.json` for devnet. A manifest is the public, auditable record of what was
deployed, from which source, and which on-chain authority controls upgrades.

`devnet.json` does not exist until a controlled devnet deployment has actually
happened. An absent manifest means PPV is not deployed to that cluster; it never
means "deployed but undocumented".

## Rules

- **Public only.** A manifest records public keys, addresses, hashes, slots, and
  transaction signatures. It must never contain private signing material.
- **Append-only.** A redeploy appends a new entry to `deployments[]`. Past
  entries are never edited or removed.
- **One entry per program per deployment.** Governance, Core and Commerce are
  independently deployable and receive independent entries.
- **Native governance.** Every PPV program's upgrade authority is the canonical
  vault PDA owned by `ppv_governance`. A member wallet is never a program upgrade
  authority.
- **Honest about the build.** `verifiable` records whether the artifact came
  from `anchor build --verifiable`. Devnet uses a plain `anchor build` and
  therefore records `false`.

## Schema

```jsonc
{
  "cluster": "devnet",
  "genesisHash": "<cluster genesis hash from `solana genesis-hash`>",
  "deployments": [
    {
      "program": "ppv_governance",            // or ppv_core / ppv_commerce
      "programId": "<base58 program address>",
      "programDataAddress": "<base58 ProgramData account>",
      "upgradeAuthority": "<canonical PPV governance vault PDA>",
      "upgradeAuthorityKind": "ppv-native-governance",
      "governanceProgramId": "<ppv_governance program id>",
      "upgradeAuthorityMembers": ["<member public key>", "..."],
      "upgradeAuthorityThreshold": 2,
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
      "verifiable": false,
      "idlHash": "sha256:<hex of target/idl/<program>.json>",
      "binaryHash": "sha256:<hex of target/deploy/<program>.so>"
    }
  ],
  "smokeTests": []
}
```

## Native authority derivation

The authority is not copied from a third-party dashboard. It is deterministic:

```text
Governance PDA = PDA(["governance"], ppv_governance_program_id)
Vault PDA      = PDA(["vault", Governance PDA], ppv_governance_program_id)
```

The deployment workflow derives those addresses from the committed
`ppv_governance` program ID and fetches the on-chain governance account. It
refuses the handoff unless the live member list, threshold, proposal delay,
proposal lifetime and treasury match the protected `devnet` environment.

## Producing hashes

```bash
sha256sum \
  target/idl/ppv_governance.json \
  target/idl/ppv_core.json \
  target/idl/ppv_commerce.json
sha256sum \
  target/deploy/ppv_governance.so \
  target/deploy/ppv_core.so \
  target/deploy/ppv_commerce.so
```

## Verifying a manifest entry

```bash
solana program show <programId> --url "$SOLANA_RPC_URL"
```

The reported ProgramData address and upgrade authority must equal the manifest.
For Core and Commerce, independently derive the expected vault PDA from the
recorded `governanceProgramId`; never trust a pasted authority address by itself.
Repeat verification through an independent RPC when available.

See `docs/devnet-deployment.md` for the controlled deployment procedure.
