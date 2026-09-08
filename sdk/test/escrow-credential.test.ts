import assert from "node:assert/strict";
import test from "node:test";

import {
  escrowCredential,
  escrowReceiptFromEvent,
  escrowSealFacts,
  reconstructAgreementLifecycle,
  type AgreementLifecycle,
  type PpvEscrowEvent,
} from "../src/index.js";
import {
  DISPUTE_FIXTURE,
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  PROOF_APPROVED_FIXTURE,
  PROOF_FIXTURE,
  PROOF_REJECTED_FIXTURE,
  addressFromByte,
  signatureFromByte,
} from "./helpers/escrow-events.js";

const PROGRAM_ID = addressFromByte(9);
const VERIFIED = { chainVerified: true };

function build(events: readonly PpvEscrowEvent[], slots?: readonly number[]): AgreementLifecycle {
  return reconstructAgreementLifecycle(
    events.map((event, index) =>
      escrowReceiptFromEvent({
        event,
        programId: PROGRAM_ID,
        transactionSignature: signatureFromByte(index + 1),
        slot: slots?.[index] ?? 1_000 + index,
        instructionIndex: 0,
        innerInstructionIndex: index,
        blockTime: event.timestamp,
      }),
    ),
  );
}

test("a settled agreement seals as settled, with the receipts to check it", () => {
  const credential = escrowCredential(build(LIFECYCLE_FIXTURE), VERIFIED);

  assert.equal(credential.state, "settled");
  assert.equal(credential.buyer, FIXTURE_ADDRESSES.BUYER);
  assert.equal(credential.seller, FIXTURE_ADDRESSES.SELLER);
  assert.equal(credential.settledAmount, 100_000_000n);
  assert.equal(credential.receiptIds.length, 4);
  assert.equal(new Set(credential.receiptIds).size, 4, "receipt ids are distinct");
});

test("an unverified chain read never reaches verified, whatever the events say", () => {
  // A credential built from events alone is a credential that trusts its own
  // event feed. Chain verification is required rather than defaulted.
  const created = build(LIFECYCLE_FIXTURE.slice(0, 1));
  assert.equal(escrowCredential(created, { chainVerified: false }).state, "recorded");
  assert.equal(escrowCredential(created, VERIFIED).state, "verified");
});

test("the seller's own claim of completion is not confirmation", () => {
  // WorkCompleted is the seller saying it finished. If that counted, one party
  // could stamp itself.
  const funded = build(LIFECYCLE_FIXTURE.slice(0, 2));
  assert.equal(escrowSealFacts(funded, VERIFIED).counterpartyConfirmed, false);

  const completed = build(LIFECYCLE_FIXTURE.slice(0, 3));
  assert.equal(escrowSealFacts(completed, VERIFIED).counterpartyConfirmed, false);
  assert.equal(escrowCredential(completed, VERIFIED).state, "verified");
});

test("an approved proof is confirmation; a rejected one is not", () => {
  const withApproval = build(
    [...LIFECYCLE_FIXTURE.slice(0, 2), PROOF_FIXTURE, PROOF_APPROVED_FIXTURE],
    [1_000, 1_001, 1_001, 1_001],
  );
  assert.equal(escrowCredential(withApproval, VERIFIED).state, "counterparty_confirmed");
  assert.deepEqual(escrowCredential(withApproval, VERIFIED).approvedProofs, [
    FIXTURE_ADDRESSES.PROOF,
  ]);

  const withRejection = build(
    [...LIFECYCLE_FIXTURE.slice(0, 2), PROOF_FIXTURE, PROOF_REJECTED_FIXTURE],
    [1_000, 1_001, 1_001, 1_001],
  );
  assert.equal(escrowSealFacts(withRejection, VERIFIED).counterpartyConfirmed, false);
  assert.deepEqual(escrowCredential(withRejection, VERIFIED).approvedProofs, []);
});

test("a refund is recorded as a refund, never as a settlement", () => {
  const refunded = build(
    [LIFECYCLE_FIXTURE[0]!, LIFECYCLE_FIXTURE[1]!, ...DISPUTE_FIXTURE],
    [1_000, 1_001, 1_002, 1_003, 1_003],
  );
  const facts = escrowSealFacts(refunded, VERIFIED);
  assert.equal(facts.refunded, true);
  assert.equal(facts.settled, false, "money going back is not money settling");
  assert.equal(facts.disputeResolved, true);
  assert.equal(facts.disputeOpen, false);
  assert.equal(escrowCredential(refunded, VERIFIED).state, "dispute_resolved");
  assert.equal(escrowCredential(refunded, VERIFIED).refundedAmount, 100_000_000n);
});

test("an open dispute is reported as open", () => {
  const disputed = build(
    [LIFECYCLE_FIXTURE[0]!, LIFECYCLE_FIXTURE[1]!, DISPUTE_FIXTURE[0]!],
    [1_000, 1_001, 1_002],
  );
  const facts = escrowSealFacts(disputed, VERIFIED);
  assert.equal(facts.disputeOpen, true);
  assert.equal(facts.disputeResolved, false);
  assert.equal(facts.settled, false);
});
