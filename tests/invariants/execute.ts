import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import type {
  Actor,
  ActionResult,
  GeneratedAction,
  ResolvedAccounts,
} from "./actions";
import type { AgreementAddresses, Fixture } from "./fixture";
import { allocationFor } from "./model";

/**
 * Turns a generated action into an actual transaction against the validator.
 *
 * Two rules hold throughout:
 *
 *   * Every account is passed explicitly. Nothing is derived by the client on
 *     the caller's behalf, because a client that quietly re-derives the
 *     canonical vault would turn a substituted-vault attack into a canonical
 *     transaction and the harness would be testing itself.
 *   * A rejection is a result, not an exception. A refused attack is the
 *     expected outcome of most generated actions; only an unexpected *shape* of
 *     failure — one that never reached the chain — is worth distinguishing, and
 *     the recorded error text preserves that for the report.
 */

export type SequenceWorld = AgreementAddresses & {
  agreementId: anchor.BN;
  /** This agreement's two tranche addresses, derived whether or not they exist. */
  milestones: [PublicKey, PublicKey];
};

/**
 * Which milestone account an action carries.
 *
 * `foreign` resolves to a real tranche of the fixture's unrelated milestone
 * contract: a correctly formed `Milestone` in entirely the wrong relationship,
 * which is the substitution PPV-M4 and PPV-P9 refuse. Deriving it from the
 * fixture rather than from this world is the point — a client that quietly
 * re-derived the canonical tranche would turn the attack into a legal call.
 */
function milestoneFor(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
): PublicKey {
  switch (action.accounts.milestone) {
    case "first":
      return world.milestones[0];
    case "second":
      return world.milestones[1];
    case "foreign":
      return fixture.unrelatedMilestone;
  }
}

function signerFor(fixture: Fixture, actor: Actor): Keypair {
  switch (actor) {
    case "buyer":
      return fixture.buyer;
    case "seller":
      return fixture.seller;
    case "attacker":
      return fixture.attacker;
  }
}

function agreementFor(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
): PublicKey {
  return action.accounts.agreement === "canonical"
    ? world.agreement
    : fixture.unrelated.agreement;
}

function vaultFor(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
): PublicKey {
  switch (action.accounts.vault) {
    case "canonical":
      return world.vault;
    case "otherAgreement":
      return fixture.unrelated.vault;
    case "fake":
      return fixture.fakeVault;
  }
}

function authorityFor(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
): PublicKey {
  return action.accounts.vaultAuthority === "canonical"
    ? world.vaultAuthority
    : fixture.unrelated.vaultAuthority;
}

function mintFor(fixture: Fixture, action: GeneratedAction): PublicKey {
  return action.accounts.mint === "canonical" ? fixture.mint : fixture.wrongMint;
}

/** The addresses an action resolved to, recorded verbatim in failure reports. */
export function resolveAccounts(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
): ResolvedAccounts {
  const resolved: ResolvedAccounts = {
    signer: signerFor(fixture, action.actor).publicKey,
    agreement: agreementFor(fixture, world, action),
  };
  if (action.kind === "fund") {
    resolved.mint = mintFor(fixture, action);
    resolved.vault = vaultFor(fixture, world, action);
    resolved.funderTokenAccount = fixture.tokens[action.accounts.source];
  }
  if (action.kind === "settle" || action.kind === "refund" || action.kind === "resolve") {
    resolved.mint = mintFor(fixture, action);
    resolved.vault = vaultFor(fixture, world, action);
    resolved.vaultAuthority = authorityFor(fixture, world, action);
    resolved.destination = fixture.tokens[action.accounts.destination];
  }
  if (
    action.kind === "submitMilestone" ||
    action.kind === "approveMilestone" ||
    action.kind === "rejectMilestone"
  ) {
    resolved.milestone = milestoneFor(fixture, world, action);
  }
  if (action.kind === "settleMilestone") {
    resolved.milestone = milestoneFor(fixture, world, action);
    resolved.mint = mintFor(fixture, action);
    resolved.vault = vaultFor(fixture, world, action);
    resolved.vaultAuthority = authorityFor(fixture, world, action);
    resolved.destination = fixture.tokens[action.accounts.destination];
  }
  return resolved;
}

function anchorErrorCode(error: unknown): string | undefined {
  if (error instanceof anchor.AnchorError) return error.error.errorCode.code;
  const text = String(error);
  const match = /Error Code: (\w+)/.exec(text);
  return match?.[1];
}

async function send(build: () => Promise<string>): Promise<ActionResult> {
  try {
    const signature = await build();
    return { succeeded: true, signature };
  } catch (error) {
    return {
      succeeded: false,
      errorCode: anchorErrorCode(error),
      error: String(error).slice(0, 400),
    };
  }
}

