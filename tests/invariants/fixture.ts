import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  AccountLayout,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import type { TokenAccountRef } from "./actions";

/**
 * The world the property harness attacks.
 *
 * Everything here is built once, before any conservation baseline is taken, so
 * that the only token movements the invariants ever see are protocol
 * movements. The fixture mints exactly once — `PPV-P1` is measured from the
 * moment that is finished.
 */

const AGREEMENT_SEED = new TextEncoder().encode("agreement");
const MILESTONE_SEED = new TextEncoder().encode("milestone");
const VAULT_AUTHORITY_SEED = new TextEncoder().encode("vault");
const VAULT_TOKEN_SEED = new TextEncoder().encode("vault_token");

export const DECIMALS = 6;
/** One token, at six decimals. Small enough to mint a large supply against. */
export const AMOUNT = 1_000_000n;

export type AgreementAddresses = {
  agreement: PublicKey;
  vaultAuthority: PublicKey;
  vault: PublicKey;
};

/**
 * A tranche address, derived from the agreement and the index its own counter
 * will assign. Derived rather than read back, so the harness can name a
 * tranche that does not exist yet — which is one of the attacks.
 */
export function milestoneAddress(
  programId: PublicKey,
  agreement: PublicKey,
  index: number,
): PublicKey {
  const indexSeed = new Uint8Array(4);
  new DataView(indexSeed.buffer).setUint32(0, index, true);
  const [milestone] = PublicKey.findProgramAddressSync(
    [MILESTONE_SEED, agreement.toBytes(), indexSeed],
    programId,
  );
  return milestone;
}

export function agreementAddresses(
  programId: PublicKey,
  creator: PublicKey,
  agreementId: BN,
): AgreementAddresses {
  const idSeed = Uint8Array.from(agreementId.toArrayLike(Buffer, "le", 8));
  const [agreement] = PublicKey.findProgramAddressSync(
    [AGREEMENT_SEED, creator.toBytes(), idSeed],
    programId,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [VAULT_AUTHORITY_SEED, agreement.toBytes()],
    programId,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_SEED, agreement.toBytes()],
    programId,
  );
  return { agreement, vaultAuthority, vault };
}

export type Fixture = {
  escrow: any;
  connection: Connection;
  payer: Keypair;
  mint: PublicKey;
  wrongMint: PublicKey;
  buyer: Keypair;
  seller: Keypair;
  attacker: Keypair;
  /** Creator of the unrelated agreement. Never signs a generated action. */
  outsider: Keypair;
  /** Counterparty of the unrelated agreement. Never signs anything. */
  outsiderCounterparty: Keypair;
  /**
   * A real tranche of a *different* milestone contract, created once and never
   * acted on. Presented in place of this agreement's tranche it is a correctly
   * formed `Milestone` in entirely the wrong relationship, which is what
   * PPV-M4 and PPV-P9 exist to refuse.
   */
  unrelatedMilestone: PublicKey;
  tokens: Record<TokenAccountRef, PublicKey>;
  /** A token account of the agreement mint owned by the attacker, presented
   *  as a vault. It is not a PDA of anything. */
  fakeVault: PublicKey;
  unrelated: AgreementAddresses;
  decodeAgreement: (data: Buffer) => Record<string, any>;
  /** Total supply of the escrowed mint held by the accounts this suite
   *  controls, measured once minting is complete. */
  conservationBaseline: bigint;
  amount: bigint;
};

/**
 * Anchor has moved generated account names between casings across IDL
 * revisions. Resolve the one this build actually uses, once, instead of
 * guessing at every decode.
 */
function agreementDecoder(escrow: any): (data: Buffer) => Record<string, any> {
  for (const name of ["escrowAgreement", "EscrowAgreement"]) {
    try {
      escrow.coder.accounts.memcmp(name);
      return (data: Buffer) => escrow.coder.accounts.decode(name, data);
    } catch {
      // Not this casing; try the next.
    }
  }
  throw new Error("ppv_escrow IDL exposes no EscrowAgreement account decoder");
}

