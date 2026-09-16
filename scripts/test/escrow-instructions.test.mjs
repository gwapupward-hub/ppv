import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { REPO, ESCROW_ID, CORE_ID } from "./helpers.mjs";
import {
  AGREEMENT_TYPE,
  ESCROW_PROGRAM_ID,
  CORE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  cancelInstruction,
  coreProofId,
  createMilestoneInstruction,
  decideProofInstruction,
  deriveAgreement,
  deriveCoreProof,
  deriveMilestone,
  deriveProof,
  deriveVault,
  deriveVaultAuthority,
  fundInstruction,
  initializeAgreementInstruction,
  instructionDiscriminator,
  markCompletedInstruction,
  openDisputeInstruction,
  refundInstruction,
  resolveDisputeInstruction,
  selectCounterpartyInstruction,
  settleInstruction,
  settleMilestoneInstruction,
  submitProofInstruction,
  updateMilestoneInstruction,
} from "../lib/escrow-instructions.mjs";

/**
 * The hand-written instruction encoding, pinned to the program it addresses.
 *
 * `scripts/lib/escrow-instructions.mjs` encodes ppv_escrow by hand rather than
 * through a generated client, deliberately: a client generated from the build
 * under test agrees with that build by construction, and agreeing with itself
 * proves nothing about the interface an outside integrator depends on.
 *
 * The cost of that choice is that the account order can silently drift from the
 * `#[derive(Accounts)]` structs, and the symptom would be a live transaction
 * failing on devnet for a reason nobody can read. So the structs themselves are
 * parsed out of `programs/ppv_escrow/src/instructions/` and compared field for
 * field. A reordered account in the program fails here, on a pull request,
 * rather than in a custody run that has already spent real time and fees.
 */

const INSTRUCTIONS_DIR = join(REPO, "programs", "ppv_escrow", "src", "instructions");

