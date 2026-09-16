/**
 * The `ppv_escrow` instruction set, encoded by hand.
 *
 * Deliberately not generated from the IDL, for the same reason
 * `scripts/devnet-lifecycle.mjs` encodes Core and Commerce by hand: a client
 * generated from the same build being tested agrees with that build by
 * construction, and agreeing with itself is not evidence. What an outside
 * integrator actually depends on is the public interface — the discriminator,
 * the borsh argument encoding, the account order, and the PDA seeds — and that
 * is what is written out here. If this file and the deployed program disagree,
 * the transaction fails on chain, which is the failure worth having.
 *
 * Account orders mirror the `#[derive(Accounts)]` structs in
 * `programs/ppv_escrow/src/instructions/` field by field. Anchor's
 * `#[event_cpi]` appends `event_authority` and `program` to the end of every
 * one of them, so every builder here does too.
 *
 * Nothing in this file signs, sends, or reads. It builds instructions.
 */

import { createHash } from "node:crypto";

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import { PERMANENT_PROGRAM_IDS } from "./identity.mjs";

export const ESCROW_PROGRAM_ID = new PublicKey(PERMANENT_PROGRAM_IDS.ppv_escrow);
export const CORE_PROGRAM_ID = new PublicKey(PERMANENT_PROGRAM_IDS.ppv_core);

/**
 * Classic SPL Token, and only Classic SPL Token.
 *
 * `ppv_escrow` declares `Program<'info, Token>`, which is this program id and
 * not Token-2022. A Token-2022 mint cannot be escrowed here at all, and the
 * harness must not accidentally create one: transfer hooks and fee extensions
 * change what a transfer means, and every custody assertion in this repository
 * assumes an amount that arrives is the amount that was sent.
 */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Anchor's instruction discriminator: sha256("global:<name>")[..8]. */
export function instructionDiscriminator(name) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** Anchor's `#[event_cpi]` accounts, appended to every instruction's list. */
export function eventCpiAccounts(programId = ESCROW_PROGRAM_ID) {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );
  return [
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];
}

/* ------------------------------------------------------------ derivations */

export function u64(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

export function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

export function deriveAgreement(creator, agreementId, programId = ESCROW_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), creator.toBuffer(), u64(agreementId)],
    programId,
  );
}

export function deriveVaultAuthority(agreement, programId = ESCROW_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agreement.toBuffer()],
    programId,
  );
}

export function deriveVault(agreement, programId = ESCROW_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), agreement.toBuffer()],
    programId,
  );
}

export function deriveProof(agreement, proofIndex, programId = ESCROW_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), agreement.toBuffer(), u32(proofIndex)],
    programId,
  );
}

export function deriveMilestone(agreement, milestoneIndex, programId = ESCROW_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone"), agreement.toBuffer(), u32(milestoneIndex)],
    programId,
  );
}

/**
 * The 16-byte `proof_id` escrow asks ppv_core to mint.
 *
 * Mirrors `core_proof_id` in `programs/ppv_escrow/src/state/proof.rs`: a domain
 * separator, the agreement, and the index, hashed, truncated to 16 bytes. The
 * client chooses nothing, which is what makes the core record's address a pure
 * function of facts already on chain.
 */
export function coreProofId(agreement, proofIndex) {
  return createHash("sha256")
    .update(Buffer.from("ppv:escrow:core-proof:v1"))
    .update(agreement.toBuffer())
    .update(u32(proofIndex))
    .digest()
    .subarray(0, 16);
}

export function deriveCoreProof(submitter, proofId, programId = CORE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), submitter.toBuffer(), Buffer.from(proofId)],
    programId,
  );
}

/** ppv_core's own `#[event_cpi]` authority, which escrow forwards on the CPI. */
export function coreEventAuthority(programId = CORE_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId)[0];
}

/* ----------------------------------------------------------------- enums */

/** Borsh discriminants, in declaration order. */
export const AGREEMENT_TYPE = Object.freeze({
  Escrow: 0,
  Invoice: 1,
  Contract: 2,
  MilestoneContract: 3,
  Bounty: 4,
  ProofOnly: 5,
});

