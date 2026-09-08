import { anchorDiscriminator } from "../reputation/hashing.js";
import { BorshReader, bytesEqual } from "./reader.js";
import type {
  AgreementState,
  AgreementType,
  MilestoneState,
  ProofStatus,
} from "./states.js";

/** Mirrors `Agreement` in `programs/ppv_escrow/src/state/agreement.rs`. */
export type AgreementAccount = {
  schemaVersion: number;
  bump: number;
  vaultAuthorityBump: number;
  vaultBump: number;
  /** Buyer. */
  creator: string;
  /** Seller. */
  counterparty: string;
  agreementId: bigint;
  agreementType: AgreementType;
  mint: string;
  vault: string;
  amount: bigint;
  termsHash: string;
  state: AgreementState;
  createdAt: number;
  fundedAt: number;
  completedAt: number;
  settledAt: number;
  proofCount: number;
  /** The approved proof settlement cited; the default address when none. */
  settlementProof: string;
  /** Who opened the dispute; the default address when none was opened. */
  disputeOpenedBy: string;
  stateChangedAt: number;
  milestoneCount: number;
  milestonesSettled: number;
  /** Sum of the scheduled tranches; must equal `amount` before funding. */
  milestoneTotal: bigint;
  /** How much has left the vault by any path. */
  settledTotal: bigint;
};

export const AGREEMENT_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "Agreement");

/** 8 discriminator + 4 bumps + 2 keys + u64 + type + 2 keys + u64 + hash + state + 4 times + proof count + reserved. */
export const AGREEMENT_ACCOUNT_SIZE =
  8 + 4 + 32 * 2 + 8 + 1 + 32 * 2 + 8 + 32 + 1 + 8 * 4 + 4 + 32 + 32 + 8 + 4 * 2 + 8 * 2 + 40;

export function decodeAgreementAccount(data: Uint8Array): AgreementAccount {
  if (!bytesEqual(data.subarray(0, 8), AGREEMENT_ACCOUNT_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_escrow Agreement account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: AgreementAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    vaultAuthorityBump: reader.u8(),
    vaultBump: reader.u8(),
    creator: reader.pubkey(),
    counterparty: reader.pubkey(),
    agreementId: reader.u64(),
    agreementType: reader.agreementType(),
    mint: reader.pubkey(),
    vault: reader.pubkey(),
    amount: reader.u64(),
    termsHash: reader.hex(32),
    state: reader.state(),
    createdAt: reader.i64(),
    fundedAt: reader.i64(),
    completedAt: reader.i64(),
    settledAt: reader.i64(),
    proofCount: reader.u32(),
    settlementProof: reader.pubkey(),
    disputeOpenedBy: reader.pubkey(),
    stateChangedAt: reader.i64(),
    milestoneCount: reader.u32(),
    milestonesSettled: reader.u32(),
    milestoneTotal: reader.u64(),
    settledTotal: reader.u64(),
  };
  reader.skip(40); // reserved
  if (reader.remaining !== 0) throw new RangeError("agreement account has trailing bytes");
  return account;
}

/** Mirrors `Proof` in `programs/ppv_escrow/src/state/proof.rs`. */
export type ProofAccount = {
  schemaVersion: number;
  bump: number;
  agreement: string;
  /**
   * The `ppv_core` ProofRecord holding the commitment. ppv_escrow keeps no copy
   * of the hashes: read this account from ppv_core for the content and context
   * hashes, or recompute its address with `coreProofAddress`.
   */
  coreProof: string;
  submitter: string;
  proofIndex: number;
  status: ProofStatus;
  createdAt: number;
  decidedAt: number;
  /** The default address while the proof is undecided. */
  decidedBy: string;
};

export const PROOF_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "Proof");

/** 8 discriminator + 2 bumps + 3 keys + u32 + status + 2 times + key + reserved. */
export const PROOF_ACCOUNT_SIZE = 8 + 2 + 32 * 3 + 4 + 1 + 8 * 2 + 32 + 32;

export function decodeProofAccount(data: Uint8Array): ProofAccount {
  if (!bytesEqual(data.subarray(0, 8), PROOF_ACCOUNT_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_escrow Proof account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: ProofAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    agreement: reader.pubkey(),
    coreProof: reader.pubkey(),
    submitter: reader.pubkey(),
    proofIndex: reader.u32(),
    status: reader.proofStatus(),
    createdAt: reader.i64(),
    decidedAt: reader.i64(),
    decidedBy: reader.pubkey(),
  };
  reader.skip(32); // reserved
  if (reader.remaining !== 0) throw new RangeError("proof account has trailing bytes");
  return account;
}

/** Mirrors `Milestone` in `programs/ppv_escrow/src/state/milestone.rs`. */
export type MilestoneAccount = {
  schemaVersion: number;
  bump: number;
  agreement: string;
  milestoneIndex: number;
  amount: bigint;
  termsHash: string;
  state: MilestoneState;
  /** The approved proof cited at settlement; the default address when none. */
  proof: string;
  createdAt: number;
  submittedAt: number;
  approvedAt: number;
  settledAt: number;
};

export const MILESTONE_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("account", "Milestone");

/** 8 discriminator + 2 bumps + key + u32 + u64 + hash + state + key + 4 times + reserved. */
export const MILESTONE_ACCOUNT_SIZE = 8 + 2 + 32 + 4 + 8 + 32 + 1 + 32 + 8 * 4 + 32;

export function decodeMilestoneAccount(data: Uint8Array): MilestoneAccount {
  if (!bytesEqual(data.subarray(0, 8), MILESTONE_ACCOUNT_DISCRIMINATOR)) {
    throw new RangeError("not a ppv_escrow Milestone account");
  }
  const reader = new BorshReader(data.subarray(8));
  const account: MilestoneAccount = {
    schemaVersion: reader.u8(),
    bump: reader.u8(),
    agreement: reader.pubkey(),
    milestoneIndex: reader.u32(),
    amount: reader.u64(),
    termsHash: reader.hex(32),
    state: reader.milestoneState(),
    proof: reader.pubkey(),
    createdAt: reader.i64(),
    submittedAt: reader.i64(),
    approvedAt: reader.i64(),
    settledAt: reader.i64(),
  };
  reader.skip(32); // reserved
  if (reader.remaining !== 0) throw new RangeError("milestone account has trailing bytes");
  return account;
}
