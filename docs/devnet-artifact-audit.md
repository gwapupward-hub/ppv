# Audit: unrecognized devnet artifacts for `ppv_core`

Status: **decided — this repository is authoritative.** The devnet program
described below is not reproducible from any commit here, so it is treated as
unrecognized third-party bytecode that happens to carry the name `ppv_core`. It
is not adopted, not linked from any client, and not recorded as a PPV
deployment.

This document records what was checked and what was found. It is not a manifest.
`deployments/devnet.json` still does not exist, and per `deployments/README.md`
that continues to mean PPV is not deployed to devnet. The next devnet deployment
will be a controlled one from this repository, per `docs/devnet-deployment.md`,
with a Squads V4 vault as upgrade authority and a manifest entry.

Findings 3 through 6 are recorded as design evidence, not as a backlog: they
describe a program this repository does not ship, and several of them are
choices this repository already made differently. Findings 7 through 9 stand as
the reason the deployment is not adopted. Finding 1 is the one item that still
needed an action, and it has one — see below.

## What was audited

Four artifacts were supplied out of band, described as a successful devnet
deployment of `ppv_core`:

| Artifact | Content |
| --- | --- |
| `ppv_core.json` | Anchor IDL, address `9D2JUUB2vUTtfxSZNGzrUXk1AFmvvqSbxZiXWLBYaBHB` |
| `ppv_core.ts` | Generated TypeScript types for the same IDL |
| `ppv_core.so` | SBF artifact, 329,408 bytes |
| Deployment record | Markdown summary of cluster, authorities, slot, and hashes |

## The artifacts are internally consistent and genuine

- `sha256(ppv_core.so)` is `7f05be69b57fe3485a3369cf884b6ac5c33d665b68b2cd51a38a24ba3d4980e4`,
  matching the deployment record exactly.
- Every instruction, account, and event discriminator in the IDL reproduces the
  Anchor derivation — `sha256("global:<name>")`, `sha256("account:<Name>")`,
  `sha256("event:<Name>")`, first eight bytes. Nothing was hand-edited.
- The IDL and the generated TypeScript agree, modulo Anchor's camelCase pass.

So the artifacts describe a real Anchor program that was really built. The
problem is not authenticity.

## The deployed program is not this repository's program

The binary was built from a source tree that is not, and never has been, in this
repository.

- `ppv_core.so` carries the panic paths
  `programs/ppv_core/src/instructions/admin.rs`,
  `.../instructions/issuer.rs`, and `.../instructions/proof.rs`.
  This repository has no `instructions/` module.
- `git log --all -S IssuerRecord` and `-S 9D2JUUB2vUTt…` return no commits. The
  code and the address appear nowhere in this repository's history.
- The deployment record's "changed project files" table names
  `memory/error-catalog.md` and `memory/deploy-history.md`. Neither path exists
  here.
- The record reports the SDK suite as 9 assertions and the Anchor suite as 3
  tests. This repository's SDK suite is 10 subtests and its Anchor suite is 6
  tests.
- The record reports host Rust `1.79.0`. This repository pins host Rust
  `1.85.1` in `rust-toolchain.toml`, CI, and `docs/devnet-deployment.md`;
  `1.79.0` is used here only to compile the Anchor CLI, never a program.
- The record describes building with `anchor build --no-idl` plus a standalone
  host-side `anchor idl build`. The supported path here is `npm run test:f1`,
  which builds twice and asserts the two IDLs are byte-identical.

Consequently `gitCommit` cannot be filled in for this deployment from any commit
in this repository, and `binaryHash` cannot be reproduced from one. That fails
the **Reproducible** rule in `deployments/README.md` outright, which is why no
manifest entry has been written: a manifest that named a commit here would
assert provenance that does not exist.

## Interface divergence

`Anchor.toml` and both `declare_id!` calls carry the placeholder ids
`Dkujj5vZp8kxhqM6hQTqqV3sTQ4Rx7J77No4bfwjrfXp` (Core) and
`4Y83YzUZnJ5LF9M1PcKHtsYcQ1LRxedwDi93PVf5H1FJ` (Commerce). The audited artifact
is a third address. The two programs are not variants of each other:

