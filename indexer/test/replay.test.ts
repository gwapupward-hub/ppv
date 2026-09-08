import assert from "node:assert/strict";
import test from "node:test";

import { deriveAgreementAddresses, type PpvEscrowEvent } from "@gwap/ppv-sdk";

import { replayAgreement, replayAgreementById, signatureHistory } from "../src/replay.js";
import {
  FIXTURE_ADDRESSES,
  InMemoryChainSource,
  LIFECYCLE_FIXTURE,
  PROGRAM_ID,
  addressFromByte,
  signatureFor,
  transactionFor,
} from "./helpers/chain-fixtures.js";

const AGREEMENT = FIXTURE_ADDRESSES.AGREEMENT;
const options = { programId: PROGRAM_ID };

/** One transaction per transition, in the order they committed. */
function lifecycleChain(events: readonly PpvEscrowEvent[] = LIFECYCLE_FIXTURE, agreement = AGREEMENT) {
  const source = new InMemoryChainSource();
  events.forEach((event, index) => {
    source.add(
      transactionFor({ signature: signatureFor(index + 1), slot: 100 + index, events: [event] }),
      [agreement],
    );
  });
  return source;
}

test("an agreement's whole lifecycle is rebuilt from chain data alone", async () => {
  const result = await replayAgreement(lifecycleChain(), AGREEMENT, options);

  assert.equal(result.lifecycle.state, "Settled");
  assert.equal(result.lifecycle.buyer, FIXTURE_ADDRESSES.BUYER);
  assert.equal(result.lifecycle.seller, FIXTURE_ADDRESSES.SELLER);
  assert.equal(result.lifecycle.mint, FIXTURE_ADDRESSES.MINT);
  assert.equal(result.lifecycle.agreementId, 42n);
  assert.equal(result.lifecycle.fundedAmount, 100_000_000n);
  assert.equal(result.lifecycle.settledAmount, 100_000_000n);
  assert.equal(result.lifecycle.settlementDestination, FIXTURE_ADDRESSES.SELLER_ATA);
  assert.equal(result.lifecycle.lastSlot, 103);
  assert.deepEqual(
    result.lifecycle.receipts.map((receipt) => receipt.action),
    ["AGREEMENT_OPENED", "AGREEMENT_FUNDED", "WORK_COMPLETED", "SETTLEMENT_EXECUTED"],
  );
  assert.equal(result.transactionsScanned, 4);
  assert.equal(result.failedTransactionsSkipped, 0);
});

test("replaying twice produces byte-identical history", async () => {
  const source = lifecycleChain();
  const first = await replayAgreement(source, AGREEMENT, options);
  const second = await replayAgreement(source, AGREEMENT, options);
  assert.deepEqual(second, first);
});

test("a partial history reports the state the chain actually reached", async () => {
  const source = lifecycleChain(LIFECYCLE_FIXTURE.slice(0, 2));
  const result = await replayAgreement(source, AGREEMENT, options);
  assert.equal(result.lifecycle.state, "Funded");
  assert.equal(result.lifecycle.settledAmount, null);
});

test("failed transactions are skipped and counted, not read as history", async () => {
  const source = lifecycleChain();
  source.add(
    transactionFor({
      signature: signatureFor(50),
      slot: 104,
      events: [LIFECYCLE_FIXTURE[3]!],
      err: { InstructionError: [0, { Custom: 6003 }] },
    }),
    [AGREEMENT],
  );

  const result = await replayAgreement(source, AGREEMENT, options);
  assert.equal(result.failedTransactionsSkipped, 1);
  assert.equal(result.events.length, 4, "the failed settlement contributed no event");
  assert.equal(result.lifecycle.state, "Settled");
});

test("events for other agreements in the same transaction are left alone", async () => {
  const other = addressFromByte(30);
  const source = new InMemoryChainSource();
  LIFECYCLE_FIXTURE.forEach((event, index) => {
    source.add(
      transactionFor({
        signature: signatureFor(index + 1),
        slot: 100 + index,
        // One transaction, two agreements: a batching client is allowed.
        events: [event, { ...LIFECYCLE_FIXTURE[0]!, agreement: other }],
      }),
      [AGREEMENT, other],
    );
  });

  const result = await replayAgreement(source, AGREEMENT, options);
  assert.equal(result.events.length, 4);
  assert.ok(result.events.every((envelope) => envelope.event.agreement === AGREEMENT));
  assert.equal(result.lifecycle.state, "Settled");
});

test("history is paged, oldest first, however small the page", async () => {
  const source = lifecycleChain();
  const history = await signatureHistory(source, AGREEMENT, { ...options, pageSize: 1 });

  assert.deepEqual(
    history.map((entry) => entry.slot),
    [100, 101, 102, 103],
  );
  assert.ok(source.signatureCalls > 1, "a page size of one must page");

  const paged = await replayAgreement(source, AGREEMENT, { ...options, pageSize: 2 });
  assert.equal(paged.lifecycle.state, "Settled");
});

test("an `until` cursor stops the walk at a signature already indexed", async () => {
  const source = lifecycleChain();
  const history = await signatureHistory(source, AGREEMENT, {
    ...options,
    until: signatureFor(2),
    pageSize: 10,
  });
  // Paging runs newest to oldest and stops at the cursor, so the cursor and
  // everything older than it is excluded — an incremental indexer already has
  // those.
  assert.deepEqual(
    history.map((entry) => entry.slot),
    [102, 103],
  );
});

test("an unbounded history is refused rather than paged forever", async () => {
  const source = lifecycleChain();
  await assert.rejects(
    signatureHistory(source, AGREEMENT, { ...options, pageSize: 1, maxSignatures: 2 }),
    /more than 2 signatures/,
  );
});

test("an agreement is addressable by creator and id, without a lookup", async () => {
  const { agreement } = deriveAgreementAddresses(PROGRAM_ID, FIXTURE_ADDRESSES.BUYER, 42n);
  const events = LIFECYCLE_FIXTURE.map((event) => ({ ...event, agreement }));
  const source = lifecycleChain(events, agreement);

  const byAddress = await replayAgreement(source, agreement, options);
  const byId = await replayAgreementById(source, FIXTURE_ADDRESSES.BUYER, 42n, options);
  assert.deepEqual(byId, byAddress);
  assert.equal(byId.agreement, agreement);
});

test("an agreement with no history is refused rather than reported as empty", async () => {
  const source = new InMemoryChainSource();
  await assert.rejects(replayAgreement(source, AGREEMENT, options), /no .* events for/);
});

test("the wrong program id says so, rather than reporting an empty agreement", async () => {
  // Every address in a replay is derived from the program id, so a mistyped one
  // produces a chain of transactions none of whose events are recognised. That
  // must not read as "this agreement never happened".
  const source = lifecycleChain();
  await assert.rejects(
    replayAgreement(source, AGREEMENT, { programId: addressFromByte(40) }),
    /in 4 transactions/,
  );
});
