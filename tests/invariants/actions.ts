import type { PublicKey } from "@solana/web3.js";

/**
 * The vocabulary of generated operations.
 *
 * An action is a *description* of a transaction, not a transaction. It is the
 * only thing fast-check ever sees, which is what makes a failing sequence
 * printable, shrinkable, and replayable from a seed. Nothing here knows how to
 * build an instruction; `execute.ts` does that, and `model.ts` independently
 * decides what should happen.
 */

/** Who signs. `attacker` is a funded wallet that is party to nothing. */
export type Actor = "buyer" | "seller" | "attacker";

/**
 * Which kind of agreement the sequence attacks.
 *
 * Chosen once per sequence rather than per action, because an agreement's type
 * is fixed at initialization and the lifecycles genuinely differ: a milestone
 * contract never reaches `Completed`, and a bounty is the only type that may
 * exist without a payee. Generating a flavour per sequence keeps one agreement
 * per sequence — which is what makes conservation measurable and a
 * counterexample readable — while letting the whole action space apply to each.
 */
export type AgreementFlavour = "escrow" | "milestone" | "bounty";

export const AGREEMENT_FLAVOURS: readonly AgreementFlavour[] = [
  "escrow",
  "milestone",
  "bounty",
];

/**
 * Which agreement account the instruction is pointed at.
 *
 * `unrelated` is a real, correctly-initialized agreement between two wallets
 * that never sign in this harness. Substituting it is therefore always an
 * attack and never a legitimate operation on somebody else's escrow, which is
 * what lets the model state "an unrelated agreement never succeeds" as a flat
 * rule and lets the suite assert that account never moves (PPV-P9).
 */
export type AgreementRef = "canonical" | "unrelated";

/** `wrong` is a second mint with the same decimals and no relationship here. */
export type MintRef = "canonical" | "wrong";

/**
 * `otherAgreement` is the unrelated agreement's real vault — correctly formed,
 * wrong relationship. `fake` is an ordinary token account of the right mint
 * owned by the attacker, i.e. a vault that is not a PDA at all.
 */
export type VaultRef = "canonical" | "otherAgreement" | "fake";

/** The PDA asked to sign the vault transfer (PPV-P5). */
export type AuthorityRef = "canonical" | "otherAgreement";

/**
 * Which milestone account the instruction carries.
 *
 * `first` and `second` are this agreement's own tranches. `foreign` is a real
 * milestone of a different milestone contract — correctly formed, wrong
 * relationship, and the account substitution that PPV-M4 and PPV-P9 exist to
 * refuse. There is no "fake" here because a milestone is an Anchor account
 * with a discriminator: a non-PDA fails on deserialization rather than on
 * relationship, which tests Anchor and not this program.
 */
export type MilestoneRef = "first" | "second" | "foreign";

export const MILESTONE_SLOTS = ["first", "second"] as const;

/**
 * A generated milestone allocation.
 *
 * `planned` takes the next tranche of a schedule that sums to exactly the
 * agreement amount, because `fund` refuses a milestone contract whose
 * schedule does not — so a generator that only ever produced arbitrary amounts
 * would never fund one, and the whole lifecycle would be unreachable.
 * `oversized` and `zero` are the two allocations the program must refuse.
 */
export type MilestoneAmountRef = "planned" | "oversized" | "zero";

/**
 * Who a bounty sponsor names as winner. `creator` is the sponsor itself, which
 * the program refuses; naming the attacker is deliberately not generated,
 * because a payee that is the attacker would make "the canonical destination"
 * mean something different for the rest of the sequence and the model would be
 * describing two protocols at once.
 */
export type WinnerRef = "seller" | "creator";

/**
 * A token account by role. `outsider` is the correct mint owned by a wallet
 * that is party to nothing; the `*WrongMint` entries are the wrong mint owned
 * by a party.
 */
export type TokenAccountRef =
  | "buyer"
  | "seller"
  | "attacker"
  | "outsider"
  | "buyerWrongMint"
  | "sellerWrongMint";

/**
 * Every account relationship one generated action can deviate in. Instructions
 * that do not take a given account ignore its field: `mark_completed` and
 * `cancel` carry no custody accounts at all, so their variants describe
 * deviations the chain never sees. Generating them anyway costs nothing and
 * keeps one shape for every action.
 */
export type AccountVariant = {
  agreement: AgreementRef;
  mint: MintRef;
  vault: VaultRef;
  vaultAuthority: AuthorityRef;
  /** `fund`'s debit side. */
  source: TokenAccountRef;
  /** The credit side of every payout. */
  destination: TokenAccountRef;
  /** Which milestone the milestone instructions carry. */
  milestone: MilestoneRef;
};