/** Every `#[derive(Accounts)]` struct in the escrow program, fields in order. */
function accountStructs() {
  const structs = new Map();
  for (const file of readdirSync(INSTRUCTIONS_DIR)) {
    if (!file.endsWith(".rs")) continue;
    const source = readFileSync(join(INSTRUCTIONS_DIR, file), "utf8");
    const pattern =
      /(#\[event_cpi\]\s*)?#\[derive\(Accounts\)\][\s\S]*?pub struct (\w+)<'info> \{([\s\S]*?)\n\}/g;
    for (const match of source.matchAll(pattern)) {
      const [, eventCpi, name, body] = match;
      const fields = [...body.matchAll(/^\s{4}pub (\w+):/gm)].map((field) => field[1]);
      structs.set(name, { name, file, eventCpi: Boolean(eventCpi), fields });
    }
  }
  return structs;
}

const STRUCTS = accountStructs();

/** Anchor renames nothing; the account order is the struct's field order. */
function expectedAccountOrder(structName) {
  const struct = STRUCTS.get(structName);
  assert.ok(struct, `no #[derive(Accounts)] struct named ${structName} was found`);
  // `#[event_cpi]` appends these two, in this order, to every struct it marks.
  return struct.eventCpi ? [...struct.fields, "event_authority", "program"] : struct.fields;
}

const creator = Keypair.generate().publicKey;
const counterparty = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const otherAccount = Keypair.generate().publicKey;
const agreementId = 7n;
const [agreement] = deriveAgreement(creator, agreementId);
const [vaultAuthority] = deriveVaultAuthority(agreement);
const [vault] = deriveVault(agreement);
const [milestone] = deriveMilestone(agreement, 0);
const [proof] = deriveProof(agreement, 0);
const termsHash = Buffer.alloc(32, 9);

/**
 * Each builder, the struct it must match, and the addresses it should produce
 * for each account, in order. Written out rather than derived so a wrong
 * address is a wrong address, not a coincidence of two derivations agreeing.
 */
const CASES = [
  {
    name: "initialize_agreement",
    struct: "InitializeAgreement",
    instruction: () =>
      initializeAgreementInstruction({
        creator,
        mint,
        agreementId,
        counterparty,
        amount: 25n,
        termsHash,
      }),
    accounts: [creator, mint, agreement, vaultAuthority, vault, TOKEN_PROGRAM_ID, SystemProgram.programId],
    signers: [creator],
    writable: [creator, agreement, vault],
  },
  {
    name: "fund",
    struct: "Fund",
    instruction: () =>
      fundInstruction({
        buyer: creator,
        agreement,
        mint,
        vault,
        funderTokenAccount: otherAccount,
      }),
    accounts: [creator, agreement, mint, vault, otherAccount, TOKEN_PROGRAM_ID],
    signers: [creator],
    writable: [agreement, vault, otherAccount],
  },
  {
    name: "mark_completed",
    struct: "MarkCompleted",
    instruction: () => markCompletedInstruction({ seller: counterparty, agreement }),
    accounts: [counterparty, agreement],
    signers: [counterparty],
    writable: [agreement],
  },
  {
    name: "settle",
    struct: "Settle",
    instruction: () =>
      settleInstruction({
        signerKey: creator,
        agreement,
        mint,
        vault,
        vaultAuthority,
        sellerTokenAccount: otherAccount,
      }),
    // settlement_proof is None, which Anchor signals with the program's own id.
    accounts: [
      creator,
      agreement,
      mint,
      vault,
      vaultAuthority,
      otherAccount,
      ESCROW_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ],
    signers: [creator],
    writable: [agreement, vault, otherAccount],
  },
  {
    name: "cancel",
    struct: "Cancel",
    instruction: () => cancelInstruction({ creator, agreement }),
    accounts: [creator, agreement],
    signers: [creator],
    writable: [agreement],
  },
  {
    name: "refund",
    struct: "Refund",
    instruction: () =>
      refundInstruction({
        seller: counterparty,
        agreement,
        mint,
        vault,
        vaultAuthority,
        buyerTokenAccount: otherAccount,
      }),
    accounts: [counterparty, agreement, mint, vault, vaultAuthority, otherAccount, TOKEN_PROGRAM_ID],
    signers: [counterparty],
    writable: [agreement, vault, otherAccount],
  },
  {
    name: "open_dispute",
    struct: "OpenDispute",
    instruction: () =>
      openDisputeInstruction({ party: creator, agreement, reasonHash: termsHash }),
    accounts: [creator, agreement],
    signers: [creator],
    writable: [agreement],
  },
  {
    name: "resolve_dispute",
    struct: "ResolveDispute",
    instruction: () =>
      resolveDisputeInstruction({
        signerKey: creator,
        agreement,
        mint,
        vault,
        vaultAuthority,
        destination: otherAccount,
      }),
    accounts: [creator, agreement, mint, vault, vaultAuthority, otherAccount, TOKEN_PROGRAM_ID],
    signers: [creator],
    writable: [agreement, vault, otherAccount],
  },
  {
    name: "select_counterparty",
    struct: "SelectCounterparty",
    instruction: () => selectCounterpartyInstruction({ creator, agreement, counterparty }),
    accounts: [creator, agreement],
    signers: [creator],
    writable: [agreement],
  },
  {
    name: "create_milestone",
    struct: "CreateMilestone",
    instruction: () =>
      createMilestoneInstruction({ creator, agreement, milestone, amount: 40n, termsHash }),
    accounts: [creator, agreement, milestone, SystemProgram.programId],
    signers: [creator],
    writable: [creator, agreement, milestone],
  },
  {
    name: "submit_milestone",
    struct: "UpdateMilestone",
    instruction: () =>
      updateMilestoneInstruction({
        name: "submit_milestone",
        signerKey: counterparty,
        agreement,
        milestone,
      }),
    accounts: [counterparty, agreement, milestone],
    signers: [counterparty],
    writable: [milestone],
  },
  {
    name: "settle_milestone",
    struct: "SettleMilestone",
    instruction: () =>
      settleMilestoneInstruction({
        signerKey: creator,
        agreement,
        milestone,
        mint,
        vault,
        vaultAuthority,
        sellerTokenAccount: otherAccount,
      }),
    accounts: [
      creator,
      agreement,
      milestone,
      mint,
      vault,
      vaultAuthority,
      otherAccount,
      ESCROW_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ],
    signers: [creator],
    writable: [agreement, milestone, vault, otherAccount],
  },
  {
    name: "submit_proof",
    struct: "SubmitProof",
    instruction: () =>
      submitProofInstruction({
        submitter: creator,
        agreement,
        proofIndex: 0,
        contentHash: termsHash,
        metadataHash: termsHash,
      }),
    accounts: [
      creator,
      agreement,
      proof,
      deriveCoreProof(creator, coreProofId(agreement, 0))[0],
      PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], CORE_PROGRAM_ID)[0],
      CORE_PROGRAM_ID,
      SystemProgram.programId,
    ],
    signers: [creator],
    writable: [creator, agreement, proof, deriveCoreProof(creator, coreProofId(agreement, 0))[0]],
  },
  {
    name: "approve_proof",
    struct: "DecideProof",
    instruction: () =>
      decideProofInstruction({ name: "approve_proof", decider: creator, agreement, proof }),
    accounts: [creator, agreement, proof],
    signers: [creator],
    writable: [proof],
  },
];

