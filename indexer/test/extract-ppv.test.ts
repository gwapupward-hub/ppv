import assert from "node:assert/strict";
import test from "node:test";

import { encodeBase58 } from "@gwap/ppv-sdk";

import { deriveEventAuthority, extractPpvEvents } from "../src/events.js";
import {
  COMMERCE_PROGRAM,
  CORE_PROGRAM,
  FIXTURES,
  encodePpvEvent,
  walletFromByte,
} from "../../sdk/test/helpers/ppv-events.js";
import type { RpcTransaction } from "../src/rpc.js";

/**
 * Attribution across two programs that share their event names.
 *
 * An Anchor event discriminator comes from the event name alone, so
 * `ppv_core` and `ppv_commerce` would produce identical bytes for any name they
 * both used. Event identity is therefore the pair (program id, discriminator),
 * and an extractor that reads the discriminator and stops is one rename away
 * from reporting a Commerce fact as a Core one. These tests exist to make that
 * confusion impossible to reintroduce, and they run without a validator so the
 * property is checked on every push rather than only in the integration suite.
 */

const PROGRAMS = { ppv_core: CORE_PROGRAM, ppv_commerce: COMMERCE_PROGRAM } as const;
const PAYER = walletFromByte(30);
const OTHER_PROGRAM = walletFromByte(31);

type Emission = { programId: string; event: Parameters<typeof encodePpvEvent>[0]; authority?: string };

/** A transaction whose inner instructions are the given event emissions. */
function transactionFor(
  emissions: Emission[],
  options: { signature?: string; slot?: number; err?: unknown; topLevel?: boolean } = {},
): RpcTransaction {
  const keys: string[] = [PAYER, OTHER_PROGRAM];
  const place = (key: string) => {
    const existing = keys.indexOf(key);
    if (existing >= 0) return existing;
    keys.push(key);
    return keys.length - 1;
  };

  const instructions = emissions.map((emission) => ({
    programIdIndex: place(emission.programId),
    accounts: [
      place(emission.authority ?? deriveEventAuthority(emission.programId)),
      place(emission.programId),
    ],
    data: encodeBase58(encodePpvEvent(emission.event)),
    stackHeight: 2,
  }));

  return {
    slot: options.slot ?? 700,
    blockTime: 1_700_000_000 + (options.slot ?? 700),
    transaction: {
      signatures: [options.signature ?? encodeBase58(new Uint8Array(64).fill(7))],
      message: {
        accountKeys: keys,
        instructions: options.topLevel
          ? instructions
          : [{ programIdIndex: place(CORE_PROGRAM), accounts: [0], data: encodeBase58(Uint8Array.of(1)) }],
      },
    },
    meta: {
      err: options.err ?? null,
      innerInstructions: options.topLevel ? [] : [{ index: 0, instructions }],
    },
  } as RpcTransaction;
}

test("each event is attributed to the program that emitted it", () => {
  const tx = transactionFor([
    { programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated },
    { programId: CORE_PROGRAM, event: FIXTURES.proofCreated },
  ]);
  const envelopes = extractPpvEvents(tx, { programs: PROGRAMS });

  assert.deepEqual(
    envelopes.map((envelope) => [envelope.program, envelope.event.name]),
    [
      ["ppv_commerce", "AgreementCreated"],
      ["ppv_core", "ProofCreated"],
    ],
  );
  assert.equal(envelopes[0]!.programId, COMMERCE_PROGRAM);
  assert.equal(envelopes[1]!.programId, CORE_PROGRAM);
  for (const [index, envelope] of envelopes.entries()) {
    assert.equal(envelope.instructionIndex, 0);
    assert.equal(envelope.innerInstructionIndex, index);
    assert.equal(envelope.slot, 700);
  }
});

test("a Commerce event emitted under the Core program id is not reported as Core", () => {
  // The event authority is derived per program, so bytes emitted by one program
  // cannot be presented as the other's: the authority check fails first. The
  // result is silence, never a Core event that never happened.
  const tx = transactionFor([{ programId: CORE_PROGRAM, event: FIXTURES.agreementCreated }]);
  assert.throws(
    () => extractPpvEvents(tx, { programs: PROGRAMS }),
    /belongs to ppv_commerce/,
    "an event claiming to be Core's while belonging to Commerce must not decode quietly",
  );
});

test("a Core event emitted under the Commerce program id is not reported as Commerce", () => {
  const tx = transactionFor([{ programId: COMMERCE_PROGRAM, event: FIXTURES.proofCreated }]);
  assert.throws(() => extractPpvEvents(tx, { programs: PROGRAMS }), /belongs to ppv_core/);
});

test("an event without the emitting program's authority is not an event", () => {
  // The generated handler requires the program's `__event_authority` PDA as a
  // signer, which only the program can produce. Without it, an inner
  // instruction is just data somebody supplied.
  const tx = transactionFor([
    { programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated, authority: PAYER },
  ]);
  assert.deepEqual(extractPpvEvents(tx, { programs: PROGRAMS }), []);
});

test("one program's authority does not authorise the other program's event", () => {
  const tx = transactionFor([
    {
      programId: COMMERCE_PROGRAM,
      event: FIXTURES.agreementCreated,
      authority: deriveEventAuthority(CORE_PROGRAM),
    },
  ]);
  assert.deepEqual(extractPpvEvents(tx, { programs: PROGRAMS }), []);
});

test("a failed transaction yields nothing", () => {
  const tx = transactionFor([{ programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated }], {
    err: { InstructionError: [0, { Custom: 6001 }] },
  });
  assert.deepEqual(extractPpvEvents(tx, { programs: PROGRAMS }), []);
});

test("a top-level instruction is never read as an event", () => {
  const tx = transactionFor([{ programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated }], {
    topLevel: true,
  });
  assert.deepEqual(extractPpvEvents(tx, { programs: PROGRAMS }), []);
});

test("an unrelated program's inner instruction is ignored", () => {
  const tx = transactionFor([{ programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated }]);
  // Only Core is in scope, so the Commerce emission is not this reader's.
  assert.deepEqual(
    extractPpvEvents(tx, { programs: { ppv_core: CORE_PROGRAM, ppv_commerce: OTHER_PROGRAM } }),
    [],
  );
});

test("extraction is a pure function of the transaction", () => {
  // Two reads of the same transaction produce the same envelopes, which is what
  // makes a duplicate delivery safe to deduplicate on chain coordinates.
  const tx = transactionFor([
    { programId: COMMERCE_PROGRAM, event: FIXTURES.agreementCreated },
    { programId: COMMERCE_PROGRAM, event: FIXTURES.agreementExecuted },
    { programId: CORE_PROGRAM, event: FIXTURES.proofCreated },
  ]);
  const first = extractPpvEvents(tx, { programs: PROGRAMS });
  const second = extractPpvEvents(tx, { programs: PROGRAMS });
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((e) => e.innerInstructionIndex)).size, first.length);
});
