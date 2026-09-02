import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_SEAL_FACTS,
  assertPublicCredentialMetadata,
  buildCredentialMetadata,
  chainEventId,
  evaluateCredentialEligibility,
  projectReceipts,
  type PpvReceiptV1,
  type ReputationEventV1,
  type SealFacts,
} from "../src/index.js";
import { COMMERCE_PROGRAM, PROOF_PDA, SIGNATURE_1, WALLET_A, WALLET_B, WALLET_C, hexFromByte } from "./helpers/ppv-events.js";

function settlementEvent(): ReputationEventV1 {
  const key = { transactionSignature: SIGNATURE_1, instructionIndex: 0, innerInstructionIndex: 0 };
  return {
    schemaVersion: 1,
    eventId: chainEventId(key, "settlement.completed"),
    eventType: "settlement.completed",
    occurredAt: "2026-01-03T00:00:00.000Z",
    eventSource: "chain",
    actorWallet: WALLET_A,
    actorGnsRecord: null,
    counterpartyWallet: WALLET_B,
    counterpartyGnsRecord: { schemaVersion: 1, name: "onyx", fullName: "onyx.gwap", owner: WALLET_B, resolvedAt: "2026-01-01T00:00:00.000Z" },
    ppvProofId: PROOF_PDA,
    proofHash: hexFromByte(4, 32),
    agreementId: null,
    escrowId: null,
    milestoneIndex: null,
    sourceProduct: "marketplace",
    sourceObjectId: "intent_1",
    deliverableId: "milestone-1",
    amount: "1000",
    mint: WALLET_C,
    outcome: "completed",
    programId: COMMERCE_PROGRAM,
    transactionSignature: SIGNATURE_1,
    instructionIndex: 0,
    innerInstructionIndex: 0,
  };
}

const SETTLED: SealFacts = { ...EMPTY_SEAL_FACTS, chainVerified: true, counterpartyConfirmed: true, settled: true };
const validProof = { exists: true, revoked: false, authority: WALLET_A, contentHash: hexFromByte(4, 32) };

function payeeReceipt(): PpvReceiptV1 {
  const receipts = projectReceipts(settlementEvent(), { sealState: "settled", disputeOpen: false });
  return receipts[1] as PpvReceiptV1;
}

function reasons(input: Parameters<typeof evaluateCredentialEligibility>[0]) {
  const result = evaluateCredentialEligibility(input);
  return result.eligible ? [] : result.reasons;
}

test("accepts a settled receipt for its holder", () => {
  const result = evaluateCredentialEligibility({ receipt: payeeReceipt(), requestedBy: WALLET_B, proof: validProof, facts: SETTLED });
  assert.equal(result.eligible, true);
  if (result.eligible) assert.equal(result.sealState, "settled");
});

test("accepts a final dispute resolution", () => {
  const facts: SealFacts = { ...SETTLED, disputeResolved: true, disputeOpen: false };
  const result = evaluateCredentialEligibility({ receipt: payeeReceipt(), requestedBy: WALLET_B, proof: validProof, facts });
  assert.equal(result.eligible, true);
  if (result.eligible) assert.equal(result.sealState, "dispute_resolved");
});

test("rejects pending, delivered-only, unapproved and unsettled work", () => {
  const receipt = payeeReceipt();
  const pending = { ...EMPTY_SEAL_FACTS, chainVerified: true };
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: validProof, facts: pending }), ["not_settled"]);
  const unapproved = { ...pending, counterpartyConfirmed: false };
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: validProof, facts: unapproved }), ["not_settled"]);
  const confirmedNotSettled = { ...pending, counterpartyConfirmed: true };
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: validProof, facts: confirmedNotSettled }), ["not_settled"]);
});

test("rejects an active dispute even when settled", () => {
  const facts = { ...SETTLED, disputeOpen: true };
  assert.deepEqual(reasons({ receipt: payeeReceipt(), requestedBy: WALLET_B, proof: validProof, facts }), ["dispute_active"]);
});

test("rejects an invalid or revoked proof", () => {
  const receipt = payeeReceipt();
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: { exists: false, revoked: false, authority: null, contentHash: null }, facts: SETTLED }), ["proof_missing"]);
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: { ...validProof, revoked: true }, facts: SETTLED }), ["proof_revoked"]);
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: { ...validProof, contentHash: hexFromByte(9, 32) }, facts: SETTLED }), ["receipt_invalid"]);
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_B, proof: validProof, facts: { ...SETTLED, chainVerified: false } }), ["proof_not_verified"]);
});

test("rejects a tampered receipt and the wrong holder", () => {
  const receipt = payeeReceipt();
  const tampered = { ...receipt, role: "payer" as const };
  assert.deepEqual(reasons({ receipt: tampered, requestedBy: WALLET_B, proof: validProof, facts: SETTLED }), ["receipt_invalid"]);
  assert.deepEqual(reasons({ receipt, requestedBy: WALLET_A, proof: validProof, facts: SETTLED }), ["wrong_holder"]);
  assert.deepEqual(reasons({ receipt: { hello: "world" }, requestedBy: WALLET_B, proof: validProof, facts: SETTLED }), ["receipt_invalid"]);
  assert.deepEqual(reasons({ receipt: { ...receipt, credentialMint: WALLET_C }, requestedBy: WALLET_B, proof: validProof, facts: SETTLED }), ["already_minted"]);
});

test("public metadata carries only allowlisted facts", () => {
  const result = evaluateCredentialEligibility({ receipt: payeeReceipt(), requestedBy: WALLET_B, proof: validProof, facts: SETTLED });
  assert.ok(result.eligible);
  if (!result.eligible) return;
  const metadata = buildCredentialMetadata(result, "https://www.gwapspot.com/receipt/x");
  assert.equal(metadata.ppv_proof_id, PROOF_PDA);
  assert.equal(metadata.holder_wallet, WALLET_B);
  assert.equal(metadata.holder_gns_record?.fullName, "onyx.gwap");
  assert.equal(metadata.role, "payee");
  assert.equal(metadata.event_type, "settlement.completed");
  assert.ok(!("amount" in metadata));
  assert.ok(!("transaction_signature" in metadata));
  assert.throws(() => buildCredentialMetadata(result, "http://insecure"), /https/);
  assert.throws(() => assertPublicCredentialMetadata({ ...metadata, agreement_content: "secret" }), /not public/);
  assert.throws(() => assertPublicCredentialMetadata({ ...metadata, line_items: [] }), /not public/);
  assert.throws(() => assertPublicCredentialMetadata({ ...metadata, holder_gns_record: { ...metadata.holder_gns_record, email: "x" } }), /not public/);
});
