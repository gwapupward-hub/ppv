import { encodeBase58 } from "../reputation/base58.js";
import {
  agreementStateFromIndex,
  agreementTypeFromIndex,
  disputeOutcomeFromIndex,
  milestoneStateFromIndex,
  proofStatusFromIndex,
  type AgreementState,
  type AgreementType,
  type DisputeOutcome,
  type MilestoneState,
  type ProofStatus,
} from "./states.js";

/** Little-endian borsh reader shared by the escrow account and event decoders. */
export class BorshReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new RangeError("escrow data truncated");
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private view(length: number): DataView {
    const slice = this.take(length);
    return new DataView(slice.buffer, slice.byteOffset, length);
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

  /** Token amounts stay `bigint`: money must not round. */
  u64(): bigint {
    return this.view(8).getBigUint64(0, true);
  }

  i64(): number {
    const value = this.view(8).getBigInt64(0, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("i64 outside safe integer range");
    }
    return Number(value);
  }

  optionalPubkey(): string | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new RangeError("invalid Option tag");
    return this.pubkey();
  }

  state(): AgreementState {
    return agreementStateFromIndex(this.u8());
  }

  agreementType(): AgreementType {
    return agreementTypeFromIndex(this.u8());
  }

  proofStatus(): ProofStatus {
    return proofStatusFromIndex(this.u8());
  }

  disputeOutcome(): DisputeOutcome {
    return disputeOutcomeFromIndex(this.u8());
  }

  milestoneState(): MilestoneState {
    return milestoneStateFromIndex(this.u8());
  }

  u32(): number {
    return this.view(4).getUint32(0, true);
  }

  /**
   * The bytes not yet read. An Anchor account is allocated at its declared
   * size and written with borsh, so any `Option::None` in it serializes
   * shorter than the space reserved for it and leaves the tail unwritten.
   * A decoder has to be able to look at that tail rather than assume it is
   * empty.
   */
  rest(): Uint8Array {
    return this.bytes.subarray(this.offset);
  }

  skip(length: number): void {
    this.take(length);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Asserts that whatever follows the decoded fields is unwritten account space.
 *
 * Anchor allocates an account at its declared `INIT_SPACE` and then writes
 * borsh into it. Borsh encodes `Option::None` as a single tag byte, while
 * `INIT_SPACE` reserves room for the tag *and* the payload — so an account
 * holding a `None` is shorter on the wire than the space it occupies, and the
 * difference is never written. For `ppv_commerce`'s `Agreement` that is the
 * ordinary case: a pending agreement has at most one signature.
 *
 * Requiring nothing to remain would therefore reject every agreement that is
 * not fully signed. Requiring what remains to be zero keeps the property that
 * actually matters — that no unaccounted-for *content* follows the fields this
 * decoder knows, which is how a layout change gets noticed instead of
 * silently misread.
 */
export function assertOnlyUnwrittenSpaceRemains(reader: BorshReader, what: string): void {
  const tail = reader.rest();
  for (const byte of tail) {
    if (byte !== 0) throw new RangeError(`${what} has trailing bytes`);
  }
}
