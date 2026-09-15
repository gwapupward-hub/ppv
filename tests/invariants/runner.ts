import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type { AgreementFlavour, GeneratedAction, Scenario } from "./actions";
import { isCanonicallyAddressed } from "./actions";
import { assertInvariants } from "./assertions";
import { executeAction, resolveAccounts, type SequenceWorld } from "./execute";
import { agreementAddresses, milestoneAddress, AMOUNT, type Fixture } from "./fixture";
import type { EscrowModel } from "./model";
import { applySuccess, emptyMilestones, predict, TERMINAL_STATES } from "./model";
import { snapshotProtocolState, type SnapshotContext } from "./snapshots";

/**
 * The core execution loop, shared by the property gate and the deterministic
 * regression replays under `regression/`.
 *
 * For every generated action:
 *
 *     snapshot BEFORE
 *       -> the reference model predicts the result
 *       -> the Anchor transaction is executed
 *       -> success or failure is recorded
 *     snapshot AFTER
 *       -> predicted result is compared with the actual one
 *       -> the expected model is compared with the chain
 *       -> every applicable invariant is asserted
 *       -> continue
 *
 * Thousands of actions are never run with only the final state inspected. The
 * first corrupting action has to be identifiable, so the invariants run between
 * every pair of snapshots and the report names the index.
 */

export type Coverage = {
  attempted: number;
  succeeded: number;
  refused: number;
  refusedNonCanonical: number;
  fundings: number;
  completions: number;
  /** Every path that paid the seller, including a conceded dispute. */
  settlements: number;
  cancellations: number;
  refunds: number;
  disputes: number;
  resolutions: number;
  /**
   * The dispute path, counted finely rather than as one total.
   *
   * `resolutions` alone hid two things. A run could clear its floor on a
   * handful of accidental in-state hits while the generator had effectively
   * stopped reaching `Disputed` — which is what seed 20260913 exposed — and a
   * run could resolve only ever toward the seller, leaving the
   * `Disputed -> Refunded` edge unexercised in every seed. Both are now their
   * own floor.
   */
  resolutionAttempts: number;
  invalidResolutionAttempts: number;
  resolutionsToSeller: number;
  resolutionsToBuyer: number;
  postResolutionAttempts: number;
  postTerminalAttempts: number;
  sequences: number;
  /** Sequences opened per agreement type, so an unreached flavour is visible. */
  escrowSequences: number;
  milestoneSequences: number;
  bountySequences: number;
  /** Milestone lifecycle, attempted and accepted. */
  milestoneActions: number;
  milestonesScheduled: number;
  milestoneReleases: number;
  milestoneDuplicateReleaseAttempts: number;
  milestoneForeignAccountAttempts: number;
  milestonePostTerminalAttempts: number;
  /** Bounty lifecycle, attempted and accepted. */
  bountyActions: number;
  winnerSelections: number;
  winnerReplacementAttempts: number;
  bountyPayouts: number;
  bountyUnassignedPayoutAttempts: number;
};

export function emptyCoverage(): Coverage {
  return {
    attempted: 0,
    succeeded: 0,
    refused: 0,
    refusedNonCanonical: 0,
    fundings: 0,
    completions: 0,
    settlements: 0,
    cancellations: 0,
    refunds: 0,
    disputes: 0,
    resolutions: 0,
    resolutionAttempts: 0,
    invalidResolutionAttempts: 0,
    resolutionsToSeller: 0,
    resolutionsToBuyer: 0,
    postResolutionAttempts: 0,
    postTerminalAttempts: 0,
    sequences: 0,
    escrowSequences: 0,
    milestoneSequences: 0,
    bountySequences: 0,
    milestoneActions: 0,
    milestonesScheduled: 0,
    milestoneReleases: 0,
    milestoneDuplicateReleaseAttempts: 0,
    milestoneForeignAccountAttempts: 0,
    milestonePostTerminalAttempts: 0,
    bountyActions: 0,
    winnerSelections: 0,
    winnerReplacementAttempts: 0,
    bountyPayouts: 0,
    bountyUnassignedPayoutAttempts: 0,
  };
}

/** The instructions that only a milestone contract implements. */
const MILESTONE_KINDS = new Set([
  "createMilestone",
  "submitMilestone",
  "approveMilestone",
  "rejectMilestone",
  "settleMilestone",
]);

export class InvariantRunner {
  private nextAgreementId: bigint;

  /**
   * Tokens stranded in the vaults of sequences that have already finished.
   * Conservation (PPV-P1) is measured against the post-mint baseline, so money
   * an unsettled sequence left behind has to stay accounted for rather than
   * simply vanishing from the live sum.
   */
  retiredInVaults = 0n;

  constructor(
    private readonly fixture: Fixture,
    firstAgreementId = 100n,
  ) {
    this.nextAgreementId = firstAgreementId;
  }