export type ActionKind =
  | "fund"
  | "complete"
  | "settle"
  | "cancel"
  | "refund"
  | "dispute"
  | "resolve"
  | "createMilestone"
  | "submitMilestone"
  | "approveMilestone"
  | "rejectMilestone"
  | "settleMilestone"
  | "selectWinner";

type Common = { actor: Actor; accounts: AccountVariant };

export type GeneratedAction =
  | ({ kind: "fund" } & Common)
  | ({ kind: "complete" } & Common)
  | ({ kind: "settle" } & Common)
  | ({ kind: "cancel" } & Common)
  | ({ kind: "refund" } & Common)
  | ({ kind: "dispute" } & Common)
  | ({ kind: "resolve" } & Common)
  | ({ kind: "createMilestone"; amount: MilestoneAmountRef } & Common)
  | ({ kind: "submitMilestone" } & Common)
  | ({ kind: "approveMilestone" } & Common)
  | ({ kind: "rejectMilestone" } & Common)
  | ({ kind: "settleMilestone" } & Common)
  | ({ kind: "selectWinner"; winner: WinnerRef } & Common);

/** One sequence: the agreement it attacks, and what it does to it. */
export type Scenario = {
  flavour: AgreementFlavour;
  actions: GeneratedAction[];
};

/** Which accounts an instruction actually reads, for compact reporting. */
const RELEVANT: Record<ActionKind, Array<keyof AccountVariant>> = {
  fund: ["agreement", "mint", "vault", "source"],
  complete: ["agreement"],
  settle: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
  cancel: ["agreement"],
  refund: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
  dispute: ["agreement"],
  resolve: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
  createMilestone: ["agreement"],
  submitMilestone: ["agreement", "milestone"],
  approveMilestone: ["agreement", "milestone"],
  rejectMilestone: ["agreement", "milestone"],
  settleMilestone: [
    "agreement",
    "milestone",
    "mint",
    "vault",
    "vaultAuthority",
    "destination",
  ],
  selectWinner: ["agreement"],
};

/**
 * A one-line rendering of an action, used in counterexample reports. Only the
 * accounts the instruction takes are printed, so a minimized sequence reads as
 * the attack it is rather than as seven fields of noise.
 */
export function describeAction(action: GeneratedAction): string {
  const deviations = RELEVANT[action.kind]
    .map((field) => [field, action.accounts[field]] as const)
    .filter(([field, value]) => value !== canonicalValue(action.kind, field))
    .map(([field, value]) => `${field}=${value}`);
  if (action.kind === "createMilestone") deviations.unshift(`amount=${action.amount}`);
  if (action.kind === "selectWinner") deviations.unshift(`winner=${action.winner}`);
  const suffix = deviations.length === 0 ? "canonical" : deviations.join(" ");
  return `${action.kind}(${action.actor}) [${suffix}]`;
}

/**
 * The value of each variant field that names the agreement's own accounts.
 *
 * `destination` depends on the instruction, because the payout paths do not
 * pay the same party: settlement and milestone release pay the seller, a
 * refund pays the buyer, and a dispute resolution pays whichever party the
 * *other* one conceded to — so neither of its two legal destinations is more
 * canonical than the other. Calling the seller's account "the canonical
 * destination" for a refund would classify every legitimate refund as an
 * attack and quietly inflate the wrong-relationship coverage counter.
 */
function canonicalValue(kind: ActionKind, field: keyof AccountVariant): string {
  switch (field) {
    case "source":
      return "buyer";
    case "destination":
      return kind === "refund" ? "buyer" : "seller";
    case "milestone":
      return "first";
    default:
      return "canonical";
  }
}

/** True when every account this instruction reads is the agreement's own. */
export function isCanonicallyAddressed(action: GeneratedAction): boolean {
  // A resolution has two legal destinations and no canonical one, so it is
  // canonically addressed when it names either party's account in the right
  // mint. Which of the two is legal for a given signer is the model's call,
  // not this function's.
  if (action.kind === "resolve") {
    const destinationIsAParty =
      action.accounts.destination === "buyer" || action.accounts.destination === "seller";
    return (
      destinationIsAParty &&
      RELEVANT.resolve
        .filter((field) => field !== "destination")
        .every((field) => action.accounts[field] === canonicalValue(action.kind, field))
    );
  }
  // Either of this agreement's own tranches is a canonical milestone; only a
  // foreign one is a wrong relationship.
  return RELEVANT[action.kind].every((field) => {
    if (field === "milestone") return action.accounts.milestone !== "foreign";
    return action.accounts[field] === canonicalValue(action.kind, field);
  });
}

export type ActionResult = {
  succeeded: boolean;
  signature?: string;
  errorCode?: string;
  error?: string;
};

/** The addresses one generated action resolves to, recorded for reports. */
export type ResolvedAccounts = Record<string, PublicKey>;
