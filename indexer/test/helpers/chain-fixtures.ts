import {
  encodeBase58,
  type EscrowAgreementOpenedEvent,
  type PpvEscrowEvent,
} from "@gwap/ppv-sdk";

import { deriveEventAuthority } from "../../src/events.js";
import type { ChainSource, RpcSignatureEntry, RpcTransaction, SignaturePage } from "../../src/rpc.js";

// The SDK's own borsh encoder for escrow events, reused so the fixtures cannot
// drift from the layout the decoder is tested against.
export {
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  addressFromByte,
  encodeEscrowEvent,
} from "../../../sdk/test/helpers/escrow-events.js";
import { LIFECYCLE_FIXTURE, addressFromByte, encodeEscrowEvent } from "../../../sdk/test/helpers/escrow-events.js";

/**
 * The opening event, narrowed out of the lifecycle union so a fixture can vary
 * the fields only that event has.
 */
export const OPENED_EVENT: EscrowAgreementOpenedEvent = (() => {
  const event = LIFECYCLE_FIXTURE[0];
  if (event?.name !== "AgreementOpened") throw new Error("fixture order changed");
  return event;
})();

export const PROGRAM_ID = addressFromByte(9);
export const EVENT_AUTHORITY = deriveEventAuthority(PROGRAM_ID);
export const PAYER = addressFromByte(20);
export const OTHER_PROGRAM = addressFromByte(21);

export function signatureFor(index: number): string {
  return encodeBase58(new Uint8Array(64).fill(index));
}

export type TransactionFixture = {
  signature: string;
  slot: number;
  blockTime?: number | null;
  events?: PpvEscrowEvent[];
  /** A failed transaction: committed nothing, so it is not history. */
  err?: unknown;
  /** Put the program id and event authority behind an address lookup table. */
  viaLookupTable?: boolean;
  /** Emit the event data as a top-level instruction instead of an inner one. */
  topLevel?: boolean;
  /** Emit the event data with some other account in the authority slot. */
  withoutEventAuthority?: boolean;
  /** Attribute the inner instruction to a different program. */
  fromOtherProgram?: boolean;
  /** Extra inner instructions that are not events, e.g. a token CPI. */
  noise?: boolean;
};

export function transactionFor(fixture: TransactionFixture): RpcTransaction {
  const staticKeys = [PAYER, OTHER_PROGRAM];
  const loadedKeys: string[] = [];
  const place = (key: string) => {
    const existing = [...staticKeys, ...loadedKeys].indexOf(key);
    if (existing >= 0) return existing;
    if (fixture.viaLookupTable) {
      loadedKeys.push(key);
      return staticKeys.length + loadedKeys.length - 1;
    }
    staticKeys.push(key);
    return staticKeys.length - 1;
  };

  const programIndex = place(fixture.fromOtherProgram ? OTHER_PROGRAM : PROGRAM_ID);
  const authorityIndex = place(fixture.withoutEventAuthority ? PAYER : EVENT_AUTHORITY);
  const selfIndex = place(PROGRAM_ID);

  const eventInstructions = (fixture.events ?? []).map((event) => ({
    programIdIndex: programIndex,
    accounts: [authorityIndex, selfIndex],
    data: encodeBase58(encodeEscrowEvent(event)),
    stackHeight: 2,
  }));

  const inner = fixture.topLevel ? [] : eventInstructions;
  if (fixture.noise) {
    // A real transaction's inner instructions include the token CPI the
    // program made. It targets another program and carries data that is not an
    // event; both reasons must exclude it.
    inner.unshift({
      programIdIndex: place(OTHER_PROGRAM),
      accounts: [0, 1],
      data: encodeBase58(Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 0])),
      stackHeight: 2,
    });
  }

  return {
    slot: fixture.slot,
    blockTime: fixture.blockTime ?? 1_700_000_000 + fixture.slot,
    transaction: {
      signatures: [fixture.signature],
      message: {
        accountKeys: staticKeys,
        instructions: fixture.topLevel
          ? eventInstructions
          : [{ programIdIndex: selfIndex, accounts: [0], data: encodeBase58(Uint8Array.of(1)) }],
      },
    },
    meta: {
      err: fixture.err ?? null,
      innerInstructions: inner.length > 0 ? [{ index: 0, instructions: inner }] : [],
      ...(fixture.viaLookupTable ? { loadedAddresses: { writable: [], readonly: loadedKeys } } : {}),
    },
  };
}

/**
 * A chain that lives in a Map. It reproduces the two behaviours a replay has to
 * cope with: signatures come back newest-first, and they come back a page at a
 * time.
 */
export class InMemoryChainSource implements ChainSource {
  /** Transactions in the order they committed, oldest first. */
  private readonly ordered: RpcTransaction[] = [];
  private readonly byAddress = new Map<string, string[]>();
  public transactionCalls = 0;
  public signatureCalls = 0;

  add(tx: RpcTransaction, addresses: readonly string[]): this {
    this.ordered.push(tx);
    const signature = tx.transaction.signatures[0] as string;
    for (const address of addresses) {
      const bucket = this.byAddress.get(address);
      if (bucket) bucket.push(signature);
      else this.byAddress.set(address, [signature]);
    }
    return this;
  }

  async signaturesForAddress(address: string, page?: SignaturePage): Promise<RpcSignatureEntry[]> {
    this.signatureCalls += 1;
    const signatures = this.byAddress.get(address) ?? [];
    const entries: RpcSignatureEntry[] = signatures
      .map((signature) => {
        const tx = this.ordered.find((candidate) => candidate.transaction.signatures[0] === signature);
        return {
          signature,
          slot: tx?.slot ?? 0,
          err: tx?.meta?.err ?? null,
          blockTime: tx?.blockTime ?? null,
        };
      })
      .reverse();

    const start = page?.before
      ? entries.findIndex((entry) => entry.signature === page.before) + 1
      : 0;
    return entries.slice(start, start + (page?.limit ?? entries.length));
  }

  async transaction(signature: string): Promise<RpcTransaction | null> {
    this.transactionCalls += 1;
    return this.ordered.find((tx) => tx.transaction.signatures[0] === signature) ?? null;
  }
}
