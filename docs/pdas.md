# PPV Address Derivation

Every PPV account address is a pure function of the program id and a small set
of public inputs. Nothing is random, nothing is assigned by a database, and
anyone with the program id can derive every address a party occupies.

## Why the program id is architecture

```text
PPV Program ID
      │
      ▼
Deterministic PDA namespace
      │
      ├── agreements
      ├── vault authorities
      ├── vaults
      └── (proofs, milestones, receipts — later phases)
```

Changing a program id does not migrate anything. It creates a second, empty
universe with different addresses for the same logical agreements, and every
client derivation, CPI integration, and indexer follows it there. Program ids
are therefore treated as permanent protocol identity, generated once from
controlled keypairs and recorded in a deployment manifest — never as a
deployment artifact regenerated per environment.

## ppv_escrow

| Account | Seeds | Notes |
| --- | --- | --- |
| Agreement | `["agreement", creator, agreement_id_le_u64]` | Creator in the seeds: the same number under a different creator is a different agreement. |
| Vault authority | `["vault", agreement]` | One authority per agreement. No global authority exists to compromise. |
| Vault (token account) | `["vault_token", agreement]` | Owned by the vault authority, fixed to the agreement's mint at creation. |
| Proof | `["proof", agreement, proof_index_le_u32]` | The index is the agreement's own counter, not a client's choice. |
| Milestone | `["milestone", agreement, milestone_index_le_u32]` | Likewise counter-assigned; the schedule is dense and ordered. |

`agreement_id` is a `u64` chosen by the creator and encoded little-endian, the
same bytes the program seeds with.

Because both custody accounts derive from the agreement address, and the
agreement address derives from the creator, an agreement's funds are reachable
only through that agreement's own account. Substituting another agreement's
vault or vault authority fails the seeds constraint before any token moves.

## ppv_core and ppv_commerce

| Account | Seeds |
| --- | --- |
| ProofRecord | `["proof", authority, proof_id]` |
| Agreement (negotiation) | `["agreement", party_a, agreement_id]` |

Both programs also use a `"proof"` seed prefix, for different objects:
`ppv_core` anchors a standalone wallet proof under `["proof", authority,
proof_id]`, while `ppv_escrow` anchors agreement-bound evidence under
`["proof", agreement, index]`. They cannot collide — different programs, and
different second seeds — and they answer different questions: "this wallet
committed to these bytes" versus "this evidence belongs to this agreement".

`ppv_commerce` and `ppv_escrow` both use an `"agreement"` seed prefix. They do
not collide: the program id is part of every derivation, and the two programs
have different ids. They are different objects — a negotiated document versus a
funded custody agreement — that a later phase may reference to each other, but
neither derives the other's address.

## Deriving addresses off-chain

`@gwap/ppv-sdk` derives all of these without a runtime dependency:

```ts
import { deriveAgreementAddresses } from "@gwap/ppv-sdk";

const { agreement, vaultAuthority, vault } = deriveAgreementAddresses(
  programId,
  creator,
  42n,
);
```

The SDK implements `find_program_address` in full, including the ed25519
on-curve rejection that makes a PDA a PDA. `sdk/test/escrow-pdas.test.ts`
cross-checks every derivation against `@solana/web3.js` as a test-only oracle,
so the dependency-free implementation is a verified equivalent rather than a
hopeful one.
