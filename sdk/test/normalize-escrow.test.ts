import assert from "node:assert/strict";
import test from "node:test";

import {
  REPUTATION_EVENT_TYPES,
  normalizeEscrowEvent,
  type EscrowEventEnvelope,
  type PpvEscrowEvent,
} from "../src/index.js";
import {
  CANCELLED_FIXTURE,
  COUNTERPARTY_ASSIGNED_FIXTURE,
  DISPUTE_FIXTURE,
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  MILESTONE_FIXTURE,
  PROOF_APPROVED_FIXTURE,
  PROOF_FIXTURE,
  PROOF_REJECTED_FIXTURE,
  addressFromByte,
  signatureFromByte,
} from "./helpers/escrow-events.js";

const PROGRAM_ID = addressFromByte(9);
const options = { resolveGns: async () => null, expectedProgramId: PROGRAM_ID };

function envelope(event: PpvEscrowEvent, index = 0): EscrowEventEnvelope {
  return {
    event,
    programId: PROGRAM_ID,
    transactionSignature: signatureFromByte(index + 1),
    slot: 1_000 + index,
    instructionIndex: 0,
    innerInstructionIndex: index,
    blockTime: event.timestamp,
  };
}

const ALL_EVENTS: readonly PpvEscrowEvent[] = [
  ...LIFECYCLE_FIXTURE,
  PROOF_FIXTURE,
  PROOF_APPROVED_FIXTURE,
  PROOF_REJECTED_FIXTURE,
  ...DISPUTE_FIXTURE,
  CANCELLED_FIXTURE,
  ...MILESTONE_FIXTURE,
  COUNTERPARTY_ASSIGNED_FIXTURE,
];

test("every escrow event either normalizes or is deliberately silent", async () => {
  for (const event of ALL_EVENTS) {
    const normalized = await normalizeEscrowEvent(envelope(event), options);
    if (event.name === "CounterpartyAssigned") {
      // A bounty naming its payee says nothing about anyone's conduct.
      // Inventing a reputation event for it would put weight on nothing.
      assert.equal(normalized, null);
      continue;
    }
    assert.ok(normalized, `${event.name} produced no reputation event`);
    assert.ok(
      (REPUTATION_EVENT_TYPES as readonly string[]).includes(normalized.eventType),
      `${normalized.eventType} is not a declared reputation event type`,
    );
    assert.equal(normalized.eventSource, "chain");
    assert.equal(normalized.escrowId, event.agreement);
    assert.equal(normalized.programId, PROGRAM_ID);
  }
});

test("nothing normalized is ever a judgement", async () => {
  // PPV records what happened; GwapScore decides what it means. A resolution
  // reports which side the money went to, never who was right.
  for (const event of ALL_EVENTS) {
    const normalized = await normalizeEscrowEvent(envelope(event), options);
    if (!normalized) continue;
    const serialized = JSON.stringify(normalized).toLowerCase();
    for (const judgement of ["good", "bad", "trust", "score", "rating", "reliable"]) {
      assert.ok(!serialized.includes(judgement), `${event.name} leaked a judgement: ${judgement}`);
    }
  }
});

test("a settlement names the payer, the payee and the amount", async () => {
  const settled = LIFECYCLE_FIXTURE[3]!;
  const normalized = await normalizeEscrowEvent(envelope(settled), options);
  assert.equal(normalized?.eventType, "settlement.completed");
  assert.equal(normalized?.actorWallet, FIXTURE_ADDRESSES.BUYER);
  assert.equal(normalized?.counterpartyWallet, FIXTURE_ADDRESSES.SELLER);
  assert.equal(normalized?.amount, "100000000");
  assert.equal(normalized?.mint, FIXTURE_ADDRESSES.MINT);
  assert.equal(normalized?.outcome, "completed");
});

test("a conceded dispute reports where the money went, not who was right", async () => {
  const resolved = DISPUTE_FIXTURE.find((event) => event.name === "DisputeResolved")!;
  const normalized = await normalizeEscrowEvent(envelope(resolved), options);
  assert.equal(normalized?.eventType, "dispute.resolved");
  assert.equal(normalized?.actorWallet, FIXTURE_ADDRESSES.SELLER, "the seller conceded");
  assert.equal(normalized?.counterpartyWallet, FIXTURE_ADDRESSES.BUYER, "the buyer received");
  assert.equal(normalized?.outcome, "resolved_for_counterparty");
});

test("a milestone event carries its index so a consumer can group tranches", async () => {
  const created = MILESTONE_FIXTURE[1]!;
  const normalized = await normalizeEscrowEvent(envelope(created), options);
  assert.equal(normalized?.eventType, "milestone.created");
  assert.equal(normalized?.milestoneIndex, 1);
  assert.equal(normalized?.amount, "40000000");
});

test("the same event replayed yields the same reputation event id", async () => {
  const first = await normalizeEscrowEvent(envelope(LIFECYCLE_FIXTURE[1]!, 3), options);
  const second = await normalizeEscrowEvent(envelope(LIFECYCLE_FIXTURE[1]!, 3), options);
  assert.equal(first?.eventId, second?.eventId);

  const elsewhere = await normalizeEscrowEvent(
    { ...envelope(LIFECYCLE_FIXTURE[1]!, 3), transactionSignature: signatureFromByte(99) },
    options,
  );
  assert.notEqual(first?.eventId, elsewhere?.eventId);
});

test("an event from another program is refused, not attributed", async () => {
  await assert.rejects(
    normalizeEscrowEvent(
      { ...envelope(LIFECYCLE_FIXTURE[0]!), programId: addressFromByte(60) },
      options,
    ),
    /expected/,
  );
});

test("an unnamed bounty payee is reported as absent, not as a wallet", async () => {
  const anonymous = { ...LIFECYCLE_FIXTURE[0]!, counterparty: "11111111111111111111111111111111" };
  const normalized = await normalizeEscrowEvent(envelope(anonymous as PpvEscrowEvent), options);
  assert.equal(normalized?.counterpartyWallet, null);
});
