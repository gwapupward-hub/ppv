# PPV Protocol Events

An application must be able to reconstruct PPV history from chain data alone.
Events are the interface that makes that possible, so they are versioned,
normalized, and tested like any other protocol surface.

## Delivery

Every PPV program emits through Anchor's event CPI (`emit_cpi!`). The event is
an inner instruction targeting the emitting program, with data laid out as:

```text
[8 bytes event-ix tag][8 bytes event discriminator][borsh fields]
```

An event CPI survives log truncation, which a plain `emit!` does not, and it
carries the emitting program id in the inner instruction itself.

## Event identity is (program id, discriminator)

Anchor derives an event discriminator from the event *name* alone. `ppv_commerce`
and `ppv_escrow` both emit an `AgreementCreated` — a negotiated document versus a
funded custody agreement — and the two discriminators are byte-identical.

An indexer must therefore select its decoder by the program the inner
instruction targeted. The SDK exposes exactly that:

```ts
import { decodeEventForProgram } from "@gwap/ppv-sdk";

const decoded = decodeEventForProgram("ppv_escrow", innerInstructionData);
```

Decoding escrow bytes as a commerce event throws rather than returning a
plausible-looking event, and both facts are pinned by tests on the Rust and
TypeScript sides.

## ppv_escrow events

All four carry the agreement address, both parties, and the exact state
transition committed.

| Event | Emitted by | Transition |
| --- | --- | --- |
| `AgreementCreated` | `initialize_agreement` | → `Open` |
| `AgreementFunded` | `fund` | `Open` → `Funded` |
| `WorkCompleted` | `mark_completed` | `Funded` → `Completed` |
| `SettlementExecuted` | `settle` | `Completed` → `Settled` |
| `ProofSubmitted` | `submit_proof` | none — reports the state it saw |

```rust
#[event]
pub struct SettlementExecuted {
    pub agreement: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub destination: Pubkey,
    pub proof: Option<Pubkey>,
    pub previous_state: AgreementState,
    pub new_state: AgreementState,
    pub timestamp: i64,
}
```

`proof` is always `None` today. It is present from the first release so that
Phase 3 can populate it without moving a byte for existing consumers.

## Reading events back

Decoding bytes is not the same as accepting history. An indexer must also
establish that the bytes came from a committed transaction, from an inner
instruction rather than a submitted one, and with the program's event authority
present. Those three rules, and the versioned-transaction account ordering that
trips up a naive reader, are in [indexing.md](indexing.md).

## Design rules

1. **Facts, never judgements.** `SettlementExecuted`, not `SellerWasReliable`.
   PPV records what happened; GwapScore decides what it means. An event never
   contains a score, a rating, or a label like `good_user`.
2. **Self-contained.** Every event names both parties and the mint, so a
   stateless consumer can attribute it without reading the account. Webhook
   delivery is at-least-once and unordered; a consumer that must fetch state to
   understand an event is a consumer that breaks under replay.
3. **Both sides of the transition.** `previous_state` and `new_state` let a
   consumer verify that the history it holds chains, rather than trusting the
   order in which events arrived.
4. **No UI vocabulary.** Field names are protocol terms. A rename to match a
   screen is a breaking change to every integrator.
5. **Emitted last.** The event is the final statement of an instruction, after
   the CPI and after the state write. An event therefore cannot describe a
   transfer that did not happen — a failed transaction commits nothing.

## Adding an event

Appending a field to an existing event breaks every decoder; adding a new event
does not. New facts get new events. When a field genuinely must be added, it
gets a new event name and the old one keeps its layout until consumers migrate.

## Later phases

`ProofApproved`, `ProofRejected`, `MilestoneCreated`,
`MilestoneFunded`, `MilestoneSubmitted`, `MilestoneApproved`, `DisputeOpened`,
`DisputeResolved`, `RefundExecuted`, `AgreementCancelled`, `InvoiceCreated`, and
`InvoicePaid` arrive with the instructions that emit them. Each is added to the
SDK decoder and the reputation contracts in the same change as the instruction,
never ahead of it.
