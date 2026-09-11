import type { PublicKey } from "@solana/web3.js";

import type { GeneratedAction } from "./actions";

/**
 * An independent reference model of an ordinary `AgreementType::Escrow`.
 *
 * Nothing in this file imports a state-transition helper from the program, and
 * nothing in it is transcribed from one. It is written from the protocol rules
 * as documented — docs/state-machines.md and docs/invariants.md — so that a
 * disagreement between this file and the chain is evidence about the protocol
 * rather than two copies of the same mistake agreeing with each other.
 *
 * The model answers exactly one question per action: *should this have
 * succeeded?* Everything else — error codes, compute units, event payloads —
 * is the chain's business and is observed, not predicted.
 */

export type EscrowModelState =
  | "open"
  | "funded"
  | "completed"
  | "settled"
  | "cancelled";

export type EscrowModel = {
  state: EscrowModelState;
  amount: bigint;
  buyer: PublicKey;
  seller: PublicKey;
  mint: PublicKey;
  buyerBalance: bigint;
  sellerBalance: bigint;
  attackerBalance: bigint;
  vaultBalance: bigint;
  settlementCount: number;
};

export const TERMINAL_STATES: ReadonlySet<EscrowModelState> = new Set<EscrowModelState>([
  "settled",
  "cancelled",
]);

/**
 * The only lifecycle edges an ordinary escrow may take (PPV-P10). Written as
 * data so the legality check is a lookup rather than a second copy of the
 * decision logic below.
 */
export const LEGAL_EDGES: ReadonlyArray<readonly [EscrowModelState, EscrowModelState]> = [
  ["open", "funded"],
  ["open", "cancelled"],
  ["funded", "completed"],
  ["completed", "settled"],
];

export function isLegalEdge(from: EscrowModelState, to: EscrowModelState): boolean {
  return LEGAL_EDGES.some(([a, b]) => a === from && b === to);
}

export type Prediction = {
  succeeds: boolean;
  /** Why, in the model's own words. Reported on divergence. */
  reason: string;
};

const OK: Prediction = { succeeds: true, reason: "every precondition holds" };

function no(reason: string): Prediction {
  return { succeeds: false, reason };
}

/**
 * Does this action satisfy every protocol precondition?
 *
 * The rules, stated once:
 *
 *   * An instruction reaches an agreement only through that agreement's own
 *     accounts. Any account belonging to another agreement, or to no agreement,
 *     is refused (PPV-P5, PPV-P9).
 *   * `fund` is the buyer's, from `Open`, debiting a token account the buyer
 *     owns in the agreement's mint.
 *   * `mark_completed` is the seller's, from `Funded`.
 *   * `settle` is either party's, from `Completed`, crediting a token account
 *     the *seller* owns in the agreement's mint (PPV-P4).
 *   * `cancel` is the buyer's, from `Open`, and moves nothing.
 *
 * Nothing else succeeds, ever.
 */
export function predict(model: EscrowModel, action: GeneratedAction): Prediction {
  const { accounts } = action;

  // An agreement account that is not this agreement is never reachable: the
  // unrelated agreement's parties never sign here, and its own accounts are
  // never presented alongside it.
  if (accounts.agreement !== "canonical") {
    return no("the instruction names an unrelated agreement account");
  }

  switch (action.kind) {
    case "fund": {
      if (model.state !== "open") {
        return no(`funding requires state open, model is ${model.state}`);
      }
      if (action.actor !== "buyer") {
        return no(`only the buyer may fund, actor is ${action.actor}`);
      }
      if (accounts.mint !== "canonical") {
        return no("the mint is not the agreement's mint");
      }
      if (accounts.vault !== "canonical") {
        return no(`the vault is not the agreement's vault (${accounts.vault})`);
      }
      if (accounts.source !== "buyer") {
        return no(
          `the funding source is not a buyer-owned account in the agreement mint (${accounts.source})`,
        );
      }
      if (model.buyerBalance < model.amount) {
        return no("the buyer does not hold the agreed amount");
      }
      return OK;
    }

    case "complete": {
      if (model.state !== "funded") {
        return no(`completion requires state funded, model is ${model.state}`);
      }
      if (action.actor !== "seller") {
        return no(`only the seller may mark work complete, actor is ${action.actor}`);
      }
      return OK;
    }

    case "settle": {
      if (model.state !== "completed") {
        return no(`settlement requires state completed, model is ${model.state}`);
      }
      if (action.actor !== "buyer" && action.actor !== "seller") {
        return no(`only a party may settle, actor is ${action.actor}`);
      }
      if (accounts.mint !== "canonical") {
        return no("the mint is not the agreement's mint");
      }
      if (accounts.vault !== "canonical") {
        return no(`the vault is not the agreement's vault (${accounts.vault})`);
      }
      if (accounts.vaultAuthority !== "canonical") {
        return no("the vault authority is not the agreement's own");
      }
      if (accounts.destination !== "seller") {
        return no(
          `settlement may only credit a seller-owned account in the agreement mint (${accounts.destination})`,
        );
      }
      return OK;
    }

    case "cancel": {
      if (model.state !== "open") {
        return no(`cancellation requires state open, model is ${model.state}`);
      }
      if (action.actor !== "buyer") {
        return no(`only the buyer may cancel, actor is ${action.actor}`);
      }
      return OK;
    }
  }
}

/**
 * The model's own transition. Called only for an action the model predicted
 * would succeed *and* that the chain agreed succeeded; a divergence is reported
 * before anything here runs, so the model never advances on a disputed fact.
 */
export function applySuccess(model: EscrowModel, action: GeneratedAction): EscrowModel {
  switch (action.kind) {
    case "fund":
      return {
        ...model,
        state: "funded",
        buyerBalance: model.buyerBalance - model.amount,
        vaultBalance: model.vaultBalance + model.amount,
      };
    case "complete":
      return { ...model, state: "completed" };
    case "settle":
      return {
        ...model,
        state: "settled",
        vaultBalance: model.vaultBalance - model.amount,
        sellerBalance: model.sellerBalance + model.amount,
        settlementCount: model.settlementCount + 1,
      };
    case "cancel":
      return { ...model, state: "cancelled" };
  }
}

/** A compact, diffable rendering of the model, for counterexample reports. */
export function describeModel(model: EscrowModel): Record<string, string> {
  return {
    state: model.state,
    amount: model.amount.toString(),
    buyerBalance: model.buyerBalance.toString(),
    sellerBalance: model.sellerBalance.toString(),
    attackerBalance: model.attackerBalance.toString(),
    vaultBalance: model.vaultBalance.toString(),
    settlementCount: String(model.settlementCount),
  };
}
