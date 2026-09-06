import { hashDocumentHexV1 } from "../canonical.js";
import type { AgreementLifecycle } from "../escrow/receipts.js";

/**
 * An invoice, composed rather than invented.
 *
 * PPV has no invoice account, no invoice instruction, and no invoice state
 * machine. An invoice is a *document* whose canonical hash is the terms hash of
 * an ordinary escrow agreement, and "paid" is what the escrow's own settlement
 * already means. Building an on-chain invoice type would duplicate the escrow's
 * authorization model with the roles renamed — a second custody surface for a
 * difference that is presentational.
 *
 * The flow, and its one wrinkle:
 *
 * ```text
 * issuer drafts invoice ──> canonical hash ──> payer creates escrow with that
 *                                              terms hash, and funds it
 *                                                     │
 *                          issuer acknowledges  <─────┘  mark_completed()
 *                                    │
 *                                    ▼  settle()
 *                          issuer is paid, receipt reconstructible
 * ```
 *
 * The wrinkle: the *payer* creates and funds the agreement, because the escrow
 * kernel's creator is its buyer. An invoice is issued by the seller, so the
 * document travels off chain and the payer escrows against its hash. That is a
 * real difference from a system where the issuer opens the record, and it is
 * the honest one to live with: making the issuer the creator would mean a
 * second funding path where the counterparty pays, and two funding paths is
 * exactly the kind of custody surface this protocol is trying not to have.
 */

export const PPV_INVOICE_SCHEMA_VERSION = "ppv-invoice:v1";

/**
 * Amounts are strings in the mint's base units, not numbers: an invoice is a
 * financial document and JSON numbers lose precision above 2^53.
 */
export type InvoiceLineV1 = {
  description: string;
  quantity: string;
  unitAmount: string;
  lineAmount: string;
};

export type CanonicalInvoiceV1 = {
  schema: typeof PPV_INVOICE_SCHEMA_VERSION;
  invoiceNumber: string;
  issuedAt: string;
  dueAt: string;
  /** The wallet being paid. */
  issuer: string;
  /** The wallet expected to pay. */
  payer: string;
  /** SPL mint the invoice is denominated in. */
  mint: string;
  /** Total in the mint's base units. Must equal the escrow's amount. */
  totalAmount: string;
  lines: readonly InvoiceLineV1[];
  memo?: string;
};

/** The hash an escrow agreement's `terms_hash` must equal to carry this invoice. */
export async function invoiceCommitment(invoice: CanonicalInvoiceV1): Promise<string> {
  return hashDocumentHexV1(invoice);
}

export type InvoiceStatus = "issued" | "funded" | "paid" | "refunded" | "cancelled";

/**
 * What the chain says happened to the invoice. Derived from the agreement's own
 * state, never from a database row: "paid" means an escrow settled, and nothing
 * else can make it say so.
 */
export function invoiceStatus(lifecycle: AgreementLifecycle): InvoiceStatus {
  switch (lifecycle.state) {
    case "Open":
      return "issued";
    case "Funded":
    case "Completed":
    case "Disputed":
      return "funded";
    case "Settled":
      return "paid";
    case "Refunded":
      return "refunded";
    case "Cancelled":
      return "cancelled";
  }
}

export type InvoiceVerification = {
  matches: boolean;
  status: InvoiceStatus;
  /** Empty when the document and the chain agree. */
  reasons: readonly string[];
};

/**
 * Checks that an invoice document is the one a given escrow was funded
 * against — the same discipline as the contract binding, for the same reason:
 * a hash on chain says *that* something was agreed, and only re-hashing the
 * document says *what*.
 */
export async function verifyInvoice(
  invoice: CanonicalInvoiceV1,
  lifecycle: AgreementLifecycle,
  escrowTermsHash: string,
): Promise<InvoiceVerification> {
  const reasons: string[] = [];

  const commitment = await invoiceCommitment(invoice);
  if (commitment !== escrowTermsHash) {
    reasons.push("the escrow's terms hash is not this invoice's commitment");
  }
  if (invoice.mint !== lifecycle.mint) {
    reasons.push(`the invoice is in ${invoice.mint}, the escrow in ${lifecycle.mint}`);
  }
  if (invoice.issuer !== lifecycle.seller) {
    reasons.push("the invoice's issuer is not the escrow's payee");
  }
  if (invoice.payer !== lifecycle.buyer) {
    reasons.push("the invoice's payer is not the escrow's funder");
  }

  const total = parseBaseUnits(invoice.totalAmount, "totalAmount", reasons);
  const lineSum = invoice.lines.reduce<bigint | null>((sum, line, index) => {
    const amount = parseBaseUnits(line.lineAmount, `lines[${index}].lineAmount`, reasons);
    return sum === null || amount === null ? null : sum + amount;
  }, 0n);
  if (total !== null && lineSum !== null && total !== lineSum) {
    reasons.push("the invoice lines do not add up to its total");
  }
  if (total !== null && lifecycle.fundedAmount !== null && total !== lifecycle.fundedAmount) {
    reasons.push("the escrow was funded for a different amount than the invoice asks");
  }
  if (total !== null && lifecycle.settledAmount !== null && total !== lifecycle.settledAmount) {
    reasons.push("the amount paid is not the amount invoiced");
  }

  return { matches: reasons.length === 0, status: invoiceStatus(lifecycle), reasons };
}

function parseBaseUnits(value: string, field: string, reasons: string[]): bigint | null {
  if (!/^\d+$/.test(value)) {
    reasons.push(`${field} is not a base-unit integer`);
    return null;
  }
  return BigInt(value);
}
