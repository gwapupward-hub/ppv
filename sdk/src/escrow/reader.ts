import { encodeBase58 } from "../reputation/base58.js";
import { agreementStateFromIndex, agreementTypeFromIndex, type AgreementState, type AgreementType } from "./states.js";

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

  skip(length: number): void {
    this.take(length);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
