import { decodeBase58 } from "./reputation/base58.js";
import {
  coreProofId,
  deriveAgreement as deriveEscrowAgreement,
  deriveCoreProof,
  deriveMilestone,
  deriveProof,
  deriveVault,
  deriveVaultAuthority,
  findProgramAddress,
  type Address,
} from "./escrow/pdas.js";
import { anchorDiscriminator } from "./reputation/hashing.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const CLASSIC_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const EVENT_AUTHORITY_SEED = new TextEncoder().encode("__event_authority");
const CORE_PROOF_SEED = new TextEncoder().encode("proof");
const COMMERCE_AGREEMENT_SEED = new TextEncoder().encode("agreement");

export type InstructionAccountSpec = Readonly<{
  address: Address;
  isSigner: boolean;
  isWritable: boolean;
}>;

export type InstructionSpec = Readonly<{
  programId: Address;
  accounts: readonly InstructionAccountSpec[];
  data: Uint8Array;
}>;

export type CoreProofKind =
  | "creation"
  | "document"
  | "agreement"
  | "invoice"
  | "deliverable"
  | "other";

const CORE_PROOF_KINDS: readonly CoreProofKind[] = [
  "creation",
  "document",
  "agreement",
  "invoice",
  "deliverable",
  "other",
];

export type EscrowAgreementType = "Escrow" | "Invoice" | "Contract" | "MilestoneContract" | "Bounty" | "ProofOnly";

const ESCROW_AGREEMENT_TYPES: Readonly<Record<EscrowAgreementType, number>> = Object.freeze({
  Escrow: 0,
  Invoice: 1,
  Contract: 2,
  MilestoneContract: 3,
  Bounty: 4,
  ProofOnly: 5,
});

const MAX_U64 = BigInt("18446744073709551615");
const MIN_I64 = BigInt("-9223372036854775808");
const MAX_I64 = BigInt("9223372036854775807");

function addressBytes(address: Address): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) throw new RangeError(`not a 32-byte address: ${address}`);
  return bytes;
}

function exactInteger(value: bigint | string, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new RangeError(`${label} must be an exact base-10 integer`);
  return BigInt(value);
}

function u64(value: bigint | string, label = "u64"): Uint8Array {
  const parsed = exactInteger(value, label);
  if (parsed < 0n || parsed > MAX_U64) throw new RangeError(`${label} is out of u64 range`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, parsed, true);
  return out;
}

function i64(value: bigint | string, label = "i64"): Uint8Array {
  const parsed = exactInteger(value, label);
  if (parsed < MIN_I64 || parsed > MAX_I64) throw new RangeError(`${label} is out of i64 range`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, parsed, true);
  return out;
}

