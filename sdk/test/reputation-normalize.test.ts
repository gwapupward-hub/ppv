import assert from "node:assert/strict";
import test from "node:test";
import {
  NormalizationError,
  isReputationEventV1,
  normalizeChainEvent,
  normalizeProductSubmission,
  type ChainEventEnvelope,
  type GnsRecordSnapshotV1,
  type GwapDeliverableReferenceV1,
  type PpvChainEvent,
  type ReputationEventV1,
} from "../src/index.js";
import {
  AGREEMENT_PDA,
  COMMERCE_PROGRAM,
  CORE_PROGRAM,
  FIXTURES,
  PROGRAM_IDS,
  PROOF_PDA,
  SIGNATURE_1,
  WALLET_A,
  WALLET_B,
  hexFromByte,
} from "./helpers/ppv-events.js";

function snapshot(name: string, owner: string): GnsRecordSnapshotV1 {
  return { schemaVersion: 1, name, fullName: `${name}.gwap`, owner, resolvedAt: "2026-01-01T00:00:00.000Z" };
}

const directory = new Map<string, string>([[WALLET_A, "emerald"], [WALLET_B, "onyx"]]);
const resolveGns = async (wallet: string) => {
  const name = directory.get(wallet);
  return name ? snapshot(name, wallet) : null;
};

function envelope(event: PpvChainEvent, overrides: Partial<ChainEventEnvelope> = {}): ChainEventEnvelope {
  return {
    event,
    programId: event.name.startsWith("Proof") ? CORE_PROGRAM : COMMERCE_PROGRAM,
    transactionSignature: SIGNATURE_1,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    blockTime: 1_700_000_100,
    ...overrides,
  };
}

const EXPECTED: Record<keyof typeof FIXTURES, Partial<ReputationEventV1>> = {
  proofCreated: {
    eventType: "proof.created", actorWallet: WALLET_A, counterpartyWallet: null,
    ppvProofId: PROOF_PDA, proofHash: hexFromByte(4, 32), agreementId: null, outcome: "recorded", programId: CORE_PROGRAM,
  },
  proofRevoked: {
    eventType: "proof.revoked", actorWallet: WALLET_A, counterpartyWallet: null,
    ppvProofId: PROOF_PDA, proofHash: hexFromByte(4, 32), outcome: "revoked", programId: CORE_PROGRAM,
  },
  agreementCreated: {
    eventType: "agreement.created", actorWallet: WALLET_A, counterpartyWallet: WALLET_B,
    ppvProofId: null, agreementId: AGREEMENT_PDA, outcome: "recorded", programId: COMMERCE_PROGRAM,
  },
  agreementRevised: {
    eventType: "agreement.revised", actorWallet: WALLET_B, counterpartyWallet: WALLET_A,
    agreementId: AGREEMENT_PDA, proofHash: hexFromByte(6, 32), outcome: "recorded",
  },
  agreementSigned: {
    eventType: "agreement.signed", actorWallet: WALLET_B, counterpartyWallet: WALLET_A,
    agreementId: AGREEMENT_PDA, outcome: "recorded",
  },
  agreementExecuted: {
    eventType: "agreement.executed", actorWallet: WALLET_A, counterpartyWallet: WALLET_B,
    agreementId: AGREEMENT_PDA, outcome: "completed",
  },
  agreementCancelled: {
    eventType: "agreement.cancelled", actorWallet: WALLET_A, counterpartyWallet: WALLET_B,
    agreementId: AGREEMENT_PDA, proofHash: null, outcome: "cancelled",
  },
};

