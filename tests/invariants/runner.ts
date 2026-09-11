import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";

import type { GeneratedAction } from "./actions";
import { isCanonicallyAddressed } from "./actions";
import { assertInvariants } from "./assertions";
import { executeAction, resolveAccounts, type SequenceWorld } from "./execute";
import { agreementAddresses, AMOUNT, type Fixture } from "./fixture";
import type { EscrowModel } from "./model";
import { applySuccess, predict } from "./model";
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
  settlements: number;
  cancellations: number;
  postTerminalAttempts: number;
  sequences: number;
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
    postTerminalAttempts: 0,
    sequences: 0,
  };
}

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

  /** A fresh `Open` agreement between the fixture's buyer and seller. */
  async openAgreement(): Promise<SequenceWorld> {
    const fixture = this.fixture;
    const agreementId = new BN((this.nextAgreementId++).toString());
    const derived = agreementAddresses(
      fixture.escrow.programId,
      fixture.buyer.publicKey,
      agreementId,
    );
    await fixture.escrow.methods
      .initializeAgreement(
        agreementId,
        fixture.seller.publicKey,
        { escrow: {} },
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
    return { ...derived, agreementId };
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
  async runSequence(
    seed: number,
    sequence: GeneratedAction[],
    coverage: Coverage,
  ): Promise<void> {
    const fixture = this.fixture;
    const world = await this.openAgreement();
    const ctx = this.snapshotContext(world);
    try {
      const start = await snapshotProtocolState(ctx);
      let model: EscrowModel = {
        state: "open",
        amount: AMOUNT,
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
      let settlementCount = 0;

      for (let index = 0; index < sequence.length; index += 1) {
        const action = sequence[index];
        const pre = await snapshotProtocolState(ctx);
        const prediction = predict(model, action);
        const wasTerminal = model.state === "settled" || model.state === "cancelled";

        const result = await executeAction(fixture, world, action);
        const post = await snapshotProtocolState(ctx);

        if (result.succeeded && action.kind === "settle") settlementCount += 1;
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
        if (result.succeeded) {
          coverage.succeeded += 1;
          if (action.kind === "fund") coverage.fundings += 1;
          if (action.kind === "complete") coverage.completions += 1;
          if (action.kind === "settle") coverage.settlements += 1;
          if (action.kind === "cancel") coverage.cancellations += 1;
        } else {
          coverage.refused += 1;
          if (!isCanonicallyAddressed(action)) coverage.refusedNonCanonical += 1;
        }
        if (wasTerminal) coverage.postTerminalAttempts += 1;
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
