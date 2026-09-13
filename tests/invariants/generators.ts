import * as fc from "fast-check";

import type {
  AccountVariant,
  Actor,
  ActionKind,
  GeneratedAction,
} from "./actions";

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
};

const actorArbitrary: fc.Arbitrary<ActorChoice> = fc.oneof(
  { arbitrary: fc.constant<ActorChoice>("expected"), weight: 10 },
  { arbitrary: fc.constant<ActorChoice>("buyer"), weight: 1 },
  { arbitrary: fc.constant<ActorChoice>("seller"), weight: 1 },
  { arbitrary: fc.constant<ActorChoice>("attacker"), weight: 2 },
);

/**
 * Weights, not a uniform draw.
 *
 * The lifecycle has to be walked before the interesting states exist: nothing
 * can be disputed until something is funded. The three original transitions
 * therefore stay heaviest, and the Phase 5 paths are common enough to be
 * reached often within a sequence of a few dozen actions. `dispute` carries
 * the same weight as `resolve` because a resolution is only legal after one.
 */
const kindArbitrary: fc.Arbitrary<ActionKind> = fc.oneof(
  { arbitrary: fc.constant<ActionKind>("fund"), weight: 4 },
  { arbitrary: fc.constant<ActionKind>("complete"), weight: 4 },
  { arbitrary: fc.constant<ActionKind>("settle"), weight: 4 },
  { arbitrary: fc.constant<ActionKind>("cancel"), weight: 1 },
  { arbitrary: fc.constant<ActionKind>("refund"), weight: 2 },
  { arbitrary: fc.constant<ActionKind>("dispute"), weight: 3 },
  { arbitrary: fc.constant<ActionKind>("resolve"), weight: 3 },
);

const variantArbitrary: fc.Arbitrary<AccountVariant> = fc.record({
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
  destination: weighted(
    "seller" as const,
    "buyer" as const,
    "attacker" as const,
    "outsider" as const,
    "sellerWrongMint" as const,
  ),
});

export const actionArbitrary: fc.Arbitrary<GeneratedAction> = fc
  .record({ kind: kindArbitrary, actor: actorArbitrary, accounts: variantArbitrary })
  .map(({ kind, actor, accounts }) => ({
    kind,
    actor: actor === "expected" ? EXPECTED_ACTOR[kind] : actor,
    accounts,
  }));

/**
 * A bounded sequence.
 *
 * `minLength: 1` keeps shrinking from producing the empty sequence, which
 * proves nothing and is never the counterexample anyone wants. `size: "max"`
 * makes generation aim at the budget rather than at fast-check's default small
 * arrays — without it a "twenty action" budget spends about seven. Length still
 * shrinks all the way back to one.
 */
export function sequenceArbitrary(maxActions: number): fc.Arbitrary<GeneratedAction[]> {
  return fc.array(actionArbitrary, { minLength: 1, maxLength: maxActions, size: "max" });
}