export const AGREEMENT_STATE = Object.freeze([
  "Open",
  "Funded",
  "Completed",
  "Settled",
  "Cancelled",
  "Disputed",
  "Refunded",
]);

export const MILESTONE_STATE = Object.freeze(["Pending", "Submitted", "Approved", "Settled"]);

/* ------------------------------------------------------------ instructions */

const ro = (pubkey) => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey) => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey, writable = false) => ({ pubkey, isSigner: true, isWritable: writable });

function escrowIx(name, keys, data = Buffer.alloc(0), programId = ESCROW_PROGRAM_ID) {
  return new TransactionInstruction({
    programId,
    keys: [...keys, ...eventCpiAccounts(programId)],
    data: Buffer.concat([instructionDiscriminator(name), data]),
  });
}

/**
 * `Option<Account<'info, T>>` in Anchor 0.30 is signalled by passing the
 * *program's own id* in the account slot. Passing the system program, or
 * omitting the account, is a different thing and fails deserialization.
 *
 * Read-only either way. Anchor decides writability from the IDL, and it forces
 * `isWritable = false` when an optional account is absent — but when it is
 * *present* it uses whatever the struct declared, and `settlement_proof` is
 * declared without `#[account(mut)]` in both `Settle` and `SettleMilestone`.
 * A settlement cites evidence; it does not modify it.
 *
 * Marking it writable anyway would have been accepted by the runtime, which is
 * what makes it worth stating: it would have diverged from the generated
 * client without ever failing, and the divergence is the thing this file exists
 * to avoid.
 */
function optionalAccount(account, programId = ESCROW_PROGRAM_ID) {
  return ro(account ?? programId);
}