  /**
   * A fresh `Open` agreement of the requested type.
   *
   * A bounty is opened with no payee at all, which is the one place the
   * protocol allows it and the reason `selectWinner` exists. Everything else
   * names the fixture's seller at creation, where it is fixed forever.
   */
  async openAgreement(flavour: AgreementFlavour): Promise<SequenceWorld> {
    const fixture = this.fixture;
    const agreementId = new BN((this.nextAgreementId++).toString());
    const derived = agreementAddresses(
      fixture.escrow.programId,
      fixture.buyer.publicKey,
      agreementId,
    );
    const agreementType =
      flavour === "milestone"
        ? { milestoneContract: {} }
        : flavour === "bounty"
          ? { bounty: {} }
          : { escrow: {} };
    const counterparty =
      flavour === "bounty" ? PublicKey.default : fixture.seller.publicKey;
    await fixture.escrow.methods
      .initializeAgreement(
        agreementId,
        counterparty,
        agreementType,
        new BN(AMOUNT.toString()),
        Array<number>(32).fill(7),
      )
      .accounts({
        creator: fixture.buyer.publicKey,
        mint: fixture.mint,
        agreement: derived.agreement,
        vaultAuthority: derived.vaultAuthority,
        vault: derived.vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([fixture.buyer])
      .rpc({ commitment: "confirmed" });
    return {
      ...derived,
      agreementId,
      milestones: [
        milestoneAddress(fixture.escrow.programId, derived.agreement, 0),
        milestoneAddress(fixture.escrow.programId, derived.agreement, 1),
      ],
    };
  }

  private snapshotContext(world: SequenceWorld): SnapshotContext {
    const fixture = this.fixture;
    return {
      connection: fixture.connection,
      decodeAgreement: fixture.decodeAgreement,
      targets: {
        agreement: world.agreement,
        vault: world.vault,
        unrelatedAgreement: fixture.unrelated.agreement,
        unrelatedVault: fixture.unrelated.vault,
        fakeVault: fixture.fakeVault,
        buyerTokens: fixture.tokens.buyer,
        sellerTokens: fixture.tokens.seller,
        attackerTokens: fixture.tokens.attacker,
        outsiderTokens: fixture.tokens.outsider,
      },
    };
  }

  /**
   * Runs one sequence against a fresh agreement. Throws `InvariantViolation`
   * at the first divergence, with the full forensic report attached.
   */
  async runSequence(seed: number, scenario: Scenario, coverage: Coverage): Promise<void> {
    const fixture = this.fixture;
    const { flavour, actions: sequence } = scenario;
    const world = await this.openAgreement(flavour);
    const ctx = this.snapshotContext(world);
    try {
      const start = await snapshotProtocolState(ctx);
      let model: EscrowModel = {
        flavour,
        state: "open",
        amount: AMOUNT,
        // Only a bounty starts without one, which is what `selectWinner` is
        // for and what every payee-dependent guard has to refuse until then.
        payeeAssigned: flavour !== "bounty",
        milestones: emptyMilestones(),
        milestoneTotal: 0n,
        releasedTotal: 0n,
        buyer: fixture.buyer.publicKey,
        seller: fixture.seller.publicKey,
        mint: fixture.mint,
        buyerBalance: start.buyer,
        sellerBalance: start.seller,
        attackerBalance: start.attacker,
        vaultBalance: start.vault,
        settlementCount: 0,
      };
      const initial = {
        buyer: fixture.buyer.publicKey.toBase58(),
        seller: fixture.seller.publicKey.toBase58(),
        mint: fixture.mint.toBase58(),
      };
      if (flavour === "escrow") coverage.escrowSequences += 1;
      if (flavour === "milestone") coverage.milestoneSequences += 1;
      if (flavour === "bounty") coverage.bountySequences += 1;
      let settlementCount = 0;
      /** Set once this sequence has had a dispute conceded. */
      let resolvedInSequence = false;

      for (let index = 0; index < sequence.length; index += 1) {
        const action = sequence[index];
        const pre = await snapshotProtocolState(ctx);
        const prediction = predict(model, action);
        // Read from the model's own terminal set rather than re-listed here:
        // a state added to one and not the other is how PPV-P2 stops being
        // checked on the paths that were added last.
        const wasTerminal = TERMINAL_STATES.has(model.state);
        const wasResolved = resolvedInSequence;

        // The tranche `create_milestone` would address next, from the model's
        // own count of what has been scheduled. The chain decides whether the
        // create succeeds; this only decides which account it names.
        const nextSlot = model.milestones.filter(
          (milestone) => milestone.state !== "absent",
        ).length;
        const result = await executeAction(fixture, world, action, nextSlot);
        const post = await snapshotProtocolState(ctx);

        // Every way the seller can be paid counts as a settlement, because
        // PPV-P3 is about the money leaving once, not about which instruction
        // sent it. A dispute conceded to the seller is a settlement.
        if (
          result.succeeded &&
          (action.kind === "settle" ||
            (action.kind === "resolve" && action.accounts.destination === "seller"))
        ) {
          settlementCount += 1;
        }
        const expected =
          prediction.succeeds && result.succeeded ? applySuccess(model, action) : model;

        assertInvariants({
          seed,
          sequence,
          actionIndex: index,
          action,
          resolved: resolveAccounts(fixture, world, action),
          prediction,
          result,
          pre,
          post,
          model,
          expected,
          settlementCount,
          retiredInVaults: this.retiredInVaults,
          baseline: fixture.conservationBaseline,
          initial,
        });

        model = expected;

        coverage.attempted += 1;
        // Counted whether or not it succeeded: the refused ones are the
        // wrong-role, wrong-account and wrong-state attacks on the concession,
        // and a run that stopped producing them has stopped attacking it.
        if (action.kind === "resolve") {
          coverage.resolutionAttempts += 1;
          if (!result.succeeded) coverage.invalidResolutionAttempts += 1;
        }
        if (result.succeeded) {
          coverage.succeeded += 1;
          if (action.kind === "fund") coverage.fundings += 1;
          if (action.kind === "complete") coverage.completions += 1;
          if (action.kind === "settle") coverage.settlements += 1;
          if (action.kind === "cancel") coverage.cancellations += 1;
          if (action.kind === "refund") coverage.refunds += 1;
          if (action.kind === "dispute") coverage.disputes += 1;
          if (action.kind === "resolve") {
            coverage.resolutions += 1;
            if (action.accounts.destination === "seller") {
              coverage.resolutionsToSeller += 1;
              coverage.settlements += 1;
            } else {
              // A concession to the buyer refunds the escrow: the other legal
              // edge out of `Disputed`, and the one no seed ever reached
              // before the dispute path existed.
              coverage.resolutionsToBuyer += 1;
            }
            resolvedInSequence = true;
          }
          if (action.kind === "createMilestone") coverage.milestonesScheduled += 1;
          if (action.kind === "settleMilestone") {
            coverage.milestoneReleases += 1;
            coverage.settlements += 1;
          }
          if (action.kind === "selectWinner") coverage.winnerSelections += 1;
          if (flavour === "bounty" && action.kind === "settle") coverage.bountyPayouts += 1;
        } else {
          coverage.refused += 1;
          if (!isCanonicallyAddressed(action)) coverage.refusedNonCanonical += 1;
        }

        // Attack-class counters, recorded on the attempt rather than on the
        // outcome. "How often was this refused" is the question; counting only
        // successes would report zero for every attack that works correctly.
        if (MILESTONE_KINDS.has(action.kind)) {
          coverage.milestoneActions += 1;
          if (action.accounts.milestone === "foreign") {
            coverage.milestoneForeignAccountAttempts += 1;
          }
          if (wasTerminal) coverage.milestonePostTerminalAttempts += 1;
          if (action.kind === "settleMilestone") {
            const slot = action.accounts.milestone === "second" ? 1 : 0;
            if (
              action.accounts.milestone !== "foreign" &&
              model.milestones[slot].state === "settled"
            ) {
              coverage.milestoneDuplicateReleaseAttempts += 1;
            }
          }
        }
        if (flavour === "bounty") {
          coverage.bountyActions += 1;
          if (action.kind === "selectWinner" && model.payeeAssigned) {
            coverage.winnerReplacementAttempts += 1;
          }
          if (
            !model.payeeAssigned &&
            (action.kind === "settle" ||
              action.kind === "refund" ||
              action.kind === "resolve")
          ) {
            coverage.bountyUnassignedPayoutAttempts += 1;
          }
        }
        if (wasTerminal) coverage.postTerminalAttempts += 1;
        // Anything attempted after a dispute was conceded. A resolution moves
        // the agreement to `Settled` or `Refunded`, so this is the replay and
        // double-spend surface specific to the dispute path — counted apart
        // from the general terminal attacks so it cannot be satisfied by them.
        if (wasResolved) coverage.postResolutionAttempts += 1;
      }
      coverage.sequences += 1;
    } finally {
      // Whatever happened, this agreement's vault is now out of play. Its
      // balance moves into the retired total so conservation stays exact for
      // every later sequence, including the shrink runs after a failure. A
      // read that fails here must not mask the violation that caused it.
      try {
        const final = await snapshotProtocolState(ctx);
        this.retiredInVaults += final.vault;
      } catch (error) {
        console.error(
          `    could not retire vault ${world.vault.toBase58()}: ${String(error)}`,
        );
      }
    }
  }
}
