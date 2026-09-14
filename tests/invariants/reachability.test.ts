import assert from "node:assert/strict";
import test from "node:test";

import * as fc from "fast-check";
import { PublicKey } from "@solana/web3.js";

import type { AgreementFlavour, GeneratedAction, Scenario } from "./actions";
import { scenarioArbitrary } from "./generators";
import { applySuccess, emptyMilestones, predict, type EscrowModel } from "./model";

/**
 * Does the generator actually reach the states the suite claims to attack?
 *
 * The property suite answers this only by running for forty minutes against a
 * validator and then failing a coverage floor — which is how the first release
 * run of the milestone model reported "no milestone was ever released" after
 * scheduling tranches across two hundred sequences. The lifecycle was reachable
 * in principle and, at those weights, unreachable in practice.
 *
 * This asks the same question of the model alone, in milliseconds. It proves
 * nothing about the program: it assumes the chain agrees with the model, which
 * is exactly what the property suite exists to check and what this cannot. What
 * it does prove is that the *generator* produces sequences which walk each
 * lifecycle to its end — so a coverage floor failing in CI means the chain
 * disagreed, not that the generator never tried.
 */

const BUYER = new PublicKey("11111111111111111111111111111112");
const SELLER = new PublicKey("11111111111111111111111111111113");
const MINT = new PublicKey("11111111111111111111111111111114");
const AMOUNT = 1_000_000n;

function freshModel(flavour: AgreementFlavour): EscrowModel {
  return {
    flavour,
    state: "open",
    amount: AMOUNT,
    buyer: BUYER,
    seller: SELLER,
    mint: MINT,
    buyerBalance: AMOUNT * 8n,
    sellerBalance: 0n,
    attackerBalance: 0n,
    vaultBalance: 0n,
    settlementCount: 0,
    payeeAssigned: flavour !== "bounty",
    milestones: emptyMilestones(),
    milestoneTotal: 0n,
    releasedTotal: 0n,
  };
}

type Tally = {
  sequences: Record<AgreementFlavour, number>;
  scheduled: number;
  releases: number;
  contractsFullyReleased: number;
  winnerSelections: number;
  winnerReplacementAttempts: number;
  unassignedPayoutAttempts: number;
  foreignMilestoneAttempts: number;
  duplicateReleaseAttempts: number;
  postTerminalAttempts: number;
  accepted: number;
  refused: number;
};

/** Walks one scenario through the model, assuming the chain agrees. */
function walk(scenario: Scenario, tally: Tally): void {
  let model = freshModel(scenario.flavour);
  tally.sequences[scenario.flavour] += 1;

  for (const action of scenario.actions) {
    const terminal =
      model.state === "settled" || model.state === "cancelled" || model.state === "refunded";
    if (terminal) tally.postTerminalAttempts += 1;
    if (action.accounts.milestone === "foreign" && isMilestoneKind(action)) {
      tally.foreignMilestoneAttempts += 1;
    }
    if (action.kind === "selectWinner" && model.payeeAssigned) {
      tally.winnerReplacementAttempts += 1;
    }
    if (
      scenario.flavour === "bounty" &&
      !model.payeeAssigned &&
      (action.kind === "settle" || action.kind === "refund" || action.kind === "resolve")
    ) {
      tally.unassignedPayoutAttempts += 1;
    }
    if (action.kind === "settleMilestone" && action.accounts.milestone !== "foreign") {
      const slot = action.accounts.milestone === "second" ? 1 : 0;
      if (model.milestones[slot].state === "settled") tally.duplicateReleaseAttempts += 1;
    }

    if (!predict(model, action).succeeds) {
      tally.refused += 1;
      continue;
    }
    tally.accepted += 1;
    if (action.kind === "createMilestone") tally.scheduled += 1;
    if (action.kind === "settleMilestone") tally.releases += 1;
    if (action.kind === "selectWinner") tally.winnerSelections += 1;
    model = applySuccess(model, action);
    if (
      scenario.flavour === "milestone" &&
      model.state === "settled" &&
      action.kind === "settleMilestone"
    ) {
      tally.contractsFullyReleased += 1;
    }
  }
}

