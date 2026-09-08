/**
 * The escrow lifecycle, mirrored from `programs/ppv_escrow/src/state/enums.rs`.
 * Clients use it to grey out an illegal action; it is never the authority for
 * one. The program re-checks every transition, and a client that disagrees with
 * the chain simply produces a transaction that fails.
 */

export const AGREEMENT_STATES = [
  "Open",
  "Funded",
  "Completed",
  "Settled",
  // Appended by Phase 5, after the originals, so an index already decoded
  // never comes to mean a different state.
  "Cancelled",
  "Disputed",
  "Refunded",
] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

export const AGREEMENT_TYPES = [
  "Escrow",
  "Invoice",
  "Contract",
  "MilestoneContract",
  "Bounty",
  "ProofOnly",
] as const;
export type AgreementType = (typeof AGREEMENT_TYPES)[number];

/** The agreement types the deployed kernel will actually create. */
export const IMPLEMENTED_AGREEMENT_TYPES: readonly AgreementType[] = [
  "Escrow",
  "MilestoneContract",
  "Bounty",
];

export const PROOF_STATUSES = ["Submitted", "Approved", "Rejected"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export function proofStatusFromIndex(index: number): ProofStatus {
  const status = PROOF_STATUSES[index];
  if (!status) throw new RangeError(`unknown proof status ${index}`);
  return status;
}

export const MILESTONE_STATES = ["Pending", "Submitted", "Approved", "Settled"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export function milestoneStateFromIndex(index: number): MilestoneState {
  const state = MILESTONE_STATES[index];
  if (!state) throw new RangeError(`unknown milestone state ${index}`);
  return state;
}

export const MILESTONE_ACTIONS = [
  "submit_milestone",
  "approve_milestone",
  "reject_milestone",
  "settle_milestone",
] as const;
export type MilestoneAction = (typeof MILESTONE_ACTIONS)[number];

const MILESTONE_TRANSITIONS: Readonly<
  Record<MilestoneAction, { from: MilestoneState; to: MilestoneState }>
> = {
  submit_milestone: { from: "Pending", to: "Submitted" },
  approve_milestone: { from: "Submitted", to: "Approved" },
  // A refusal sends the tranche back to be redone, unlike a proof decision.
  reject_milestone: { from: "Submitted", to: "Pending" },
  settle_milestone: { from: "Approved", to: "Settled" },
};

export const MILESTONE_ACTION_SIGNER: Readonly<
  Record<MilestoneAction, "buyer" | "seller" | "either_party">
> = {
  submit_milestone: "seller",
  approve_milestone: "buyer",
  reject_milestone: "buyer",
  settle_milestone: "either_party",
};

export function isLegalMilestoneTransition(
  state: MilestoneState,
  action: MilestoneAction,
): boolean {
  return MILESTONE_TRANSITIONS[action].from === state;
}

export function milestoneStateAfter(
  state: MilestoneState,
  action: MilestoneAction,
): MilestoneState | null {
  return isLegalMilestoneTransition(state, action) ? MILESTONE_TRANSITIONS[action].to : null;
}

export const DISPUTE_OUTCOMES = ["SellerPaid", "BuyerRefunded"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export function disputeOutcomeFromIndex(index: number): DisputeOutcome {
  const outcome = DISPUTE_OUTCOMES[index];
  if (!outcome) throw new RangeError(`unknown dispute outcome ${index}`);
  return outcome;
}

export const ESCROW_ACTIONS = [
  "select_counterparty",
  "fund",
  "mark_completed",
  "settle",
  "cancel",
  "open_dispute",
  "resolve_dispute",
  "refund",
] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

/** Every action's legal source states and where each one leads. */
const TRANSITIONS: Readonly<
  Record<EscrowAction, { from: readonly AgreementState[]; to: readonly AgreementState[] }>
> = {
  // The one action that does not move the agreement: it fills in the payee a
  // bounty was created without.
  select_counterparty: { from: ["Open", "Funded"], to: ["Open", "Funded"] },
  fund: { from: ["Open"], to: ["Funded"] },
  mark_completed: { from: ["Funded"], to: ["Completed"] },
  settle: { from: ["Completed"], to: ["Settled"] },
  cancel: { from: ["Open"], to: ["Cancelled"] },
  open_dispute: { from: ["Funded", "Completed"], to: ["Disputed"] },
  // The outcome depends on which party concedes, so this is the one action
  // whose destination is not fixed by its source.
  resolve_dispute: { from: ["Disputed"], to: ["Settled", "Refunded"] },
  refund: { from: ["Funded", "Completed"], to: ["Refunded"] },
};

/** Who the program requires as the signer of each action. */
export const ACTION_SIGNER: Readonly<
  Record<EscrowAction, "buyer" | "seller" | "either_party" | "conceding_party">
> = {
  select_counterparty: "buyer",
  fund: "buyer",
  mark_completed: "seller",
  settle: "either_party",
  cancel: "buyer",
  open_dispute: "either_party",
  // The signer gives up its own claim; the money goes to the other party.
  resolve_dispute: "conceding_party",
  refund: "seller",
};

/** Every way an agreement can end: paid, refunded, or abandoned unfunded. */
export function isTerminal(state: AgreementState): boolean {
  return state === "Settled" || state === "Cancelled" || state === "Refunded";
}

export function isLegalTransition(state: AgreementState, action: EscrowAction): boolean {
  return TRANSITIONS[action].from.includes(state);
}

/**
 * Where an action leads, when that is determined by the action alone.
 * `resolve_dispute` returns null even though it is legal, because who receives
 * the money decides where it lands — use `legalActions` to ask what is allowed.
 */
export function stateAfter(state: AgreementState, action: EscrowAction): AgreementState | null {
  if (!isLegalTransition(state, action)) return null;
  const destinations = TRANSITIONS[action].to;
  return destinations.length === 1 ? (destinations[0] as AgreementState) : null;
}

export function legalActions(state: AgreementState): readonly EscrowAction[] {
  return ESCROW_ACTIONS.filter((action) => isLegalTransition(state, action));
}

export function agreementStateFromIndex(index: number): AgreementState {
  const state = AGREEMENT_STATES[index];
  if (!state) throw new RangeError(`unknown agreement state ${index}`);
  return state;
}

export function agreementTypeFromIndex(index: number): AgreementType {
  const type = AGREEMENT_TYPES[index];
  if (!type) throw new RangeError(`unknown agreement type ${index}`);
  return type;
}
