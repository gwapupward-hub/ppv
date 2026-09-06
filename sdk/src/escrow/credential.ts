import {
  resolveSealState,
  type PpvSealState,
  type SealFacts,
} from "../reputation/index.js";
import type { AgreementLifecycle } from "./receipts.js";

/**
 * "PPV Verified", derived from chain state rather than asserted by a product.
 *
 * The words mean exactly one thing: the displayed credential corresponds to a
 * verifiable PPV protocol record at this state. They say nothing about quality,
 * ownership, honesty, or future behaviour — and nothing here can be set by a
 * client, because every field is computed from a lifecycle that was itself
 * rebuilt from committed events.
 *
 * This is the short path: given a reconstructed lifecycle, get the seal without
 * going through the reputation pipeline. It agrees with `deriveSealFacts` by
 * construction, because both read the same facts.
 */

export type EscrowCredential = {
  agreement: string;
  state: PpvSealState;
  facts: SealFacts;
  buyer: string;
  seller: string;
  mint: string;
  /** What was escrowed, paid and returned, in base units. */
  fundedAmount: bigint | null;
  settledAmount: bigint | null;
  refundedAmount: bigint | null;
  /** Approved evidence this history cites, in submission order. */
  approvedProofs: readonly string[];
  /** Receipts a verifier can re-derive from the chain to check this. */
  receiptIds: readonly string[];
  lastSlot: number;
};

export type EscrowCredentialOptions = {
  /**
   * Whether the indexer re-read the agreement account from chain and it matched
   * the reconstructed history. A credential built from events alone is a
   * credential that trusts its own event feed, so this is required rather than
   * defaulted.
   */
  chainVerified: boolean;
};

export function escrowSealFacts(
  lifecycle: AgreementLifecycle,
  options: EscrowCredentialOptions,
): SealFacts {
  const has = (action: string) =>
    lifecycle.receipts.some((receipt) => receipt.action === action);

  // A dispute that was resolved is not open: resolution is terminal here,
  // because the agreement leaves `Disputed` for a terminal state.
  const disputeResolved = has("DISPUTE_RESOLVED");
  const disputeOpen = lifecycle.state === "Disputed";

  return {
    chainVerified: options.chainVerified,
    // Escrow proofs cannot be revoked; only `ppv_core` proofs can, and those
    // are a different object with their own seal.
    proofRevoked: false,
    // Confirmation is the *other* party accepting something: an approved proof,
    // an approved milestone, or a completed settlement. `WorkCompleted` is the
    // seller's own claim and deliberately does not count.
    counterpartyConfirmed:
      lifecycle.proofs.some((proof) => proof.status === "Approved") ||
      lifecycle.milestones.some((milestone) => milestone.state === "Settled") ||
      lifecycle.state === "Settled",
    settled: lifecycle.settledAmount !== null && lifecycle.settledAmount > 0n,
    refunded: lifecycle.refundedAmount !== null && lifecycle.refundedAmount > 0n,
    disputeOpen,
    disputeResolved,
  };
}

export function escrowCredential(
  lifecycle: AgreementLifecycle,
  options: EscrowCredentialOptions,
): EscrowCredential {
  const facts = escrowSealFacts(lifecycle, options);
  return {
    agreement: lifecycle.agreement,
    state: resolveSealState(facts),
    facts,
    buyer: lifecycle.buyer,
    seller: lifecycle.seller,
    mint: lifecycle.mint,
    fundedAmount: lifecycle.fundedAmount,
    settledAmount: lifecycle.settledAmount,
    refundedAmount: lifecycle.refundedAmount,
    approvedProofs: lifecycle.proofs
      .filter((proof) => proof.status === "Approved")
      .map((proof) => proof.proof),
    receiptIds: lifecycle.receipts.map((receipt) => receipt.receiptId),
    lastSlot: lifecycle.lastSlot,
  };
}
