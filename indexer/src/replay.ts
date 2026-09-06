import {
  deriveAgreementAddresses,
  type AgreementLifecycle,
  type EscrowEventEnvelope,
} from "@gwap/ppv-sdk";

import { deriveEventAuthority, extractEscrowEvents } from "./events.js";
import { ReceiptStore } from "./projections.js";
import type { ChainSource, RpcSignatureEntry } from "./rpc.js";

/**
 * Replay: the Phase 2 definition of done, expressed as a function.
 *
 * Given a program id, an agreement address, and any Solana RPC endpoint, this
 * rebuilds that agreement's entire lifecycle — who took part, what state it
 * reached, what funds moved, and the receipt for every transition — with no
 * access to a GWAP database. If this function disagrees with a PPV product's
 * screen, the function is right.
 */

export type ReplayOptions = {
  programId: string;
  /** Stop paging once the history reaches this signature (exclusive). */
  until?: string;
  /** Signatures fetched per page. */
  pageSize?: number;
  /** Safety valve for an address with an unexpectedly long history. */
  maxSignatures?: number;
};

export type ReplayResult = {
  agreement: string;
  lifecycle: AgreementLifecycle;
  /** Every event found, in the order the chain produced them. */
  events: EscrowEventEnvelope[];
  /** Transactions read, including those that carried no PPV event. */
  transactionsScanned: number;
  /** Transactions skipped because they failed and therefore committed nothing. */
  failedTransactionsSkipped: number;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_SIGNATURES = 10_000;

/**
 * Collects an address's signatures oldest-first. The RPC returns them newest
 * first and pages backwards, so the whole history is gathered before anything
 * is read: an agreement has a bounded number of transactions by construction,
 * and reconstruction needs the creation transaction to mean anything.
 */
export async function signatureHistory(
  source: ChainSource,
  address: string,
  options?: ReplayOptions,
): Promise<RpcSignatureEntry[]> {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxSignatures = options?.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const collected: RpcSignatureEntry[] = [];
  let before: string | undefined;

  for (;;) {
    const page = await source.signaturesForAddress(address, {
      ...(before ? { before } : {}),
      limit: pageSize,
    });
    if (page.length === 0) break;

    for (const entry of page) {
      if (options?.until && entry.signature === options.until) {
        return collected.reverse();
      }
      collected.push(entry);
    }
    if (collected.length >= maxSignatures) {
      throw new Error(`${address} has more than ${maxSignatures} signatures; raise maxSignatures`);
    }
    if (page.length < pageSize) break;
    before = page[page.length - 1]?.signature;
    if (!before) break;
  }

  return collected.reverse();
}

export async function replayAgreement(
  source: ChainSource,
  agreement: string,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const eventAuthority = deriveEventAuthority(options.programId);
  const history = await signatureHistory(source, agreement, options);
  const store = new ReceiptStore();
  const events: EscrowEventEnvelope[] = [];
  let transactionsScanned = 0;
  let failedTransactionsSkipped = 0;

  for (const entry of history) {
    // The signature listing already reports failures. Reading the transaction
    // anyway would be wasted work, and extraction refuses it a second time.
    if (entry.err != null) {
      failedTransactionsSkipped += 1;
      continue;
    }

    const tx = await source.transaction(entry.signature);
    if (!tx) continue;
    transactionsScanned += 1;

    for (const envelope of extractEscrowEvents(tx, {
      programId: options.programId,
      eventAuthority,
    })) {
      // One transaction can legitimately touch several agreements. Only this
      // agreement's events belong in this replay.
      if (envelope.event.agreement !== agreement) continue;
      events.push(envelope);
      store.addEvent(envelope);
    }
  }

  if (events.length === 0) {
    // The overwhelmingly common cause is the wrong program id, and the bare
    // "no receipts" that reconstruction would raise sends the reader looking
    // at the agreement instead.
    throw new Error(
      `no ${options.programId} events for ${agreement} in ${transactionsScanned} transactions` +
        `${failedTransactionsSkipped > 0 ? ` (${failedTransactionsSkipped} failed and skipped)` : ""}`,
    );
  }

  return {
    agreement,
    lifecycle: store.projectAgreement(agreement),
    events,
    transactionsScanned,
    failedTransactionsSkipped,
  };
}

/**
 * The same replay addressed the way a user thinks about it: "creator X's
 * agreement number 42". The address is derived, never looked up.
 */
export async function replayAgreementById(
  source: ChainSource,
  creator: string,
  agreementId: bigint | number,
  options: ReplayOptions,
): Promise<ReplayResult> {
  const { agreement } = deriveAgreementAddresses(options.programId, creator, agreementId);
  return replayAgreement(source, agreement, options);
}
