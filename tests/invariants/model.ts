import type { PublicKey } from "@solana/web3.js";

import type { AgreementFlavour, GeneratedAction, MilestoneRef } from "./actions";

/**
 * An independent reference model of a `ppv_escrow` agreement.
 *
 * Nothing in this file imports a state-transition helper from the program, and
 * nothing in it is transcribed from one. It is written from the protocol rules
 * as documented — docs/state-machines.md, docs/invariants.md and
 * docs/security/ppv-escrow-surface.md — so that a disagreement between this
 * file and the chain is evidence about the protocol rather than two copies of
 * the same mistake agreeing with each other.
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
  | "cancelled"
  | "disputed"
  | "refunded";

/** One tranche of a milestone contract, as the model understands it. */
export type MilestoneModelState = "absent" | "pending" | "submitted" | "approved" | "settled";

export type MilestoneModel = {
  state: MilestoneModelState;
  allocation: bigint;
};

export type EscrowModel = {
  flavour: AgreementFlavour;
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
  /**
   * Whether the payee is known. Only a bounty may be false, and only until the
   * sponsor names a winner — after which it is as fixed as it is everywhere
   * else, which is PPV-B1.
   */
  payeeAssigned: boolean;
  /** The two tranches a milestone contract may schedule, in order. */
  milestones: [MilestoneModel, MilestoneModel];
  /** Sum of the allocations scheduled so far. */
  milestoneTotal: bigint;
  /** Sum of everything that has left the vault, by any path. */
  releasedTotal: bigint;
};

/**
 * The schedule a milestone contract is generated against.
 *
 * `fund` refuses a milestone contract whose tranches do not sum to exactly the
 * agreement amount, so a generator producing arbitrary allocations would never
 * fund one and the entire milestone lifecycle would be unreachable — the
 * failure RR-1 is about. Two tranches keep the path short enough to be reached
 * inside a generated sequence and still make "release each one exactly once"
 * a claim with more than one case.
 */
export const MILESTONE_SCHEDULE: readonly [bigint, bigint] = [600_000n, 400_000n];

export const TERMINAL_STATES: ReadonlySet<EscrowModelState> = new Set<EscrowModelState>([
  "settled",
  "cancelled",
  "refunded",
]);

/**
 * The only lifecycle edges an agreement may take (PPV-P10). Written as data so
 * the legality check is a lookup rather than a second copy of the decision
 * logic below.
 */
