import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  CLASSIC_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  buildCancelCommerceAgreementInstruction,
  buildCreateCommerceAgreementInstruction,
  buildCreateMilestoneEscrowInstruction,
  buildCreateProofInstruction,
  buildInitializeEscrowInstruction,
  buildReviseCommerceAgreementInstruction,
  buildSettleEscrowInstruction,
  buildSettleMilestoneEscrowInstruction,
  buildSignCommerceAgreementInstruction,
  buildSubmitProofEscrowInstruction,
  deriveCommerceAgreement,
  deriveCoreProofRecord,
  deriveEventAuthority,
  deriveLinkedCoreProofAddress,
  deriveLinkedCoreProofId,
  deriveEscrowProofAddress,
} from "../src/index.js";

const CORE = new PublicKey("9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU");
const COMMERCE = new PublicKey("GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3");
const ESCROW = new PublicKey("7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4");

function discriminator(name: string) {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function eventAccounts(programId: PublicKey) {
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );
  return [
    { address: eventAuthority.toBase58(), isSigner: false, isWritable: false },
    { address: programId.toBase58(), isSigner: false, isWritable: false },
  ];
}

function hex(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("hex");
}

function u32(value: number) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function i64(value: bigint) {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(value);
  return out;
}

test("Core create proof spec matches the public Anchor interface", () => {
  const authority = Keypair.generate().publicKey;
  const proofId = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const contentHash = new Uint8Array(32).fill(7);
  const contextHash = new Uint8Array(32).fill(9);

  const [proof] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), authority.toBytes(), Buffer.from(proofId)],
    CORE,
  );
  const spec = buildCreateProofInstruction({
    programId: CORE.toBase58(),
    authority: authority.toBase58(),
    proofId,
    contentHash,
    contextHash,
    kind: "agreement",
  });

  assert.equal(spec.programId, CORE.toBase58());
  assert.deepEqual(spec.accounts, [
    { address: authority.toBase58(), isSigner: true, isWritable: true },
    { address: proof.toBase58(), isSigner: false, isWritable: true },
    { address: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ...eventAccounts(CORE),
  ]);
  assert.equal(
    hex(spec.data),
    Buffer.concat([
      discriminator("create_proof"),
      Buffer.from(proofId),
      Buffer.from(contentHash),
      Buffer.from(contextHash),
      Buffer.from([2]),
    ]).toString("hex"),
  );
  assert.equal(
    deriveCoreProofRecord(CORE.toBase58(), authority.toBase58(), proofId),
    proof.toBase58(),
  );
});

test("Commerce create/sign/revise/cancel specs match the public interface", () => {
  const partyA = Keypair.generate().publicKey;
  const partyB = Keypair.generate().publicKey;
  const agreementId = new Uint8Array(16).fill(11);
  const contentHash = new Uint8Array(32).fill(12);
  const termsHash = new Uint8Array(32).fill(13);
  const expiresAt = 1_800_000_000n;

  const [agreement] = PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), partyA.toBytes(), Buffer.from(agreementId)],
    COMMERCE,
  );
  assert.equal(
    deriveCommerceAgreement(COMMERCE.toBase58(), partyA.toBase58(), agreementId),
    agreement.toBase58(),
  );

  const created = buildCreateCommerceAgreementInstruction({
    programId: COMMERCE.toBase58(),
    partyA: partyA.toBase58(),
    partyB: partyB.toBase58(),
    agreementId,
    contentHash,
    termsHash,
    expiresAt,
  });
  assert.deepEqual(created.accounts, [
    { address: partyA.toBase58(), isSigner: true, isWritable: true },
    { address: agreement.toBase58(), isSigner: false, isWritable: true },
    { address: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ...eventAccounts(COMMERCE),
  ]);
  assert.equal(
    hex(created.data),
    Buffer.concat([
      discriminator("create_agreement"),
      Buffer.from(agreementId),
      partyB.toBuffer(),
      Buffer.from(contentHash),
      Buffer.from(termsHash),
      i64(expiresAt),
    ]).toString("hex"),
  );

  const signed = buildSignCommerceAgreementInstruction({
    programId: COMMERCE.toBase58(),
    signer: partyB.toBase58(),
    agreement: agreement.toBase58(),
    expectedVersion: 4,
    contentHash,
    termsHash,
  });
  assert.equal(
    hex(signed.data),
    Buffer.concat([
      discriminator("sign_agreement"),
      u32(4),
      Buffer.from(contentHash),
      Buffer.from(termsHash),
    ]).toString("hex"),
  );

  const revised = buildReviseCommerceAgreementInstruction({
    programId: COMMERCE.toBase58(),
    signer: partyA.toBase58(),
    agreement: agreement.toBase58(),
    expectedVersion: 4,
    contentHash,
    termsHash,
  });
  assert.equal(hex(revised.data).slice(0, 16), discriminator("propose_revision").toString("hex"));

  const cancelled = buildCancelCommerceAgreementInstruction({
    programId: COMMERCE.toBase58(),
    signer: partyA.toBase58(),
    agreement: agreement.toBase58(),
  });
  assert.equal(hex(cancelled.data), discriminator("cancel_agreement").toString("hex"));
});

