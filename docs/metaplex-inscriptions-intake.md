# Metaplex Inscriptions — PPV Capability Intake

Status: **Research / future design intake — not implemented**

Source reviewed: https://www.metaplex.com/docs/smart-contracts/inscription

## Why this belongs in PPV

Metaplex Inscriptions can store arbitrary data directly in Solana accounts and can
optionally attach that data to an NFT mint. They also support associated inscription
accounts for additional data such as media.

That gives PPV a useful optional layer for **permanent public representations of
already-finalized protocol facts**:

- proof manifests,
- receipt manifests,
- credential manifests,
- rendered PPV stamp/card metadata,
- receipt/credential artwork or other public media,
- optional NFT-backed credential representations.

This does **not** change PPV's trust model.

> PPV programs, finalized transactions, accounts, events, deterministic receipts,
> and chain-derived credential state remain the source of truth. An inscription is
> a representation/archive of those facts, never an independent claim.

This keeps the existing rule from `credentials.md`: a card, stamp, PDF, NFT, or
inscription is a representation of the protocol record, not the credential itself.

## Metaplex capabilities relevant to PPV

The current Metaplex Inscription documentation describes two useful modes:

1. **Storage-provider inscription**
   - Stores arbitrary data directly on Solana.
   - Not inherently a tradable NFT.
   - Best candidate for PPV archival/public record use.

2. **Mint-linked inscription**
   - Attached to an NFT mint.
   - Appropriate when PPV intentionally creates an optional transferable digital
     representation.

Associated inscriptions can be derived from the primary inscription using an
association tag. This is a strong fit for keeping a compact PPV JSON manifest as the
primary inscription while attaching public artwork or other media separately.

Metaplex currently documents arbitrary inscription storage up to 10 MB. PPV should
still default to **small deterministic manifests**, not large evidence payloads.

## Proposed PPV use: Inscribed Verification Package

Working name:

`PPV Inscribed Verification Package v1`

An inscription should be created only from a PPV record whose chain state has already
been independently finalized and verified.

Example primary payload:

```json
{
  "schema": "ppv.inscription.v1",
  "network": "solana-devnet",
  "artifactType": "proof_credential",
  "source": {
    "programId": "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU",
    "transactionSignature": "<finalized transaction>",
    "proofAddress": "<core proof PDA>",
    "agreementAddress": "<optional bound commerce agreement>",
    "receiptId": "<deterministic PPV receipt id if applicable>"
  },
  "commitments": {
    "contentHash": "<32-byte hash>",
    "contextHash": "<32-byte hash>",
    "termsHash": "<optional commerce terms hash>"
  },
  "state": {
    "seal": "verified",
    "chainVerified": true,
    "slot": "<finalized slot>"
  },
  "identity": {
    "wallet": "<canonical wallet>",
    "gnsSnapshot": "<event-time .gwap name or null>"
  }
}
```

The exact schema must be versioned and frozen before implementation.

## Optional associated inscriptions

A primary PPV manifest could have associated inscriptions for public presentation
assets, for example:

- `image/png` — stamped credential card,
- `image/svg+xml` — PPV seal/stamp artwork,
- `application/pdf` — user-requested public certificate,
- `application/vnd.gwap.ppv+json` — expanded public verification metadata.

Association tags are presentation/storage identifiers only. They must never redefine
the PPV protocol state.

## Immutability rule

Metaplex inscriptions can have one or more update authorities. Their documentation
states that an inscription becomes immutable when no update authorities remain.

For any PPV artifact advertised as **permanent/final**, the intended lifecycle is:

```text
build bytes
  → verify source PPV chain state
  → initialize inscription
  → write complete bytes
  → re-fetch and hash/compare written bytes
  → remove every update authority
  → record inscription address in PPV application index
```

The authority-removal step is irreversible and must occur only after byte-for-byte
verification.

A mutable inscription must never be labeled permanent.

## Two PPV modes

### A. Archive inscription — preferred first implementation

Use Metaplex's storage-provider inscription mode.

Purpose:

- public proof/receipt/credential archive,
- no NFT required,
- no transfer semantics,
- simple external verification,
- preserves the distinction between protocol record and representation.

This should be the first prototype.

### B. Inscribed credential asset — later optional representation

If PPV's optional credential NFT path is activated later, the asset may use a
mint-linked inscription for its metadata and associated artwork.

Rules:

- minting remains optional,
- eligibility is derived server-side from chain facts,
- owning the asset does not create or transfer PPV reputation,
- transferring the asset does not transfer the underlying historical identity,
- the underlying PPV record remains independently verifiable without the NFT.

## Revocation and changing lifecycle state

Do **not** rewrite an immutable inscription when the underlying PPV state later
changes.

Example:

```text
ProofCreated → inscription A: seal=verified
ProofRevoked → inscription B: event=proof.revoked, references A + proof PDA
```

The current PPV state is still derived by replaying protocol events/accounts.

