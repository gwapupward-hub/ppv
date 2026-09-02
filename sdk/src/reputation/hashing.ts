import { createHash } from "node:crypto";
import type { ReputationEventType, SourceProduct } from "./contracts.js";

/**
 * Deterministic identifiers. Every id is a pure function of the chain
 * coordinates it describes, so replaying the same transaction any number of
 * times yields the same event, the same receipts, and no duplicate reputation
 * input. Never derive an id from wall-clock time or a random value.
 */

const EVENT_DOMAIN = "ppv-reputation-event:v1";
const RECEIPT_DOMAIN = "ppv-receipt:v1";
const ID_HEX_LENGTH = 40;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export type ChainIdempotencyKey = {
  transactionSignature: string;
  instructionIndex: number;
  innerInstructionIndex: number | null;
};

/** The chain coordinates that make one emitted event unique. */
export function chainIdempotencyKey(key: ChainIdempotencyKey): string {
  return `${key.transactionSignature}:${key.instructionIndex}:${key.innerInstructionIndex ?? "-"}`;
}

export function chainEventId(key: ChainIdempotencyKey, eventType: ReputationEventType): string {
  const digest = sha256Hex(`${EVENT_DOMAIN}|chain|${chainIdempotencyKey(key)}|${eventType}`);
  return `evt_${digest.slice(0, ID_HEX_LENGTH)}`;
}

export type ProductIdempotencyKey = ChainIdempotencyKey & {
  eventType: ReputationEventType;
  sourceProduct: SourceProduct;
  sourceObjectId: string;
  deliverableId: string;
};

/**
 * A product-attested event has no transaction of its own. It borrows the chain
 * coordinates of the proof it references and extends them with the product
 * object, so the same submission registered twice collapses to one event.
 */
export function productEventId(key: ProductIdempotencyKey): string {
  const digest = sha256Hex(
    `${EVENT_DOMAIN}|product|${chainIdempotencyKey(key)}|${key.eventType}|${key.sourceProduct}|${key.sourceObjectId}|${key.deliverableId}`,
  );
  return `evt_${digest.slice(0, ID_HEX_LENGTH)}`;
}

export function receiptId(eventId: string, holderWallet: string, role: string): string {
  const digest = sha256Hex(`${RECEIPT_DOMAIN}|${eventId}|${holderWallet}|${role}`);
  return `rcpt_${digest.slice(0, ID_HEX_LENGTH)}`;
}

/** Anchor discriminators are the first 8 bytes of sha256 over a namespaced name. */
export function anchorDiscriminator(namespace: "event" | "account" | "global", name: string): Uint8Array {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}
