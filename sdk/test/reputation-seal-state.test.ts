import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSealFacts,
  resolveSealState,
  sealRank,
  type ReputationEventType,
  type ReputationEventV1,
} from "../src/index.js";
import { CORE_PROGRAM, PROOF_PDA, SIGNATURE_1, WALLET_A, WALLET_B, hexFromByte } from "./helpers/ppv-events.js";

let counter = 0;
function at(eventType: ReputationEventType, occurredAt: string): ReputationEventV1 {
  counter += 1;
  return {
    schemaVersion: 1,
    eventId: `evt_${counter.toString(16).padStart(40, "0")}`,
    eventType,
    occurredAt,
    eventSource: "chain",
    actorWallet: WALLET_A,
    actorGnsRecord: null,
    counterpartyWallet: WALLET_B,
    counterpartyGnsRecord: null,
    ppvProofId: PROOF_PDA,
    proofHash: hexFromByte(4, 32),
    agreementId: null,
    escrowId: null,
    milestoneIndex: null,
    sourceProduct: null,
    sourceObjectId: null,
    deliverableId: null,
    amount: null,
    mint: null,
    outcome: "recorded",
    programId: CORE_PROGRAM,
    transactionSignature: SIGNATURE_1,
    instructionIndex: counter,
    innerInstructionIndex: 0,
  };
}

const T = (n: number) => `2026-01-0${n}T00:00:00.000Z`;

test("seal ladder resolves deterministically from facts", () => {
  const created = [at("proof.created", T(1))];
  assert.equal(resolveSealState(deriveSealFacts(created, { chainVerified: false })), "recorded");
  assert.equal(resolveSealState(deriveSealFacts(created, { chainVerified: true })), "verified");

  const confirmed = [...created, at("agreement.executed", T(2))];
  assert.equal(resolveSealState(deriveSealFacts(confirmed, { chainVerified: true })), "counterparty_confirmed");

  const settled = [...confirmed, at("settlement.completed", T(3))];
  assert.equal(resolveSealState(deriveSealFacts(settled, { chainVerified: true })), "settled");

  const paid = [...created, at("invoice.paid", T(3))];
  assert.equal(resolveSealState(deriveSealFacts(paid, { chainVerified: true })), "settled");

  const disputed = [...settled, at("dispute.opened", T(4))];
  const openFacts = deriveSealFacts(disputed, { chainVerified: true });
  assert.equal(openFacts.disputeOpen, true);
  assert.equal(resolveSealState(openFacts), "settled", "an open dispute does not lower the ladder, it flags it");

  const resolved = [...disputed, at("dispute.resolved", T(5))];
  const resolvedFacts = deriveSealFacts(resolved, { chainVerified: true });
  assert.equal(resolvedFacts.disputeOpen, false);
  assert.equal(resolveSealState(resolvedFacts), "dispute_resolved");
});

test("a chain-verified flag without chain state cannot promote past recorded on its own", () => {
  const facts = deriveSealFacts([], { chainVerified: false });
  assert.equal(resolveSealState(facts), "recorded");
});

test("delivery order does not change the result", () => {
  const events = [
    at("dispute.resolved", T(5)),
    at("settlement.completed", T(3)),
    at("proof.created", T(1)),
    at("dispute.opened", T(4)),
    at("agreement.executed", T(2)),
  ];
  const forward = deriveSealFacts(events, { chainVerified: true });
  const reversed = deriveSealFacts([...events].reverse(), { chainVerified: true });
  assert.deepEqual(forward, reversed);
  assert.equal(resolveSealState(forward), "dispute_resolved");
});

test("a dispute reopened after a resolution is open again", () => {
  const events = [at("dispute.opened", T(2)), at("dispute.resolved", T(3)), at("dispute.opened", T(4))];
  const facts = deriveSealFacts(events, { chainVerified: true });
  assert.equal(facts.disputeOpen, true);
  assert.equal(resolveSealState(facts), "verified");
});

test("revocation is terminal and outranks everything", () => {
  const events = [at("proof.created", T(1)), at("settlement.completed", T(2)), at("proof.revoked", T(3))];
  assert.equal(resolveSealState(deriveSealFacts(events, { chainVerified: true })), "revoked");
  assert.ok(sealRank("revoked") < sealRank("recorded"));
  assert.ok(sealRank("dispute_resolved") > sealRank("settled"));
});
