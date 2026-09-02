import assert from "node:assert/strict";
import test from "node:test";
import {
  chainEventId,
  isPpvReceiptV1,
  projectReceipts,
  receiptId,
  refreshReceiptState,
  type GnsRecordSnapshotV1,
  type ReputationEventV1,
} from "../src/index.js";
import { COMMERCE_PROGRAM, PROOF_PDA, SIGNATURE_1, WALLET_A, WALLET_B, WALLET_C, hexFromByte } from "./helpers/ppv-events.js";

function snapshot(name: string, owner: string): GnsRecordSnapshotV1 {
  return { schemaVersion: 1, name, fullName: `${name}.gwap`, owner, resolvedAt: "2026-01-01T00:00:00.000Z" };
}

function event(overrides: Partial<ReputationEventV1>): ReputationEventV1 {
  const base: ReputationEventV1 = {
    schemaVersion: 1,
    eventId: "",
    eventType: "agreement.executed",
    occurredAt: "2026-01-02T00:00:00.000Z",
    eventSource: "chain",
    actorWallet: WALLET_A,
    actorGnsRecord: snapshot("emerald", WALLET_A),
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
    outcome: "completed",
    programId: COMMERCE_PROGRAM,
    transactionSignature: SIGNATURE_1,
    instructionIndex: 0,
    innerInstructionIndex: 0,
    ...overrides,
  };
  base.eventId = chainEventId(
    { transactionSignature: base.transactionSignature, instructionIndex: base.instructionIndex, innerInstructionIndex: base.innerInstructionIndex },
    base.eventType,
  );
  return base;
}

const context = { sealState: "counterparty_confirmed" as const, disputeOpen: false };

test("payer and payee receipts for a settlement", () => {
  const receipts = projectReceipts(event({ eventType: "settlement.completed", amount: "2500000", mint: WALLET_C }), context);
  assert.equal(receipts.length, 2);
  const [payer, payee] = receipts;
  assert.equal(payer?.holderWallet, WALLET_A);
  assert.equal(payer?.role, "payer");
  assert.deepEqual(payer?.counterpartyWallets, [WALLET_B]);
  assert.equal(payee?.holderWallet, WALLET_B);
  assert.equal(payee?.role, "payee");
  assert.equal(payee?.amount, "2500000");
  assert.equal(payee?.mint, WALLET_C);
  assert.ok(receipts.every(isPpvReceiptV1));
});

test("buyer and seller receipts for a delivered milestone, with product role hints", () => {
  const delivered = projectReceipts(event({ eventType: "milestone.delivered", outcome: "recorded", milestoneIndex: 2 }), context);
  assert.equal(delivered[0]?.role, "seller");
  assert.equal(delivered[1]?.role, "buyer");

  const hinted = projectReceipts(
    event({ eventType: "agreement.executed", sourceProduct: "marketplace" }),
    { ...context, roleHints: { [WALLET_A]: "buyer", [WALLET_B]: "seller" } },
  );
  assert.equal(hinted[0]?.role, "buyer");
  assert.equal(hinted[1]?.role, "seller");
});

test("collaborator receipts for a bilateral agreement", () => {
  const receipts = projectReceipts(event({}), context);
  assert.deepEqual(receipts.map((r) => r.role), ["collaborator", "collaborator"]);
  assert.equal(receipts[0]?.sealState, "counterparty_confirmed");
});

test("proof.submitted to a marketplace buyer, to a DIMI collaborator, and with no counterparty", () => {
  const marketplace = projectReceipts(event({ eventType: "proof.submitted", sourceProduct: "marketplace", outcome: "recorded" }), context);
  assert.deepEqual(marketplace.map((r) => r.role), ["creator", "buyer"]);
  const dimi = projectReceipts(event({ eventType: "proof.submitted", sourceProduct: "dimi", outcome: "recorded" }), context);
  assert.deepEqual(dimi.map((r) => r.role), ["creator", "collaborator"]);
  const solo = projectReceipts(event({ eventType: "proof.created", counterpartyWallet: null, outcome: "recorded" }), context);
  assert.equal(solo.length, 1);
  assert.equal(solo[0]?.role, "creator");
  assert.deepEqual(solo[0]?.counterpartyWallets, []);
});

test("multiple participants: a dispute with an arbiter yields three receipts", () => {
  const receipts = projectReceipts(event({ eventType: "dispute.opened", outcome: "opened" }), {
    ...context,
    disputeOpen: true,
    arbiterWallet: WALLET_C,
    arbiterGnsRecord: snapshot("judge", WALLET_C),
  });
  assert.deepEqual(receipts.map((r) => [r.holderWallet, r.role]), [
    [WALLET_A, "collaborator"],
    [WALLET_B, "collaborator"],
    [WALLET_C, "arbiter"],
  ]);
  assert.deepEqual(receipts[2]?.counterpartyWallets, [WALLET_A, WALLET_B]);
  assert.ok(receipts.every((r) => r.disputeOpen));
});

test("a participant without a GNS name still receives a receipt", () => {
  const receipts = projectReceipts(event({ counterpartyGnsRecord: null }), context);
  assert.equal(receipts[1]?.holderGnsRecord, null);
  assert.deepEqual(receipts[0]?.counterpartyGnsRecords, [null]);
  assert.equal(receipts[1]?.counterpartyGnsRecords[0]?.fullName, "emerald.gwap");
});

test("receipt ids are deterministic and recomputable from the event", () => {
  const a = projectReceipts(event({}), context);
  const b = projectReceipts(event({}), context);
  assert.deepEqual(a, b);
  for (const receipt of a) {
    assert.equal(receipt.receiptId, receiptId(receipt.eventId, receipt.holderWallet, receipt.role));
  }
  assert.notEqual(a[0]?.receiptId, a[1]?.receiptId);
});

test("refreshing state never touches identity or chain coordinates", () => {
  const [receipt] = projectReceipts(event({}), context);
  const refreshed = refreshReceiptState(receipt as NonNullable<typeof receipt>, {
    sealState: "settled",
    disputeOpen: false,
    mintEligible: true,
    credentialMint: WALLET_C,
  });
  assert.equal(refreshed.sealState, "settled");
  assert.equal(refreshed.mintEligible, true);
  assert.equal(refreshed.credentialMint, WALLET_C);
  assert.equal(refreshed.receiptId, receipt?.receiptId);
  assert.equal(refreshed.holderWallet, receipt?.holderWallet);
  assert.deepEqual(refreshed.holderGnsRecord, receipt?.holderGnsRecord);
  assert.equal(refreshed.transactionSignature, receipt?.transactionSignature);
});
