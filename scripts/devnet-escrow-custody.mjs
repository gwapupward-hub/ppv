#!/usr/bin/env node
/**
 * PPV Escrow live devnet custody validation.
 *
 * `ppv_escrow` is deployed to devnet, its bytes match the reviewed release, and
 * its upgrade authority is the dedicated custody vault. All three are facts
 * about *identity*, established by reading accounts. None of them says anything
 * about what the program does when there are tokens in it, and the repository
 * has until now had no way to find out: every custody claim it makes is proved
 * against a model, a local validator, or the source.
 *
 * This harness is the missing third thing. It puts disposable, economically
 * worthless Classic SPL tokens into real per-agreement vaults on devnet and
 * establishes, by arithmetic over observed balances, that:
 *
 *   * money enters the vault the protocol derives, in the exact amount agreed;
 *   * money leaves it only to the party the protocol names;
 *   * every unauthorized, mis-destined, mis-minted, duplicated and
 *     post-terminal attempt is refused *and leaves nothing changed*;
 *   * the events the deployed program emits reconstruct the histories that
 *     actually happened.
 *
 * What it is not:
 *
 *   * It is not authorization to open the custody gate. RR-13 — an independent
 *     Solana security review — is open, legal review is open, and a passing
 *     live run is not a substitute for either.
 *   * It is not a mainnet artifact. The cluster gate refuses mainnet by genesis
 *     hash before a keypair is loaded or an instruction is built.
 *   * It is not a deployment tool. It holds no program keypair, takes no
 *     upgrade authority, and calls no loader instruction.
 *
 * Usage:
 *
 *   PPV_CUSTODY_RPC_URL=https://api.devnet.solana.com \
 *   PPV_CUSTODY_FUNDER=/path/to/devnet-funder.json \
 *     node scripts/devnet-escrow-custody.mjs --execute
 *
 * Without `--execute` it runs the read-only preflight and stops, which is the
 * safe default: a harness whose value-moving mode is the default is one
 * mistyped command from sending transactions nobody asked for.
 *
 * The funder is a disposable devnet wallet whose only job is paying rent and
 * fees for the throwaway wallets this run creates. Its path is read, never
 * printed; no key material reaches stdout, the evidence record, or the
 * repository.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import { loadFunderSecretOrThrow } from "./lib/funder-secret.mjs";
import { PERMANENT_PROGRAM_IDS, ESCROW_CUSTODY_GOVERNANCE } from "./lib/identity.mjs";
import { registerSensitiveEndpoint, redact } from "./lib/endpoint-safety.mjs";
import { DEVNET_GENESIS, RPC_RATE_LIMIT, RpcRateLimitError, readDeployedProgram, rpc } from "./lib/rpc.mjs";
import {
  PERMISSION_ALL,
  SQUADS_V4_PROGRAM_ID,
  compareToPolicy,
  deriveVault as deriveSquadsVault,
  readMultisig,
} from "./lib/squads.mjs";
import {
  ESCROW_PROGRAM_ID,
  CORE_PROGRAM_ID,
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
  markCompletedInstruction,
  openDisputeInstruction,
  refundInstruction,
  resolveDisputeInstruction,
  selectCounterpartyInstruction,
  settleInstruction,
  settleMilestoneInstruction,
  submitProofInstruction,
  updateMilestoneInstruction,
} from "./lib/escrow-instructions.mjs";
import {
  CustodyDefect,
  CustodyHarnessFailure,
  assertNoSecrets,
  attemptRefusal,
  jsonSafe,
  requireDevnet,
  requireNoMainnetEndpoint,
  send,
  snapshotBalances,
  stepWithoutValue,
} from "./lib/custody-runner.mjs";
import {
  PPV_INVARIANTS,
  assertAccountingConsistent,
  assertFunding,
  assertNoMovement,
  assertPayout,
  assertTerminal,
} from "./lib/custody-invariants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

/** The harness's own version, recorded in evidence so a result names its tool. */
export const HARNESS_VERSION = "1.0.0";

/**
 * The deployment facts this run refuses to proceed without.
 *
 * Written down rather than read from the evidence record alone, so that a run
 * against a tampered record fails instead of validating whatever it was handed.
 * The record is then checked against these, and the chain against both.
 */
