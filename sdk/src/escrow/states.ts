/**
 * The escrow lifecycle, mirrored from `programs/ppv_escrow/src/state/enums.rs`.
 * Clients use it to grey out an illegal action; it is never the authority for
 * one. The program re-checks every transition, and a client that disagrees with
 * the chain simply produces a transaction that fails.
 */

export const AGREEMENT_STATES = ["Open", "Funded", "Completed", "Settled"] as const;
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
export const IMPLEMENTED_AGREEMENT_TYPES: readonly AgreementType[] = ["Escrow"];

export const ESCROW_ACTIONS = ["fund", "mark_completed", "settle"] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

const TRANSITIONS: Readonly<Record<EscrowAction, { from: AgreementState; to: AgreementState }>> = {
  fund: { from: "Open", to: "Funded" },
  mark_completed: { from: "Funded", to: "Completed" },
  settle: { from: "Completed", to: "Settled" },
};

/** Who the program requires as the signer of each action. */
export const ACTION_SIGNER: Readonly<Record<EscrowAction, "buyer" | "seller" | "either_party">> = {
  fund: "buyer",
  mark_completed: "seller",
  settle: "either_party",
};

export function isTerminal(state: AgreementState): boolean {
  return state === "Settled";
}

export function isLegalTransition(state: AgreementState, action: EscrowAction): boolean {
  return TRANSITIONS[action].from === state;
}

export function stateAfter(state: AgreementState, action: EscrowAction): AgreementState | null {
  return isLegalTransition(state, action) ? TRANSITIONS[action].to : null;
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
