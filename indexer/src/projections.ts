import {
  escrowReceiptFromEvent,
  reconstructAgreementLifecycle,
  type AgreementLifecycle,
  type EscrowEventEnvelope,
  type PpvEscrowReceiptV1,
} from "@gwap/ppv-sdk";

/**
 * An idempotent receipt store and the agreement projections built from it.
 *
 * Delivery is at-least-once and unordered whichever way an indexer is fed —
 * webhook, RPC backfill, or a replay after an outage. The store therefore keys
 * on the receipt id, which is a pure function of chain coordinates: the same
 * transaction seen a hundred times is one receipt, and the store converges on
 * the same contents no matter what order it saw things in.
 */
export class ReceiptStore {
  private readonly receipts = new Map<string, PpvEscrowReceiptV1>();

  get size(): number {
    return this.receipts.size;
  }

  /** Returns true when this receipt was new to the store. */
  add(receipt: PpvEscrowReceiptV1): boolean {
    const existing = this.receipts.get(receipt.receiptId);
    if (existing) {
      // A receipt id that resolves to different content means one of the two
      // did not come from the transaction it claims. Refuse both rather than
      // pick a winner.
      if (existing.action !== receipt.action || existing.agreement !== receipt.agreement) {
        throw new Error(`receipt ${receipt.receiptId} replayed with different content`);
      }
      return false;
    }
    this.receipts.set(receipt.receiptId, receipt);
    return true;
  }

  addEvent(envelope: EscrowEventEnvelope): boolean {
    return this.add(escrowReceiptFromEvent(envelope));
  }

  addEvents(envelopes: readonly EscrowEventEnvelope[]): number {
    let added = 0;
    for (const envelope of envelopes) if (this.addEvent(envelope)) added += 1;
    return added;
  }

  all(): PpvEscrowReceiptV1[] {
    return [...this.receipts.values()];
  }

  forAgreement(agreement: string): PpvEscrowReceiptV1[] {
    return this.all().filter((receipt) => receipt.agreement === agreement);
  }

  /** Rebuilt lifecycles, keyed by agreement address. */
  project(): Map<string, AgreementLifecycle> {
    const grouped = new Map<string, PpvEscrowReceiptV1[]>();
    for (const receipt of this.receipts.values()) {
      const bucket = grouped.get(receipt.agreement);
      if (bucket) bucket.push(receipt);
      else grouped.set(receipt.agreement, [receipt]);
    }

    const projections = new Map<string, AgreementLifecycle>();
    for (const [agreement, receipts] of grouped) {
      projections.set(agreement, reconstructAgreementLifecycle(receipts));
    }
    return projections;
  }

  projectAgreement(agreement: string): AgreementLifecycle {
    return reconstructAgreementLifecycle(this.forAgreement(agreement));
  }
}
