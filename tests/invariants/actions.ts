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
  /** `settle`'s credit side. */
  destination: TokenAccountRef;
};

export type ActionKind =
  | "fund"
  | "complete"
  | "settle"
  | "cancel"
  | "refund"
  | "dispute"
  | "resolve";

export type GeneratedAction =
  | { kind: "fund"; actor: Actor; accounts: AccountVariant }
  | { kind: "complete"; actor: Actor; accounts: AccountVariant }
  | { kind: "settle"; actor: Actor; accounts: AccountVariant }
  | { kind: "cancel"; actor: Actor; accounts: AccountVariant }
  | { kind: "refund"; actor: Actor; accounts: AccountVariant }
  | { kind: "dispute"; actor: Actor; accounts: AccountVariant }
  | { kind: "resolve"; actor: Actor; accounts: AccountVariant };

/** Which accounts an instruction actually reads, for compact reporting. */
const RELEVANT: Record<ActionKind, Array<keyof AccountVariant>> = {
  fund: ["agreement", "mint", "vault", "source"],
  complete: ["agreement"],
  settle: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
  cancel: ["agreement"],
  refund: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
  dispute: ["agreement"],
  resolve: ["agreement", "mint", "vault", "vaultAuthority", "destination"],
};

/**
 * A one-line rendering of an action, used in counterexample reports. Only the
 * accounts the instruction takes are printed, so a minimized sequence reads as
 * the attack it is rather than as six fields of noise.
 */
export function describeAction(action: GeneratedAction): string {
  const deviations = RELEVANT[action.kind]
    .map((field) => [field, action.accounts[field]] as const)
    .filter(([field, value]) => value !== canonicalValue(action.kind, field))
    .map(([field, value]) => `${field}=${value}`);
  const suffix = deviations.length === 0 ? "canonical" : deviations.join(" ");
  return `${action.kind}(${action.actor}) [${suffix}]`;
}

/**
 * The value of each variant field that names the agreement's own accounts.
 *
 * `destination` depends on the instruction, because the three payout paths do
 * not pay the same party: settlement pays the seller, a refund pays the buyer,
 * and a dispute resolution pays whichever party the *other* one conceded to —
 * so neither of its two legal destinations is more canonical than the other.
 * Calling the seller's account "the canonical destination" for a refund would
 * classify every legitimate refund as an attack and quietly inflate the
 * wrong-relationship coverage counter.
 */
function canonicalValue(kind: ActionKind, field: keyof AccountVariant): string {
  switch (field) {
    case "source":
      return "buyer";
    case "destination":
      return kind === "refund" ? "buyer" : "seller";
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
  return RELEVANT[action.kind].every(
    (field) => action.accounts[field] === canonicalValue(action.kind, field),
  );
}

export type ActionResult = {
  succeeded: boolean;
  signature?: string;
  errorCode?: string;
  error?: string;
};

/** The addresses one generated action resolves to, recorded for reports. */
export type ResolvedAccounts = Record<string, PublicKey>;
