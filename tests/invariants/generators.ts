import * as fc from "fast-check";

import type {
  AccountVariant,
  Actor,
  ActionKind,
  AgreementFlavour,
  GeneratedAction,
  MilestoneAmountRef,
  MilestoneRef,
  Scenario,
  TokenAccountRef,
  WinnerRef,
} from "./actions";
import { AGREEMENT_FLAVOURS } from "./actions";

/**
 * Generation of both instruction order and account relationships.
 *
 * Two biases are deliberate and are the difference between a harness that
 * explores the state machine and one that bounces off `Open` for twenty
 * actions:
 *
 *   * Canonical accounts and the instruction's own actor are weighted heavily,
 *     so legal transitions actually happen and the deep states — `Completed`,
 *     `Settled` — are reached inside the sequence budget. Every non-canonical
 *     option remains reachable; it is rarer, not excluded.
 *   * `cancel` is weighted down. It is the one action that can end a sequence
 *     on its second step, and an `Open -> Cancelled` sequence tests terminal
 *     finality at the cost of never testing settlement at all.
 *
 * An invalid action is never wasted coverage: a failed attack still has to
 * leave the chain byte-identical (PPV-P8), and that is asserted after every
 * one of them. The suite additionally asserts, after the whole run, that the
 * budget actually reached the states it claims to cover — see
 * `protocol.invariant.ts`. A bias that quietly stopped producing settlements
 * therefore fails the suite rather than silently shrinking its own coverage.
 *
 * Every `fc.oneof` below lists its canonical option first, because fast-check
 * shrinks toward the first entry. A minimized counterexample is therefore the
 * most honest sequence that still breaks the property.
 *
 * At the weights below, a measured release-tier run accepts about 10% of
 * generated actions and presents a wrong-relationship account in about 36% of
 * them, which is the balance these numbers exist to hold: deep enough to reach
 * `Settled` inside the budget, adversarial enough that most of the run is an
 * attack. Change them and re-measure both figures; the coverage floors will
 * catch a collapse but not a slow drift.
 */

/** How much more likely the canonical account is than each deviation. */
const CANONICAL_WEIGHT = 10;
const DEVIATION_WEIGHT = 1;

function weighted<T>(canonical: T, ...deviations: T[]): fc.Arbitrary<T> {
  return fc.oneof(
    { arbitrary: fc.constant(canonical), weight: CANONICAL_WEIGHT },
    ...deviations.map((value) => ({
      arbitrary: fc.constant(value),
      weight: DEVIATION_WEIGHT,
    })),
  );
}

/**
 * The actor is generated as a *role* rather than a wallet, so "the actor this
 * instruction expects" shrinks to first place regardless of which instruction
 * the sequence ends up carrying at that index.
 */
type ActorChoice = "expected" | Actor;

const EXPECTED_ACTOR: Record<ActionKind, Actor> = {
  fund: "buyer",
  complete: "seller",
  // Either party may settle; the seller is the one being paid.
  settle: "seller",
  cancel: "buyer",
  // A refund is the seller's own claim to surrender.
  refund: "seller",
  // Either party may dispute; the buyer is the one who usually wants to.
  dispute: "buyer",
  // Either party may resolve, and never in its own favour. The buyer
  // conceding to the seller is the shape that pairs with the default
  // destination, so it is the one that shrinks to first place.
  resolve: "buyer",
  // The buyer plans and decides tranches; the seller does the work and is
  // paid for it.
  createMilestone: "buyer",
  submitMilestone: "seller",
  approveMilestone: "buyer",
  rejectMilestone: "buyer",
  settleMilestone: "seller",
  // Only the sponsor may name a bounty winner.
  selectWinner: "buyer",
};

const actorArbitrary: fc.Arbitrary<ActorChoice> = fc.oneof(
  { arbitrary: fc.constant<ActorChoice>("expected"), weight: 10 },
  { arbitrary: fc.constant<ActorChoice>("buyer"), weight: 1 },
  { arbitrary: fc.constant<ActorChoice>("seller"), weight: 1 },
  { arbitrary: fc.constant<ActorChoice>("attacker"), weight: 2 },
);

/**
 * Weights, per agreement flavour.
 *
 * The lifecycle has to be walked before the interesting states exist: nothing
 * can be disputed until something is funded, and no tranche can be released
 * until two have been scheduled and the contract funded. So each flavour
 * weights the actions that advance *its own* lifecycle, and keeps the others
 * at a low weight rather than excluding them — scheduling a tranche on an
 * ordinary escrow is a wrong-type attack worth generating, just not worth
 * spending half the budget on.
 *
 * A milestone contract needs `createMilestone` twice before `fund` can
 * succeed, then submit/approve/settle twice. That is nine canonical actions,
 * against a release-tier budget of up to 32, which is why the milestone
 * actions carry the weight they do: at a uniform draw the lifecycle would be
 * reachable in principle and almost never reached in practice, which is the
 * failure RR-1 names.
 */