for (const kase of CASES) {
  test(`${kase.name}: the account list matches ${kase.struct} field for field`, () => {
    const order = expectedAccountOrder(kase.struct);
    const instruction = kase.instruction();
    const built = [
      ...kase.accounts.map((key) => key.toBase58()),
      // The event-CPI pair every escrow instruction carries.
      PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        ESCROW_PROGRAM_ID,
      )[0].toBase58(),
      ESCROW_PROGRAM_ID.toBase58(),
    ];
    assert.equal(
      instruction.keys.length,
      order.length,
      `${kase.name} builds ${instruction.keys.length} accounts, ${kase.struct} declares ` +
        `${order.length}: ${order.join(", ")}`,
    );
    assert.deepEqual(
      instruction.keys.map((key) => key.pubkey.toBase58()),
      built,
      `${kase.name} account order must be ${order.join(", ")}`,
    );
  });

  test(`${kase.name}: signers and writability match the struct's constraints`, () => {
    const instruction = kase.instruction();
    const signers = instruction.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58());
    assert.deepEqual(signers, kase.signers.map((key) => key.toBase58()));

    const writable = instruction.keys
      .filter((key) => key.isWritable)
      .map((key) => key.pubkey.toBase58());
    assert.deepEqual(
      writable.slice().sort(),
      kase.writable.map((key) => key.toBase58()).sort(),
      `${kase.name} writability`,
    );
  });

  test(`${kase.name}: the discriminator is Anchor's for that instruction name`, () => {
    const instruction = kase.instruction();
    assert.deepEqual(
      Array.from(instruction.data.subarray(0, 8)),
      Array.from(instructionDiscriminator(kase.name)),
    );
    assert.equal(instruction.programId.toBase58(), ESCROW_ID);
  });
}

test("every escrow accounts struct carries #[event_cpi]", () => {
  // If one ever does not, the builders' unconditional event-CPI pair would be
  // two accounts too many and every transaction would fail on chain.
  for (const struct of STRUCTS.values()) {
    assert.ok(struct.eventCpi, `${struct.name} in ${struct.file} has no #[event_cpi]`);
  }
});

test("the Rust structs really were parsed, not silently missed", () => {
  assert.ok(STRUCTS.size >= 12, `only ${STRUCTS.size} account structs were parsed`);
  for (const name of [
    "InitializeAgreement",
    "Fund",
    "Settle",
    "Refund",
    "Cancel",
    "OpenDispute",
    "ResolveDispute",
    "SelectCounterparty",
    "CreateMilestone",
    "UpdateMilestone",
    "SettleMilestone",
    "SubmitProof",
    "DecideProof",
    "MarkCompleted",
  ]) {
    assert.ok(STRUCTS.has(name), `${name} was not parsed out of the program source`);
  }
});