export const EXPECTED = Object.freeze({
  genesis: DEVNET_GENESIS,
  programId: "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4",
  programDataAddress: "2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa",
  upgradeAuthority: "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE",
  binaryHash: "0acc61defeb2ee810cf3a4bc87f93f8ef457399fe6b52d170055ed7e0c96f9bf",
  releaseCommit: "231dceb91c141e1afe6e57ef48fafb199da5c678",
  evidencePath: "deployments/evidence/ppv-escrow-devnet-231dceb.json",
  evidenceSha256: "7c74113405ec4a537aeb13a931c4c07c00bc476a8e4b899a5fbe2ac79ac15196",
  multisig: "GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46",
  threshold: 2,
  members: Object.freeze([
    "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
    "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ]),
  vaultIndex: 0,
});

/**
 * Which coverage rows in `scripts/devnet-smoke.mjs` a completed scenario
 * establishes.
 *
 * Named here, next to the scenario that would establish them, so a row goes
 * green because a specific scenario ran rather than because a release record
 * exists. A scenario that fails, or that never runs, contributes nothing.
 */
export const SCENARIO_COVERAGE = Object.freeze({
  ordinaryEscrow: ["funding", "settlement"],
  cancel: [],
  refund: ["refund"],
  disputeToSeller: ["concession / dispute"],
  disputeToBuyer: ["concession / dispute"],
  milestones: ["milestone release"],
  bounty: ["bounty counterparty selection"],
  proofs: ["approval"],
});

const log = (line = "") => process.stdout.write(`${line}\n`);
const step = (ok, name, detail = "") =>
  log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * What each disposable wallet is given, and why it is not smaller.
 *
 * The buyer is the creator of every agreement, and a creator pays rent for
 * every account its instructions open. Over the full matrix that is:
 *
 *   10 agreements       × 0.003410 SOL = 0.03410   (EscrowAgreement, 362 bytes)
 *   10 vault token accts × 0.002039 SOL = 0.02039   (SPL token account, 165 bytes)
 *    3 milestones        × 0.002165 SOL = 0.00649   (Milestone, 183 bytes)
 *   ~30 transaction fees                 = 0.00015
 *                                        ----------
 *                                          0.06113 SOL
 *
 * The first version of this file funded each wallet with 0.05 SOL, which is
 * less than that. The run would have reached roughly the bounty scenario and
 * then failed on an account it could not pay rent for — after several vaults
 * had already been funded and emptied, and with a real chance of dying between
 * a `fund` and its settlement, which is precisely the stranded-custody outcome
 * the accounting rules exist to prevent.
 *
 * 0.25 SOL is four times the computed need. Devnet SOL is free and meaningless,
 * so the margin costs nothing; running out mid-matrix costs an entire authorized
 * execution.
 */
export const WALLET_FUNDING_LAMPORTS = 0.25 * LAMPORTS_PER_SOL;

/**
 * The floor the funder must clear before the harness will move value.
 *
 * Three wallets at 0.25, plus the funder's own outlay — two mints, five
 * associated token accounts, and the fees for creating them — is roughly
 * 0.77 SOL. One SOL is the smallest round number above that with margin, and
 * asking for more than the run can spend would be its own kind of sloppiness.
 */
export const MINIMUM_FUNDER_LAMPORTS = 1 * LAMPORTS_PER_SOL;

/**
 * The funder, checked before anything is created.
 *
 * Reports the funder's PUBLIC address and balance — never anything else about
 * it — and refuses to continue below the floor. A run that discovers it is out
 * of SOL halfway through the matrix has spent an authorization it cannot get
 * back, and may leave a vault holding tokens; this is the check that makes that
 * a refusal at the start instead.
 */
export async function checkFunder(connection, funderPublicKey, { minimum = MINIMUM_FUNDER_LAMPORTS } = {}) {
  const lamports = await connection.getBalance(funderPublicKey, "confirmed");
  const sol = lamports / LAMPORTS_PER_SOL;
  if (lamports < minimum) {
    throw new CustodyHarnessFailure(
      `the funder ${funderPublicKey.toBase58()} holds ${sol} SOL; the full scenario matrix needs ` +
        `at least ${minimum / LAMPORTS_PER_SOL} SOL. Top it up from the devnet faucet rather than ` +
        "starting a run that cannot finish.",
    );
  }
  return { address: funderPublicKey.toBase58(), lamports, sol };
}

/** A unique, meaningless 32-byte hash per run, so nothing collides across runs. */
function runHash(runId, label) {
  return createHash("sha256").update(`ppv:custody-validation:${runId}:${label}`).digest();
}

/* ============================================================== PHASE 2 ==== */

/**
 * Everything provable by reading, before a single token exists.
 *
 * Ordered so the cheapest refusal comes first and the most expensive read last,
 * and so mainnet is refused before anything at all is constructed.
 */
export async function preflight(client, { evidence, expected = EXPECTED } = {}) {
  const facts = {};
  log("Read-only preflight");

  facts.genesis = await requireDevnet(client);
  step(true, "cluster is devnet, and is not mainnet-beta", facts.genesis);

  const program = await client.accountInfo(expected.programId);
  if (!program) throw new CustodyHarnessFailure(`${expected.programId} has no account`);
  if (!program.executable) {
    throw new CustodyHarnessFailure(`${expected.programId} is not executable`);
  }
  if (program.owner !== "BPFLoaderUpgradeab1e11111111111111111111111") {
    throw new CustodyHarnessFailure(
      `${expected.programId} is owned by ${program.owner}, not the upgradeable loader`,
    );
  }
  facts.programId = expected.programId;
  facts.programOwner = program.owner;
  step(true, "ppv_escrow is deployed, executable, loader-owned", expected.programId);

  const record = evidence ?? readEvidence(join(REPO, expected.evidencePath));
  if (record.programId !== expected.programId) {
    throw new CustodyHarnessFailure("the canonical evidence names a different program id");
  }
  if (record.releaseCommit !== expected.releaseCommit) {
    throw new CustodyHarnessFailure(
      `the canonical evidence names release commit ${record.releaseCommit}, expected ` +
        `${expected.releaseCommit}`,
    );
  }
  facts.releaseCommit = record.releaseCommit;
  step(true, "canonical evidence still names the reviewed release commit", record.releaseCommit);

  // The recorded release length, passed so the comparison is against exactly
  // the deployed ELF and the loader's tail is separately proved to be zero
  // padding — a stronger statement than trimming trailing zeros and hoping.
  const deployed = await readDeployedProgram(client, expected.programId, {
    binaryLength: record.binaryLength ?? null,
  });
  if (deployed.programDataAddress !== expected.programDataAddress) {
    throw new CustodyHarnessFailure(
      `ProgramData resolves to ${deployed.programDataAddress}, expected ${expected.programDataAddress}`,
    );
  }
  facts.programDataAddress = deployed.programDataAddress;
  step(true, "ProgramData resolves to the recorded account", deployed.programDataAddress);

  if (deployed.upgradeAuthority !== expected.upgradeAuthority) {
    throw new CustodyHarnessFailure(
      `SECURITY: the live upgrade authority is ${deployed.upgradeAuthority}, expected the custody ` +
        `vault ${expected.upgradeAuthority}. Somebody other than the custody multisig can replace ` +
        "the code this run is about to put tokens into.",
    );
  }
  facts.upgradeAuthority = deployed.upgradeAuthority;
  step(true, "upgrade authority is the custody vault", deployed.upgradeAuthority);

  if (deployed.deployedBinaryHash !== expected.binaryHash) {
    throw new CustodyHarnessFailure(
      `SECURITY: the deployed bytes hash to ${deployed.deployedBinaryHash}, not the reviewed ` +
        `${expected.binaryHash}. This is not the binary the attack matrix describes.`,
    );
  }
  facts.binaryHash = `sha256:${deployed.deployedBinaryHash}`;
  facts.lastDeploySlot = deployed.lastDeploySlot;
  step(true, "deployed bytes are the reviewed binary", facts.binaryHash);

  // RR-7: the multisig itself, not what the repository says about it.
  const multisig = await readMultisig(client, expected.multisig);
  const squadsFailures = compareToPolicy(multisig, {
    multisig: expected.multisig,
    threshold: expected.threshold,
    members: [...expected.members],
    vault: expected.upgradeAuthority,
    vaultIndex: expected.vaultIndex,
    requiredPermissionMask: PERMISSION_ALL,
  });
  if (squadsFailures.length > 0) {
    throw new CustodyHarnessFailure(
      `the live Squads multisig does not match the recorded custody configuration:\n  ` +
        squadsFailures.join("\n  "),
    );
  }
  const derivedVault = deriveSquadsVault(expected.multisig, expected.vaultIndex);
  facts.squads = {
    program: SQUADS_V4_PROGRAM_ID,
    multisig: expected.multisig,
    threshold: multisig.threshold,
    members: multisig.members.map((member) => member.key),
    permissions: multisig.members.map((member) => member.mask),
    permissionNames: multisig.members.map((member) => member.permissions.join("+")),
    vaultIndex: expected.vaultIndex,
    vaultDerived: derivedVault.address,
    vaultBump: derivedVault.bump,
    timeLock: multisig.timeLock,
    decodedFrom: "live-chain-state",
  };
  step(
    true,
    `Squads multisig decoded live: ${multisig.threshold}-of-${multisig.members.length}`,
    `vault[${expected.vaultIndex}] = ${derivedVault.address}`,
  );

  // One shared signer with Core/Commerce governance, and exactly one.
  const nonCustody = [
    "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
    "2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ];
  const shared = facts.squads.members.filter((member) => nonCustody.includes(member));
  if (shared.length !== 1) {
    throw new CustodyHarnessFailure(
      `${shared.length} live custody signer(s) also govern the non-custodial programs ` +
        `(${shared.join(", ") || "none"}); exactly one is the approved devnet exception`,
    );
  }
  facts.sharedSignerCount = shared.length;
  facts.sharedSigners = shared;
  step(true, "exactly one shared signer, the approved devnet exception", shared[0]);

  // The governance record in this repository must agree with the chain.
  if (
    ESCROW_CUSTODY_GOVERNANCE.vault !== derivedVault.address ||
    ESCROW_CUSTODY_GOVERNANCE.multisig !== expected.multisig
  ) {
    throw new CustodyHarnessFailure(
      "the frozen ESCROW_CUSTODY_GOVERNANCE record disagrees with the live multisig",
    );
  }
  step(true, "the frozen governance record agrees with the chain");

  log("\nREAD_ONLY_PREFLIGHT=PASS");
  log("SQUADS_LIVE_DECODE=PASS");
  return facts;
}

export function readEvidence(path) {
  const raw = readFileSync(path);
  const sha = createHash("sha256").update(raw).digest("hex");
  const record = JSON.parse(raw.toString("utf8"));
  if (sha !== EXPECTED.evidenceSha256) {
    throw new CustodyHarnessFailure(
      `canonical evidence ${path} hashes to ${sha}, expected ${EXPECTED.evidenceSha256}. ` +
        "The record this run would validate against has changed.",
    );
  }
  record.__sha256 = sha;
  return record;
}

/* ============================================================== PHASE 4 ==== */

/**
 * Disposable material for one run.
 *
 * Every wallet is generated here and discarded when the process exits. Nothing
 * is written to disk, nothing is reused between runs, and the only key that
 * outlives the process is the funder's, which the operator supplies and this
 * file only ever reads.
 *
 * The mint has `decimals = 0` deliberately. Custody accounting is the thing
 * under test, and integer units make every assertion in the run a statement
 * about exact quantities rather than about a scaled representation of them —
 * "the vault holds 100" rather than "the vault holds 100000000, which is 100".
 */
/**
 * A pause between the setup burst and the first scenario read.
 *
 * Setup opens three wallets, two mints, five token accounts and two mints-to in
 * a few seconds, each with its own confirmation polling, and the first thing
 * the matrix then does is a `getMultipleAccounts` over every watched address.
 * On public devnet in run 35405785493 that last read was the one the rate
 * limiter refused.
 *
 * This is not the fix — bounded 429 handling in `scripts/lib/rpc.mjs` is. It is
 * a cheap way to stop asking for the refusal in the first place, and it is
 * deliberately short: a long sleep would be a way of hiding a rate-limit
 * problem rather than surviving one.
 */
export const SCENARIO_COOLDOWN_MS = 750;

export async function cooldownBeforeScenarios({ sleep = setTimeout } = {}) {
  await new Promise((resolve) => sleep(resolve, SCENARIO_COOLDOWN_MS));
}

export async function setup(ctx, { supply = 10_000n } = {}) {
  const spl = await import("@solana/spl-token");
  log("\nDisposable test material");

  ctx.buyer = Keypair.generate();
  ctx.seller = Keypair.generate();
  ctx.outsider = Keypair.generate();
  for (const [name, wallet] of [
    ["buyer", ctx.buyer],
    ["seller", ctx.seller],
    ["outsider", ctx.outsider],
  ]) {
    await fundLamports(ctx, wallet.publicKey, WALLET_FUNDING_LAMPORTS);
    step(
      true,
      `disposable ${name} wallet`,
      `${wallet.publicKey.toBase58()} (${WALLET_FUNDING_LAMPORTS / LAMPORTS_PER_SOL} SOL)`,
    );
  }

  // Classic SPL Token only. Token-2022 is out of scope for this program: it
  // declares `Program<'info, Token>`, and a transfer hook or fee extension
  // would change what "the amount that arrived" means.
  ctx.mint = await spl.createMint(
    ctx.connection,
    ctx.funder,
    ctx.funder.publicKey,
    null,
    0,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  ctx.otherMint = await spl.createMint(
    ctx.connection,
    ctx.funder,
    ctx.funder.publicKey,
    null,
    0,
    undefined,
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  step(true, "disposable Classic SPL mint, decimals 0", ctx.mint.toBase58());
  step(true, "second disposable mint, for the mint-binding negatives", ctx.otherMint.toBase58());

  ctx.ata = {};
  for (const [name, owner, mint] of [
    ["buyer", ctx.buyer, ctx.mint],
    ["seller", ctx.seller, ctx.mint],
    ["outsider", ctx.outsider, ctx.mint],
    ["buyerOther", ctx.buyer, ctx.otherMint],
    ["sellerOther", ctx.seller, ctx.otherMint],
  ]) {
    const account = await spl.createAssociatedTokenAccount(
      ctx.connection,
      ctx.funder,
      mint,
      owner.publicKey,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
    );
    ctx.ata[name] = account;
    watch(ctx, account.toBase58());
  }
  step(true, "disposable token accounts created", Object.keys(ctx.ata).join(", "));

  await spl.mintTo(
    ctx.connection,
    ctx.funder,
    ctx.mint,
    ctx.ata.buyer,
    ctx.funder,
    supply,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  await spl.mintTo(
    ctx.connection,
    ctx.funder,
    ctx.otherMint,
    ctx.ata.buyerOther,
    ctx.funder,
    supply,
    [],
    { commitment: "confirmed" },
    TOKEN_PROGRAM_ID,
  );
  step(true, `${supply} economically meaningless test units minted to the buyer`);

  ctx.supply = supply;
  return ctx;
}

/** Tops a disposable wallet up for rent and fees, from the funder. */
async function fundLamports(ctx, to, lamports) {
  const { SystemProgram } = await import("@solana/web3.js");
  const balance = await ctx.connection.getBalance(to, "confirmed");
  if (balance >= lamports) return;
  await send(
    ctx.connection,
    [
      SystemProgram.transfer({
        fromPubkey: ctx.funder.publicKey,
        toPubkey: to,
        lamports: lamports - balance,
      }),
    ],
    [ctx.funder],
    { label: `funding ${to.toBase58()} for fees`, client: ctx.client },
  );
}

/** Registers an account so every later snapshot covers it. */
export function watch(ctx, address) {
  ctx.watched.add(address);
  return address;
}

export function watched(ctx) {
  return [...ctx.watched];
}

/* --------------------------------------------------------- agreement reads */

/** The agreement account as the deployed program wrote it. */
export async function readAgreement(ctx, agreement) {
  const { decodeEscrowAgreementAccount } = await import("@gwap/ppv-sdk");
  const info = await ctx.client.accountInfo(agreement.toBase58());
  if (!info) return null;
  const decoded = decodeEscrowAgreementAccount(Buffer.from(info.data[0], "base64"));
  return decoded;
}

export async function readMilestone(ctx, milestone) {
  const { decodeMilestoneAccount } = await import("@gwap/ppv-sdk");
  const info = await ctx.client.accountInfo(milestone.toBase58());
  if (!info) return null;
  return decodeMilestoneAccount(Buffer.from(info.data[0], "base64"));
}

export async function readProof(ctx, proof) {
  const { decodeProofAccount } = await import("@gwap/ppv-sdk");
  const info = await ctx.client.accountInfo(proof.toBase58());
  if (!info) return null;
  return decodeProofAccount(Buffer.from(info.data[0], "base64"));
}

/**
 * Creates an agreement and returns everything the scenarios need to address it.
 *
 * The derived vault and vault authority are asserted against what the program
 * actually wrote, rather than assumed — a client that derives a different vault
 * than the program uses would otherwise pass every balance check by watching an
 * account nothing touches.
 */
export async function openAgreement(
  ctx,
  { label, creator, counterparty, agreementType = "Escrow", amount, mint = null },
) {
  const agreementId = ctx.nextAgreementId();
  const useMint = mint ?? ctx.mint;
  const [agreement] = deriveAgreement(creator.publicKey, agreementId);
  const [vaultAuthority] = deriveVaultAuthority(agreement);
  const [vault] = deriveVault(agreement);
  watch(ctx, vault.toBase58());

  const before = await snapshotBalances(ctx.client, watched(ctx));
  const signature = await send(
    ctx.connection,
    [
      initializeAgreementInstruction({
        creator: creator.publicKey,
        mint: useMint,
        agreementId,
        counterparty,
        agreementType,
        amount,
        termsHash: runHash(ctx.runId, `${label}:terms`),
      }),
    ],
    [creator],
    { label: `${label}: initialize_agreement`, client: ctx.client },
  );
  const after = await snapshotBalances(ctx.client, watched(ctx));
  assertNoMovement(before, after, { label: `${label}: initialize_agreement` });

  const account = await readAgreement(ctx, agreement);
  if (!account) throw new CustodyHarnessFailure(`${label}: the agreement account was not created`);
  if (account.state !== "Open") {
    throw new CustodyDefect(`${label}: a new agreement is in state ${account.state}, not Open`);
  }
  if (account.vault !== vault.toBase58()) {
    throw new CustodyDefect(
      `${label}: the program recorded vault ${account.vault}, the client derived ${vault.toBase58()}`,
    );
  }
  if (account.mint !== useMint.toBase58()) {
    throw new CustodyDefect(`${label}: the program recorded mint ${account.mint}`);
  }
  step(true, `${label}: initialized, state=Open`, agreement.toBase58());

  return {
    label,
    agreementId,
    agreement,
    vault,
    vaultAuthority,
    mint: useMint,
    amount,
    signatures: [{ step: "initialize_agreement", signature }],
    account,
  };
}

/**
 * One value-moving step, asserted as arithmetic rather than as a status.
 *
 * `expected` is the complete delta map: every watched account absent from it
 * must not have moved. The agreement's own accounting is re-read afterwards and
 * checked against the vault, which is what makes `PPV-P10` a live claim rather
 * than a model one.
 */
export async function valueStep(
  ctx,
  handle,
  { label, instructions, signers, expected, expectState, invariant },
) {
  const before = await snapshotBalances(ctx.client, watched(ctx));
  const signature = await send(ctx.connection, instructions, signers, { label, client: ctx.client });
  const after = await snapshotBalances(ctx.client, watched(ctx));

  const observed = expected(before, after);
  const account = await readAgreement(ctx, handle.agreement);
  if (expectState && account.state !== expectState) {
    throw new CustodyDefect(
      `${label}: the agreement is in state ${account.state}, expected ${expectState}`,
    );
  }
  assertAccountingConsistent(account, after.get(handle.vault.toBase58()), { label });

  handle.signatures.push({ step: label, signature });
  handle.account = account;
  step(true, label, `${signature.slice(0, 12)}… state=${account.state}`);
  return { signature, deltas: observed, account, invariant };
}

/* ========================================================== PHASES 5–10 ==== */

/**
 * The ordinary path, end to end, with the double-settlement refusal attached to
 * it rather than filed away in a negative suite — because "this agreement
 * cannot pay twice" is a property of *this* agreement in *this* terminal state,
 * and testing it against some other agreement would prove something weaker.
 */
export async function scenarioOrdinaryEscrow(ctx) {
  log("\nPhase 5 — ordinary escrow");
  const amount = 25n;
  const handle = await openAgreement(ctx, {
    label: "ordinary",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount,
  });
  const negatives = [];

  await valueStep(ctx, handle, {
    label: "ordinary: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount,
        label: "ordinary: fund",
      }),
  });

  // Double funding: Open-only, and the agreement is Funded.
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: fund a second time",
      invariant: "PPV-P8",
      instructions: [
        fundInstruction({
          buyer: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          funderTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  // The seller cannot settle to itself before completion, and the buyer cannot
  // mark the seller's work complete.
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: buyer marks the seller's work completed",
      invariant: "PPV-P6",
      instructions: [
        markCompletedInstruction({ seller: ctx.buyer.publicKey, agreement: handle.agreement }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "ordinary: mark_completed",
    invariant: "PPV-P10",
    instructions: [
      markCompletedInstruction({ seller: ctx.seller.publicKey, agreement: handle.agreement }),
    ],
    signers: [ctx.seller],
    expectState: "Completed",
    expected: (before, after) =>
      assertNoMovement(before, after, { label: "ordinary: mark_completed" }),
  });

  // Settlement must land in an account the seller owns, under the right mint.
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: settle to an outsider's token account",
      invariant: "PPV-P4",
      instructions: [
        settleInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.outsider,
        }),
      ],
      signers: [ctx.seller],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: settle under the wrong mint",
      invariant: "PPV-P5",
      instructions: [
        settleInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          mint: ctx.otherMint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.sellerOther,
        }),
      ],
      signers: [ctx.seller],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: an outsider settles",
      invariant: "PPV-P6",
      instructions: [
        settleInstruction({
          signerKey: ctx.outsider.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.outsider],
    }),
  );

  await valueStep(ctx, handle, {
    label: "ordinary: settle",
    invariant: "PPV-P4",
    instructions: [
      settleInstruction({
        signerKey: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        sellerTokenAccount: ctx.ata.seller,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Settled",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.seller.toBase58(),
        amount,
        label: "ordinary: settle",
      }),
  });

  await requireEmptyVault(ctx, handle, "ordinary");
  assertTerminal(handle.account.state, { label: "ordinary" });

  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: settle a second time",
      invariant: "PPV-P3",
      instructions: [
        settleInstruction({
          signerKey: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "ordinary: refund after settlement",
      invariant: "PPV-P7",
      instructions: [
        refundInstruction({
          seller: ctx.seller.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          buyerTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  return finish(ctx, handle, negatives, "ordinaryEscrow");
}

/** Phase 6, first half: an agreement nobody funded, abandoned. */
export async function scenarioCancel(ctx) {
  log("\nPhase 6 — cancellation");
  const amount = 11n;
  const handle = await openAgreement(ctx, {
    label: "cancel",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount,
  });
  const negatives = [];

  negatives.push(
    await refuse(ctx, handle, {
      label: "cancel: the seller cancels the buyer's agreement",
      invariant: "PPV-P6",
      instructions: [
        cancelInstruction({ creator: ctx.seller.publicKey, agreement: handle.agreement }),
      ],
      signers: [ctx.seller],
    }),
  );

  await valueStep(ctx, handle, {
    label: "cancel: cancel",
    invariant: "PPV-P10",
    instructions: [cancelInstruction({ creator: ctx.buyer.publicKey, agreement: handle.agreement })],
    signers: [ctx.buyer],
    expectState: "Cancelled",
    expected: (before, after) => assertNoMovement(before, after, { label: "cancel: cancel" }),
  });
  assertTerminal(handle.account.state, { label: "cancel" });
  await requireEmptyVault(ctx, handle, "cancel");

  negatives.push(
    await refuse(ctx, handle, {
      label: "cancel: fund after cancellation",
      invariant: "PPV-P7",
      instructions: [
        fundInstruction({
          buyer: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          funderTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  return finish(ctx, handle, negatives, "cancel");
}

/** Phase 6, second half: the seller gives escrowed money back. */
export async function scenarioRefund(ctx) {
  log("\nPhase 6 — refund");
  const amount = 13n;
  const handle = await openAgreement(ctx, {
    label: "refund",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount,
  });
  const negatives = [];

  await valueStep(ctx, handle, {
    label: "refund: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount,
        label: "refund: fund",
      }),
  });

  // The buyer cannot take its own money back; that is what a dispute is for.
  negatives.push(
    await refuse(ctx, handle, {
      label: "refund: the buyer refunds itself",
      invariant: "PPV-P6",
      instructions: [
        refundInstruction({
          seller: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          buyerTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "refund: the seller refunds to its own account",
      invariant: "PPV-P4",
      instructions: [
        refundInstruction({
          seller: ctx.seller.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          buyerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  await valueStep(ctx, handle, {
    label: "refund: refund",
    invariant: "PPV-P4",
    instructions: [
      refundInstruction({
        seller: ctx.seller.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        buyerTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.seller],
    expectState: "Refunded",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.buyer.toBase58(),
        amount,
        label: "refund: refund",
      }),
  });

  await requireEmptyVault(ctx, handle, "refund");
  assertTerminal(handle.account.state, { label: "refund" });

  negatives.push(
    await refuse(ctx, handle, {
      label: "refund: refund a second time",
      invariant: "PPV-P3",
      instructions: [
        refundInstruction({
          seller: ctx.seller.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          buyerTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  return finish(ctx, handle, negatives, "refund");
}

/**
 * Phase 7 — disputes, resolved only by concession.
 *
 * Two scenarios rather than one, because the two outcomes are different code
 * paths that emit different events and end in different terminal states, and a
 * run that exercised one of them would leave the other unproven.
 *
 * `conceder` is the party that gives up its claim; the money goes to the other
 * one. That is the whole rule, and the negatives below are the ways somebody
 * might try to break it: direct the money to itself, resolve as a non-party,
 * pay a destination belonging to nobody, or pay in the wrong asset.
 */
export async function scenarioDispute(ctx, { conceder, label, expectState, viaCompleted = false }) {
  const isBuyerConceding = conceder === "buyer";
  log(`\nPhase 7 — dispute, ${conceder} concedes`);
  const amount = 17n;
  const handle = await openAgreement(ctx, {
    label,
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount,
  });
  const negatives = [];

  await valueStep(ctx, handle, {
    label: `${label}: fund`,
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount,
        label: `${label}: fund`,
      }),
  });

  if (viaCompleted) {
    await valueStep(ctx, handle, {
      label: `${label}: mark_completed`,
      invariant: "PPV-P10",
      instructions: [
        markCompletedInstruction({ seller: ctx.seller.publicKey, agreement: handle.agreement }),
      ],
      signers: [ctx.seller],
      expectState: "Completed",
      expected: (before, after) =>
        assertNoMovement(before, after, { label: `${label}: mark_completed` }),
    });
  }

  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: an outsider opens the dispute`,
      invariant: "PPV-P6",
      instructions: [
        openDisputeInstruction({
          party: ctx.outsider.publicKey,
          agreement: handle.agreement,
          reasonHash: runHash(ctx.runId, `${label}:reason`),
        }),
      ],
      signers: [ctx.outsider],
    }),
  );

  await valueStep(ctx, handle, {
    label: `${label}: open_dispute`,
    invariant: "PPV-P10",
    instructions: [
      openDisputeInstruction({
        party: (isBuyerConceding ? ctx.seller : ctx.buyer).publicKey,
        agreement: handle.agreement,
        reasonHash: runHash(ctx.runId, `${label}:reason`),
      }),
    ],
    signers: [isBuyerConceding ? ctx.seller : ctx.buyer],
    expectState: "Disputed",
    expected: (before, after) =>
      assertNoMovement(before, after, { label: `${label}: open_dispute` }),
  });

  const conceding = isBuyerConceding ? ctx.buyer : ctx.seller;
  const beneficiaryAta = isBuyerConceding ? ctx.ata.seller : ctx.ata.buyer;
  const concederAta = isBuyerConceding ? ctx.ata.buyer : ctx.ata.seller;

  // The whole safety property: a party cannot concede to itself.
  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: the ${conceder} resolves the dispute to its own account`,
      invariant: "PPV-P4",
      instructions: [
        resolveDisputeInstruction({
          signerKey: conceding.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          destination: concederAta,
        }),
      ],
      signers: [conceding],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: a non-party resolves the dispute`,
      invariant: "PPV-P6",
      instructions: [
        resolveDisputeInstruction({
          signerKey: ctx.outsider.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          destination: beneficiaryAta,
        }),
      ],
      signers: [ctx.outsider],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: resolution to an account owned by nobody in the agreement`,
      invariant: "PPV-P4",
      instructions: [
        resolveDisputeInstruction({
          signerKey: conceding.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          destination: ctx.ata.outsider,
        }),
      ],
      signers: [conceding],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: resolution under the wrong mint`,
      invariant: "PPV-P5",
      instructions: [
        resolveDisputeInstruction({
          signerKey: conceding.publicKey,
          agreement: handle.agreement,
          mint: ctx.otherMint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          destination: isBuyerConceding ? ctx.ata.sellerOther : ctx.ata.buyerOther,
        }),
      ],
      signers: [conceding],
    }),
  );

  await valueStep(ctx, handle, {
    label: `${label}: resolve_dispute`,
    invariant: "PPV-P4",
    instructions: [
      resolveDisputeInstruction({
        signerKey: conceding.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        destination: beneficiaryAta,
      }),
    ],
    signers: [conceding],
    expectState,
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: beneficiaryAta.toBase58(),
        amount,
        label: `${label}: resolve_dispute`,
      }),
  });

  await requireEmptyVault(ctx, handle, label);
  assertTerminal(handle.account.state, { label });

  negatives.push(
    await refuse(ctx, handle, {
      label: `${label}: resolve the dispute a second time`,
      invariant: "PPV-P3",
      instructions: [
        resolveDisputeInstruction({
          signerKey: conceding.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          destination: beneficiaryAta,
        }),
      ],
      signers: [conceding],
    }),
  );

  return finish(ctx, handle, negatives, isBuyerConceding ? "disputeToSeller" : "disputeToBuyer");
}

/**
 * Phase 8 — a milestone contract.
 *
 * Two tranches of a single escrow, which is the shape that makes the accounting
 * worth testing: `settled_total` moves twice, `remaining()` shrinks, and the
 * agreement settles on the last tranche rather than on a separate instruction.
 * A single-tranche milestone contract would exercise none of that.
 */
export async function scenarioMilestones(ctx) {
  log("\nPhase 8 — milestone contract");
  const total = 100n;
  const tranches = [40n, 60n];
  const handle = await openAgreement(ctx, {
    label: "milestones",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    agreementType: "MilestoneContract",
    amount: total,
  });
  const negatives = [];

  const milestones = [];
  for (const [index, amount] of tranches.entries()) {
    const [milestone] = deriveMilestone(handle.agreement, index);
    await valueStep(ctx, handle, {
      label: `milestones: create_milestone ${index} (${amount})`,
      invariant: "PPV-P2",
      instructions: [
        createMilestoneInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          milestone,
          amount,
          termsHash: runHash(ctx.runId, `milestone:${index}`),
        }),
      ],
      signers: [ctx.buyer],
      expectState: "Open",
      expected: (before, after) =>
        assertNoMovement(before, after, { label: `milestones: create_milestone ${index}` }),
    });
    milestones.push({ index, amount, address: milestone });
  }

  if (handle.account.milestoneTotal !== total) {
    throw new CustodyDefect(
      `milestones: the scheduled total is ${handle.account.milestoneTotal}, expected ${total}`,
    );
  }

  // A tranche that would push the schedule past the agreement amount.
  const [overflowMilestone] = deriveMilestone(handle.agreement, tranches.length);
  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: schedule a tranche beyond the agreement amount",
      invariant: "PPV-P2",
      instructions: [
        createMilestoneInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          milestone: overflowMilestone,
          amount: 1n,
          termsHash: runHash(ctx.runId, "milestone:overflow"),
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "milestones: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount: total,
        label: "milestones: fund",
      }),
  });

  // Tranche 0: submit, approve, release. Releasing before approval must fail.
  const first = milestones[0];
  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release tranche 0 before it is submitted",
      invariant: "PPV-P10",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: first.address,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  await milestoneUpdate(ctx, handle, first, "submit_milestone", ctx.seller, "Submitted");

  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release tranche 0 after submission but before approval",
      invariant: "PPV-P10",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: first.address,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: the seller approves its own tranche",
      invariant: "PPV-P6",
      instructions: [
        updateMilestoneInstruction({
          name: "approve_milestone",
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: first.address,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  await milestoneUpdate(ctx, handle, first, "approve_milestone", ctx.buyer, "Approved");

  await valueStep(ctx, handle, {
    label: "milestones: settle_milestone 0",
    invariant: "PPV-P4",
    instructions: [
      settleMilestoneInstruction({
        signerKey: ctx.seller.publicKey,
        agreement: handle.agreement,
        milestone: first.address,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        sellerTokenAccount: ctx.ata.seller,
      }),
    ],
    signers: [ctx.seller],
    expectState: "Funded",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.seller.toBase58(),
        amount: first.amount,
        label: "milestones: settle_milestone 0",
      }),
  });

  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release tranche 0 a second time",
      invariant: "PPV-P3",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: first.address,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  // Tranche 1: submitted, rejected, resubmitted, approved, released.
  const second = milestones[1];
  await milestoneUpdate(ctx, handle, second, "submit_milestone", ctx.seller, "Submitted");
  await milestoneUpdate(ctx, handle, second, "reject_milestone", ctx.buyer, "Pending");
  await milestoneUpdate(ctx, handle, second, "submit_milestone", ctx.seller, "Submitted");
  await milestoneUpdate(ctx, handle, second, "approve_milestone", ctx.buyer, "Approved");

  // A milestone belonging to a different agreement must not release this vault.
  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release using a foreign milestone PDA",
      invariant: "PPV-P9",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: ctx.foreignMilestone,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release tranche 1 to the buyer's account",
      invariant: "PPV-P4",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: second.address,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.buyer,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  await valueStep(ctx, handle, {
    label: "milestones: settle_milestone 1",
    invariant: "PPV-P4",
    instructions: [
      settleMilestoneInstruction({
        signerKey: ctx.buyer.publicKey,
        agreement: handle.agreement,
        milestone: second.address,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        sellerTokenAccount: ctx.ata.seller,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Settled",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.seller.toBase58(),
        amount: second.amount,
        label: "milestones: settle_milestone 1",
      }),
  });

  await requireEmptyVault(ctx, handle, "milestones");
  assertTerminal(handle.account.state, { label: "milestones" });

  negatives.push(
    await refuse(ctx, handle, {
      label: "milestones: release a tranche after the agreement settled",
      invariant: "PPV-P7",
      instructions: [
        settleMilestoneInstruction({
          signerKey: ctx.seller.publicKey,
          agreement: handle.agreement,
          milestone: second.address,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
        }),
      ],
      signers: [ctx.seller],
    }),
  );

  handle.milestones = milestones.map((m) => ({
    index: m.index,
    amount: m.amount.toString(),
    address: m.address.toBase58(),
  }));
  return finish(ctx, handle, negatives, "milestones");
}

/** A milestone state transition: it must succeed, and it must move no tokens. */
async function milestoneUpdate(ctx, handle, milestone, name, signerWallet, expectState) {
  const label = `milestones: ${name} ${milestone.index}`;
  const result = await stepWithoutValue(ctx.connection, ctx.client, {
    label,
    instructions: [
      updateMilestoneInstruction({
        name,
        signerKey: signerWallet.publicKey,
        agreement: handle.agreement,
        milestone: milestone.address,
      }),
    ],
    signers: [signerWallet],
    watched: watched(ctx),
  });
  const account = await readMilestone(ctx, milestone.address);
  if (account.state !== expectState) {
    throw new CustodyDefect(
      `${label}: the milestone is ${account.state}, expected ${expectState}`,
    );
  }
  handle.signatures.push({ step: label, signature: result.signature });
  step(true, label, `milestone state=${account.state}`);
  return result;
}

/**
 * Phase 9 — a bounty.
 *
 * The one agreement that may exist without a payee, which is the point: money
 * is escrowed so applicants can see it before doing the work, and the sponsor
 * names the winner afterwards. "Afterwards, once" is the whole safety of it, so
 * the negatives here are about the exception's boundaries — the sponsor naming
 * itself, naming nobody, and re-naming after a choice is made.
 */
export async function scenarioBounty(ctx) {
  log("\nPhase 9 — bounty");
  const amount = 21n;
  const handle = await openAgreement(ctx, {
    label: "bounty",
    creator: ctx.buyer,
    counterparty: PublicKey.default,
    agreementType: "Bounty",
    amount,
  });
  const negatives = [];

  if (handle.account.counterparty !== PublicKey.default.toBase58()) {
    throw new CustodyDefect("bounty: a bounty was created with a counterparty already set");
  }
  step(true, "bounty: created with no counterparty, as the implementation permits");

  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: the sponsor selects itself",
      invariant: "PPV-P4",
      instructions: [
        selectCounterpartyInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          counterparty: ctx.buyer.publicKey,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: the sponsor selects the default address",
      invariant: "PPV-P4",
      instructions: [
        selectCounterpartyInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          counterparty: PublicKey.default,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: a non-sponsor selects the winner",
      invariant: "PPV-P6",
      instructions: [
        selectCounterpartyInstruction({
          creator: ctx.outsider.publicKey,
          agreement: handle.agreement,
          counterparty: ctx.seller.publicKey,
        }),
      ],
      signers: [ctx.outsider],
    }),
  );

  await valueStep(ctx, handle, {
    label: "bounty: select_counterparty",
    invariant: "PPV-P4",
    instructions: [
      selectCounterpartyInstruction({
        creator: ctx.buyer.publicKey,
        agreement: handle.agreement,
        counterparty: ctx.seller.publicKey,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Open",
    expected: (before, after) =>
      assertNoMovement(before, after, { label: "bounty: select_counterparty" }),
  });
  if (handle.account.counterparty !== ctx.seller.publicKey.toBase58()) {
    throw new CustodyDefect("bounty: the selected counterparty was not recorded");
  }

  // Selection is once. From here the payee is as frozen as anywhere else.
  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: replace the winner after selection",
      invariant: "PPV-P4",
      instructions: [
        selectCounterpartyInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          counterparty: ctx.outsider.publicKey,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "bounty: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount,
        label: "bounty: fund",
      }),
  });

  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: replace the winner after the money is escrowed",
      invariant: "PPV-P4",
      instructions: [
        selectCounterpartyInstruction({
          creator: ctx.buyer.publicKey,
          agreement: handle.agreement,
          counterparty: ctx.outsider.publicKey,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "bounty: mark_completed",
    invariant: "PPV-P10",
    instructions: [
      markCompletedInstruction({ seller: ctx.seller.publicKey, agreement: handle.agreement }),
    ],
    signers: [ctx.seller],
    expectState: "Completed",
    expected: (before, after) =>
      assertNoMovement(before, after, { label: "bounty: mark_completed" }),
  });

  negatives.push(
    await refuse(ctx, handle, {
      label: "bounty: settle to an account the selected winner does not own",
      invariant: "PPV-P4",
      instructions: [
        settleInstruction({
          signerKey: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.outsider,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "bounty: settle",
    invariant: "PPV-P4",
    instructions: [
      settleInstruction({
        signerKey: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        sellerTokenAccount: ctx.ata.seller,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Settled",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.seller.toBase58(),
        amount,
        label: "bounty: settle",
      }),
  });

  await requireEmptyVault(ctx, handle, "bounty");
  assertTerminal(handle.account.state, { label: "bounty" });
  return finish(ctx, handle, negatives, "bounty");
}

/**
 * Phase 10 — proofs, and the one program boundary PPV has.
 *
 * `submit_proof` is the only escrow instruction that calls another program, and
 * the interesting claims are about the boundary rather than about the escrow
 * record: the CPI targets the permanent `ppv_core` id (pinned by type, not by a
 * client-supplied account), the core record's address is derived from facts
 * already on chain, and a proof decision is the *other* party's to make.
 *
 * None of it moves value, which is asserted rather than assumed — an approval
 * that moved money would fold evidence into custody, and this is the run that
 * could notice.
 */
export async function scenarioProofs(ctx) {
  log("\nPhase 10 — live proof path (CPI into ppv_core)");
  const amount = 9n;
  const handle = await openAgreement(ctx, {
    label: "proofs",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount,
  });
  const negatives = [];

  await valueStep(ctx, handle, {
    label: "proofs: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: handle.vault.toBase58(),
        amount,
        label: "proofs: fund",
      }),
  });

  const proofs = [];

  // Proof 0: submitted by the seller, approved by the buyer.
  const zero = await submitProof(ctx, handle, 0, ctx.seller);
  proofs.push(zero);

  negatives.push(
    await refuse(ctx, handle, {
      label: "proofs: the submitter approves its own proof",
      invariant: "PPV-P6",
      instructions: [
        decideProofInstruction({
          name: "approve_proof",
          decider: ctx.seller.publicKey,
          agreement: handle.agreement,
          proof: zero.proof,
        }),
      ],
      signers: [ctx.seller],
    }),
  );
  negatives.push(
    await refuse(ctx, handle, {
      label: "proofs: a non-party approves a proof",
      invariant: "PPV-P6",
      instructions: [
        decideProofInstruction({
          name: "approve_proof",
          decider: ctx.outsider.publicKey,
          agreement: handle.agreement,
          proof: zero.proof,
        }),
      ],
      signers: [ctx.outsider],
    }),
  );

  await decideProof(ctx, handle, zero, "approve_proof", ctx.buyer, "Approved");

  negatives.push(
    await refuse(ctx, handle, {
      label: "proofs: decide an already-decided proof",
      invariant: "PPV-P3",
      instructions: [
        decideProofInstruction({
          name: "reject_proof",
          decider: ctx.buyer.publicKey,
          agreement: handle.agreement,
          proof: zero.proof,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  // Proof 1: submitted by the seller, rejected by the buyer.
  const one = await submitProof(ctx, handle, 1, ctx.seller);
  proofs.push(one);
  await decideProof(ctx, handle, one, "reject_proof", ctx.buyer, "Rejected");

  // The foreign proof fixture: created here, used once, and wound down
  // immediately.
  //
  // A proof that belongs to a *different* agreement is the only way to ask
  // whether the program checks that a proof it is handed is one of its own.
  // A fabricated address would fail because the account does not exist, which
  // proves nothing.
  //
  // It is funded, and funded means custody. It used to be opened at the top of
  // the run and refunded at the very end, so those 3 units sat in a PPV vault
  // across every unrelated scenario; when run 35430583241 stopped inside this
  // scenario, the teardown never ran and they were stranded. Its whole life is
  // now inside this scenario, and it is emptied before the main agreement's
  // final settlement — the step that failed in that run.
  const foreignProofAgreement = await openAgreement(ctx, {
    label: "foreign-proof-source",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    amount: 3n,
  });
  await valueStep(ctx, foreignProofAgreement, {
    label: "foreign-proof-source: fund",
    invariant: "PPV-P8",
    instructions: [
      fundInstruction({
        buyer: ctx.buyer.publicKey,
        agreement: foreignProofAgreement.agreement,
        mint: foreignProofAgreement.mint,
        vault: foreignProofAgreement.vault,
        funderTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Funded",
    expected: (before, after) =>
      assertFunding(before, after, {
        buyer: ctx.ata.buyer.toBase58(),
        vault: foreignProofAgreement.vault.toBase58(),
        amount: 3n,
        label: "foreign-proof-source: fund",
      }),
  });
  const foreignProofHandle = await submitProof(ctx, foreignProofAgreement, 0, ctx.seller);
  ctx.foreignProof = foreignProofHandle.proof;
  ctx.foreignAgreements = [...(ctx.foreignAgreements ?? []), foreignProofAgreement];

  // Not conditional: a negative the run quietly skips is a negative the
  // summary counts and nobody performed.
  if (!ctx.foreignProof) {
    throw new CustodyHarnessFailure(
      "proofs: no foreign proof was prepared, so the relationship-binding negative cannot run",
    );
  }
  negatives.push(
    await refuse(ctx, handle, {
      label: "proofs: decide a proof belonging to another agreement",
      invariant: "PPV-P9",
      instructions: [
        decideProofInstruction({
          name: "approve_proof",
          decider: ctx.buyer.publicKey,
          agreement: handle.agreement,
          proof: ctx.foreignProof,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  // Wound down the moment it has served its purpose, and before the main
  // agreement's settlement, so a failure there cannot strand it.
  await valueStep(ctx, foreignProofAgreement, {
    label: "foreign-proof-source: refund",
    invariant: "PPV-P4",
    instructions: [
      refundInstruction({
        seller: ctx.seller.publicKey,
        agreement: foreignProofAgreement.agreement,
        mint: foreignProofAgreement.mint,
        vault: foreignProofAgreement.vault,
        vaultAuthority: foreignProofAgreement.vaultAuthority,
        buyerTokenAccount: ctx.ata.buyer,
      }),
    ],
    signers: [ctx.seller],
    expectState: "Refunded",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: foreignProofAgreement.vault.toBase58(),
        recipient: ctx.ata.buyer.toBase58(),
        amount: 3n,
        label: "foreign-proof-source: refund",
      }),
  });

  // Asserted, not assumed: the point of moving it here is that it ends empty.
  const foreignVaultAfter = (
    await snapshotBalances(ctx.client, [foreignProofAgreement.vault.toBase58()])
  ).get(foreignProofAgreement.vault.toBase58());
  if (foreignVaultAfter !== 0n) {
    throw new CustodyDefect(
      `foreign-proof-source: its vault still holds ${foreignVaultAfter} after the refund`,
      { label: "foreign-proof-source", vault: foreignProofAgreement.vault.toBase58() },
    );
  }
  step(true, "foreign-proof-source: vault emptied before the main settlement", "0");

  // Settlement citing the approved proof: the payment and its justification in
  // one transaction, which is the composition the surface document claims.
  await valueStep(ctx, handle, {
    label: "proofs: mark_completed",
    invariant: "PPV-P10",
    instructions: [
      markCompletedInstruction({ seller: ctx.seller.publicKey, agreement: handle.agreement }),
    ],
    signers: [ctx.seller],
    expectState: "Completed",
    expected: (before, after) =>
      assertNoMovement(before, after, { label: "proofs: mark_completed" }),
  });

  negatives.push(
    await refuse(ctx, handle, {
      label: "proofs: settle citing the rejected proof",
      invariant: "PPV-P10",
      instructions: [
        settleInstruction({
          signerKey: ctx.buyer.publicKey,
          agreement: handle.agreement,
          mint: handle.mint,
          vault: handle.vault,
          vaultAuthority: handle.vaultAuthority,
          sellerTokenAccount: ctx.ata.seller,
          settlementProof: one.proof,
        }),
      ],
      signers: [ctx.buyer],
    }),
  );

  await valueStep(ctx, handle, {
    label: "proofs: settle citing the approved proof",
    invariant: "PPV-P4",
    instructions: [
      settleInstruction({
        signerKey: ctx.buyer.publicKey,
        agreement: handle.agreement,
        mint: handle.mint,
        vault: handle.vault,
        vaultAuthority: handle.vaultAuthority,
        sellerTokenAccount: ctx.ata.seller,
        settlementProof: zero.proof,
      }),
    ],
    signers: [ctx.buyer],
    expectState: "Settled",
    expected: (before, after) =>
      assertPayout(before, after, {
        vault: handle.vault.toBase58(),
        recipient: ctx.ata.seller.toBase58(),
        amount,
        label: "proofs: settle citing the approved proof",
      }),
  });

  if (handle.account.settlementProof !== zero.proof.toBase58()) {
    throw new CustodyDefect(
      `proofs: settlement recorded proof ${handle.account.settlementProof}, expected ${zero.proof.toBase58()}`,
    );
  }
  await requireEmptyVault(ctx, handle, "proofs");

  handle.proofs = proofs.map((p) => ({
    index: p.index,
    proof: p.proof.toBase58(),
    coreProof: p.coreProof.toBase58(),
    submitter: p.submitter,
  }));
  return finish(ctx, handle, negatives, "proofs");
}

/** Anchors evidence, and proves the record really landed under ppv_core. */
async function submitProof(ctx, handle, index, submitterWallet) {
  const label = `proofs: submit_proof ${index}`;
  const [proof] = deriveProof(handle.agreement, index);
  const proofId = coreProofId(handle.agreement, index);
  const [coreProof] = deriveCoreProof(submitterWallet.publicKey, proofId);

  const result = await stepWithoutValue(ctx.connection, ctx.client, {
    label,
    instructions: [
      submitProofInstruction({
        submitter: submitterWallet.publicKey,
        agreement: handle.agreement,
        proofIndex: index,
        contentHash: runHash(ctx.runId, `${handle.label}:proof:${index}:content`),
        metadataHash: runHash(ctx.runId, `${handle.label}:proof:${index}:metadata`),
      }),
    ],
    signers: [submitterWallet],
    watched: watched(ctx),
  });

  // The escrow-side record.
  const escrowProof = await readProof(ctx, proof);
  if (!escrowProof) throw new CustodyDefect(`${label}: no escrow proof account was created`);
  if (escrowProof.agreement !== handle.agreement.toBase58()) {
    throw new CustodyDefect(`${label}: the proof is bound to ${escrowProof.agreement}`);
  }
  if (escrowProof.coreProof !== coreProof.toBase58()) {
    throw new CustodyDefect(
      `${label}: the escrow record names core proof ${escrowProof.coreProof}, the client derived ` +
        coreProof.toBase58(),
    );
  }

  // The core-side record, at the address derived under the permanent Core id.
  const coreInfo = await ctx.client.accountInfo(coreProof.toBase58());
  if (!coreInfo) {
    throw new CustodyDefect(
      `${label}: no ppv_core proof record exists at ${coreProof.toBase58()}; the CPI did not ` +
        "create what the escrow record claims",
    );
  }
  if (coreInfo.owner !== CORE_PROGRAM_ID.toBase58()) {
    throw new CustodyDefect(
      `${label}: the core proof at ${coreProof.toBase58()} is owned by ${coreInfo.owner}, not the ` +
        `permanent ppv_core ${CORE_PROGRAM_ID.toBase58()}`,
    );
  }

  handle.signatures.push({ step: label, signature: result.signature });
  step(true, label, `core proof ${coreProof.toBase58().slice(0, 12)}… owned by ppv_core`);
  return { index, proof, coreProof, submitter: submitterWallet.publicKey.toBase58(), signature: result.signature };
}

async function decideProof(ctx, handle, proofHandle, name, decider, expectStatus) {
  const label = `proofs: ${name} ${proofHandle.index}`;
  const result = await stepWithoutValue(ctx.connection, ctx.client, {
    label,
    instructions: [
      decideProofInstruction({
        name,
        decider: decider.publicKey,
        agreement: handle.agreement,
        proof: proofHandle.proof,
      }),
    ],
    signers: [decider],
    watched: watched(ctx),
  });
  const account = await readProof(ctx, proofHandle.proof);
  if (account.status !== expectStatus) {
    throw new CustodyDefect(`${label}: the proof is ${account.status}, expected ${expectStatus}`);
  }
  handle.signatures.push({ step: label, signature: result.signature });
  step(true, label, `proof status=${account.status}`);
  return result;
}

/* ------------------------------------------------------- shared assertions */

/**
 * One expected-failure attempt, with the whole before/after picture recorded.
 *
 * Every refusal here goes through `attemptRefusal`, which fails the run if the
 * transaction succeeded *or* if it failed while changing anything. "It failed"
 * on its own is not the claim: a program that wrote state before validating
 * would satisfy it and still be broken.
 */
async function refuse(ctx, handle, { label, invariant, instructions, signers }) {
  const record = await attemptRefusal(ctx.connection, ctx.client, {
    label,
    invariant,
    instructions,
    signers,
    watched: watched(ctx),
    readAgreement: () => readAgreement(ctx, handle.agreement),
  });
  ctx.negatives.push(record);
  step(true, `refused: ${label}`, record.errorCode?.name ?? `code ${record.errorCode?.number}`);
  return record;
}

/**
 * Phase 17's rule, applied as the scenario ends rather than at the end of the
 * run: a terminated agreement's vault holds nothing.
 *
 * Checked here so a stranded balance is attributed to the scenario that
 * stranded it, instead of appearing as an unexplained total at the end.
 */
async function requireEmptyVault(ctx, handle, label) {
  const snapshot = await snapshotBalances(ctx.client, [handle.vault.toBase58()]);
  const balance = snapshot.get(handle.vault.toBase58());
  if (balance !== 0n) {
    throw new CustodyDefect(
      `${label}: the vault ${handle.vault.toBase58()} still holds ${balance} units after the ` +
        "agreement terminated",
    );
  }
  step(true, `${label}: final vault balance is 0`);
  return balance;
}

function finish(ctx, handle, negatives, scenarioKey) {
  ctx.scenarios[scenarioKey] = {
    label: handle.label,
    agreement: handle.agreement.toBase58(),
    agreementId: handle.agreementId.toString(),
    vault: handle.vault.toBase58(),
    vaultAuthority: handle.vaultAuthority.toBase58(),
    mint: handle.mint.toBase58(),
    amount: handle.amount.toString(),
    finalState: handle.account.state,
    settledTotal: handle.account.settledTotal.toString(),
    signatures: handle.signatures,
    negatives: negatives.map((n) => n.label),
    milestones: handle.milestones ?? [],
    proofs: handle.proofs ?? [],
    establishes: SCENARIO_COVERAGE[scenarioKey] ?? [],
  };
  ctx.completed.add(scenarioKey);
  return handle;
}

/* ============================================================= PHASE 12 ==== */

/**
 * The fields this harness reads off an `EscrowEventEnvelope`.
 *
 * Declared rather than inferred, so `scripts/test/reconstruction-envelope-
 * contract.test.mjs` can hold this list against the type the SDK actually
 * exports and fail on drift in either direction.
 */
export const ESCROW_EVENT_ENVELOPE_FIELDS_READ = Object.freeze([
  "event",
  "programId",
  "transactionSignature",
]);

/**
 * One reconstructed event, checked against the envelope contract.
 *
 * Live run 35457793117 completed the entire custody matrix — every scenario,
 * every negative, every funded vault back to zero — and then failed here with
 *
 *     ordinaryEscrow: an event was attributed to undefined, not ppv_escrow
 *
 * `undefined` was the finding. The harness read `envelope.program` and
 * `envelope.signature`; `EscrowEventEnvelope` carries neither. It has
 * `programId` and `transactionSignature`, and the literal `"ppv_escrow"` the
 * old check wanted lives one level in, on `envelope.event.program`, where the
 * decoder writes it. So the check compared `undefined` against a string and
 * failed every event of every scenario. Nothing was wrong with the chain, the
 * program, or the events.
 *
 * Attribution is now bound to the deployed program id rather than to a decoder
 * literal, which is the stronger claim: `programId` is the program whose event
 * authority signed the CPI these bytes came from, while `event.program` is a
 * constant this repository's own decoder writes into every event it builds and
 * could not disagree with itself.
 */
export function assertEscrowEventEnvelope(envelope, { key, programId }) {
  if (envelope?.programId !== programId) {
    throw new CustodyDefect(
      `${key}: an event was attributed to program id ${envelope?.programId ?? "undefined"}, not ` +
        `${programId}`,
    );
  }
  if (typeof envelope.transactionSignature !== "string" || envelope.transactionSignature === "") {
    throw new CustodyDefect(`${key}: an event carries no transaction signature`);
  }
  return envelope;
}

/**
 * Every generated transaction, read back and reconstructed.
 *
 * Nothing here is built from what the harness remembers doing. The histories
 * are rebuilt from the chain through the same SDK and indexer path an outside
 * integrator would use — `replayAgreement` pages the agreement's signatures,
 * pulls each transaction, extracts the inner instructions the escrow program
 * emitted, decodes them as escrow events, and projects a lifecycle. The
 * projection is then compared against the live account, which is the comparison
 * that matters: an indexer that decodes cleanly and projects the wrong state is
 * worse than one that fails.
 *
 * Idempotence and order-independence are exercised on the receipts, because
 * that is where the property lives: delivery is at-least-once and unordered
 * whichever way an indexer is fed.
 */
export async function reconstruct(ctx) {
  log("\nPhase 12 — live events and history reconstruction");
  const { httpChainSource, replayAgreement, ReceiptStore } = await import("@gwap/ppv-indexer");

  const source = httpChainSource(ctx.endpoint);
  const results = {};

  for (const [key, scenario] of Object.entries(ctx.scenarios)) {
    const replay = await replayAgreement(source, scenario.agreement, {
      programId: ESCROW_PROGRAM_ID.toBase58(),
    });

    for (const envelope of replay.events) {
      assertEscrowEventEnvelope(envelope, { key, programId: ESCROW_PROGRAM_ID.toBase58() });
    }

    const live = await readAgreement(ctx, new PublicKey(scenario.agreement));
    if (replay.lifecycle.state !== live.state) {
      throw new CustodyDefect(
        `${key}: the reconstructed projection says ${replay.lifecycle.state}, the live account ` +
          `says ${live.state}`,
      );
    }

    // Idempotence: the same events delivered twice produce one history.
    const doubled = new ReceiptStore();
    doubled.addEvents(replay.events);
    const addedSecondTime = doubled.addEvents(replay.events);
    if (addedSecondTime !== 0) {
      throw new CustodyDefect(
        `${key}: re-delivering ${replay.events.length} events added ${addedSecondTime} receipts; ` +
          "delivery is at-least-once and the store must be idempotent",
      );
    }

    // Order independence: reversed delivery converges on the same history.
    const reversed = new ReceiptStore();
    reversed.addEvents([...replay.events].reverse());
    const reversedLifecycle = reversed.projectAgreement(scenario.agreement);
    if (reversedLifecycle.state !== replay.lifecycle.state) {
      throw new CustodyDefect(
        `${key}: reversed delivery reconstructs ${reversedLifecycle.state}, forward delivery ` +
          `reconstructs ${replay.lifecycle.state}`,
      );
    }
    const doubledLifecycle = doubled.projectAgreement(scenario.agreement);
    if (doubledLifecycle.state !== replay.lifecycle.state) {
      throw new CustodyDefect(`${key}: duplicate delivery changed the projected state`);
    }

    // The money, as the events describe it, against the money as it moved.
    const settled = replay.lifecycle.settledAmount ?? 0n;
    const refunded = replay.lifecycle.refundedAmount ?? 0n;
    const paidOut = settled + refunded;
    if (paidOut.toString() !== scenario.settledTotal) {
      throw new CustodyDefect(
        `${key}: the events account for ${paidOut} paid out, the agreement records ` +
          `${scenario.settledTotal}`,
      );
    }

    results[key] = {
      agreement: scenario.agreement,
      events: replay.events.length,
      eventNames: replay.events.map((e) => e.event.name),
      transactionsScanned: replay.transactionsScanned,
      failedTransactionsSkipped: replay.failedTransactionsSkipped,
      projectedState: replay.lifecycle.state,
      liveState: live.state,
      projectionAgreesWithChain: true,
      duplicateDeliveryIdempotent: true,
      reversedDeliveryConverges: true,
      settledAmount: settled.toString(),
      refundedAmount: refunded.toString(),
      milestones: replay.lifecycle.milestones.length,
      proofs: replay.lifecycle.proofs.length,
    };
    step(
      true,
      `${key}: ${replay.events.length} events reconstruct ${replay.lifecycle.state}`,
      `${replay.transactionsScanned} transactions scanned`,
    );
  }

  return results;
}

/* ============================================================= PHASE 14 ==== */

/**
 * The public evidence record.
 *
 * Built, scrubbed, and only then written. `assertNoSecrets` walks the whole
 * object and refuses anything key-shaped; it does not redact, because a
 * redacting generator would still have handled a secret and the next reviewer
 * would have no way to know.
 */
export function buildEvidence(ctx, { preflightFacts, reconstruction, commit }) {
  const record = {
    artifact: "ppv-escrow-devnet-custody-validation",
    schemaVersion: 1,
    harness: {
      script: "scripts/devnet-escrow-custody.mjs",
      version: HARNESS_VERSION,
      repositoryCommit: commit,
      runId: ctx.runId,
    },
    cluster: "devnet",
    // The cluster is identified by its genesis hash, which is the claim that
    // matters and is verifiable by anyone. The endpoint is deliberately absent:
    // a dedicated RPC URL carries a credential, evidence is published, and
    // which endpoint was read proves nothing that the genesis hash does not.
    genesisHash: preflightFacts.genesis,
    program: {
      name: "ppv_escrow",
      programId: preflightFacts.programId,
      programDataAddress: preflightFacts.programDataAddress,
      programOwner: preflightFacts.programOwner,
      upgradeAuthority: preflightFacts.upgradeAuthority,
      liveBinaryHash: preflightFacts.binaryHash,
      lastDeploySlot: preflightFacts.lastDeploySlot,
      releaseCommit: preflightFacts.releaseCommit,
      canonicalEvidence: EXPECTED.evidencePath,
      canonicalEvidenceSha256: EXPECTED.evidenceSha256,
    },
    custodyGovernance: {
      ...preflightFacts.squads,
      sharedSignerCount: preflightFacts.sharedSignerCount,
      sharedSigners: preflightFacts.sharedSigners,
    },
    testMaterial: {
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      tokenProgramName: "CLASSIC_SPL_TOKEN",
      mint: ctx.mint?.toBase58() ?? null,
      mintDecimals: 0,
      secondaryMint: ctx.otherMint?.toBase58() ?? null,
      mintedSupply: ctx.supply?.toString() ?? null,
      funder: ctx.funderPublicKey ?? null,
      funderStartingLamports: ctx.funderStartingLamports ?? null,
      wallets: {
        buyer: ctx.buyer?.publicKey.toBase58() ?? null,
        seller: ctx.seller?.publicKey.toBase58() ?? null,
        outsider: ctx.outsider?.publicKey.toBase58() ?? null,
      },
      tokenAccounts: Object.fromEntries(
        Object.entries(ctx.ata ?? {}).map(([name, address]) => [name, address.toBase58()]),
      ),
      note:
        "Disposable devnet material with no economic value. Every wallet was generated in " +
        "memory for this run and discarded with the process.",
    },
    invariants: PPV_INVARIANTS,
    scenarios: ctx.scenarios,
    expectedFailures: ctx.negatives,
    expectedFailureSummary: {
      total: ctx.negatives.length,
      refused: ctx.negatives.filter((n) => n.result === "refused").length,
      changedState: ctx.negatives.filter((n) => n.stateBefore !== n.stateAfter).length,
    },
    reconstruction,
    finalBalances: ctx.finalBalances ?? null,
    finalVaultTotal: ctx.finalVaultTotal ?? null,
    gates: {
      readOnlyPreflight: "PASS",
      squadsLiveDecode: "PASS",
      liveCustodyValidation: "PASS",
      custodyGate: "CLOSED",
      independentSecurityReview: "OPEN (RR-13)",
      legalReview: "OPEN",
      mainnetAuthorized: "NO",
    },
    timestamp: new Date().toISOString(),
  };

  return assertNoSecrets(jsonSafe(record));
}

export function writeEvidence(record, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/* ================================================================= main ==== */

function createContext({ endpoint, connection, client, funder }) {
  let agreementCounter = 0n;
  const runSeed = BigInt(`0x${randomBytes(4).toString("hex")}`) * 1_000_000n;
  return {
    endpoint,
    connection,
    client,
    funder,
    runId: randomBytes(8).toString("hex"),
    watched: new Set(),
    scenarios: {},
    negatives: [],
    completed: new Set(),
    // Unique per run so a re-run never collides with an agreement this or any
    // other run already created under the same creator.
    nextAgreementId: () => runSeed + agreementCounter++,
  };
}

export async function run({ endpoint, funderPath, outPath, commit, onContext = null }) {
  requireNoMainnetEndpoint(endpoint);
  const client = rpc(endpoint);
  const preflightFacts = await preflight(client);

  const connection = new Connection(endpoint, "confirmed");
  // Not an inline `JSON.parse`. A malformed keypair throws an error whose
  // message quotes the input, and this script's top-level handler prints
  // `error.message`. `loadFunderSecretOrThrow` throws a constant instead.
  const funder = Keypair.fromSecretKey(loadFunderSecretOrThrow(funderPath));
  const ctx = createContext({ endpoint, connection, client, funder });
  ctx.commit = commit;
  if (onContext) onContext(ctx);

  const funderState = await checkFunder(connection, funder.publicKey);
  log("\nFunder");
  step(true, "disposable devnet funder", `${funderState.address} holds ${funderState.sol} SOL`);
  ctx.funderPublicKey = funderState.address;
  ctx.funderStartingLamports = funderState.lamports;

  await setup(ctx);
  await cooldownBeforeScenarios();

  // Two further agreements exist only to give the relationship-binding
  // negatives a *genuinely foreign* account to present.
  //
  // This matters more than it looks. Presenting a fabricated address would make
  // those negatives fail — but fail because the account does not exist, which
  // proves nothing about whether the program checks that an account belongs to
  // the agreement it is presented with. A real milestone and a real proof, each
  // belonging to a different agreement, are the only way to ask the question.
  //
  // They need different shapes: a milestone can only exist on a milestone
  // contract, and a proof can only be submitted while an agreement is live
  // (Funded, Completed or Disputed), which a milestone contract in `Open` is
  // not. Both are wound down to an empty vault at the end of the run.
  const foreignMilestoneAgreement = await openAgreement(ctx, {
    label: "foreign-milestone-source",
    creator: ctx.buyer,
    counterparty: ctx.seller.publicKey,
    agreementType: "MilestoneContract",
    amount: 5n,
  });
  const [foreignMilestone] = deriveMilestone(foreignMilestoneAgreement.agreement, 0);
  await send(
    ctx.connection,
    [
      createMilestoneInstruction({
        creator: ctx.buyer.publicKey,
        agreement: foreignMilestoneAgreement.agreement,
        milestone: foreignMilestone,
        amount: 5n,
        termsHash: runHash(ctx.runId, "foreign:milestone"),
      }),
    ],
    [ctx.buyer],
    { label: "foreign-milestone-source: create_milestone", client: ctx.client },
  );
  ctx.foreignMilestone = foreignMilestone;

  ctx.foreignAgreements = [foreignMilestoneAgreement];
  step(true, "foreign milestone created for the milestone relationship-binding negative");

  // The foreign PROOF fixture is deliberately NOT created here.
  //
  // It used to be, and it held 3 funded units in a PPV vault across every
  // unrelated scenario until a teardown at the very end of the run. When run
  // 35430583241 stopped inside the proof scenario, that teardown never
  // executed and the units were stranded. It is created, used and wound down
  // inside `scenarioProofs`, which is the only scenario that needs it.

  await scenarioOrdinaryEscrow(ctx);
  await scenarioCancel(ctx);
  await scenarioRefund(ctx);
  await scenarioDispute(ctx, {
    conceder: "buyer",
    label: "dispute-to-seller",
    expectState: "Settled",
  });
  await scenarioDispute(ctx, {
    conceder: "seller",
    label: "dispute-to-buyer",
    expectState: "Refunded",
    viaCompleted: true,
  });
  await scenarioMilestones(ctx);
  await scenarioBounty(ctx);
  await scenarioProofs(ctx);

  // The foreign milestone source was never funded, so cancelling it is all
  // that is required. The foreign proof source is funded, and is therefore
  // created and wound down inside `scenarioProofs` rather than left alive
  // here — see the note where it used to be created.
  await send(
    ctx.connection,
    [
      cancelInstruction({
        creator: ctx.buyer.publicKey,
        agreement: foreignMilestoneAgreement.agreement,
      }),
    ],
    [ctx.buyer],
    { label: "foreign-milestone-source: cancel", client: ctx.client },
  );
  const reconstruction = await reconstruct(ctx);

  log("\nPhase 17 — final accounting");
  const finalSnapshot = await snapshotBalances(ctx.client, watched(ctx));
  ctx.finalBalances = finalSnapshot.toJSON();
  let vaultTotal = 0n;
  for (const scenario of Object.values(ctx.scenarios)) {
    vaultTotal += finalSnapshot.get(scenario.vault);
  }
  for (const handle of ctx.foreignAgreements) {
    vaultTotal += finalSnapshot.get(handle.vault.toBase58());
  }
  ctx.finalVaultTotal = vaultTotal.toString();
  if (vaultTotal !== 0n) {
    throw new CustodyDefect(
      `${vaultTotal} test units remain stranded across the run's vaults; every agreement ` +
        "terminated, so every vault must be empty",
    );
  }
  step(true, "every vault this run created is empty");

  const minted = ctx.supply * 2n;
  let held = 0n;
  for (const address of watched(ctx)) held += finalSnapshot.get(address);
  if (held !== minted) {
    throw new CustodyDefect(
      `${held} units are accounted for across every watched account, ${minted} were minted`,
    );
  }
  step(true, `all ${minted} minted units accounted for across watched accounts`);

  const record = buildEvidence(ctx, { preflightFacts, reconstruction, commit });
  const written = writeEvidence(record, outPath);
  log(`\nEvidence written to ${written}`);

  log("\nNegative suite");
  log(`  attempted ${ctx.negatives.length}`);
  log(`  refused   ${ctx.negatives.filter((n) => n.result === "refused").length}`);
  log(`  state or balance changed by a refusal: 0`);

  return { record, path: written, context: ctx };
}

/**
 * The endpoint this run reads and signs through.
 *
 * `PPV_CUSTODY_RPC_URL` is required and has no default. Run 35405785493 died on
 * the shared public endpoint's rate limiter after its disposable setup had
 * already been created, so a run that silently falls back to that endpoint is a
 * run that will spend devnet SOL and then fail the same way. Better to stop
 * before anything exists and say which secret is missing.
 *
 * Registered as sensitive the moment it is read — before a client, before a
 * keypair, before anything that can throw — because a dedicated endpoint
 * usually authenticates with a key inside the URL.
 */
export function resolveEndpoint(env = process.env) {
  const endpoint = env.PPV_CUSTODY_RPC_URL;
  if (!endpoint || endpoint.trim() === "") {
    throw new CustodyHarnessFailure(
      "DEDICATED_DEVNET_RPC=MISSING — PPV_CUSTODY_RPC_URL is not configured for the " +
        "devnet-custody-validation environment. This harness has no default endpoint: the shared " +
        "public devnet RPC rate-limited run 35405785493 mid-run, and falling back to it would " +
        "spend devnet SOL before failing the same way.",
    );
  }
  registerSensitiveEndpoint(endpoint);
  return endpoint;
}

async function main() {
  const argv = process.argv.slice(2);
  const endpoint = resolveEndpoint();
  requireNoMainnetEndpoint(endpoint);

  if (!argv.includes("--execute")) {
    log("PPV Escrow live devnet custody validation — PREFLIGHT ONLY");
    log("Pass --execute to send the value-moving suite.\n");
    await preflight(rpc(endpoint));
    log("\nNo transaction was sent.");
    return;
  }

  const funderPath = process.env.PPV_CUSTODY_FUNDER;
  if (!funderPath) {
    throw new CustodyHarnessFailure(
      "PPV_CUSTODY_FUNDER is not set. The suite needs a disposable, funded devnet keypair to pay " +
        "rent and fees for the throwaway wallets it creates.",
    );
  }
  const commit = process.env.PPV_COMMIT_SHA || "unknown";
  const outPath =
    process.env.PPV_CUSTODY_EVIDENCE_OUT ||
    join(
      REPO,
      "deployments",
      "validation",
      `ppv-escrow-devnet-custody-${commit.slice(0, 7) || "unknown"}.json`,
    );

  await run({ endpoint, funderPath, outPath, commit, onContext: (ctx) => {
    // Held so an execute-mode failure can write a public diagnostic about
    // what actually happened. Run 35430583241 failed mid-matrix and uploaded
    // nothing at all, which left the operator with a log and no account state.
    liveContext = ctx;
  } });
  log("\nPPV ESCROW LIVE DEVNET CUSTODY VALIDATION: PASS");
  log("CUSTODY GATE REMAINS CLOSED — RR-13 and legal review are open, mainnet is not authorized.");
}

/**
 * What a failed execute-mode run leaves behind.
 *
 * Run 35430583241 stopped inside the proof scenario and uploaded no artifact at
 * all, so the only record of ten successful lifecycles and two funded fixtures
 * was a log. This is that record — and it is emphatically NOT validation
 * evidence. It is named differently, written to a different place, and says so
 * in its own first field, because the one thing worse than no evidence is a
 * failed run's debris being mistaken for some.
 *
 * Public facts only. The same `assertNoSecrets` that guards the evidence record
 * guards this one, so an RPC URL, a keypair or an environment value fails the
 * write rather than being uploaded.
 */
export function buildFailureDiagnostic(ctx, error, { runId = null, commit = null } = {}) {
  const scenarios = ctx?.scenarios ?? {};
  const completed = Object.keys(scenarios);
  const record = {
    artifact: "ppv-escrow-devnet-custody-failure",
    isValidationEvidence: false,
    note:
      "A failed live custody execution. This is diagnostic material about one run, not evidence " +
      "of custody behaviour, and it must never be read as a PASS or landed under " +
      "deployments/validation/.",
    schemaVersion: 1,
    workflowRunId: runId,
    repositoryCommit: commit ?? ctx?.commit ?? null,
    harnessRunId: ctx?.runId ?? null,
    cluster: "devnet",
    classification: error?.classification ?? classifyFailure(error),
    failedAt: error?.message ? redact(error.message) : null,
    lastCompletedPhase: completed.length > 0 ? completed[completed.length - 1] : null,
    completedScenarios: completed,
    knownSignature: error?.signature ?? null,
    testMint: ctx?.mint ? String(ctx.mint) : null,
    secondTestMint: ctx?.secondMint ? String(ctx.secondMint) : null,
    wallets: ctx
      ? {
          funder: ctx.funderPublicKey ?? null,
          buyer: ctx.buyer?.publicKey?.toBase58() ?? null,
          seller: ctx.seller?.publicKey?.toBase58() ?? null,
          outsider: ctx.outsider?.publicKey?.toBase58() ?? null,
        }
      : null,
    scenarios: Object.fromEntries(
      Object.entries(scenarios).map(([key, value]) => [
        key,
        {
          agreement: value?.agreement ?? null,
          vault: value?.vault ?? null,
          finalState: value?.finalState ?? null,
          signatures: value?.signatures ?? [],
        },
      ]),
    ),
    watchedAccounts: ctx?.watched ? [...ctx.watched] : [],
    negatives: (ctx?.negatives ?? []).map((row) => ({
      label: row.label,
      signature: row.signature ?? null,
      onChain: row.onChain ?? false,
      errorCode: row.errorCode ?? null,
    })),
    unfinishedFixtures: (ctx?.foreignAgreements ?? []).map((handle) => ({
      label: handle?.label ?? null,
      agreement: handle?.agreement ? String(handle.agreement) : null,
      vault: handle?.vault ? String(handle.vault) : null,
    })),
    generatedAt: new Date().toISOString(),
  };
  return assertNoSecrets(record);
}

/** A best-effort classification for an error that carries none of its own. */
function classifyFailure(error) {
  if (error instanceof CustodyDefect) return "CUSTODY_DEFECT";
  if (error instanceof RpcRateLimitError) return RPC_RATE_LIMIT;
  if (error instanceof CustodyHarnessFailure) return "HARNESS_DEFECT";
  return "RPC_PROVIDER_FAILURE";
}

/** Set by `main()` so the failure path can describe what the run had reached. */
let liveContext = null;

if (process.argv[1] && process.argv[1].endsWith("devnet-escrow-custody.mjs")) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      // Redacted, not merely trusted: this message can come from web3.js or
      // undici wrapping a request whose URL carries the RPC credential.
      process.stderr.write(`\nFAIL  ${redact(error?.message ?? String(error))}\n`);
      if (error instanceof RpcRateLimitError) {
        // Named so the run summary cannot record an endpoint's rate limiter as
        // a custody finding. The validation still fails; what failed is the
        // machine in front of the chain, not the program on it.
        process.stderr.write(
          `\nCLASSIFICATION=${RPC_RATE_LIMIT}\n` +
            "The RPC endpoint refused reads after bounded retries. No custody assertion was\n" +
            "evaluated against this failure: it is not a defect, not an invariant violation,\n" +
            "and not evidence about the deployed program. Re-run against a less contended\n" +
            "endpoint; do not resend any transaction by hand.\n",
        );
      }
      if (error instanceof CustodyDefect) {
        process.stderr.write(
          "\nThis is a finding about the DEPLOYED PROGRAM, not about the harness.\n" +
            "Do not patch around it. Do not upgrade the program. Report it.\n",
        );
      }
      // Written on every execute-mode failure, so the next operator inherits
      // account state rather than a log. Guarded: a diagnostic that cannot be
      // written must not replace the real failure with its own.
      try {
        const runId = process.env.GITHUB_RUN_ID || null;
        const diagnosticPath =
          process.env.PPV_CUSTODY_FAILURE_OUT ||
          // A different directory, not just a different filename. The
          // validation upload globs deployments/validation/*.json, and a
          // failed run's debris must not be able to arrive inside an artifact
          // named "validation".
          join(REPO, "deployments", "diagnostics", `ppv-escrow-devnet-custody-failure-${runId ?? "local"}.json`);
        if (liveContext) {
          const diagnostic = buildFailureDiagnostic(liveContext, error, {
            runId,
            commit: process.env.PPV_COMMIT_SHA || null,
          });
          mkdirSync(dirname(diagnosticPath), { recursive: true });
          writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
          process.stderr.write(`\nFAILURE DIAGNOSTIC (not validation evidence): ${diagnosticPath}\n`);
        }
      } catch (diagnosticError) {
        process.stderr.write(
          `\ncould not write the failure diagnostic: ${redact(diagnosticError?.message ?? "unknown")}\n`,
        );
      }
      process.stderr.write("PPV ESCROW LIVE DEVNET CUSTODY VALIDATION: FAILED\n");
      process.exit(1);
    });
}

export { CustodyDefect, CustodyHarnessFailure };