export const LEGAL_EDGES: ReadonlyArray<readonly [EscrowModelState, EscrowModelState]> = [
  ["open", "funded"],
  ["open", "cancelled"],
  ["funded", "completed"],
  ["completed", "settled"],
  // A milestone contract settles when its last tranche is released, straight
  // from `funded`: it never passes through `completed`.
  ["funded", "settled"],
  ["funded", "refunded"],
  ["completed", "refunded"],
  ["funded", "disputed"],
  ["completed", "disputed"],
  ["disputed", "settled"],
  ["disputed", "refunded"],
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

export function emptyMilestones(): [MilestoneModel, MilestoneModel] {
  return [
    { state: "absent", allocation: 0n },
    { state: "absent", allocation: 0n },
  ];
}

/** Which of the two tranches an action names, or null for a foreign one. */
function slotOf(ref: MilestoneRef): 0 | 1 | null {
  if (ref === "first") return 0;
  if (ref === "second") return 1;
  return null;
}

/** Every custody account an instruction that moves money must get right. */
function custodyAccountsAreCanonical(action: GeneratedAction): Prediction | null {
  const { accounts } = action;
  if (accounts.mint !== "canonical") return no("the mint is not the agreement's mint");
  if (accounts.vault !== "canonical") {
    return no(`the vault is not the agreement's vault (${accounts.vault})`);
  }
  if (accounts.vaultAuthority !== "canonical") {
    return no("the vault authority is not the agreement's own");
  }
  return null;
}

/**
 * Does this action satisfy every protocol precondition?
 *
 * The rules, stated once:
 *
 *   * An instruction reaches an agreement only through that agreement's own
 *     accounts. Any account belonging to another agreement, or to no
 *     agreement, is refused (PPV-P5, PPV-P9).
 *   * `fund` is the buyer's, from `Open`, debiting a buyer-owned account in
 *     the agreement's mint. A milestone contract must be fully scheduled.
 *   * `mark_completed` is the seller's, from `Funded`, and never for a
 *     milestone contract.
 *   * `settle` is either party's, from `Completed`, crediting a token account
 *     the *seller* owns (PPV-P4).
 *   * `cancel` is the buyer's, from `Open`, and moves nothing.
 *   * `refund` is the seller's, from `Funded` or `Completed`, crediting the
 *     *buyer* (PPV-D4).
 *   * `open_dispute` is either party's, from `Funded` or `Completed`.
 *   * `resolve_dispute` is either party's, from `Disputed`, crediting the
 *     *other* party (PPV-D2, PPV-D5).
 *   * milestone scheduling is the buyer's, from `Open`, milestone contracts
 *     only, and may never over-promise the escrow (PPV-M1).
 *   * a tranche is submitted by the seller, decided by the buyer, and released
 *     to the seller once (PPV-M3, PPV-M4), only while `Funded`.
 *   * a bounty's winner is named by the sponsor, once, and never replaced
 *     (PPV-B1). Every payee-dependent action needs one to exist.
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
      if (accounts.mint !== "canonical") return no("the mint is not the agreement's mint");
      if (accounts.vault !== "canonical") {
        return no(`the vault is not the agreement's vault (${accounts.vault})`);
      }
      if (accounts.source !== "buyer") {
        return no(
          `the funding source is not a buyer-owned account in the agreement mint (${accounts.source})`,
        );
      }
      // A milestone contract's schedule is fixed before the money arrives and
      // must account for all of it, or tranches could never release it.
      if (model.flavour === "milestone" && model.milestoneTotal !== model.amount) {
        return no(
          `a milestone contract must be fully scheduled before funding (${model.milestoneTotal} of ${model.amount})`,
        );
      }
      if (model.buyerBalance < model.amount) {
        return no("the buyer does not hold the agreed amount");
      }
      return OK;
    }

    case "complete": {
      if (model.flavour === "milestone") {
        return no("a milestone contract has no single moment of completion");
      }
      if (!model.payeeAssigned) return no("the agreement has no payee yet");
      if (model.state !== "funded") {
        return no(`completion requires state funded, model is ${model.state}`);
      }
      if (action.actor !== "seller") {
        return no(`only the seller may mark work complete, actor is ${action.actor}`);
      }
      return OK;
    }

    case "settle": {
      if (!model.payeeAssigned) return no("the agreement has no payee yet");
      if (model.state !== "completed") {
        return no(`settlement requires state completed, model is ${model.state}`);
      }
      if (action.actor !== "buyer" && action.actor !== "seller") {
        return no(`only a party may settle, actor is ${action.actor}`);
      }
      const custody = custodyAccountsAreCanonical(action);
      if (custody) return custody;
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

    case "refund": {
      // The seller's own claim, surrendered. A buyer who wants its money back
      // over the seller's objection has to dispute, which is why this is a
      // separate instruction rather than a branch of one.
      if (!model.payeeAssigned) return no("the agreement has no payee yet");
      if (model.state !== "funded" && model.state !== "completed") {
        return no(`a refund requires escrowed money, model is ${model.state}`);
      }
      if (action.actor !== "seller") {
        return no(`only the seller may refund, actor is ${action.actor}`);
      }
      const custody = custodyAccountsAreCanonical(action);
      if (custody) return custody;
      if (accounts.destination !== "buyer") {
        return no(
          `a refund may only credit a buyer-owned account in the agreement mint (${accounts.destination})`,
        );
      }
      return OK;
    }

    case "dispute": {
      // Either party, over money already escrowed. A dispute is between two
      // parties, so an unclaimed bounty has nobody to have one with.
      if (!model.payeeAssigned) return no("the agreement has no payee yet");
      if (model.state !== "funded" && model.state !== "completed") {
        return no(`a dispute requires escrowed money, model is ${model.state}`);
      }
      if (action.actor !== "buyer" && action.actor !== "seller") {
        return no(`only a party may open a dispute, actor is ${action.actor}`);
      }
      return OK;
    }

    case "resolve": {
      // Concession. The beneficiary is whoever owns the destination, and the
      // signer must not be that party: the only wallet that can send this
      // vault to the seller is the buyer's, and vice versa. Neither can take it.
      if (!model.payeeAssigned) return no("the agreement has no payee yet");
      if (model.state !== "disputed") {
        return no(`resolution requires a dispute, model is ${model.state}`);
      }
      if (action.actor !== "buyer" && action.actor !== "seller") {
        return no(`only a party may resolve a dispute, actor is ${action.actor}`);
      }
      const custody = custodyAccountsAreCanonical(action);
      if (custody) return custody;
      if (accounts.destination !== "buyer" && accounts.destination !== "seller") {
        return no(
          `a resolution may only credit a party's account in the agreement mint (${accounts.destination})`,
        );
      }
      if (accounts.destination === action.actor) {
        return no("a party cannot concede a dispute to itself");
      }
      return OK;
    }

    case "createMilestone": {
      if (model.flavour !== "milestone") {
        return no(`only a milestone contract has tranches, this is a ${model.flavour}`);
      }
      if (model.state !== "open") {
        return no(`the schedule is fixed while open, model is ${model.state}`);
      }
      if (action.actor !== "buyer") {
        return no(`only the buyer may schedule a tranche, actor is ${action.actor}`);
      }
      const next = model.milestones.findIndex((milestone) => milestone.state === "absent");
      if (next === -1) {
        // A third `create_milestone` would derive an account this harness does
        // not track. The program allows it; the schedule cap refuses it once
        // the budget is spent, which is the case that matters here.
        return no("both tranches of this harness's schedule already exist");
      }
      const allocation = allocationFor(action, next);
      if (allocation === 0n) return no("a tranche must be worth more than zero");
      if (model.milestoneTotal + allocation > model.amount) {
        return no(
          `the schedule would promise ${model.milestoneTotal + allocation} of ${model.amount}`,
        );
      }
      return OK;
    }

    case "submitMilestone":
    case "approveMilestone":
    case "rejectMilestone":
    case "settleMilestone": {
      if (model.flavour !== "milestone") {
        return no(`only a milestone contract has tranches, this is a ${model.flavour}`);
      }
      // Tranche work happens against escrowed money and stops for anything
      // else: a disputed, refunded or settled contract releases nothing.
      if (model.state !== "funded") {
        return no(`tranche work requires state funded, model is ${model.state}`);
      }
      const slot = slotOf(accounts.milestone);
      if (slot === null) {
        return no("the milestone belongs to a different agreement");
      }
      const milestone = model.milestones[slot];
      if (milestone.state === "absent") {
        return no(`tranche ${slot} was never scheduled`);
      }

      if (action.kind === "submitMilestone") {
        if (action.actor !== "seller") {
          return no(`only the seller may submit a tranche, actor is ${action.actor}`);
        }
        if (milestone.state !== "pending") {
          return no(`tranche ${slot} is ${milestone.state}, not pending`);
        }
        return OK;
      }
      if (action.kind === "approveMilestone" || action.kind === "rejectMilestone") {
        if (action.actor !== "buyer") {
          return no(`only the buyer may decide a tranche, actor is ${action.actor}`);
        }
        if (milestone.state !== "submitted") {
          return no(`tranche ${slot} is ${milestone.state}, not submitted`);
        }
        return OK;
      }
      // settleMilestone
      if (action.actor !== "buyer" && action.actor !== "seller") {
        return no(`only a party may release a tranche, actor is ${action.actor}`);
      }
      if (milestone.state !== "approved") {
        return no(`tranche ${slot} is ${milestone.state}, not approved`);
      }
      const custody = custodyAccountsAreCanonical(action);
      if (custody) return custody;
      if (accounts.destination !== "seller") {
        return no(
          `a tranche may only credit a seller-owned account in the agreement mint (${accounts.destination})`,
        );
      }
      if (milestone.allocation > model.amount - model.releasedTotal) {
        return no("the tranche is larger than the vault still owes");
      }
      return OK;
    }

    case "selectWinner": {
      if (model.flavour !== "bounty") {
        return no(`only a bounty names a winner, this is a ${model.flavour}`);
      }
      if (action.actor !== "buyer") {
        return no(`only the sponsor may name a winner, actor is ${action.actor}`);
      }
      // Once, and never again. This is PPV-B1, and it is the whole safety of
      // letting a bounty exist without a payee in the first place.
      if (model.payeeAssigned) return no("this bounty already has a winner");
      if (model.state !== "open" && model.state !== "funded") {
        return no(`a winner may be named while open or funded, model is ${model.state}`);
      }
      if (action.winner === "creator") {
        return no("the sponsor cannot name itself");
      }
      return OK;
    }
  }
}

/** The allocation a generated `createMilestone` asks for. */
export function allocationFor(
  action: Extract<GeneratedAction, { kind: "createMilestone" }>,
  slot: number,
): bigint {
  switch (action.amount) {
    case "planned":
      return MILESTONE_SCHEDULE[slot] ?? 0n;
    case "oversized":
      // The whole budget. Legal as a first tranche only if nothing else is
      // scheduled, which is exactly the boundary PPV-M1 draws.
      return 1_000_000n;
    case "zero":
      return 0n;
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
      return paid(model, "settled", "seller", model.amount - model.releasedTotal);
    case "cancel":
      return { ...model, state: "cancelled" };
    case "refund":
      return paid(model, "refunded", "buyer", model.amount - model.releasedTotal);
    case "dispute":
      return { ...model, state: "disputed" };
    case "resolve": {
      // The destination decides both where the money went and how the
      // agreement ends, because on chain they are one fact: the account's
      // owner. Two facts that could disagree is how a resolution pays one
      // party and records the other.
      const toSeller = action.accounts.destination === "seller";
      return paid(
        model,
        toSeller ? "settled" : "refunded",
        toSeller ? "seller" : "buyer",
        model.amount - model.releasedTotal,
      );
    }
    case "createMilestone": {
      const slot = model.milestones.findIndex((milestone) => milestone.state === "absent");
      const allocation = allocationFor(action, slot);
      const milestones = [...model.milestones] as [MilestoneModel, MilestoneModel];
      milestones[slot] = { state: "pending", allocation };
      return { ...model, milestones, milestoneTotal: model.milestoneTotal + allocation };
    }
    case "submitMilestone":
      return withMilestone(model, action, "submitted");
    case "approveMilestone":
      return withMilestone(model, action, "approved");
    case "rejectMilestone":
      // A refusal returns the tranche to pending so the seller can try again —
      // unlike a proof decision, which is about fixed bytes and is final.
      return withMilestone(model, action, "pending");
    case "settleMilestone": {
      const slot = slotOf(action.accounts.milestone) as 0 | 1;
      const allocation = model.milestones[slot].allocation;
      const advanced = withMilestone(model, action, "settled");
      const released = advanced.releasedTotal + allocation;
      // The agreement itself finishes when the last tranche is paid.
      const finished = advanced.milestones.every((milestone) => milestone.state === "settled");
      return {
        ...advanced,
        state: finished ? "settled" : advanced.state,
        releasedTotal: released,
        vaultBalance: advanced.vaultBalance - allocation,
        sellerBalance: advanced.sellerBalance + allocation,
        settlementCount: advanced.settlementCount + 1,
      };
    }
    case "selectWinner":
      return { ...model, payeeAssigned: true };
  }
}

function withMilestone(
  model: EscrowModel,
  action: GeneratedAction,
  state: MilestoneModelState,
): EscrowModel {
  const slot = slotOf(action.accounts.milestone) as 0 | 1;
  const milestones = [...model.milestones] as [MilestoneModel, MilestoneModel];
  milestones[slot] = { ...milestones[slot], state };
  return { ...model, milestones };
}

/** One payout, recorded the same way whichever instruction made it. */
function paid(
  model: EscrowModel,
  state: EscrowModelState,
  to: "buyer" | "seller",
  amount: bigint,
): EscrowModel {
  return {
    ...model,
    state,
    vaultBalance: model.vaultBalance - amount,
    buyerBalance: to === "buyer" ? model.buyerBalance + amount : model.buyerBalance,
    sellerBalance: to === "seller" ? model.sellerBalance + amount : model.sellerBalance,
    releasedTotal: model.releasedTotal + amount,
    settlementCount: to === "seller" ? model.settlementCount + 1 : model.settlementCount,
  };
}

/** A compact, diffable rendering of the model, for counterexample reports. */
export function describeModel(model: EscrowModel): Record<string, string> {
  return {
    flavour: model.flavour,
    state: model.state,
    amount: model.amount.toString(),
    payeeAssigned: String(model.payeeAssigned),
    milestones: model.milestones
      .map((milestone, index) => `${index}:${milestone.state}@${milestone.allocation}`)
      .join(" "),
    milestoneTotal: model.milestoneTotal.toString(),
    releasedTotal: model.releasedTotal.toString(),
    buyerBalance: model.buyerBalance.toString(),
    sellerBalance: model.sellerBalance.toString(),
    attackerBalance: model.attackerBalance.toString(),
    vaultBalance: model.vaultBalance.toString(),
    settlementCount: String(model.settlementCount),
  };
}