/* ------------------------------------------------------- argument encoding */

test("initialize_agreement encodes its arguments in declaration order", () => {
  const instruction = initializeAgreementInstruction({
    creator,
    mint,
    agreementId,
    counterparty,
    agreementType: "MilestoneContract",
    amount: 100n,
    termsHash,
  });
  const data = instruction.data;
  assert.equal(data.length, 8 + 8 + 32 + 1 + 8 + 32);
  assert.equal(data.readBigUInt64LE(8), agreementId);
  assert.equal(
    new PublicKey(data.subarray(16, 48)).toBase58(),
    counterparty.toBase58(),
  );
  assert.equal(data[48], AGREEMENT_TYPE.MilestoneContract);
  assert.equal(data.readBigUInt64LE(49), 100n);
  assert.deepEqual(Array.from(data.subarray(57, 89)), Array.from(termsHash));
});

test("the agreement type discriminants match the Rust enum's declaration order", () => {
  const source = readFileSync(
    join(REPO, "programs", "ppv_escrow", "src", "state", "enums.rs"),
    "utf8",
  );
  const body = source.match(/pub enum AgreementType \{([\s\S]*?)\n\}/)[1];
  const variants = [...body.matchAll(/^\s{4}(\w+),/gm)].map((m) => m[1]);
  assert.deepEqual(variants, Object.keys(AGREEMENT_TYPE));
  variants.forEach((variant, index) => assert.equal(AGREEMENT_TYPE[variant], index));
});

test("select_counterparty encodes exactly one pubkey", () => {
  const instruction = selectCounterpartyInstruction({ creator, agreement, counterparty });
  assert.equal(instruction.data.length, 8 + 32);
  assert.equal(new PublicKey(instruction.data.subarray(8)).toBase58(), counterparty.toBase58());
});

test("create_milestone encodes amount then terms hash", () => {
  const instruction = createMilestoneInstruction({
    creator,
    agreement,
    milestone,
    amount: 40n,
    termsHash,
  });
  assert.equal(instruction.data.length, 8 + 8 + 32);
  assert.equal(instruction.data.readBigUInt64LE(8), 40n);
});

test("submit_proof encodes content hash then metadata hash", () => {
  const content = Buffer.alloc(32, 1);
  const metadata = Buffer.alloc(32, 2);
  const instruction = submitProofInstruction({
    submitter: creator,
    agreement,
    proofIndex: 0,
    contentHash: content,
    metadataHash: metadata,
  });
  assert.equal(instruction.data.length, 8 + 64);
  assert.deepEqual(Array.from(instruction.data.subarray(8, 40)), Array.from(content));
  assert.deepEqual(Array.from(instruction.data.subarray(40, 72)), Array.from(metadata));
});

/* ------------------------------------------------------------- derivations */

test("PDA derivations match the seeds the program declares", () => {
  const constants = readFileSync(
    join(REPO, "programs", "ppv_escrow", "src", "constants.rs"),
    "utf8",
  );
  const seedOf = (name) => constants.match(new RegExp(`${name}: &\\[u8\\] = b"([^"]+)"`))[1];
  assert.equal(seedOf("AGREEMENT_SEED"), "agreement");
  assert.equal(seedOf("VAULT_AUTHORITY_SEED"), "vault");
  assert.equal(seedOf("VAULT_TOKEN_SEED"), "vault_token");
  assert.equal(seedOf("PROOF_SEED"), "proof");
  assert.equal(seedOf("MILESTONE_SEED"), "milestone");
  assert.equal(
    constants.match(/CORE_PROOF_ID_DOMAIN: &\[u8\] = b"([^"]+)"/)[1],
    "ppv:escrow:core-proof:v1",
  );

  assert.equal(
    deriveAgreement(creator, agreementId)[0].toBase58(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("agreement"), creator.toBuffer(), (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(agreementId);
        return b;
      })()],
      ESCROW_PROGRAM_ID,
    )[0].toBase58(),
  );
});