test("every supported PPV event converts into the expected ReputationEventV1", async () => {
  for (const [key, fixture] of Object.entries(FIXTURES) as Array<[keyof typeof FIXTURES, PpvChainEvent]>) {
    const event = await normalizeChainEvent(envelope(fixture), { resolveGns, expectedProgramIds: PROGRAM_IDS });
    assert.ok(isReputationEventV1(event), `${key} is structurally valid`);
    for (const [field, value] of Object.entries(EXPECTED[key])) {
      assert.deepEqual(event[field as keyof ReputationEventV1], value, `${key}.${field}`);
    }
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.eventSource, "chain");
    assert.equal(event.occurredAt, "2023-11-14T22:15:00.000Z", "block time wins over the event timestamp");
    assert.equal(event.transactionSignature, SIGNATURE_1);
    assert.equal(event.actorGnsRecord?.fullName, directory.get(event.actorWallet) + ".gwap");
    if (event.counterpartyWallet) {
      assert.equal(event.counterpartyGnsRecord?.owner, event.counterpartyWallet);
    } else {
      assert.equal(event.counterpartyGnsRecord, null);
    }
  }
});

test("falls back to the event's own timestamp when the block time is missing", async () => {
  const event = await normalizeChainEvent(envelope(FIXTURES.proofCreated, { blockTime: null }), {
    resolveGns,
    expectedProgramIds: PROGRAM_IDS,
  });
  assert.equal(event.occurredAt, new Date(1_700_000_000_000).toISOString());
});