async function fundWallet(
  connection: Connection,
  wallet: PublicKey,
  sol: number,
): Promise<void> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const signature = await connection.requestAirdrop(wallet, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

/**
 * @param agreementBudget how many agreements the run will create. The buyer's
 * SOL and token supply are sized from it, because a run that ran out of either
 * halfway through would look exactly like a protocol failure.
 */
export async function buildFixture(
  provider: anchor.AnchorProvider,
  escrow: any,
  agreementBudget: number,
): Promise<Fixture> {
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const buyer = Keypair.generate();
  const seller = Keypair.generate();
  const attacker = Keypair.generate();
  const outsider = Keypair.generate();
  const outsiderCounterparty = Keypair.generate();

  // The buyer pays rent for every agreement and vault the run creates; the
  // others only ever pay transaction fees.
  const buyerSol = Math.max(10, Math.ceil(agreementBudget * 0.01) + 10);
  for (let remaining = buyerSol; remaining > 0; remaining -= 50) {
    await fundWallet(connection, buyer.publicKey, Math.min(50, remaining));
  }
  for (const wallet of [seller, attacker, outsider]) {
    await fundWallet(connection, wallet.publicKey, 20);
  }

  const mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  const wrongMint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);

  const tokens: Record<TokenAccountRef, PublicKey> = {
    buyer: await createAssociatedTokenAccount(connection, payer, mint, buyer.publicKey),
    seller: await createAssociatedTokenAccount(connection, payer, mint, seller.publicKey),
    attacker: await createAssociatedTokenAccount(connection, payer, mint, attacker.publicKey),
    outsider: await createAssociatedTokenAccount(connection, payer, mint, outsider.publicKey),
    buyerWrongMint: await createAssociatedTokenAccount(
      connection,
      payer,
      wrongMint,
      buyer.publicKey,
    ),
    sellerWrongMint: await createAssociatedTokenAccount(
      connection,
      payer,
      wrongMint,
      seller.publicKey,
    ),
  };

  // A second attacker-owned account of the agreement mint. Presented as a
  // vault it is a correctly formed token account in entirely the wrong
  // relationship, which is the point (PPV-P5).
  const fakeVault = await createAccount(
    connection,
    payer,
    mint,
    attacker.publicKey,
    Keypair.generate(),
  );

  // Enough for every agreement the budget can create, twice over. Minting
  // happens here and nowhere else: the conservation baseline below is taken
  // once this returns and must hold for the rest of the run.
  const supply = AMOUNT * BigInt(agreementBudget + 8) * 2n;
  await mintTo(connection, payer, mint, tokens.buyer, payer, supply);
  await mintTo(connection, payer, wrongMint, tokens.buyerWrongMint, payer, supply);

  const decodeAgreement = agreementDecoder(escrow);

  // One unrelated agreement, created once and never acted on again. Both of
  // its parties are wallets that never sign a generated action, so every
  // instruction pointed at it is refused on authority alone and the account is
  // free to serve as a fixed "correct account, wrong relationship" probe.
  const unrelatedId = new BN(1);
  const unrelated = agreementAddresses(escrow.programId, outsider.publicKey, unrelatedId);
  await escrow.methods
    .initializeAgreement(
      unrelatedId,
      outsiderCounterparty.publicKey,
      { escrow: {} },
      new BN(AMOUNT.toString()),
      Array<number>(32).fill(11),
    )
    .accounts({
      creator: outsider.publicKey,
      mint,
      agreement: unrelated.agreement,
      vaultAuthority: unrelated.vaultAuthority,
      vault: unrelated.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([outsider])
    .rpc({ commitment: "confirmed" });

  // A second unrelated agreement, this one a milestone contract with one
  // scheduled tranche. Its parties never sign here either, so its tranche is a
  // fixed "correct account, wrong agreement" probe for the milestone paths.
  const unrelatedMilestoneId = new BN(2);
  const unrelatedContract = agreementAddresses(
    escrow.programId,
    outsider.publicKey,
    unrelatedMilestoneId,
  );
  await escrow.methods
    .initializeAgreement(
      unrelatedMilestoneId,
      outsiderCounterparty.publicKey,
      { milestoneContract: {} },
      new BN(AMOUNT.toString()),
      Array<number>(32).fill(13),
    )
    .accounts({
      creator: outsider.publicKey,
      mint,
      agreement: unrelatedContract.agreement,
      vaultAuthority: unrelatedContract.vaultAuthority,
      vault: unrelatedContract.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([outsider])
    .rpc({ commitment: "confirmed" });

  const unrelatedMilestone = milestoneAddress(
    escrow.programId,
    unrelatedContract.agreement,
    0,
  );
  await escrow.methods
    .createMilestone(new BN(AMOUNT.toString()), Array<number>(32).fill(17))
    .accounts({
      creator: outsider.publicKey,
      agreement: unrelatedContract.agreement,
      milestone: unrelatedMilestone,
      systemProgram: SystemProgram.programId,
    })
    .signers([outsider])
    .rpc({ commitment: "confirmed" });

  const controlled = [
    tokens.buyer,
    tokens.seller,
    tokens.attacker,
    tokens.outsider,
    fakeVault,
    unrelated.vault,
    unrelatedContract.vault,
  ];
  const infos = await connection.getMultipleAccountsInfo(controlled, "confirmed");
  const conservationBaseline = infos.reduce<bigint>((total, info) => {
    if (!info) return total;
    return total + AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount;
  }, 0n);

  return {
    escrow,
    connection,
    payer,
    mint,
    wrongMint,
    buyer,
    seller,
    attacker,
    outsider,
    outsiderCounterparty,
    tokens,
    fakeVault,
    unrelated,
    unrelatedMilestone,
    decodeAgreement,
    conservationBaseline,
    amount: AMOUNT,
  };
}
