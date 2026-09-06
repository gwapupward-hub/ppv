import { createHash } from "node:crypto";
import {
  AGREEMENT_STATES,
  AGREEMENT_TYPES,
  EVENT_IX_TAG,
  decodeBase58,
  encodeBase58,
  type AgreementState,
  type AgreementType,
  type PpvEscrowEvent,
} from "../../src/index.js";

/**
 * Test-side borsh encoder for `ppv_escrow` events. Layouts mirror
 * `programs/ppv_escrow/src/events/` and are pinned on the Rust side too, so a
 * drift shows up in CI on whichever side moved.
 */

export function addressFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(32).fill(byte));
}

export function hexFromByte(byte: number, length: number): string {
  return Buffer.alloc(length, byte).toString("hex");
}

export function signatureFromByte(byte: number): string {
  return encodeBase58(new Uint8Array(64).fill(byte));
}

function pubkey(value: string): Buffer {
  const bytes = decodeBase58(value);
  if (bytes.length !== 32) throw new Error(`not a 32-byte address: ${value}`);
  return Buffer.from(bytes);
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value));
  return out;
}

function state(value: AgreementState): Buffer {
  return Buffer.from([AGREEMENT_STATES.indexOf(value)]);
}

function agreementType(value: AgreementType): Buffer {
  return Buffer.from([AGREEMENT_TYPES.indexOf(value)]);
}

function optionalPubkey(value: string | null): Buffer {
  return value === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), pubkey(value)]);
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}

export function encodeEscrowEvent(event: PpvEscrowEvent): Uint8Array {
  let body: Buffer;
  switch (event.name) {
    case "AgreementCreated":
      body = Buffer.concat([
        pubkey(event.agreement),
        u64(event.agreementId),
        pubkey(event.creator),
        pubkey(event.counterparty),
        agreementType(event.agreementType),
        pubkey(event.mint),
        pubkey(event.vault),
        u64(event.amount),
        Buffer.from(event.termsHash, "hex"),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "AgreementFunded":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        u64(event.amount),
        pubkey(event.mint),
        pubkey(event.vault),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "WorkCompleted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.creator),
        pubkey(event.counterparty),
        pubkey(event.actor),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
    case "SettlementExecuted":
      body = Buffer.concat([
        pubkey(event.agreement),
        pubkey(event.buyer),
        pubkey(event.seller),
        u64(event.amount),
        pubkey(event.mint),
        pubkey(event.destination),
        optionalPubkey(event.proof),
        state(event.previousState),
        state(event.newState),
        i64(event.timestamp),
      ]);
      break;
  }
  return Uint8Array.from(Buffer.concat([Buffer.from(EVENT_IX_TAG), discriminator(event.name), body]));
}

const BUYER = addressFromByte(1);
const SELLER = addressFromByte(2);
const MINT = addressFromByte(3);
const VAULT = addressFromByte(4);
const AGREEMENT = addressFromByte(5);
const SELLER_ATA = addressFromByte(6);

/** One complete, well-formed lifecycle, shared by the event and receipt tests. */
export const LIFECYCLE_FIXTURE: readonly PpvEscrowEvent[] = [
  {
    program: "ppv_escrow",
    name: "AgreementCreated",
    agreement: AGREEMENT,
    agreementId: 42n,
    creator: BUYER,
    counterparty: SELLER,
    agreementType: "Escrow",
    mint: MINT,
    vault: VAULT,
    amount: 100_000_000n,
    termsHash: hexFromByte(7, 32),
    newState: "Open",
    timestamp: 1_700_000_000,
  },
  {
    program: "ppv_escrow",
    name: "AgreementFunded",
    agreement: AGREEMENT,
    creator: BUYER,
    counterparty: SELLER,
    amount: 100_000_000n,
    mint: MINT,
    vault: VAULT,
    previousState: "Open",
    newState: "Funded",
    timestamp: 1_700_000_100,
  },
  {
    program: "ppv_escrow",
    name: "WorkCompleted",
    agreement: AGREEMENT,
    creator: BUYER,
    counterparty: SELLER,
    actor: SELLER,
    previousState: "Funded",
    newState: "Completed",
    timestamp: 1_700_000_200,
  },
  {
    program: "ppv_escrow",
    name: "SettlementExecuted",
    agreement: AGREEMENT,
    buyer: BUYER,
    seller: SELLER,
    amount: 100_000_000n,
    mint: MINT,
    destination: SELLER_ATA,
    proof: null,
    previousState: "Completed",
    newState: "Settled",
    timestamp: 1_700_000_300,
  },
];

export const FIXTURE_ADDRESSES = { BUYER, SELLER, MINT, VAULT, AGREEMENT, SELLER_ATA };