export function executeAction(
  fixture: Fixture,
  world: SequenceWorld,
  action: GeneratedAction,
  /** The tranche index the agreement's counter is at, per the model. */
  nextSlot = 0,
): Promise<ActionResult> {
  const { escrow } = fixture;
  const signer = signerFor(fixture, action.actor);
  const agreement = agreementFor(fixture, world, action);

  switch (action.kind) {
    case "fund":
      return send(() =>
        escrow.methods
          .fund()
          .accounts({
            buyer: signer.publicKey,
            agreement,
            mint: mintFor(fixture, action),
            vault: vaultFor(fixture, world, action),
            funderTokenAccount: fixture.tokens[action.accounts.source],
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "complete":
      return send(() =>
        escrow.methods
          .markCompleted()
          .accounts({ seller: signer.publicKey, agreement })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "settle":
      return send(() =>
        escrow.methods
          .settle()
          .accounts({
            signer: signer.publicKey,
            agreement,
            mint: mintFor(fixture, action),
            vault: vaultFor(fixture, world, action),
            vaultAuthority: authorityFor(fixture, world, action),
            sellerTokenAccount: fixture.tokens[action.accounts.destination],
            settlementProof: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "cancel":
      return send(() =>
        escrow.methods
          .cancel()
          .accounts({ creator: signer.publicKey, agreement })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "refund":
      return send(() =>
        escrow.methods
          .refund()
          .accounts({
            seller: signer.publicKey,
            agreement,
            mint: mintFor(fixture, action),
            vault: vaultFor(fixture, world, action),
            vaultAuthority: authorityFor(fixture, world, action),
            buyerTokenAccount: fixture.tokens[action.accounts.destination],
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "dispute":
      return send(() =>
        escrow.methods
          // A non-zero reason hash: the program refuses an all-zero one, and a
          // dispute refused on its hash would never exercise the state gate.
          .openDispute(Array<number>(32).fill(5))
          .accounts({ party: signer.publicKey, agreement })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "resolve":
      return send(() =>
        escrow.methods
          .resolveDispute()
          .accounts({
            signer: signer.publicKey,
            agreement,
            mint: mintFor(fixture, action),
            vault: vaultFor(fixture, world, action),
            vaultAuthority: authorityFor(fixture, world, action),
            destination: fixture.tokens[action.accounts.destination],
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "createMilestone": {
      // `create_milestone` derives its account from the agreement's own
      // counter, never from the caller: the harness cannot choose which
      // tranche it creates, only ask for the next one. `nextSlot` is the
      // model's view of that counter, passed in rather than kept as module
      // state — a harness with hidden state is one whose failures cannot be
      // replayed from a seed.
      const slot = Math.min(nextSlot, world.milestones.length - 1);
      return send(() =>
        escrow.methods
          .createMilestone(
            new anchor.BN(allocationFor(action, nextSlot).toString()),
            TRANCHE_TERMS,
          )
          .accounts({
            creator: signer.publicKey,
            agreement,
            milestone: world.milestones[slot],
            systemProgram: SystemProgram.programId,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );
    }

    case "submitMilestone":
      return send(() =>
        escrow.methods
          .submitMilestone()
          .accounts({
            signer: signer.publicKey,
            agreement,
            milestone: milestoneFor(fixture, world, action),
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "approveMilestone":
      return send(() =>
        escrow.methods
          .approveMilestone()
          .accounts({
            signer: signer.publicKey,
            agreement,
            milestone: milestoneFor(fixture, world, action),
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "rejectMilestone":
      return send(() =>
        escrow.methods
          .rejectMilestone()
          .accounts({
            signer: signer.publicKey,
            agreement,
            milestone: milestoneFor(fixture, world, action),
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "settleMilestone":
      return send(() =>
        escrow.methods
          .settleMilestone()
          .accounts({
            signer: signer.publicKey,
            agreement,
            milestone: milestoneFor(fixture, world, action),
            mint: mintFor(fixture, action),
            vault: vaultFor(fixture, world, action),
            vaultAuthority: authorityFor(fixture, world, action),
            sellerTokenAccount: fixture.tokens[action.accounts.destination],
            settlementProof: null,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );

    case "selectWinner":
      return send(() =>
        escrow.methods
          .selectCounterparty(
            action.winner === "seller"
              ? fixture.seller.publicKey
              : // The sponsor naming itself, which the program refuses.
                fixture.buyer.publicKey,
          )
          .accounts({ creator: signer.publicKey, agreement })
          .signers([signer])
          .rpc({ commitment: "confirmed" }),
      );
  }
}

/** A non-zero terms hash: the program refuses an all-zero one. */
const TRANCHE_TERMS = Array<number>(32).fill(3);