| | This repository | Audited artifact |
| --- | --- | --- |
| Instructions | `create_proof`, `revoke_proof` | plus `initialize_core`, `set_paused`, `propose_admin`, `accept_admin`, `register_issuer`, `set_issuer_active` |
| Accounts | `ProofRecord` | `CoreConfig`, `IssuerRecord`, `ProofRecord` |
| Proof PDA seeds | `["proof", authority, proof_id]` | `["proof", proof_id]` |
| Second commitment | `context_hash` | `metadata_hash` |
| Proof kind | `ProofKind` enum | `u8` |
| Empty content hash | rejected (`InvalidContentHash`) | accepted |
| Governance | none | admin, two-step handover, pause, issuer registry |

## Findings against the audited program

Ordered by consequence. These are properties of the deployed binary, not of any
code in this repository.

### 1. `initialize_core` is unclaimed and permissionless — act on this first

`initialize_core` takes `admin` (signer, payer), the `config` PDA, and the
system program. It takes no arguments and constrains `admin` to nothing: no
`address`, no seed derivation, no relation to the upgrade authority. Whoever
lands the transaction is written into `CoreConfig.admin`.

The record states Core was left uninitialized on purpose. On a live, publicly
readable program that is not a neutral state — it is an open claim. Any devnet
account can call `initialize_core` and become admin, gaining `set_paused`,
`register_issuer`, `set_issuer_active`, and `propose_admin`. `CoreConfig` is
`init`, so the claim cannot be contested afterwards: a second call fails because
the account already exists, and there is no reset path. Recovering would mean a
program upgrade, which is why this is urgent rather than merely untidy.

Deciding whether to keep this deployment (see the closing section) does not need
to block claiming the admin seat, and holding the seat does not commit anyone to
keeping the program.

### 2. The deployment is otherwise inert

Every instruction except `initialize_core` and `revoke_proof` takes the `config`
PDA as an `Account<CoreConfig>`, so that account must already exist. Because it
does not, those instructions all fail on account deserialization. `revoke_proof`
does not read `config`, but it needs a `ProofRecord` that no one can create yet.

So the program is deployed but cannot serve a single proof. That limits the
blast radius of finding 1 to the admin seat itself — no proof or issuer state
exists to be tampered with — and it means nothing is lost by abandoning the
address if that is the decision.

### 3. Proof ids are a single global namespace — proofs can be squatted

`create_proof` derives the proof account from `["proof", proof_id]` alone.
`proof_id` is 16 client-chosen bytes and the instruction initializes the
account, so the first transaction to land for a given `proof_id` wins and
becomes `owner` permanently. Nothing binds the id to the wallet.

Any client that derives `proof_id` deterministically — from the document, from
the content hash, from anything an observer can also compute — lets an observer
register that id first. The real author is then permanently unable to record
their proof, and the registry shows an attacker as the owner of that record.
Even with random ids, an id is a scarce global resource rather than a
per-wallet one.

This repository's `create_proof` namespaces by signer
(`["proof", authority, proof_id]`), so two wallets may hold the same `proof_id`
and neither can block the other. The integration test that covers it is named
"creates wallet-namespaced evidence" — the property is deliberate here, and the
audited program does not have it. A PDA layout cannot be changed without
abandoning every proof already recorded under it, so this has to be settled
before the program is put into service, not after.

### 4. The issuer registry gates nothing

`register_issuer` and `set_issuer_active` write `IssuerRecord`, but no other
instruction reads one — `create_proof` does not take an issuer account. The
registry is write-only metadata. It confers no authority and blocks no action,
while presenting a surface that reads as if issuers were privileged. Either
something must consume it or it should not ship.

### 5. `owner_gns` is caller-supplied and unverified

`create_proof` writes whatever `owner_gns` pubkey the caller passes, with no
check against any name service. The IDL documents it as "display context only
and never authorizes", which is the correct intent, but any consumer that
renders it as an identity will render an attacker-chosen one. It needs to be
treated as untrusted input at every read site.

### 6. An all-zero content hash is accepted

The audited error set has no equivalent of `InvalidContentHash`, so a proof
committing to 32 zero bytes is a valid proof. This repository rejects it
*before* allocating the account, and has a test for exactly that.