test("Escrow initialize derives its own agreement and custody addresses", () => {
  const creator = Keypair.generate().publicKey;
  const counterparty = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const agreementId = 91n;
  const amount = 1_234_567n;
  const termsHash = new Uint8Array(32).fill(15);

  const [agreement] = PublicKey.findProgramAddressSync(
    [Buffer.from("agreement"), creator.toBytes(), u64(agreementId)],
    ESCROW,
  );
  const [vaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), agreement.toBytes()],
    ESCROW,
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), agreement.toBytes()],
    ESCROW,
  );

  const spec = buildInitializeEscrowInstruction({
    programId: ESCROW.toBase58(),
    creator: creator.toBase58(),
    mint: mint.toBase58(),
    agreementId,
    counterparty: counterparty.toBase58(),
    agreementType: "Escrow",
    amountBaseUnits: amount,
    termsHash,
  });

  assert.deepEqual(spec.accounts, [
    { address: creator.toBase58(), isSigner: true, isWritable: true },
    { address: mint.toBase58(), isSigner: false, isWritable: false },
    { address: agreement.toBase58(), isSigner: false, isWritable: true },
    { address: vaultAuthority.toBase58(), isSigner: false, isWritable: false },
    { address: vault.toBase58(), isSigner: false, isWritable: true },
    { address: CLASSIC_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { address: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ...eventAccounts(ESCROW),
  ]);
  assert.equal(
    hex(spec.data),
    Buffer.concat([
      discriminator("initialize_agreement"),
      u64(agreementId),
      counterparty.toBuffer(),
      Buffer.from([0]),
      u64(amount),
      Buffer.from(termsHash),
    ]).toString("hex"),
  );
});

test("Escrow builders refuse reserved agreement types and inexact/zero amounts", () => {
  const common = {
    programId: ESCROW.toBase58(),
    creator: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    agreementId: "2",
    counterparty: Keypair.generate().publicKey.toBase58(),
    termsHash: new Uint8Array(32).fill(1),
  };

  for (const agreementType of ["Invoice", "Contract", "ProofOnly"] as const) {
    assert.throws(
      () => buildInitializeEscrowInstruction({ ...common, agreementType, amountBaseUnits: "1" }),
      /reserved and not currently supported/,
    );
  }
  for (const amountBaseUnits of ["0", "01", "1.2", "1e6", "-1", "18446744073709551616"]) {
    assert.throws(
      () => buildInitializeEscrowInstruction({ ...common, agreementType: "Escrow", amountBaseUnits }),
      RangeError,
    );
  }
});

test("settlement evidence is both-or-neither and uses Anchor's optional-account sentinel", () => {
  const signer = Keypair.generate().publicKey.toBase58();
  const agreement = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const vault = Keypair.generate().publicKey.toBase58();
  const vaultAuthority = Keypair.generate().publicKey.toBase58();
  const sellerTokenAccount = Keypair.generate().publicKey.toBase58();

  const uncited = buildSettleEscrowInstruction({
    programId: ESCROW.toBase58(),
    signer,
    agreement,
    mint,
    vault,
    vaultAuthority,
    sellerTokenAccount,
  });
  assert.equal(uncited.accounts[6]?.address, ESCROW.toBase58());
  assert.equal(uncited.accounts[7]?.address, ESCROW.toBase58());
  assert.equal(uncited.accounts[6]?.isWritable, false);
  assert.equal(uncited.accounts[7]?.isWritable, false);

  const escrowProof = Keypair.generate().publicKey.toBase58();
  const coreProof = Keypair.generate().publicKey.toBase58();
  const cited = buildSettleEscrowInstruction({
    programId: ESCROW.toBase58(),
    signer,
    agreement,
    mint,
    vault,
    vaultAuthority,
    sellerTokenAccount,
    settlementProof: escrowProof,
    coreProof,
  });
  assert.equal(cited.accounts[6]?.address, escrowProof);
  assert.equal(cited.accounts[7]?.address, coreProof);

  assert.throws(
    () => buildSettleEscrowInstruction({
      programId: ESCROW.toBase58(), signer, agreement, mint, vault, vaultAuthority, sellerTokenAccount,
      settlementProof: escrowProof,
    }),
    /supplied together/,
  );
  assert.throws(
    () => buildSettleEscrowInstruction({
      programId: ESCROW.toBase58(), signer, agreement, mint, vault, vaultAuthority, sellerTokenAccount,
      settlementProof: escrowProof, coreProof: escrowProof,
    }),
    /distinct accounts/,
  );
});

