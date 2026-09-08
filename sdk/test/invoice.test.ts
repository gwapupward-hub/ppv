import assert from "node:assert/strict";
import test from "node:test";

import {
  PPV_INVOICE_SCHEMA_VERSION,
  escrowReceiptFromEvent,
  invoiceCommitment,
  invoiceStatus,
  reconstructAgreementLifecycle,
  verifyInvoice,
  type AgreementLifecycle,
  type CanonicalInvoiceV1,
} from "../src/index.js";
import {
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  addressFromByte,
  signatureFromByte,
} from "./helpers/escrow-events.js";

const PROGRAM_ID = addressFromByte(9);

const INVOICE: CanonicalInvoiceV1 = {
  schema: PPV_INVOICE_SCHEMA_VERSION,
  invoiceNumber: "GWAP-2026-0041",
  issuedAt: "2026-03-01T00:00:00.000Z",
  dueAt: "2026-03-31T00:00:00.000Z",
  issuer: FIXTURE_ADDRESSES.SELLER,
  payer: FIXTURE_ADDRESSES.BUYER,
  mint: FIXTURE_ADDRESSES.MINT,
  totalAmount: "100000000",
  lines: [
    { description: "Design system audit", quantity: "1", unitAmount: "60000000", lineAmount: "60000000" },
    { description: "Implementation review", quantity: "2", unitAmount: "20000000", lineAmount: "40000000" },
  ],
};

function lifecycle(steps = LIFECYCLE_FIXTURE.length): AgreementLifecycle {
  return reconstructAgreementLifecycle(
    LIFECYCLE_FIXTURE.slice(0, steps).map((event, index) =>
      escrowReceiptFromEvent({
        event,
        programId: PROGRAM_ID,
        transactionSignature: signatureFromByte(index + 1),
        slot: 1_000 + index,
        instructionIndex: 0,
        innerInstructionIndex: index,
        blockTime: event.timestamp,
      }),
    ),
  );
}

test("an invoice commits to a hash the escrow can carry", async () => {
  const commitment = await invoiceCommitment(INVOICE);
  assert.match(commitment, /^[0-9a-f]{64}$/);
  // Canonicalization is order-independent, so the same invoice written with its
  // keys in another order is the same invoice.
  const reordered = { ...INVOICE, lines: INVOICE.lines, payer: INVOICE.payer } as CanonicalInvoiceV1;
  assert.equal(await invoiceCommitment(reordered), commitment);
  // And a changed amount is a different invoice.
  assert.notEqual(await invoiceCommitment({ ...INVOICE, totalAmount: "99999999" }), commitment);
});

test("paid means the escrow settled, and nothing else can say so", () => {
  assert.equal(invoiceStatus(lifecycle(1)), "issued");
  assert.equal(invoiceStatus(lifecycle(2)), "funded");
  assert.equal(invoiceStatus(lifecycle(3)), "funded");
  assert.equal(invoiceStatus(lifecycle()), "paid");
});

test("a matching invoice verifies against the escrow that paid it", async () => {
  const commitment = await invoiceCommitment(INVOICE);
  const result = await verifyInvoice(INVOICE, lifecycle(), commitment);
  assert.deepEqual(result, { matches: true, status: "paid", reasons: [] });
});

test("an invoice the escrow did not commit to does not verify", async () => {
  const result = await verifyInvoice(INVOICE, lifecycle(), "00".repeat(32));
  assert.equal(result.matches, false);
  assert.match(result.reasons.join(" "), /not this invoice's commitment/);
});

test("wrong parties, mint or amount are each reported", async () => {
  const commitment = await invoiceCommitment(INVOICE);

  const swapped = await verifyInvoice(
    { ...INVOICE, issuer: FIXTURE_ADDRESSES.BUYER, payer: FIXTURE_ADDRESSES.SELLER },
    lifecycle(),
    commitment,
  );
  assert.equal(swapped.matches, false);
  assert.match(swapped.reasons.join(" "), /issuer is not the escrow's payee/);
  assert.match(swapped.reasons.join(" "), /payer is not the escrow's funder/);

  const wrongMint = await verifyInvoice(
    { ...INVOICE, mint: addressFromByte(50) },
    lifecycle(),
    commitment,
  );
  assert.match(wrongMint.reasons.join(" "), /the invoice is in/);
});

test("an invoice whose lines do not add up is refused before anyone pays it", async () => {
  const broken: CanonicalInvoiceV1 = {
    ...INVOICE,
    lines: [{ description: "Half", quantity: "1", unitAmount: "50000000", lineAmount: "50000000" }],
  };
  const result = await verifyInvoice(broken, lifecycle(), await invoiceCommitment(broken));
  assert.equal(result.matches, false);
  assert.match(result.reasons.join(" "), /lines do not add up/);
});

test("an amount that is not a base-unit integer is refused", async () => {
  // Amounts are strings in base units because JSON numbers lose precision above
  // 2^53, and an invoice is a financial document.
  const broken = { ...INVOICE, totalAmount: "100.5" } as CanonicalInvoiceV1;
  const result = await verifyInvoice(broken, lifecycle(), await invoiceCommitment(broken));
  assert.equal(result.matches, false);
  assert.match(result.reasons.join(" "), /not a base-unit integer/);
});

test("an escrow funded for the wrong amount does not pay this invoice", async () => {
  const cheaper: CanonicalInvoiceV1 = {
    ...INVOICE,
    totalAmount: "60000000",
    lines: [INVOICE.lines[0]!],
  };
  const result = await verifyInvoice(cheaper, lifecycle(), await invoiceCommitment(cheaper));
  assert.equal(result.matches, false);
  assert.match(result.reasons.join(" "), /funded for a different amount/);
});