This preserves history instead of pretending a previously published representation
never existed.

For a product UI, the verifier should show the current chain-derived state first and
then show all related inscriptions as historical/public artifacts.

## Receipts

PPV receipts remain deterministic projections of chain events.

Inscriptions should **not** replace receipt derivation or add a second receipt ID.

Instead:

```text
PPV event
  → deterministic receiptId
  → optional inscription containing receiptId + source chain coordinates
```

An inscription address is an additional locator, not receipt identity.

## Privacy boundary

This is critical because inscription bytes are public on-chain data.

PPV must never inscribe by default:

- private evidence,
- private contracts,
- personal documents,
- secrets,
- wallet key material,
- access tokens,
- encrypted blobs that users may incorrectly assume can later be deleted,
- personally sensitive information merely because a user submitted it to PPV.

Default inscription payloads should contain only:

- public chain coordinates,
- hashes/commitments,
- deterministic receipt identifiers,
- explicitly public GNS presentation data,
- explicitly opted-in public artwork/metadata.

Any feature that allows user-provided bytes to be inscribed must have a separate
explicit public/permanent-data consent step.

## Cost / size policy

Metaplex inscriptions consume Solana account storage and therefore rent. Large media
can become materially more expensive than storing compact verification manifests.

PPV should:

1. calculate the expected inscription rent before signature,
2. display exact bytes and expected cost,
3. require explicit user approval,
4. default to compact JSON,
5. make media inscription separately optional,
6. never silently inscribe large source documents.

Cost constants must be queried or calculated by the current integration rather than
hard-coded as permanent economics.

## Security invariants

1. **Source-of-truth invariant** — an inscription cannot create a PPV fact.
2. **Finality invariant** — only finalized and independently verified chain state may
   be inscribed as verified.
3. **Identity invariant** — historical wallet/GNS binding comes from PPV's event-time
   identity rules, not the current owner of an inscription or NFT.
4. **Receipt invariant** — inscription address never replaces deterministic
   `receiptId`.
5. **Revocation invariant** — revocation changes PPV's current derived state; immutable
   historical inscriptions remain historical.
6. **Privacy invariant** — no private source material is inscribed without an explicit
   separate permanent-public-data action.
7. **Authority invariant** — an artifact called permanent must have no remaining
   inscription update authority.
8. **Custody invariant** — inscription support must not open or depend on PPV Escrow
   custody.
9. **Mainnet invariant** — prototype and acceptance work remains devnet-only until an
   independent release gate explicitly authorizes mainnet.

## Suggested implementation sequence

### Stage 0 — intake

This document only. No package, program, or wallet behavior changes.

### Stage 1 — devnet read-only research adapter

Add a small adapter that can:

- derive/fetch inscription metadata,
- fetch inscription bytes,
- inspect update authorities,
- verify an inscription's byte hash,
- map an inscription manifest back to PPV chain coordinates.

No writes.

### Stage 2 — devnet archive prototype

For an already-finalized PPV Core proof:

- build `ppv.inscription.v1`,
- estimate rent,
- require explicit wallet approval,
- initialize a storage-provider inscription,
- write bytes,
- re-fetch and verify exact bytes,
- remove update authority,
- verify immutability,
- display inscription alongside the proof.

Start with **one compact JSON inscription only**. No NFT and no media.

### Stage 3 — receipt + credential presentation

Allow eligible finalized receipts/credentials to create optional public inscriptions.
Add associated artwork only after the JSON archive path is proven.

### Stage 4 — optional mint-linked credential

Evaluate mint-linked inscriptions only as the representation layer for PPV's optional
credential asset.

This stage requires a separate decision on:

- asset standard,
- transferability / soulbound semantics,
- ownership versus historical identity,
- mint authority,
- revocation presentation,
- who pays inscription rent.

## Acceptance criteria for a first devnet prototype

A prototype is successful only if an independent verifier can start from the
inscription address and establish:

1. exact inscription bytes,
2. no remaining update authority for a final artifact,
3. referenced PPV program id,
4. referenced finalized transaction,
5. referenced proof/receipt/agreement account,
6. hashes matching PPV chain state,
7. event-time identity snapshot if included,
8. current PPV state independently from the inscription,
9. whether the inscription is historical because a later revocation/state transition
   occurred.

## Explicit non-goals

This intake does not:

- modify `ppv_core`, `ppv_commerce`, or `ppv_escrow`,
- add a new PPV program,
- activate NFT minting,
- activate mainnet,
- activate custody,
- replace PPV receipts,
- make inscriptions required for verification,
- turn ownership of an inscription/NFT into protocol reputation.

## Decision to preserve

**Use Metaplex Inscriptions as an optional permanent public packaging layer around
PPV facts, not as a new source of PPV truth.**

That architecture gives PPV the benefit of fully on-chain public artifacts while
keeping the protocol's existing event, receipt, identity, revocation, and security
models intact.