test("milestone settlement applies the same RR13-001 citation structure", () => {
  const args = {
    programId: ESCROW.toBase58(),
    signer: Keypair.generate().publicKey.toBase58(),
    agreement: Keypair.generate().publicKey.toBase58(),
    milestone: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    vault: Keypair.generate().publicKey.toBase58(),
    vaultAuthority: Keypair.generate().publicKey.toBase58(),
    sellerTokenAccount: Keypair.generate().publicKey.toBase58(),
  };
  const uncited = buildSettleMilestoneEscrowInstruction(args);
  assert.equal(uncited.accounts[7]?.address, ESCROW.toBase58());
  assert.equal(uncited.accounts[8]?.address, ESCROW.toBase58());
  assert.throws(
    () => buildSettleMilestoneEscrowInstruction({
      ...args,
      coreProof: Keypair.generate().publicKey.toBase58(),
    }),
    /supplied together/,
  );
});

test("escrow proof submission derives the only linked Core ProofRecord address", () => {
  const submitter = Keypair.generate().publicKey;
  const agreement = Keypair.generate().publicKey;
  const proofIndex = 7;
  const contentHash = new Uint8Array(32).fill(21);
  const metadataHash = new Uint8Array(32).fill(22);

  const index = u32(proofIndex);
  const [escrowProof] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), agreement.toBytes(), index],
    ESCROW,
  );
  const coreId = createHash("sha256")
    .update(Buffer.from("ppv:escrow:core-proof:v1"))
    .update(agreement.toBytes())
    .update(index)
    .digest()
    .subarray(0, 16);
  const [coreProof] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof"), submitter.toBytes(), coreId],
    CORE,
  );

  assert.equal(
    deriveEscrowProofAddress({
      programId: ESCROW.toBase58(),
      agreement: agreement.toBase58(),
      proofIndex,
    }),
    escrowProof.toBase58(),
  );
  assert.deepEqual(
    Buffer.from(deriveLinkedCoreProofId({ agreement: agreement.toBase58(), proofIndex })),
    coreId,
  );
  assert.equal(
    deriveLinkedCoreProofAddress({
      coreProgramId: CORE.toBase58(),
      submitter: submitter.toBase58(),
      agreement: agreement.toBase58(),
      proofIndex,
    }),
    coreProof.toBase58(),
  );

  const spec = buildSubmitProofEscrowInstruction({
    programId: ESCROW.toBase58(),
    coreProgramId: CORE.toBase58(),
    submitter: submitter.toBase58(),
    agreement: agreement.toBase58(),
    proofIndex,
    contentHash,
    metadataHash,
  });

  assert.equal(spec.accounts[2]?.address, escrowProof.toBase58());
  assert.equal(spec.accounts[3]?.address, coreProof.toBase58());
  assert.equal(spec.accounts[4]?.address, deriveEventAuthority(CORE.toBase58()));
  assert.equal(spec.accounts[5]?.address, CORE.toBase58());
  assert.equal(hex(spec.data).slice(0, 16), discriminator("submit_proof").toString("hex"));
});

test("milestone creation derives the dense current-index PDA and exact u64 amount", () => {
  const creator = Keypair.generate().publicKey;
  const agreement = Keypair.generate().publicKey;
  const termsHash = new Uint8Array(32).fill(31);
  const index = 3;
  const amount = 9007199254740993n;
  const [milestone] = PublicKey.findProgramAddressSync(
    [Buffer.from("milestone"), agreement.toBytes(), u32(index)],
    ESCROW,
  );
  const spec = buildCreateMilestoneEscrowInstruction({
    programId: ESCROW.toBase58(),
    creator: creator.toBase58(),
    agreement: agreement.toBase58(),
    milestoneIndex: index,
    amountBaseUnits: amount.toString(),
    termsHash,
  });

  assert.equal(spec.accounts[2]?.address, milestone.toBase58());
  assert.equal(
    hex(spec.data),
    Buffer.concat([
      discriminator("create_milestone"),
      u64(amount),
      Buffer.from(termsHash),
    ]).toString("hex"),
  );
});