test("idempotency: replaying the same chain coordinates yields the same eventId", async () => {
  const first = await normalizeChainEvent(envelope(FIXTURES.agreementExecuted), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  const replay = await normalizeChainEvent(envelope(FIXTURES.agreementExecuted), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  assert.equal(first.eventId, replay.eventId);
  assert.deepEqual(first, replay);
});

test("two events emitted by one instruction get distinct ids via the inner index", async () => {
  const signed = await normalizeChainEvent(envelope(FIXTURES.agreementSigned, { innerInstructionIndex: 0 }), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  const executed = await normalizeChainEvent(envelope(FIXTURES.agreementExecuted, { innerInstructionIndex: 1 }), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  assert.notEqual(signed.eventId, executed.eventId);
  assert.equal(signed.transactionSignature, executed.transactionSignature);
  assert.equal(signed.instructionIndex, executed.instructionIndex);
});

test("an event from the wrong program is refused", async () => {
  await assert.rejects(
    normalizeChainEvent(envelope(FIXTURES.proofCreated, { programId: COMMERCE_PROGRAM }), { resolveGns, expectedProgramIds: PROGRAM_IDS }),
    NormalizationError,
  );
  await assert.rejects(
    normalizeChainEvent(envelope(FIXTURES.agreementExecuted, { programId: CORE_PROGRAM }), { resolveGns, expectedProgramIds: PROGRAM_IDS }),
    NormalizationError,
  );
});

test("a GNS snapshot for a different wallet can never be attached", async () => {
  const lying = async () => snapshot("emerald", WALLET_B);
  await assert.rejects(
    normalizeChainEvent(envelope(FIXTURES.proofCreated), { resolveGns: lying, expectedProgramIds: PROGRAM_IDS }),
    /does not match wallet/,
  );
});

test("identity: a later .gwap transfer does not rewrite the historical snapshot", async () => {
  const before = await normalizeChainEvent(envelope(FIXTURES.proofCreated), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  assert.equal(before.actorWallet, WALLET_A);
  assert.equal(before.actorGnsRecord?.fullName, "emerald.gwap");

  // emerald.gwap moves to wallet B.
  const moved = new Map<string, string>([[WALLET_B, "emerald"]]);
  const resolveAfterTransfer = async (wallet: string) => {
    const name = moved.get(wallet);
    return name ? snapshot(name, wallet) : null;
  };

  const later = await normalizeChainEvent(
    envelope({ ...FIXTURES.proofCreated, authority: WALLET_B }, { transactionSignature: SIGNATURE_1, instructionIndex: 1 }),
    { resolveGns: resolveAfterTransfer, expectedProgramIds: PROGRAM_IDS },
  );
  assert.equal(later.actorWallet, WALLET_B);
  assert.equal(later.actorGnsRecord?.fullName, "emerald.gwap");

  // Replaying the old transaction with the new directory produces the same
  // eventId, so an idempotent store keeps the first, historical snapshot. The
  // wallet itself is the canonical authority either way.
  const replay = await normalizeChainEvent(envelope(FIXTURES.proofCreated), { resolveGns: resolveAfterTransfer, expectedProgramIds: PROGRAM_IDS });
  assert.equal(replay.eventId, before.eventId);
  assert.equal(replay.actorWallet, WALLET_A);
  assert.equal(replay.actorGnsRecord, null, "wallet A no longer holds emerald at replay time");
});

test("proof events are enriched with a registered deliverable reference", async () => {
  const reference: GwapDeliverableReferenceV1 = {
    schemaVersion: 1,
    sourceProduct: "marketplace",
    sourceObjectId: "intent_abc",
    deliverableId: "milestone-1",
    creatorWallet: WALLET_A,
    creatorGnsRecord: snapshot("emerald", WALLET_A),
    ppvProofId: PROOF_PDA,
    proofHash: hexFromByte(4, 32),
    createdAt: "2026-02-01T00:00:00.000Z",
    counterpartyWallet: WALLET_B,
    deliverableKind: "milestone",
  };
  const event = await normalizeChainEvent(envelope(FIXTURES.proofCreated), {
    resolveGns,
    expectedProgramIds: PROGRAM_IDS,
    lookupDeliverable: async (id) => (id === PROOF_PDA ? reference : null),
  });
  assert.equal(event.sourceProduct, "marketplace");
  assert.equal(event.sourceObjectId, "intent_abc");
  assert.equal(event.deliverableId, "milestone-1");
});

test("proof.submitted borrows the proof's chain coordinates and is deterministic", async () => {
  const proofCreated = await normalizeChainEvent(envelope(FIXTURES.proofCreated), { resolveGns, expectedProgramIds: PROGRAM_IDS });
  const reference: GwapDeliverableReferenceV1 = {
    schemaVersion: 1,
    sourceProduct: "dimi",
    sourceObjectId: "track_9",
    deliverableId: "master-v1",
    creatorWallet: WALLET_A,
    creatorGnsRecord: proofCreated.actorGnsRecord,
    ppvProofId: PROOF_PDA,
    proofHash: hexFromByte(4, 32),
    createdAt: "2026-02-01T00:00:00.000Z",
    counterpartyWallet: WALLET_B,
    deliverableKind: "master",
  };
  const submission = normalizeProductSubmission({
    reference,
    proofCreated,
    submittedAt: "2026-02-01T00:00:00.000Z",
    counterpartyGnsRecord: snapshot("onyx", WALLET_B),
  });
  assert.ok(isReputationEventV1(submission));
  assert.equal(submission.eventType, "proof.submitted");
  assert.equal(submission.eventSource, "product");
  assert.equal(submission.transactionSignature, proofCreated.transactionSignature);
  assert.notEqual(submission.eventId, proofCreated.eventId);
  const again = normalizeProductSubmission({
    reference,
    proofCreated,
    submittedAt: "2026-03-01T00:00:00.000Z",
    counterpartyGnsRecord: snapshot("onyx", WALLET_B),
  });
  assert.equal(again.eventId, submission.eventId, "resubmission collapses to one event");

  assert.throws(
    () => normalizeProductSubmission({ reference: { ...reference, proofHash: hexFromByte(9, 32) }, proofCreated, submittedAt: "2026-02-01T00:00:00.000Z", counterpartyGnsRecord: null }),
    /hash does not match/,
  );
  assert.throws(
    () => normalizeProductSubmission({ reference: { ...reference, creatorWallet: WALLET_B }, proofCreated, submittedAt: "2026-02-01T00:00:00.000Z", counterpartyGnsRecord: null }),
    /not the proof authority/,
  );
  assert.throws(
    () => normalizeProductSubmission({ reference, proofCreated: { ...proofCreated, eventType: "proof.revoked" }, submittedAt: "2026-02-01T00:00:00.000Z", counterpartyGnsRecord: null }),
    /must reference a proof.created/,
  );
});
