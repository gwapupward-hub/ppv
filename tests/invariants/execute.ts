import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import type {
  Actor,
  ActionResult,
  GeneratedAction,
  ResolvedAccounts,
} from "./actions";
import type { AgreementAddresses, Fixture } from "./fixture";

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
};

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
  if (action.kind === "settle") {
    resolved.mint = mintFor(fixture, action);
    resolved.vault = vaultFor(fixture, world, action);
    resolved.vaultAuthority = authorityFor(fixture, world, action);
    resolved.sellerTokenAccount = fixture.tokens[action.accounts.destination];
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
  }
}