function isMilestoneKind(action: GeneratedAction): boolean {
  return (
    action.kind === "createMilestone" ||
    action.kind === "submitMilestone" ||
    action.kind === "approveMilestone" ||
    action.kind === "rejectMilestone" ||
    action.kind === "settleMilestone"
  );
}

function sample(seed: number, runs: number, actions: number): Tally {
  const tally: Tally = {
    sequences: { escrow: 0, milestone: 0, bounty: 0 },
    scheduled: 0,
    releases: 0,
    contractsFullyReleased: 0,
    winnerSelections: 0,
    winnerReplacementAttempts: 0,
    unassignedPayoutAttempts: 0,
    foreignMilestoneAttempts: 0,
    duplicateReleaseAttempts: 0,
    postTerminalAttempts: 0,
    accepted: 0,
    refused: 0,
  };
  for (const scenario of fc.sample(scenarioArbitrary(actions), { seed, numRuns: runs })) {
    walk(scenario, tally);
  }
  return tally;
}

test("the PR budget reaches every lifecycle the coverage floors demand", () => {
  // The same seeds and shape the PR tier runs, so a floor that would fail in
  // CI fails here first — in milliseconds rather than in forty minutes.
  const tally = sample(20260912, 100, 20);

  assert.ok(tally.sequences.escrow > 0, "no ordinary escrow was generated");
  assert.ok(tally.sequences.milestone > 0, "no milestone contract was generated");
  assert.ok(tally.sequences.bounty > 0, "no bounty was generated");

  assert.ok(tally.scheduled > 0, `no tranche was ever scheduled: ${JSON.stringify(tally)}`);
  assert.ok(tally.releases > 0, `no tranche was ever released: ${JSON.stringify(tally)}`);
  assert.ok(
    tally.contractsFullyReleased > 0,
    `no milestone contract ever ran to completion: ${JSON.stringify(tally)}`,
  );
  assert.ok(
    tally.winnerSelections > 0,
    `no bounty winner was ever named: ${JSON.stringify(tally)}`,
  );
  assert.ok(
    tally.unassignedPayoutAttempts > 0,
    `no payout was attempted on an unclaimed bounty: ${JSON.stringify(tally)}`,
  );
  assert.ok(
    tally.foreignMilestoneAttempts > 0,
    `no foreign milestone account was presented: ${JSON.stringify(tally)}`,
  );
});

test("the release budget reaches them with margin, not by luck", () => {
  // A floor cleared by one accidental success is not coverage. At the release
  // shape every lifecycle should be walked many times over.
  const tally = sample(20260913, 200, 32);
  assert.ok(tally.releases >= 20, `only ${tally.releases} tranche releases in 200 sequences`);
  assert.ok(
    tally.contractsFullyReleased >= 5,
    `only ${tally.contractsFullyReleased} milestone contracts ran to completion`,
  );
  assert.ok(
    tally.winnerSelections >= 20,
    `only ${tally.winnerSelections} bounty winners were named`,
  );
});

test("most of the run is still an attack", () => {
  // The directed prefix exists to reach deep states, not to turn the suite
  // into a happy-path walk. If acceptance ever climbs near half the actions,
  // the prefix has taken over and the randomized attack has been diluted.
  const tally = sample(20260914, 200, 32);
  const attempted = tally.accepted + tally.refused;
  const acceptedShare = tally.accepted / attempted;
  assert.ok(
    acceptedShare < 0.4,
    `${(acceptedShare * 100).toFixed(1)}% of actions were accepted; the suite is not attacking`,
  );
  assert.ok(
    tally.postTerminalAttempts > 0 && tally.duplicateReleaseAttempts > 0,
    `terminal and duplicate-release attacks must both occur: ${JSON.stringify(tally)}`,
  );
});