test("the derivations agree with the published SDK, which integrators use", async () => {
  const sdk = await import("@gwap/ppv-sdk");
  const id = ESCROW_ID;
  assert.equal(
    sdk.deriveAgreement(id, creator.toBase58(), agreementId).address,
    agreement.toBase58(),
  );
  assert.equal(sdk.deriveVault(id, agreement.toBase58()).address, vault.toBase58());
  assert.equal(
    sdk.deriveVaultAuthority(id, agreement.toBase58()).address,
    vaultAuthority.toBase58(),
  );
  assert.equal(sdk.deriveMilestone(id, agreement.toBase58(), 0).address, milestone.toBase58());
  assert.equal(sdk.deriveProof(id, agreement.toBase58(), 0).address, proof.toBase58());
  assert.deepEqual(
    Array.from(sdk.coreProofId(agreement.toBase58(), 0)),
    Array.from(coreProofId(agreement, 0)),
  );
  assert.equal(
    sdk.deriveCoreProof(CORE_ID, creator.toBase58(), agreement.toBase58(), 0).address,
    deriveCoreProof(creator, coreProofId(agreement, 0))[0].toBase58(),
  );
});

test("the core proof id matches the program's own domain-separated derivation", () => {
  const expected = createHash("sha256")
    .update(Buffer.from("ppv:escrow:core-proof:v1"))
    .update(agreement.toBuffer())
    .update((() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(3);
      return b;
    })())
    .digest()
    .subarray(0, 16);
  assert.deepEqual(Array.from(coreProofId(agreement, 3)), Array.from(expected));
});

/* ---------------------------------------------------------- token program */

test("every instruction addresses Classic SPL Token, never Token-2022", () => {
  const withTokenProgram = CASES.filter((kase) =>
    kase.accounts.some((key) => key.equals(TOKEN_PROGRAM_ID)),
  );
  assert.ok(withTokenProgram.length >= 6, "the custody instructions must name a token program");
  for (const kase of CASES) {
    const instruction = kase.instruction();
    assert.ok(
      !instruction.keys.some((key) => key.pubkey.equals(TOKEN_2022_PROGRAM_ID)),
      `${kase.name} must not address Token-2022`,
    );
  }
});