const KIND_WEIGHTS: Record<AgreementFlavour, Partial<Record<ActionKind, number>>> = {
  escrow: {
    fund: 4,
    complete: 4,
    settle: 4,
    cancel: 1,
    refund: 2,
    dispute: 3,
    resolve: 3,
    // Wrong-type attacks against an ordinary escrow.
    createMilestone: 1,
    settleMilestone: 1,
    selectWinner: 1,
  },
  milestone: {
    createMilestone: 6,
    fund: 4,
    submitMilestone: 5,
    approveMilestone: 5,
    rejectMilestone: 2,
    settleMilestone: 6,
    refund: 2,
    dispute: 2,
    resolve: 2,
    cancel: 1,
    // Both are refused for this type; generating them is the attack.
    complete: 1,
    settle: 1,
    selectWinner: 1,
  },
  bounty: {
    selectWinner: 5,
    fund: 4,
    complete: 4,
    settle: 4,
    refund: 2,
    dispute: 3,
    resolve: 3,
    cancel: 1,
    createMilestone: 1,
    settleMilestone: 1,
  },
};

function kindArbitrary(flavour: AgreementFlavour): fc.Arbitrary<ActionKind> {
  const weights = KIND_WEIGHTS[flavour];
  return fc.oneof(
    ...(Object.entries(weights) as Array<[ActionKind, number]>).map(([kind, weight]) => ({
      arbitrary: fc.constant(kind),
      weight,
    })),
  );
}

/**
 * Which tranche an instruction names. `foreign` is a real milestone of a
 * different contract: the wrong-relationship attack PPV-M4 and PPV-P9 refuse.
 */
const milestoneArbitrary: fc.Arbitrary<MilestoneRef> = weighted(
  "first" as const,
  "second" as const,
  "foreign" as const,
);

/**
 * `planned` follows the schedule that sums to the agreement amount, so the
 * contract can actually be funded. The other two are the allocations the
 * program must refuse — one over the budget, one worth nothing.
 */
const milestoneAmountArbitrary: fc.Arbitrary<MilestoneAmountRef> = weighted(
  "planned" as const,
  "oversized" as const,
  "zero" as const,
);

/** Naming the seller is the legal choice; naming yourself is refused. */
const winnerArbitrary: fc.Arbitrary<WinnerRef> = weighted("seller" as const, "creator" as const);

function destinationArbitrary(kind: ActionKind): fc.Arbitrary<TokenAccountRef> {
  const canonical: TokenAccountRef = kind === "refund" ? "buyer" : "seller";
  const deviations: TokenAccountRef[] = (
    ["seller", "buyer", "attacker", "outsider", "sellerWrongMint"] as const
  ).filter((ref) => ref !== canonical);
  return weighted(canonical, ...deviations);
}

function variantArbitrary(kind: ActionKind): fc.Arbitrary<AccountVariant> {
  return fc.record({
    agreement: weighted("canonical" as const, "unrelated" as const),
    mint: weighted("canonical" as const, "wrong" as const),
    vault: weighted("canonical" as const, "otherAgreement" as const, "fake" as const),
    vaultAuthority: weighted("canonical" as const, "otherAgreement" as const),
    source: weighted(
      "buyer" as const,
      "seller" as const,
      "attacker" as const,
      "outsider" as const,
      "buyerWrongMint" as const,
    ),
    destination: destinationArbitrary(kind),
    milestone: milestoneArbitrary,
  });
}

function actionArbitrary(flavour: AgreementFlavour): fc.Arbitrary<GeneratedAction> {
  return kindArbitrary(flavour).chain((kind) =>
    fc
      .record({
        actor: actorArbitrary,
        accounts: variantArbitrary(kind),
        amount: milestoneAmountArbitrary,
        winner: winnerArbitrary,
      })
      .map(
        ({ actor, accounts, amount, winner }) =>
          ({
            kind,
            actor: actor === "expected" ? EXPECTED_ACTOR[kind] : actor,
            accounts,
            // Carried on every action and read only by the two kinds that
            // have them. Generating them unconditionally keeps one record
            // shape, which is what lets `kind` shrink freely without the
            // other fields becoming undefined underneath it.
            amount,
            winner,
          }) as GeneratedAction,
      ),
  );
}

/**
 * A bounded sequence against one agreement of one flavour.
 *
 * `minLength: 1` keeps shrinking from producing the empty sequence, which
 * proves nothing and is never the counterexample anyone wants. `size: "max"`
 * makes generation aim at the budget rather than at fast-check's default small
 * arrays — without it a "twenty action" budget spends about seven. Length still
 * shrinks all the way back to one.
 *
 * The flavour is generated with the sequence rather than fixed per run, so a
 * single seed attacks all three lifecycles. `escrow` is listed first because
 * fast-check shrinks toward it, and a counterexample that survives
 * simplification to an ordinary escrow is the clearest one to read.
 */
export function scenarioArbitrary(maxActions: number): fc.Arbitrary<Scenario> {
  return fc
    .constantFrom(...AGREEMENT_FLAVOURS)
    .chain((flavour) =>
      fc
        .array(actionArbitrary(flavour), { minLength: 1, maxLength: maxActions, size: "max" })
        .map((actions) => ({ flavour, actions })),
    );
}