export function initializeAgreementInstruction({
  creator,
  mint,
  agreementId,
  counterparty,
  agreementType = "Escrow",
  amount,
  termsHash,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  const [agreement] = deriveAgreement(creator, agreementId, programId);
  const [vaultAuthority] = deriveVaultAuthority(agreement, programId);
  const [vault] = deriveVault(agreement, programId);
  const typeIndex = AGREEMENT_TYPE[agreementType];
  if (typeIndex === undefined) throw new Error(`unknown agreement type: ${agreementType}`);
  return escrowIx(
    "initialize_agreement",
    [
      signer(creator, true),
      ro(mint),
      rw(agreement),
      ro(vaultAuthority),
      rw(vault),
      ro(tokenProgram),
      ro(SystemProgram.programId),
    ],
    Buffer.concat([
      u64(agreementId),
      counterparty.toBuffer(),
      Buffer.from([typeIndex]),
      u64(amount),
      Buffer.from(termsHash),
    ]),
    programId,
  );
}

export function fundInstruction({
  buyer,
  agreement,
  mint,
  vault,
  funderTokenAccount,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  return escrowIx(
    "fund",
    [
      signer(buyer),
      rw(agreement),
      ro(mint),
      rw(vault),
      rw(funderTokenAccount),
      ro(tokenProgram),
    ],
    Buffer.alloc(0),
    programId,
  );
}

export function markCompletedInstruction({ seller, agreement, programId = ESCROW_PROGRAM_ID }) {
  return escrowIx("mark_completed", [signer(seller), rw(agreement)], Buffer.alloc(0), programId);
}

export function settleInstruction({
  signerKey,
  agreement,
  mint,
  vault,
  vaultAuthority,
  sellerTokenAccount,
  settlementProof = null,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  return escrowIx(
    "settle",
    [
      signer(signerKey),
      rw(agreement),
      ro(mint),
      rw(vault),
      ro(vaultAuthority),
      rw(sellerTokenAccount),
      optionalAccount(settlementProof, programId),
      ro(tokenProgram),
    ],
    Buffer.alloc(0),
    programId,
  );
}

export function cancelInstruction({ creator, agreement, programId = ESCROW_PROGRAM_ID }) {
  return escrowIx("cancel", [signer(creator), rw(agreement)], Buffer.alloc(0), programId);
}

export function refundInstruction({
  seller,
  agreement,
  mint,
  vault,
  vaultAuthority,
  buyerTokenAccount,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  return escrowIx(
    "refund",
    [
      signer(seller),
      rw(agreement),
      ro(mint),
      rw(vault),
      ro(vaultAuthority),
      rw(buyerTokenAccount),
      ro(tokenProgram),
    ],
    Buffer.alloc(0),
    programId,
  );
}

export function openDisputeInstruction({
  party,
  agreement,
  reasonHash,
  programId = ESCROW_PROGRAM_ID,
}) {
  return escrowIx(
    "open_dispute",
    [signer(party), rw(agreement)],
    Buffer.from(reasonHash),
    programId,
  );
}

export function resolveDisputeInstruction({
  signerKey,
  agreement,
  mint,
  vault,
  vaultAuthority,
  destination,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  return escrowIx(
    "resolve_dispute",
    [
      signer(signerKey),
      rw(agreement),
      ro(mint),
      rw(vault),
      ro(vaultAuthority),
      rw(destination),
      ro(tokenProgram),
    ],
    Buffer.alloc(0),
    programId,
  );
}

export function selectCounterpartyInstruction({
  creator,
  agreement,
  counterparty,
  programId = ESCROW_PROGRAM_ID,
}) {
  return escrowIx(
    "select_counterparty",
    [signer(creator), rw(agreement)],
    counterparty.toBuffer(),
    programId,
  );
}

export function createMilestoneInstruction({
  creator,
  agreement,
  milestone,
  amount,
  termsHash,
  programId = ESCROW_PROGRAM_ID,
}) {
  return escrowIx(
    "create_milestone",
    [signer(creator, true), rw(agreement), rw(milestone), ro(SystemProgram.programId)],
    Buffer.concat([u64(amount), Buffer.from(termsHash)]),
    programId,
  );
}

/** submit / approve / reject share one accounts struct, so one builder. */
export function updateMilestoneInstruction({
  name,
  signerKey,
  agreement,
  milestone,
  programId = ESCROW_PROGRAM_ID,
}) {
  if (!["submit_milestone", "approve_milestone", "reject_milestone"].includes(name)) {
    throw new Error(`not a milestone update instruction: ${name}`);
  }
  return escrowIx(
    name,
    [signer(signerKey), ro(agreement), rw(milestone)],
    Buffer.alloc(0),
    programId,
  );
}

export function settleMilestoneInstruction({
  signerKey,
  agreement,
  milestone,
  mint,
  vault,
  vaultAuthority,
  sellerTokenAccount,
  settlementProof = null,
  programId = ESCROW_PROGRAM_ID,
  tokenProgram = TOKEN_PROGRAM_ID,
}) {
  return escrowIx(
    "settle_milestone",
    [
      signer(signerKey),
      rw(agreement),
      rw(milestone),
      ro(mint),
      rw(vault),
      ro(vaultAuthority),
      rw(sellerTokenAccount),
      optionalAccount(settlementProof, programId),
      ro(tokenProgram),
    ],
    Buffer.alloc(0),
    programId,
  );
}

export function submitProofInstruction({
  submitter,
  agreement,
  proofIndex,
  contentHash,
  metadataHash,
  programId = ESCROW_PROGRAM_ID,
  coreProgramId = CORE_PROGRAM_ID,
}) {
  const [proof] = deriveProof(agreement, proofIndex, programId);
  const [coreProof] = deriveCoreProof(
    submitter,
    coreProofId(agreement, proofIndex),
    coreProgramId,
  );
  return escrowIx(
    "submit_proof",
    [
      signer(submitter, true),
      rw(agreement),
      rw(proof),
      rw(coreProof),
      ro(coreEventAuthority(coreProgramId)),
      ro(coreProgramId),
      ro(SystemProgram.programId),
    ],
    Buffer.concat([Buffer.from(contentHash), Buffer.from(metadataHash)]),
    programId,
  );
}

/** approve_proof and reject_proof share one accounts struct, so one builder. */
export function decideProofInstruction({
  name,
  decider,
  agreement,
  proof,
  programId = ESCROW_PROGRAM_ID,
}) {
  if (!["approve_proof", "reject_proof"].includes(name)) {
    throw new Error(`not a proof decision instruction: ${name}`);
  }
  return escrowIx(name, [signer(decider), ro(agreement), rw(proof)], Buffer.alloc(0), programId);
}