## Findings against the deployment process

### 7. The upgrade authority is a single key, not the required multisig

The record names `5QwqU6eBzuSsRAd4t7Q8tATSxBGahAyqxdEyYo52PxLe` as upgrade
authority, IDL authority, and deploy payer, held at
`~/.config/solana/ppv-devnet-admin.json`.

`docs/devnet-deployment.md` requires a **Squads V4 vault PDA** as upgrade
authority, and requires program and deployer keypairs to live in a cloud secret
manager, pulled back only for the duration of a build. One local file currently
holds the ability to replace the program bytecode *and* to replace the published
IDL, with no threshold and no second party. That is the single point of
compromise the runbook exists to prevent.

### 8. The on-chain IDL is unmanaged

The record documents an IDL account at
`2NCGp5XdWwAnsRpezEMjv4F1qfan582mY98p17tWbsEP` with the same authority. Nothing
in this repository's runbook covers publishing, rotating, or verifying an
on-chain IDL, and `scripts/verify-deployment.sh` does not check it. A consumer
that trusts the published IDL is trusting an authority the manifest does not
track.

### 9. No manifest, so nothing is independently verifiable

The record is prose. It carries no `genesisHash`, `deploymentSignature`,
`gitCommit`, `toolchain` block, `verifiable` flag, `idlHash`,
`upgradeAuthorityKind`, `upgradeAuthorityMembers`, or
`upgradeAuthorityThreshold`. `scripts/verify-deployment.sh` cannot read it, and
without a genesis hash the record does not even pin which devnet it describes.

### 10. `Anchor.toml` advertises a Commerce devnet address that was never deployed

`[programs.devnet].ppv_commerce` names a placeholder id. Only Core is described
as deployed. The table reads as a deployment record and is not one.

### 11. On-chain state could not be confirmed during this audit

`https://api.devnet.solana.com` is not reachable from the environment this audit
ran in (the egress proxy refuses the tunnel). Every on-chain claim above —
program account, ProgramData address, upgrade authority, IDL account, slot — is
taken from the supplied record and has **not** been independently read. Before
any of it is relied on, run the checks in `docs/devnet-deployment.md` against
two independent RPC providers.

## What must happen next

The unresolved question is which artifact is authoritative: the program this
repository builds, or the program on devnet. They are different programs and
only one can be `ppv_core`.

The question this audit opened — which artifact is authoritative — has been
answered: **this repository is.** Consequences:

- `Anchor.toml` and both `declare_id!` calls stay on their placeholder ids.
  Adopting `9D2JUUB2vUTt…` would state a provenance this repository cannot
  support, and no manifest entry can name a `gitCommit` that reproduces the
  artifact.
- The devnet program at `9D2JUUB2vUTt…` is **out of service**. Nothing in this
  repository, in the SDK, or in any GwapSpot surface should call it, link to
  it, or present it as PPV. It is not "the old deployment" — it is not a PPV
  deployment at all.
- Devnet gets a real deployment when one is run from this repository under
  `docs/devnet-deployment.md`: controlled program keypairs from the secret
  store, a Squads V4 vault PDA as upgrade authority, and a manifest entry
  written by `scripts/record-deployment.sh`.
- If the source behind the audited artifact turns up later, that changes
  nothing on its own. It would have to rebuild to `7f05be69…4980e4` under the
  pinned toolchain before any of it could be adopted, and findings 3 through 6
  would need answering first — finding 3 especially, because a PDA layout
  cannot be changed afterwards without abandoning every proof recorded under it.

### Finding 1 is still live

Abandoning the address does not close the admin seat. Until someone calls
`initialize_core`, anyone can, and whoever does holds it permanently. An
abandoned program with a known admin is strictly better than an abandoned
program with an unknown one, so the seat is worth claiming even though the
program is not worth keeping.

`scripts/claim-core-admin.ts` does exactly that and nothing else. It is a
deliberate operator action: it simulates by default, refuses to send without an
explicit confirmation variable, and is not wired into CI or any npm lifecycle
script. It signs with a keypair the operator names; nothing in this repository
holds one. See the script's header for usage.

Once the seat is claimed, record the holder here and treat any later change of
`CoreConfig.admin` as a security event.
