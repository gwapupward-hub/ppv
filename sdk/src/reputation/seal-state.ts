import type { PpvSealState, ReputationEventV1 } from "./contracts.js";

/**
 * Seal state is a pure function of the facts PPV has recorded. It is never
 * stored from a client and never overridden by a product. The words
 * "PPV Verified / Stamped & Guaranteed" mean exactly one thing: the displayed
 * credential corresponds to a verifiable PPV protocol record at this state.
 * They say nothing about quality, ownership, honesty or future behaviour.
 */
export type SealFacts = {
  /** The indexer re-read the proof or agreement account from chain and it matched. */
  chainVerified: boolean;
  proofRevoked: boolean;
  /** Both parties signed the current version, or a milestone was approved. */
  counterpartyConfirmed: boolean;
  /** Value settled: settlement completed, invoice paid, or a milestone released. */
  settled: boolean;
  /** Money went back to the buyer. Never implies settlement. */
  refunded: boolean;
  disputeOpen: boolean;
  disputeResolved: boolean;
};

export const EMPTY_SEAL_FACTS: SealFacts = {
  chainVerified: false,
  proofRevoked: false,
  counterpartyConfirmed: false,
  settled: false,
  refunded: false,
  disputeOpen: false,
  disputeResolved: false,
};

/**
 * Folds every known event for one proof or agreement into seal facts. Order of
 * delivery does not matter: the fold is commutative for every flag except the
 * dispute pair, which is resolved by comparing the latest open against the
 * latest resolution.
 */
export function deriveSealFacts(
  events: readonly ReputationEventV1[],
  options: { chainVerified: boolean },
): SealFacts {
  let lastDisputeOpened: string | null = null;
  let lastDisputeResolved: string | null = null;
  const facts: SealFacts = { ...EMPTY_SEAL_FACTS, chainVerified: options.chainVerified };

  for (const event of events) {
    switch (event.eventType) {
      case "proof.revoked":
        facts.proofRevoked = true;
        break;
      // Confirmation means the *other* party accepted something. Approving a
      // proof or a milestone is that; executing a signed agreement is that.
      case "agreement.executed":
      case "milestone.approved":
      case "proof.approved":
        facts.counterpartyConfirmed = true;
        break;
      case "invoice.paid":
      case "settlement.completed":
      case "milestone.settled":
        facts.counterpartyConfirmed = true;
        facts.settled = true;
        break;
      case "agreement.refunded":
        facts.refunded = true;
        break;
      case "dispute.opened":
        if (!lastDisputeOpened || event.occurredAt > lastDisputeOpened) lastDisputeOpened = event.occurredAt;
        break;
      case "dispute.resolved":
        if (!lastDisputeResolved || event.occurredAt > lastDisputeResolved) lastDisputeResolved = event.occurredAt;
        break;

      // Everything below is deliberately not seal-relevant, and the switch is
      // exhaustive so that adding a reputation event type forces this decision
      // to be made rather than silently defaulting to "ignore".
      //
      // `work.completed` is the seller's own claim that it finished. A
      // credential that treated it as confirmation would let one party stamp
      // itself. `proof.rejected` and `milestone.rejected` withhold confirmation
      // rather than granting it, and there is nothing to un-set: only an
      // approval ever sets the flag. The rest record that something was created
      // or proposed, which is not yet anyone agreeing to it.
      case "proof.created":
      case "proof.submitted":
      case "proof.rejected":
      case "agreement.created":
      case "agreement.revised":
      case "agreement.signed":
      case "agreement.cancelled":
      case "escrow.funded":
      case "milestone.created":
      case "milestone.delivered":
      case "milestone.rejected":
      case "work.completed":
        break;
    }
  }

  facts.disputeResolved = lastDisputeResolved !== null;
  facts.disputeOpen =
    lastDisputeOpened !== null && (lastDisputeResolved === null || lastDisputeOpened > lastDisputeResolved);
  return facts;
}

export function resolveSealState(facts: SealFacts): PpvSealState {
  if (facts.proofRevoked) return "revoked";
  if (facts.disputeResolved && !facts.disputeOpen) return "dispute_resolved";
  if (facts.settled) return "settled";
  if (facts.counterpartyConfirmed) return "counterparty_confirmed";
  if (facts.chainVerified) return "verified";
  return "recorded";
}

/** Ladder position used for display ordering only. `revoked` deliberately ranks lowest. */
export function sealRank(state: PpvSealState): number {
  switch (state) {
    case "revoked":
      return -1;
    case "recorded":
      return 0;
    case "verified":
      return 1;
    case "counterparty_confirmed":
      return 2;
    case "settled":
      return 3;
    case "dispute_resolved":
      return 4;
  }
}
