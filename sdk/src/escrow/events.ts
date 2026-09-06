import { anchorDiscriminator } from "../reputation/hashing.js";
import { EVENT_IX_TAG } from "../reputation/chain-events.js";
import { BorshReader, bytesEqual } from "./reader.js";
import type { AgreementState, AgreementType } from "./states.js";

/**
 * Decoder for the events `ppv_escrow` emits through Anchor's event CPI.
 * Layouts mirror `programs/ppv_escrow/src/events/` field by field, and the Rust
 * crate pins the same discriminators and byte offsets in its unit tests.
 *
 * An event CPI is an inner instruction to the emitting program whose data is:
 *   [8 bytes event-instruction tag][8 bytes event discriminator][borsh fields]
 *
 * Event identity is the pair (program id, discriminator), never the
 * discriminator alone. `ppv_commerce` also emits an `AgreementCreated` — a
 * different fact with a different layout — and the two share a discriminator
 * because Anchor derives it from the name. That is why this decoder is a
 * separate entry point rather than more cases in the shared one: an indexer
 * must select the decoder by the program id the inner instruction targeted.
 */

export const PPV_ESCROW_EVENT_NAMES = [
  "AgreementCreated",
  "AgreementFunded",
  "WorkCompleted",
  "SettlementExecuted",
] as const;
export type PpvEscrowEventName = (typeof PPV_ESCROW_EVENT_NAMES)[number];

type Base = { program: "ppv_escrow"; agreement: string; timestamp: number };

export type EscrowAgreementCreatedEvent = Base & {
  name: "AgreementCreated";
  agreementId: bigint;
  creator: string;
  counterparty: string;
  agreementType: AgreementType;
  mint: string;
  vault: string;
  amount: bigint;
  termsHash: string;
  newState: AgreementState;
};

export type EscrowAgreementFundedEvent = Base & {
  name: "AgreementFunded";
  creator: string;
  counterparty: string;
  amount: bigint;
  mint: string;
  vault: string;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowWorkCompletedEvent = Base & {
  name: "WorkCompleted";
  creator: string;
  counterparty: string;
  actor: string;
  previousState: AgreementState;
  newState: AgreementState;
};

export type EscrowSettlementExecutedEvent = Base & {
  name: "SettlementExecuted";
  buyer: string;
  seller: string;
  amount: bigint;
  mint: string;
  destination: string;
  /** Always null in the kernel; the proof vault arrives in Phase 3. */
  proof: string | null;
  previousState: AgreementState;
  newState: AgreementState;
};

export type PpvEscrowEvent =
  | EscrowAgreementCreatedEvent
  | EscrowAgreementFundedEvent
  | EscrowWorkCompletedEvent
  | EscrowSettlementExecutedEvent;

export function escrowEventDiscriminatorHex(name: PpvEscrowEventName): string {
  return Buffer.from(anchorDiscriminator("event", name)).toString("hex");
}

const DISCRIMINATORS: ReadonlyArray<{ name: PpvEscrowEventName; bytes: Uint8Array }> =
  PPV_ESCROW_EVENT_NAMES.map((name) => ({ name, bytes: anchorDiscriminator("event", name) }));

/**
 * Decodes the data of one inner instruction that targeted the `ppv_escrow`
 * program. Returns null when the data is not a PPV escrow event, and throws
 * when it claims to be one but is malformed, so an indexer can tell "not ours"
 * from "corrupt".
 */
export function decodeEscrowEventData(data: Uint8Array): PpvEscrowEvent | null {
  if (data.length < 16 || !bytesEqual(data.subarray(0, 8), EVENT_IX_TAG)) return null;
  const discriminator = data.subarray(8, 16);
  const match = DISCRIMINATORS.find((entry) => bytesEqual(entry.bytes, discriminator));
  if (!match) return null;

  const reader = new BorshReader(data.subarray(16));
  let event: PpvEscrowEvent;
  switch (match.name) {
    case "AgreementCreated":
      event = {
        program: "ppv_escrow",
        name: "AgreementCreated",
        agreement: reader.pubkey(),
        agreementId: reader.u64(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        agreementType: reader.agreementType(),
        mint: reader.pubkey(),
        vault: reader.pubkey(),
        amount: reader.u64(),
        termsHash: reader.hex(32),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "AgreementFunded":
      event = {
        program: "ppv_escrow",
        name: "AgreementFunded",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        amount: reader.u64(),
        mint: reader.pubkey(),
        vault: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "WorkCompleted":
      event = {
        program: "ppv_escrow",
        name: "WorkCompleted",
        agreement: reader.pubkey(),
        creator: reader.pubkey(),
        counterparty: reader.pubkey(),
        actor: reader.pubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
    case "SettlementExecuted":
      event = {
        program: "ppv_escrow",
        name: "SettlementExecuted",
        agreement: reader.pubkey(),
        buyer: reader.pubkey(),
        seller: reader.pubkey(),
        amount: reader.u64(),
        mint: reader.pubkey(),
        destination: reader.pubkey(),
        proof: reader.optionalPubkey(),
        previousState: reader.state(),
        newState: reader.state(),
        timestamp: reader.i64(),
      };
      break;
  }
  if (reader.remaining !== 0) throw new RangeError("event data has trailing bytes");
  return event;
}