test("the escrow program declares Classic SPL Token in its account structs", () => {
  // The harness's Token-2022 refusal is only meaningful if the program agrees.
  //
  // Comments are stripped first, deliberately. `initialize_agreement.rs`
  // *explains* that it avoids Anchor's `init` + `token::` constraints precisely
  // because their codegen reaches for `anchor_spl::token_2022` — a sentence
  // about staying classic-token-only, which a naive grep reads as evidence of
  // the opposite.
  for (const file of readdirSync(INSTRUCTIONS_DIR)) {
    const source = readFileSync(join(INSTRUCTIONS_DIR, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/token_2022|Token2022/.test(source),
      `${file} references Token-2022 in code; the classic-token-only scope has changed`,
    );
    assert.ok(
      !/Program<'info, Token2022>/.test(source),
      `${file} declares a Token-2022 program account`,
    );
  }

  // And the one that actually fixes the scope: the token program is the classic
  // `Token` type in every struct that takes one.
  const fund = readFileSync(join(INSTRUCTIONS_DIR, "fund.rs"), "utf8");
  assert.match(fund, /pub token_program: Program<'info, Token>/);
});

test("the permanent program ids are the deployed ones", () => {
  assert.equal(ESCROW_PROGRAM_ID.toBase58(), ESCROW_ID);
  assert.equal(CORE_PROGRAM_ID.toBase58(), CORE_ID);
  const lib = readFileSync(join(REPO, "programs", "ppv_escrow", "src", "lib.rs"), "utf8");
  assert.ok(lib.includes(`declare_id!("${ESCROW_ID}")`));
});

test("an unknown instruction name is refused rather than encoded", () => {
  assert.throws(
    () => updateMilestoneInstruction({ name: "settle_milestone", signerKey: creator, agreement, milestone }),
    /not a milestone update instruction/,
  );
  assert.throws(
    () => decideProofInstruction({ name: "submit_proof", decider: creator, agreement, proof }),
    /not a proof decision instruction/,
  );
  assert.throws(
    () =>
      initializeAgreementInstruction({
        creator,
        mint,
        agreementId,
        counterparty,
        agreementType: "NotAType",
        amount: 1n,
        termsHash,
      }),
    /unknown agreement type/,
  );
});


/* --------------------------------------------- the optional settlement proof */

/**
 * The optional account, in both of its states.
 *
 * The struct-pinning cases above all pass `settlementProof: null`, so they
 * exercise the absent path only — and the absent path is the forgiving one,
 * because Anchor forces an absent optional to non-writable regardless of what
 * the client asked for. The *present* path takes its writability from the IDL,
 * which takes it from the struct, and `settlement_proof` is declared without
 * `#[account(mut)]` in both `Settle` and `SettleMilestone`: a settlement cites
 * evidence, it does not modify it.
 *
 * A writable-when-present client would have been accepted by the runtime and
 * would never have failed, which is exactly the silent divergence from the
 * generated client that hand-encoding has to be defended against.
 */
test("settlement_proof is declared without #[account(mut)] in both structs", () => {
  for (const [file, struct] of [
    ["settle.rs", "Settle"],
    ["milestone.rs", "SettleMilestone"],
  ]) {
    const source = readFileSync(join(INSTRUCTIONS_DIR, file), "utf8");
    const body = source.match(new RegExp(`pub struct ${struct}<'info> \\{([\\s\\S]*?)\\n\\}`))[1];
    const declaration = body.match(/([^\n]*\n[^\n]*)pub settlement_proof:/);
    assert.ok(declaration, `${struct} has no settlement_proof field`);
    assert.ok(
      !/#\[account\(\s*mut/.test(declaration[1]),
      `${struct}.settlement_proof is now mutable; the builders must follow`,
    );
  }
});

for (const [label, build] of [
  [
    "settle",
    (settlementProof) =>
      settleInstruction({
        signerKey: creator,
        agreement,
        mint,
        vault,
        vaultAuthority,
        sellerTokenAccount: otherAccount,
        settlementProof,
      }),
  ],
  [
    "settle_milestone",
    (settlementProof) =>
      settleMilestoneInstruction({
        signerKey: creator,
        agreement,
        milestone,
        mint,
        vault,
        vaultAuthority,
        sellerTokenAccount: otherAccount,
        settlementProof,
      }),
  ],
]) {
  test(`${label}: an absent settlement proof is the program id, read-only`, () => {
    const instruction = build(null);
    const slot = instruction.keys.find((key) => key.pubkey.equals(ESCROW_PROGRAM_ID));
    assert.ok(slot, "an absent optional account must be signalled by the program id");
    assert.equal(slot.isWritable, false);
    assert.equal(slot.isSigner, false);
  });

  test(`${label}: a cited settlement proof is passed read-only, as the struct declares`, () => {
    const instruction = build(proof);
    const slot = instruction.keys.find((key) => key.pubkey.equals(proof));
    assert.ok(slot, "the cited proof must appear in the account list");
    assert.equal(
      slot.isWritable,
      false,
      "settlement_proof has no #[account(mut)]; a settlement cites evidence rather than modifying it",
    );
    assert.equal(slot.isSigner, false);
  });

  test(`${label}: citing a proof changes only that one slot`, () => {
    const absent = build(null).keys;
    const present = build(proof).keys;
    assert.equal(absent.length, present.length);
    const differing = absent
      .map((key, index) => [index, key, present[index]])
      .filter(([, a, b]) => !a.pubkey.equals(b.pubkey) || a.isWritable !== b.isWritable);
    assert.equal(differing.length, 1, "only the optional slot may differ");
    assert.ok(differing[0][1].pubkey.equals(ESCROW_PROGRAM_ID));
    assert.ok(differing[0][2].pubkey.equals(proof));
  });
}
