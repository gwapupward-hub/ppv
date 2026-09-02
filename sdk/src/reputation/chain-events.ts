import { encodeBase58 } from "./base58.js";
import { anchorDiscriminator } from "./hashing.js";

/**
 * Decoder for the events `ppv_core` and `ppv_commerce` emit through Anchor's
 * event CPI (`emit_cpi!`). Layouts mirror `programs/<program>/src/events.rs` field by
 * field; the Rust crates pin the same discriminators in their unit tests so a
 * drift between the two shows up in CI on either side.
 *
 * An event CPI is an inner instruction to the emitting program whose data is:
 *   [8 bytes event-instruction tag][8 bytes event discriminator][borsh fields]
 */

/** `anchor_lang::event::EVENT_IX_TAG_LE` — sha256("anchor:event")[..8]. */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const PROOF_KINDS = ["creation", "document", "agreement", "invoice", "deliverable", "other"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export type ProofCreatedEvent = {
  name: "ProofCreated";
  proof: string;
  authority: string;
  proofId: string;
  contentHash: string;
  contextHash: string;
  kind: ProofKind;
  createdAt: number;
};

export type ProofRevokedEvent = {
  name: "ProofRevoked";
  proof: string;
  authority: string;
  proofId: string;
  contentHash: string;
  kind: ProofKind;
  revokedAt: number;
};

export type AgreementCreatedEvent = {
  name: "AgreementCreated";
  agreement: string;
  agreementId: string;
  partyA: string;
  partyB: string;
  version: number;
  contentHash: string;
  termsHash: string;
  expiresAt: number;
  createdAt: number;
};

export type AgreementRevisedEvent = {
  name: "AgreementRevised";
  agreement: string;
  partyA: string;
  partyB: string;
  proposer: string;
  previousVersion: number;
  newVersion: number;
  contentHash: string;
  termsHash: string;
  signaturesCleared: boolean;
  revisedAt: number;
};

export type AgreementSignedEvent = {
  name: "AgreementSigned";
  agreement: string;
  partyA: string;
  partyB: string;
  signer: string;
  version: number;
  contentHash: string;
  termsHash: string;
  signedAt: number;
};

export type AgreementExecutedEvent = {
  name: "AgreementExecuted";
  agreement: string;
  partyA: string;
  partyB: string;
  version: number;
  contentHash: string;
  termsHash: string;
  executedAt: number;
};

export type AgreementCancelledEvent = {
  name: "AgreementCancelled";
  agreement: string;
  partyA: string;
  partyB: string;
  cancelledBy: string;
  version: number;
  cancelledAt: number;
};

export type PpvChainEvent =
  | ProofCreatedEvent
  | ProofRevokedEvent
  | AgreementCreatedEvent
  | AgreementRevisedEvent
  | AgreementSignedEvent
  | AgreementExecutedEvent
  | AgreementCancelledEvent;

export type PpvChainEventName = PpvChainEvent["name"];

export const PPV_CORE_EVENT_NAMES = ["ProofCreated", "ProofRevoked"] as const;
export const PPV_COMMERCE_EVENT_NAMES = [
  "AgreementCreated",
  "AgreementRevised",
  "AgreementSigned",
  "AgreementExecuted",
  "AgreementCancelled",
] as const;

export const PPV_EVENT_NAMES = [...PPV_CORE_EVENT_NAMES, ...PPV_COMMERCE_EVENT_NAMES] as const;

export function eventDiscriminatorHex(name: PpvChainEventName): string {
  return Buffer.from(anchorDiscriminator("event", name)).toString("hex");
}

class BorshReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining() {
    return this.bytes.length - this.offset;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new RangeError("event data truncated");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  pubkey(): string {
    return encodeBase58(this.take(32));
  }

  hex(length: number): string {
    return Buffer.from(this.take(length)).toString("hex");
  }

  u8(): number {
    return this.take(1)[0] as number;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new RangeError("invalid bool");
    return value === 1;
  }

  u32(): number {
    const slice = this.take(4);
    return new DataView(slice.buffer, slice.byteOffset, 4).getUint32(0, true);
  }

  i64(): number {
    const slice = this.take(8);
    const value = new DataView(slice.buffer, slice.byteOffset, 8).getBigInt64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("i64 outside safe integer range");
    }
    return Number(value);
  }

  proofKind(): ProofKind {
    const index = this.u8();
    const kind = PROOF_KINDS[index];
    if (!kind) throw new RangeError("unknown proof kind");
    return kind;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const DISCRIMINATORS: ReadonlyArray<{ name: PpvChainEventName; bytes: Uint8Array }> = PPV_EVENT_NAMES.map(
  (name) => ({ name, bytes: anchorDiscriminator("event", name) }),
);

/**
 * Decodes the data of one inner instruction. Returns null when the data is not
 * a PPV event CPI, and throws when it claims to be one but is malformed, so an
 * indexer can distinguish "not ours" from "corrupt".
 */
export function decodePpvEventData(data: Uint8Array): PpvChainEvent | null {
  if (data.length < 16 || !bytesEqual(data.subarray(0, 8), EVENT_IX_TAG)) return null;
  const discriminator = data.subarray(8, 16);
  const match = DISCRIMINATORS.find((entry) => bytesEqual(entry.bytes, discriminator));
  if (!match) return null;

  const reader = new BorshReader(data.subarray(16));
  let event: PpvChainEvent;
  switch (match.name) {
    case "ProofCreated":
      event = {
        name: "ProofCreated",
        proof: reader.pubkey(),
        authority: reader.pubkey(),
        proofId: reader.hex(16),
        contentHash: reader.hex(32),
        contextHash: reader.hex(32),
        kind: reader.proofKind(),
        createdAt: reader.i64(),
      };
      break;
    case "ProofRevoked":
      event = {
        name: "ProofRevoked",
        proof: reader.pubkey(),
        authority: reader.pubkey(),
        proofId: reader.hex(16),
        contentHash: reader.hex(32),
        kind: reader.proofKind(),
        revokedAt: reader.i64(),
      };
      break;
    case "AgreementCreated":
      event = {
        name: "AgreementCreated",
        agreement: reader.pubkey(),
        agreementId: reader.hex(16),
        partyA: reader.pubkey(),
        partyB: reader.pubkey(),
        version: reader.u32(),
        contentHash: reader.hex(32),
        termsHash: reader.hex(32),
        expiresAt: reader.i64(),
        createdAt: reader.i64(),
      };
      break;
    case "AgreementRevised":
      event = {
        name: "AgreementRevised",
        agreement: reader.pubkey(),
        partyA: reader.pubkey(),
        partyB: reader.pubkey(),
        proposer: reader.pubkey(),
        previousVersion: reader.u32(),
        newVersion: reader.u32(),
        contentHash: reader.hex(32),
        termsHash: reader.hex(32),
        signaturesCleared: reader.bool(),
        revisedAt: reader.i64(),
      };
      break;
    case "AgreementSigned":
      event = {
        name: "AgreementSigned",
        agreement: reader.pubkey(),
        partyA: reader.pubkey(),
        partyB: reader.pubkey(),
        signer: reader.pubkey(),
        version: reader.u32(),
        contentHash: reader.hex(32),
        termsHash: reader.hex(32),
        signedAt: reader.i64(),
      };
      break;
    case "AgreementExecuted":
      event = {
        name: "AgreementExecuted",
        agreement: reader.pubkey(),
        partyA: reader.pubkey(),
        partyB: reader.pubkey(),
        version: reader.u32(),
        contentHash: reader.hex(32),
        termsHash: reader.hex(32),
        executedAt: reader.i64(),
      };
      break;
    case "AgreementCancelled":
      event = {
        name: "AgreementCancelled",
        agreement: reader.pubkey(),
        partyA: reader.pubkey(),
        partyB: reader.pubkey(),
        cancelledBy: reader.pubkey(),
        version: reader.u32(),
        cancelledAt: reader.i64(),
      };
      break;
  }
  if (reader.remaining !== 0) throw new RangeError("event data has trailing bytes");
  return event;
}

/**
 * Whether an event name belongs to `ppv_core` or `ppv_commerce`. An indexer
 * uses this to refuse an event that arrives under the wrong program id.
 */
export function programForEvent(name: PpvChainEventName): "ppv_core" | "ppv_commerce" {
  return (PPV_CORE_EVENT_NAMES as readonly string[]).includes(name) ? "ppv_core" : "ppv_commerce";
}
