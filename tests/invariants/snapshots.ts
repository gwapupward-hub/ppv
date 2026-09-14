import { AccountLayout } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

/**
 * One canonical chain-observation function.
 *
 * Every fact the assertions use comes from here, and everything here is read
 * back from the validator after the fact. Nothing is inferred from the
 * transaction helper that just ran: a helper that reports what it *meant* to do
 * is exactly the witness a custody bug would fool.
 *
 * The whole snapshot is one `getMultipleAccountsInfo` call at a fixed
 * commitment, so the eight observables are read at one point in the ledger
 * rather than drifting against each other across eight round trips.
 */

export type AgreementObservation = {
  exists: boolean;
  /** The decoded `AgreementState` variant name, or `"absent"`. */
  state: string;
  agreementType: string;
  creator: string;
  counterparty: string;
  mint: string;
  vault: string;
  amount: bigint;
  settledTotal: bigint;
  /** Tranche bookkeeping, read for PPV-M1 and PPV-M3. */
  milestoneCount: number;
  milestonesSettled: number;
  milestoneTotal: bigint;
  settledAt: bigint;
  fundedAt: bigint;
  completedAt: bigint;
  /** Base64 of the raw account, for byte-exact atomicity comparison. */
  raw: string;
};

export type ProtocolSnapshot = {
  agreement: AgreementObservation;
  vault: bigint;
  buyer: bigint;
  seller: bigint;
  attacker: bigint;
  outsider: bigint;
  /** An attacker-owned token account of the escrowed mint, presented to the
   *  program as a vault. Nothing may ever land in it. */
  fakeVault: bigint;
  unrelatedVault: bigint;
  /** Base64 of the unrelated agreement account — it must never move. */
  unrelatedAgreementRaw: string;
  /**
   * Every unit of the escrowed mint this harness controls and that is still
   * reachable: the three party wallets, the outsider wallet, the fake vault,
   * this sequence's vault, and the unrelated agreement's vault. Balances already stranded in
   * the vaults of *earlier* sequences are carried by the runner's retired
   * total, so the sum below plus that total is conserved against the
   * post-mint baseline (PPV-P1).
   */
  controlledLive: bigint;
};

export type SnapshotTargets = {
  agreement: PublicKey;
  vault: PublicKey;
  unrelatedAgreement: PublicKey;
  unrelatedVault: PublicKey;
  fakeVault: PublicKey;
  buyerTokens: PublicKey;
  sellerTokens: PublicKey;
  attackerTokens: PublicKey;
  outsiderTokens: PublicKey;
};

export type SnapshotContext = {
  connection: Connection;
  decodeAgreement: (data: Buffer) => Record<string, any>;
  targets: SnapshotTargets;
};

const ABSENT: AgreementObservation = {
  exists: false,
  state: "absent",
  agreementType: "absent",
  creator: "",
  counterparty: "",
  mint: "",
  vault: "",
  amount: 0n,
  settledTotal: 0n,
  milestoneCount: 0,
  milestonesSettled: 0,
  milestoneTotal: 0n,
  settledAt: 0n,
  fundedAt: 0n,
  completedAt: 0n,
  raw: "",
};

/** Anchor renders a fieldless enum as `{ variantName: {} }`. */
function variantName(value: unknown): string {
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1) return keys[0];
  }
  return String(value);
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined) return 0n;
  // Anchor decodes u64/i64 as BN.
  return BigInt((value as { toString(): string }).toString());
}

function tokenAmount(data: Buffer | undefined | null): bigint {
  if (!data || data.length < AccountLayout.span) return 0n;
  return AccountLayout.decode(data.subarray(0, AccountLayout.span)).amount;
}

export async function snapshotProtocolState(
  ctx: SnapshotContext,
): Promise<ProtocolSnapshot> {
  const { targets } = ctx;
  const order = [
    targets.agreement,
    targets.vault,
    targets.buyerTokens,
    targets.sellerTokens,
    targets.attackerTokens,
    targets.outsiderTokens,
    targets.unrelatedAgreement,
    targets.unrelatedVault,
    targets.fakeVault,
  ];
  const infos = await ctx.connection.getMultipleAccountsInfo(order, "confirmed");

  const agreementInfo = infos[0];
  let agreement: AgreementObservation = ABSENT;
  if (agreementInfo) {
    const decoded = ctx.decodeAgreement(agreementInfo.data);
    agreement = {
      exists: true,
      state: variantName(decoded.state),
      agreementType: variantName(decoded.agreementType),
      creator: String(decoded.creator),
      counterparty: String(decoded.counterparty),
      mint: String(decoded.mint),
      vault: String(decoded.vault),
      amount: big(decoded.amount),
      settledTotal: big(decoded.settledTotal),
      milestoneCount: Number(decoded.milestoneCount ?? 0),
      milestonesSettled: Number(decoded.milestonesSettled ?? 0),
      milestoneTotal: big(decoded.milestoneTotal),
      settledAt: big(decoded.settledAt),
      fundedAt: big(decoded.fundedAt),
      completedAt: big(decoded.completedAt),
      raw: agreementInfo.data.toString("base64"),
    };
  }

  const vault = tokenAmount(infos[1]?.data);
  const buyer = tokenAmount(infos[2]?.data);
  const seller = tokenAmount(infos[3]?.data);
  const attacker = tokenAmount(infos[4]?.data);
  const outsider = tokenAmount(infos[5]?.data);
  const unrelatedVault = tokenAmount(infos[7]?.data);
  const fakeVault = tokenAmount(infos[8]?.data);

  return {
    agreement,
    vault,
    buyer,
    seller,
    attacker,
    outsider,
    fakeVault,
    unrelatedVault,
    unrelatedAgreementRaw: infos[6]?.data.toString("base64") ?? "",
    controlledLive:
      vault + buyer + seller + attacker + outsider + fakeVault + unrelatedVault,
  };
}

/**
 * The observables PPV-P8 compares before and after a failed action. Anything
 * that is economically or semantically meaningful belongs here; anything that
 * moves on its own — a slot, a fee payer's lamports — deliberately does not,
 * because a comparison that can never hold is a comparison nobody keeps.
 */
export function economicFingerprint(snapshot: ProtocolSnapshot): string {
  return JSON.stringify({
    agreement: snapshot.agreement.raw,
    vault: snapshot.vault.toString(),
    buyer: snapshot.buyer.toString(),
    seller: snapshot.seller.toString(),
    attacker: snapshot.attacker.toString(),
    outsider: snapshot.outsider.toString(),
    fakeVault: snapshot.fakeVault.toString(),
    unrelatedVault: snapshot.unrelatedVault.toString(),
    unrelatedAgreement: snapshot.unrelatedAgreementRaw,
  });
}

/** A readable rendering of a snapshot, used in counterexample reports. */
export function describeSnapshot(snapshot: ProtocolSnapshot): Record<string, string> {
  return {
    state: snapshot.agreement.state,
    amount: snapshot.agreement.amount.toString(),
    settledTotal: snapshot.agreement.settledTotal.toString(),
    vault: snapshot.vault.toString(),
    buyer: snapshot.buyer.toString(),
    seller: snapshot.seller.toString(),
    attacker: snapshot.attacker.toString(),
    outsider: snapshot.outsider.toString(),
    fakeVault: snapshot.fakeVault.toString(),
    unrelatedVault: snapshot.unrelatedVault.toString(),
    controlledLive: snapshot.controlledLive.toString(),
  };
}