function u32(value: number, label = "u32"): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} is out of u32 range`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function fixed(value: Uint8Array, bytes: number, label: string, nonZero = false): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== bytes) {
    throw new RangeError(`${label} must be exactly ${bytes} bytes`);
  }
  if (nonZero && value.every((byte) => byte === 0)) {
    throw new RangeError(`${label} must not be all zeroes`);
  }
  return value;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const ro = (address: Address): InstructionAccountSpec => ({ address, isSigner: false, isWritable: false });
const rw = (address: Address): InstructionAccountSpec => ({ address, isSigner: false, isWritable: true });
const signer = (address: Address, isWritable = false): InstructionAccountSpec => ({
  address,
  isSigner: true,
  isWritable,
});

export function deriveEventAuthority(programId: Address): Address {
  return findProgramAddress([EVENT_AUTHORITY_SEED], programId).address;
}

function eventAccounts(programId: Address): readonly InstructionAccountSpec[] {
  return [ro(deriveEventAuthority(programId)), ro(programId)];
}

function instruction(
  programId: Address,
  name: string,
  accounts: readonly InstructionAccountSpec[],
  args: readonly Uint8Array[] = [],
): InstructionSpec {
  return {
    programId,
    accounts: [...accounts, ...eventAccounts(programId)],
    data: concat([anchorDiscriminator("global", name), ...args]),
  };
}

export function deriveCoreProofRecord(
  programId: Address,
  authority: Address,
  proofId: Uint8Array,
): Address {
  return findProgramAddress(
    [CORE_PROOF_SEED, addressBytes(authority), fixed(proofId, 16, "proofId")],
    programId,
  ).address;
}

export function deriveCommerceAgreement(
  programId: Address,
  partyA: Address,
  agreementId: Uint8Array,
): Address {
  return findProgramAddress(
    [COMMERCE_AGREEMENT_SEED, addressBytes(partyA), fixed(agreementId, 16, "agreementId")],
    programId,
  ).address;
}

export function buildCreateProofInstruction(input: {
  programId: Address;
  authority: Address;
  proofId: Uint8Array;
  contentHash: Uint8Array;
  contextHash: Uint8Array;
  kind: CoreProofKind;
}): InstructionSpec {
  const kind = CORE_PROOF_KINDS.indexOf(input.kind);
  if (kind < 0) throw new RangeError(`unknown proof kind: ${input.kind}`);
  const proofId = fixed(input.proofId, 16, "proofId");
  const proof = deriveCoreProofRecord(input.programId, input.authority, proofId);
  return instruction(
    input.programId,
    "create_proof",
    [signer(input.authority, true), rw(proof), ro(SYSTEM_PROGRAM_ID)],
    [
      proofId,
      fixed(input.contentHash, 32, "contentHash", true),
      fixed(input.contextHash, 32, "contextHash"),
      Uint8Array.of(kind),
    ],
  );
}

export function buildRevokeProofInstruction(input: {
  programId: Address;
  authority: Address;
  proof: Address;
}): InstructionSpec {
  return instruction(input.programId, "revoke_proof", [signer(input.authority), rw(input.proof)]);
}

export function buildCreateCommerceAgreementInstruction(input: {
  programId: Address;
  partyA: Address;
  partyB: Address;
  agreementId: Uint8Array;
  contentHash: Uint8Array;
  termsHash: Uint8Array;
  expiresAt: bigint | string;
}): InstructionSpec {
  if (input.partyA === input.partyB) throw new RangeError("partyB must differ from partyA");
  fixed(addressBytes(input.partyB), 32, "partyB");
  const agreementId = fixed(input.agreementId, 16, "agreementId");
  const agreement = deriveCommerceAgreement(input.programId, input.partyA, agreementId);
  return instruction(
    input.programId,
    "create_agreement",
    [signer(input.partyA, true), rw(agreement), ro(SYSTEM_PROGRAM_ID)],
    [
      agreementId,
      addressBytes(input.partyB),
      fixed(input.contentHash, 32, "contentHash", true),
      fixed(input.termsHash, 32, "termsHash", true),
      i64(input.expiresAt, "expiresAt"),
    ],
  );
}

export function buildReviseCommerceAgreementInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
  expectedVersion: number;
  contentHash: Uint8Array;
  termsHash: Uint8Array;
}): InstructionSpec {
  return instruction(
    input.programId,
    "propose_revision",
    [signer(input.signer), rw(input.agreement)],
    [
      u32(input.expectedVersion, "expectedVersion"),
      fixed(input.contentHash, 32, "contentHash", true),
      fixed(input.termsHash, 32, "termsHash", true),
    ],
  );
}

export function buildSignCommerceAgreementInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
  expectedVersion: number;
  contentHash: Uint8Array;
  termsHash: Uint8Array;
}): InstructionSpec {
  return instruction(
    input.programId,
    "sign_agreement",
    [signer(input.signer), rw(input.agreement)],
    [
      u32(input.expectedVersion, "expectedVersion"),
      fixed(input.contentHash, 32, "contentHash", true),
      fixed(input.termsHash, 32, "termsHash", true),
    ],
  );
}

export function buildCancelCommerceAgreementInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
}): InstructionSpec {
  return instruction(input.programId, "cancel_agreement", [signer(input.signer), rw(input.agreement)]);
}

function escrowInstruction(
  programId: Address,
  name: string,
  accounts: readonly InstructionAccountSpec[],
  args: readonly Uint8Array[] = [],
): InstructionSpec {
  return instruction(programId, name, accounts, args);
}

function citationAccounts(input: {
  programId: Address;
  settlementProof?: Address | null;
  coreProof?: Address | null;
}): readonly [InstructionAccountSpec, InstructionAccountSpec] {
  const settlementProof = input.settlementProof ?? null;
  const coreProof = input.coreProof ?? null;
  if ((settlementProof === null) !== (coreProof === null)) {
    throw new RangeError("settlementProof and coreProof must be supplied together");
  }
  if (settlementProof !== null && settlementProof === coreProof) {
    throw new RangeError("settlementProof and coreProof are distinct accounts");
  }
  return [
    ro(settlementProof ?? input.programId),
    ro(coreProof ?? input.programId),
  ];
}

export function buildInitializeEscrowInstruction(input: {
  programId: Address;
  creator: Address;
  mint: Address;
  agreementId: bigint | string;
  counterparty: Address;
  agreementType?: EscrowAgreementType;
  amountBaseUnits: bigint | string;
  termsHash: Uint8Array;
  tokenProgram?: Address;
}): InstructionSpec {
  const agreementType = input.agreementType ?? "Escrow";
  const agreementTypeIndex = ESCROW_AGREEMENT_TYPES[agreementType];
  if (agreementTypeIndex === undefined) throw new RangeError(`unknown agreement type: ${agreementType}`);
  const agreement = deriveEscrowAgreement(input.programId, input.creator, exactInteger(input.agreementId, "agreementId")).address;
  const vaultAuthority = deriveVaultAuthority(input.programId, agreement).address;
  const vault = deriveVault(input.programId, agreement).address;
  return escrowInstruction(
    input.programId,
    "initialize_agreement",
    [
      signer(input.creator, true),
      ro(input.mint),
      rw(agreement),
      ro(vaultAuthority),
      rw(vault),
      ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
    ],
    [
      u64(input.agreementId, "agreementId"),
      addressBytes(input.counterparty),
      Uint8Array.of(agreementTypeIndex),
      u64(input.amountBaseUnits, "amountBaseUnits"),
      fixed(input.termsHash, 32, "termsHash", true),
    ],
  );
}

export function buildFundEscrowInstruction(input: {
  programId: Address;
  buyer: Address;
  agreement: Address;
  mint: Address;
  vault: Address;
  funderTokenAccount: Address;
  tokenProgram?: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, "fund", [
    signer(input.buyer),
    rw(input.agreement),
    ro(input.mint),
    rw(input.vault),
    rw(input.funderTokenAccount),
    ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
  ]);
}

export function buildMarkCompletedEscrowInstruction(input: {
  programId: Address;
  seller: Address;
  agreement: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, "mark_completed", [signer(input.seller), rw(input.agreement)]);
}

export function buildSettleEscrowInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
  mint: Address;
  vault: Address;
  vaultAuthority: Address;
  sellerTokenAccount: Address;
  settlementProof?: Address | null;
  coreProof?: Address | null;
  tokenProgram?: Address;
}): InstructionSpec {
  const citation = citationAccounts(input);
  return escrowInstruction(input.programId, "settle", [
    signer(input.signer),
    rw(input.agreement),
    ro(input.mint),
    rw(input.vault),
    ro(input.vaultAuthority),
    rw(input.sellerTokenAccount),
    ...citation,
    ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
  ]);
}

export function buildCancelEscrowInstruction(input: {
  programId: Address;
  creator: Address;
  agreement: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, "cancel", [signer(input.creator), rw(input.agreement)]);
}

export function buildRefundEscrowInstruction(input: {
  programId: Address;
  seller: Address;
  agreement: Address;
  mint: Address;
  vault: Address;
  vaultAuthority: Address;
  buyerTokenAccount: Address;
  tokenProgram?: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, "refund", [
    signer(input.seller),
    rw(input.agreement),
    ro(input.mint),
    rw(input.vault),
    ro(input.vaultAuthority),
    rw(input.buyerTokenAccount),
    ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
  ]);
}

export function buildOpenDisputeEscrowInstruction(input: {
  programId: Address;
  party: Address;
  agreement: Address;
  reasonHash: Uint8Array;
}): InstructionSpec {
  return escrowInstruction(
    input.programId,
    "open_dispute",
    [signer(input.party), rw(input.agreement)],
    [fixed(input.reasonHash, 32, "reasonHash", true)],
  );
}

export function buildResolveDisputeEscrowInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
  mint: Address;
  vault: Address;
  vaultAuthority: Address;
  destination: Address;
  tokenProgram?: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, "resolve_dispute", [
    signer(input.signer),
    rw(input.agreement),
    ro(input.mint),
    rw(input.vault),
    ro(input.vaultAuthority),
    rw(input.destination),
    ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
  ]);
}

export function buildSelectCounterpartyEscrowInstruction(input: {
  programId: Address;
  creator: Address;
  agreement: Address;
  counterparty: Address;
}): InstructionSpec {
  return escrowInstruction(
    input.programId,
    "select_counterparty",
    [signer(input.creator), rw(input.agreement)],
    [addressBytes(input.counterparty)],
  );
}

export function buildCreateMilestoneEscrowInstruction(input: {
  programId: Address;
  creator: Address;
  agreement: Address;
  milestoneIndex: number;
  amountBaseUnits: bigint | string;
  termsHash: Uint8Array;
}): InstructionSpec {
  const milestone = deriveMilestone(input.programId, input.agreement, input.milestoneIndex).address;
  return escrowInstruction(
    input.programId,
    "create_milestone",
    [signer(input.creator, true), rw(input.agreement), rw(milestone), ro(SYSTEM_PROGRAM_ID)],
    [u64(input.amountBaseUnits, "amountBaseUnits"), fixed(input.termsHash, 32, "termsHash", true)],
  );
}

export function buildUpdateMilestoneEscrowInstruction(input: {
  programId: Address;
  action: "submit_milestone" | "approve_milestone" | "reject_milestone";
  signer: Address;
  agreement: Address;
  milestone: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, input.action, [
    signer(input.signer),
    ro(input.agreement),
    rw(input.milestone),
  ]);
}

export function buildSettleMilestoneEscrowInstruction(input: {
  programId: Address;
  signer: Address;
  agreement: Address;
  milestone: Address;
  mint: Address;
  vault: Address;
  vaultAuthority: Address;
  sellerTokenAccount: Address;
  settlementProof?: Address | null;
  coreProof?: Address | null;
  tokenProgram?: Address;
}): InstructionSpec {
  const citation = citationAccounts(input);
  return escrowInstruction(input.programId, "settle_milestone", [
    signer(input.signer),
    rw(input.agreement),
    rw(input.milestone),
    ro(input.mint),
    rw(input.vault),
    ro(input.vaultAuthority),
    rw(input.sellerTokenAccount),
    ...citation,
    ro(input.tokenProgram ?? CLASSIC_TOKEN_PROGRAM_ID),
  ]);
}

export function buildSubmitProofEscrowInstruction(input: {
  programId: Address;
  coreProgramId: Address;
  submitter: Address;
  agreement: Address;
  proofIndex: number;
  contentHash: Uint8Array;
  metadataHash: Uint8Array;
}): InstructionSpec {
  const proof = deriveProof(input.programId, input.agreement, input.proofIndex).address;
  const coreProof = deriveCoreProof(
    input.coreProgramId,
    input.submitter,
    input.agreement,
    input.proofIndex,
  ).address;
  return escrowInstruction(
    input.programId,
    "submit_proof",
    [
      signer(input.submitter, true),
      rw(input.agreement),
      rw(proof),
      rw(coreProof),
      ro(deriveEventAuthority(input.coreProgramId)),
      ro(input.coreProgramId),
      ro(SYSTEM_PROGRAM_ID),
    ],
    [
      fixed(input.contentHash, 32, "contentHash", true),
      fixed(input.metadataHash, 32, "metadataHash"),
    ],
  );
}

export function buildDecideProofEscrowInstruction(input: {
  programId: Address;
  action: "approve_proof" | "reject_proof";
  decider: Address;
  agreement: Address;
  proof: Address;
}): InstructionSpec {
  return escrowInstruction(input.programId, input.action, [
    signer(input.decider),
    ro(input.agreement),
    rw(input.proof),
  ]);
}

export function deriveEscrowProofAddress(input: {
  programId: Address;
  agreement: Address;
  proofIndex: number;
}): Address {
  return deriveProof(input.programId, input.agreement, input.proofIndex).address;
}

export function deriveLinkedCoreProofAddress(input: {
  coreProgramId: Address;
  submitter: Address;
  agreement: Address;
  proofIndex: number;
}): Address {
  return deriveCoreProof(
    input.coreProgramId,
    input.submitter,
    input.agreement,
    input.proofIndex,
  ).address;
}

export function deriveLinkedCoreProofId(input: {
  agreement: Address;
  proofIndex: number;
}): Uint8Array {
  return coreProofId(input.agreement, input.proofIndex);
}
