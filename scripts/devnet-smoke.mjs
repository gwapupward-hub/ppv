/**
 * PPV devnet smoke suite.
 *
 * Two phases, and the first gates the second:
 *
 *   identity  — both programs exist, are executable, are owned by the BPF
 *               upgradeable loader, sit at their permanent ids, and are held by
 *               the configured Squads vault.
 *   lifecycle — a real transaction per protocol step, then the SDK reading its
 *               own events back off the chain.
 *
 * The suite refuses to run anywhere but devnet. That is not a convenience
 * check: the lifecycle phase signs transactions, and a smoke test that can be
 * pointed at mainnet by an environment variable is a loaded gun.
 *
 *   npm run test:devnet:smoke                  # identity, then lifecycle
 *   npm run test:devnet:smoke -- --identity-only
 *
 * Inputs (public values only):
 *   PPV_SMOKE_RPC_URL        default https://api.devnet.solana.com
 *   PPV_SQUADS_VAULT_PDA     the expected upgrade authority
 *   PPV_SMOKE_WALLET         path to a funded devnet keypair (lifecycle only)
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID, DEVNET_DEPLOYED_PROGRAMS, ESCROW_CUSTODY_GOVERNANCE } from "./lib/identity.mjs";
import { PROOF_RECORD_DISCRIMINATOR, PROOF_RECORD_LEN, decodeProofRecord } from "./lib/core-accounts.mjs";
import { encodeBase58, isAddress, isProgramDerived } from "./lib/pubkey.mjs";
import {
  DEVNET_GENESIS,
  MAINNET_GENESIS,
  decodeProgramDataAddress,
  decodeProgramDataAuthority,
  readDeployedProgram,
  rpc,
} from "./lib/rpc.mjs";

const ENCODER = new TextEncoder();

/**
 * Every lifecycle step, and exactly how far each one is actually verified.
 *
 * Recorded here rather than in prose so the suite reports its own coverage and
 * cannot claim more than it checks. The four classes are deliberately distinct:
 *
 *   live         verified against the deployed devnet program
 *   validator    verified, but only against a local validator
 *   need-escrow  cannot be tested until ppv_escrow is deployed
 *   need-commerce cannot be tested until ppv_commerce is deployed
 *   need-wallet  a live devnet transaction the suite can send, once it is
 *                given a funded devnet keypair
 *
 * A step that is only proven on a local validator is not proven on devnet, and
 * a green checkmark that blurs the two is worse than no checkmark at all.
 */
export const LIFECYCLE_COVERAGE = [
  { step: "devnet cluster identity", coverage: "live", how: "getGenesisHash equals the devnet genesis" },

  { step: "ppv_core permanent identity", requires: "ppv_core", coverage: "live", how: "program account at the permanent id" },
  { step: "ppv_core executable + loader owner", requires: "ppv_core", coverage: "live", how: "account flags and owner read from chain" },
  { step: "ppv_core ProgramData", requires: "ppv_core", coverage: "live", how: "resolved from the Program account and read" },
  { step: "ppv_core Squads upgrade authority", requires: "ppv_core", coverage: "live", how: "ProgramData authority equals the vault" },
  { step: "ppv_core deployed bytes", requires: "ppv_core", coverage: "live", how: "live ProgramData bytes hashed and compared to the release record" },
  { step: "ppv_core account layout", requires: "ppv_core", coverage: "live", how: "ProofRecord discriminator and layout over live program accounts" },
  { step: "SDK PDA derivation for ppv_core", requires: "ppv_core", coverage: "live", how: "proof PDAs derived under the permanent Core id" },
  { step: "SDK ppv_core instruction targeting", requires: "ppv_core", coverage: "live", how: "built instructions address the permanent Core id" },
  { step: "proof creation", requires: "ppv_core", coverage: "need-wallet", how: "ppv_core create_proof; needs PPV_SMOKE_WALLET" },
  { step: "proof revocation", requires: "ppv_core", coverage: "need-wallet", how: "ppv_core revoke_proof; needs PPV_SMOKE_WALLET" },

  { step: "ppv_commerce permanent identity", requires: "ppv_commerce", coverage: "live", how: "program account at the permanent id" },
  { step: "ppv_commerce executable + loader owner", requires: "ppv_commerce", coverage: "live", how: "account flags and owner read from chain" },
  { step: "ppv_commerce ProgramData", requires: "ppv_commerce", coverage: "live", how: "resolved from the Program account and read" },
  { step: "ppv_commerce Squads upgrade authority", requires: "ppv_commerce", coverage: "live", how: "ProgramData authority equals the vault" },
  { step: "ppv_commerce deployed bytes", requires: "ppv_commerce", coverage: "live", how: "live ProgramData bytes hashed and compared to the release record" },
  { step: "ppv_commerce account layout", requires: "ppv_commerce", coverage: "live", how: "Agreement discriminator and layout over live program accounts" },
  { step: "SDK PDA derivation for ppv_commerce", requires: "ppv_commerce", coverage: "live", how: "agreement PDAs derived under the permanent Commerce id" },
  { step: "SDK ppv_commerce instruction targeting", requires: "ppv_commerce", coverage: "live", how: "built instructions address the permanent Commerce id" },
  { step: "agreement creation", requires: "ppv_commerce", coverage: "need-wallet", how: "ppv_commerce create_agreement; needs PPV_SMOKE_WALLET" },
  { step: "independent two-party acceptance", requires: "ppv_commerce", coverage: "need-wallet", how: "two ppv_commerce sign_agreement transactions from distinct wallets" },
  { step: "cancellation", requires: "ppv_commerce", coverage: "need-wallet", how: "ppv_commerce cancel_agreement; needs PPV_SMOKE_WALLET" },

  { step: "Core/Commerce identity separation", coverage: "live", how: "distinct permanent ids, distinct loader-owned accounts, distinct event authorities" },
  { step: "cross-program account decoding separation", coverage: "validator", how: "each decoder refuses the other program's bytes" },
  { step: "cross-program event attribution", coverage: "validator", how: "extractPpvEvents attributes by emitting program, not by discriminator" },
  { step: "canonical terms-hash binding", coverage: "validator", how: "canonical hash vs the executed agreement's committed terms hash" },
  { step: "Core proof bound to a Commerce agreement", coverage: "validator", how: "proof content hash equals the agreement terms hash, context names the agreement" },
  { step: "combined history reconstruction", coverage: "validator", how: "SDK/indexer rebuild agreement and proof history from transactions alone" },
  { step: "idempotent and order-independent replay", coverage: "validator", how: "duplicate and reversed delivery reconstruct the same history" },
  { step: "normalized reputation event", coverage: "validator", how: "SDK normalizeChainEvent over the emitted events" },
  { step: "receipt / credential derivation", coverage: "validator", how: "SDK receipts and seal state from those events" },

  { step: "funding", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow custody" },
  { step: "approval", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow approve_proof" },
  { step: "milestone release", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow milestones" },
  { step: "settlement", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow settle" },
  { step: "refund", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow refund" },
  { step: "concession / dispute", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow disputes" },
  { step: "bounty counterparty selection", requires: "ppv_escrow", coverage: "live", how: "requires ppv_escrow bounties" },
];

const COVERAGE_LABELS = Object.freeze({
  live: "LIVE VERIFIED",
  validator: "LOCAL-VALIDATOR VERIFIED",
  "need-wallet": "NOT RUN — REQUIRES FUNDED DEVNET TEST WALLET",
});

/**
 * What a step's coverage actually is, given which programs are released.
 *
 * Derived rather than written down. A step that needs a program nobody has
 * deployed is "not testable until" that program, no matter what it would prove
 * once the program exists — and the moment the program's release record lands,
 * the same row starts telling the truth about a live check without anyone
 * editing this file. A hand-maintained table is exactly how a stale
 * "NOT TESTABLE UNTIL COMMERCE" survives the sprint that deployed Commerce.
 */
export function coverageLabel(entry, releasedPrograms) {
  if (entry.requires && !releasedPrograms.has(entry.requires)) {
    return `NOT TESTABLE UNTIL ${entry.requires.replace("ppv_", "").toUpperCase()}`;
  }
  return COVERAGE_LABELS[entry.coverage] ?? entry.coverage;
}

export class SmokeFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeFailure";
  }
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

/**
 * Refuses anything that is not the devnet cluster. Mainnet is rejected by its
 * own genesis hash before any other consideration, so a misconfigured endpoint
 * cannot become a signed mainnet transaction.
 */
export async function assertDevnet(client, expectedGenesis) {
  const genesis = await client.genesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new SmokeFailure(
      `${client.endpoint} is mainnet-beta. This suite signs transactions and will not run there.`,
    );
  }
  const expected = expectedGenesis || DEVNET_GENESIS;
  if (genesis !== expected) {
    throw new SmokeFailure(`${client.endpoint} reports genesis ${genesis}, expected ${expected}`);
  }
  return genesis;
}

/** Identity and custody of one deployed program, read straight from the chain. */
/**
 * The upgrade authority a given program is supposed to have.
 *
 * Not one value for the whole protocol. `ppv_escrow` is governed by its own
 * custody multisig, separate from the vault holding Core and Commerce — that
 * separation is the custody gate's central requirement, so a suite that assumed
 * a single authority would raise a SECURITY failure against a correctly
 * governed escrow. The tempting repair at that point is to relax the
 * comparison, which would silently stop checking the one program that holds
 * value. Reading escrow's expected authority from the frozen governance record
 * keeps the check strict and makes it right.
 */
export function expectedAuthorityFor(name, fallback) {
  if (name === "ppv_escrow" && ESCROW_CUSTODY_GOVERNANCE) {
    return ESCROW_CUSTODY_GOVERNANCE.vault;
  }
  return fallback;
}

export async function checkProgram(client, name, expectedId, expectedAuthority, encodeBase58) {
  const account = await client.accountInfo(expectedId);
  if (!account) {
    throw new SmokeFailure(`${name} is not deployed at ${expectedId}`);
  }
  if (!account.executable) {
    throw new SmokeFailure(`${name} account at ${expectedId} is not executable`);
  }
  if (account.owner !== UPGRADEABLE_LOADER_ID) {
    throw new SmokeFailure(`${name} is owned by ${account.owner}, not the upgradeable loader`);
  }
  record(`${name}: deployed, executable, upgradeable-loader owned`, true, expectedId);

  const programDataAddress = encodeBase58(decodeProgramDataAddress(account.data[0]));
  const programData = await client.accountInfo(programDataAddress);
  if (!programData) {
    throw new SmokeFailure(`${name} ProgramData account ${programDataAddress} is missing`);
  }
  const { authority, slot } = decodeProgramDataAuthority(programData.data[0]);
  if (!authority) {
    throw new SmokeFailure(`${name} is immutable — its upgrade authority has been revoked`);
  }
  const authorityAddress = encodeBase58(authority);
  if (authorityAddress !== expectedAuthority) {
    // Not configuration drift. Somebody other than the expected multisig can
    // replace this program's code.
    throw new SmokeFailure(
      `SECURITY: ${name} upgrade authority is ${authorityAddress}, expected ${expectedAuthority}`,
    );
  }
  record(`${name}: upgrade authority is the configured Squads vault`, true, authorityAddress);
  return { programDataAddress, authorityAddress, lastDeploySlot: slot };
}

/**
 * The deployed bytes against the release record's bytes.
 *
 * Done here as well as in `verify-deployed-program.mjs` so the coverage table
 * below can say "LIVE VERIFIED" about the deployed binary without that claim
 * depending on a second command someone may not have run. A checkmark that is
 * only true in one particular workflow is the kind of checkmark this suite
 * exists to avoid.
 */
export async function checkDeployedBinary(client, name, release) {
  if (!release?.binaryHash || !release?.binaryLength) return null;
  const state = await readDeployedProgram(client, release.programId, {
    binaryLength: release.binaryLength,
  });
  const liveHash = `sha256:${state.deployedBinaryHash}`;
  if (liveHash !== release.binaryHash) {
    throw new SmokeFailure(
      `${name} live binary is ${liveHash}, the release record is ${release.binaryHash}`,
    );
  }
  record(
    `${name}: deployed bytes equal the release artifact`,
    true,
    `${release.binaryLength} bytes, ${release.binaryHash}`,
  );
  return liveHash;
}

/**
 * Which programs this suite expects to find live.
 *
 * Driven by the committed release records rather than by the identity table: a
 * program with no record has not been released, and demanding it on chain would
 * make the suite fail for the one reason that is not a problem. When a program
 * is released its record lands in the same commit, and the suite starts
 * requiring it without anyone remembering to edit a list here.
 */
export function releasedPrograms(evidenceDir) {
  const released = {};
  let entries = [];
  try {
    entries = readdirSync(evidenceDir);
  } catch {
    return released;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(evidenceDir, entry);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed.cluster !== "devnet") continue;
    released[parsed.program] = { ...parsed, recordPath: path };
  }
  return released;
}

export async function runIdentityPhase(
  client,
  { expectedAuthority, expectedGenesis, encodeBase58, released = null },
) {
  process.stdout.write("\nCluster\n");
  const genesis = await assertDevnet(client, expectedGenesis);
  record("target cluster is devnet", true, genesis);

  if (!expectedAuthority) {
    throw new SmokeFailure("PPV_SQUADS_VAULT_PDA is not set — the expected authority is unknown");
  }
  if (!isAddress(expectedAuthority) || !isProgramDerived(expectedAuthority)) {
    throw new SmokeFailure(
      `PPV_SQUADS_VAULT_PDA ${expectedAuthority} is not a program-derived address`,
    );
  }

  // Default to the programs that are actually deployed to devnet, not to the
  // whole identity table. A program can have a permanent identity and be
  // deliberately undeployed — ppv_escrow is exactly that — and requiring the
  // identity table on chain would report that correct state as a failure.
  const expected =
    released ?? Object.fromEntries(DEVNET_DEPLOYED_PROGRAMS.map((name) => [name, {}]));

  process.stdout.write("\nPrograms\n");
  const programs = {};
  const notReleased = [];
  for (const [name, id] of Object.entries(PERMANENT_PROGRAM_IDS)) {
    if (!(name in expected)) {
      notReleased.push(name);
      process.stdout.write(`  n/a   ${name}: no devnet release record — not expected on chain yet\n`);
      continue;
    }
    programs[name] = await checkProgram(
      client,
      name,
      id,
      expectedAuthorityFor(name, expectedAuthority),
      encodeBase58,
    );
    await checkDeployedBinary(client, name, expected[name]);
  }
  return { genesis, programs, notReleased };
}

/**
 * Live reads of the accounts ppv_core owns.
 *
 * This is the part of Core that can be exercised on devnet without signing
 * anything: the program's own account space, read back and decoded through the
 * declared layout. Finding no proofs yet is a fact about devnet, not a failure —
 * but a proof that exists and does not decode is a layout problem, and that is
 * the thing worth catching.
 */
export async function runCoreReadPhase(client, programId = PERMANENT_PROGRAM_IDS.ppv_core) {
  process.stdout.write("\nppv_core account reads\n");
  const accounts = await client.call("getProgramAccounts", [
    programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: PROOF_RECORD_LEN },
        { memcmp: { offset: 0, bytes: encodeBase58(PROOF_RECORD_DISCRIMINATOR) } },
      ],
    },
  ]);

  const proofs = [];
  for (const entry of accounts ?? []) {
    const bytes = Buffer.from(entry.account.data[0], "base64");
    try {
      proofs.push({ address: entry.pubkey, ...decodeProofRecord(bytes) });
    } catch (error) {
      record(`ppv_core: proof ${entry.pubkey} decodes`, false, error.message);
      throw new SmokeFailure(`live ppv_core account ${entry.pubkey} does not decode: ${error.message}`);
    }
  }
  record(
    "ppv_core: live program accounts read and decoded",
    true,
    proofs.length === 0
      ? "no ProofRecord accounts exist on devnet yet"
      : `${proofs.length} ProofRecord account(s), all decoded`,
  );
  return proofs;
}

/**
 * Live reads of the accounts ppv_commerce owns.
 *
 * Same shape as the ppv_core read phase and for the same reason: the program's
 * own account space, read back and decoded through the declared layout. An
 * agreement that exists and does not decode is a layout problem; none existing
 * yet is a fact about devnet.
 */
export async function runCommerceReadPhase(client, programId = PERMANENT_PROGRAM_IDS.ppv_commerce) {
  process.stdout.write("\nppv_commerce account reads\n");
  const { COMMERCE_AGREEMENT_DISCRIMINATOR, decodeCommerceAgreementAccount } = await import(
    "@gwap/ppv-sdk"
  );

  const accounts = await client.call("getProgramAccounts", [
    programId,
    {
      encoding: "base64",
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: encodeBase58(COMMERCE_AGREEMENT_DISCRIMINATOR) } }],
    },
  ]);

  const agreements = [];
  for (const entry of accounts ?? []) {
    const bytes = Buffer.from(entry.account.data[0], "base64");
    try {
      agreements.push({ address: entry.pubkey, ...decodeCommerceAgreementAccount(bytes) });
    } catch (error) {
      record(`ppv_commerce: agreement ${entry.pubkey} decodes`, false, error.message);
      throw new SmokeFailure(
        `live ppv_commerce account ${entry.pubkey} does not decode: ${error.message}`,
      );
    }
  }
  record(
    "ppv_commerce: live program accounts read and decoded",
    true,
    agreements.length === 0
      ? "no Agreement accounts exist on devnet yet"
      : `${agreements.length} Agreement account(s), all decoded`,
  );

  // Every executed agreement must carry two distinct accepting signers. This is
  // the property that makes an executed agreement mean something, checked
  // against whatever devnet actually holds rather than against a fixture.
  for (const agreement of agreements) {
    if (agreement.state !== "Executed") continue;
    if (!agreement.signatureA || !agreement.signatureB) {
      throw new SmokeFailure(`executed agreement ${agreement.address} is missing a signature`);
    }
    if (agreement.signatureA.signer === agreement.signatureB.signer) {
      throw new SmokeFailure(
        `SECURITY: executed agreement ${agreement.address} was accepted twice by ${agreement.signatureA.signer}`,
      );
    }
    if (
      agreement.signatureA.termsHashSigned !== agreement.termsHash ||
      agreement.signatureB.termsHashSigned !== agreement.termsHash
    ) {
      throw new SmokeFailure(
        `SECURITY: executed agreement ${agreement.address} has a signature on different terms`,
      );
    }
  }
  const executed = agreements.filter((a) => a.state === "Executed").length;
  if (executed > 0) {
    record(
      "ppv_commerce: every executed agreement has two distinct signers on the same terms",
      true,
      `${executed} executed`,
    );
  }
  return agreements;
}

/**
 * That the two programs are separable on chain, not only in the decoders.
 *
 * Distinct permanent ids, and distinct `__event_authority` PDAs — the accounts
 * that make an event CPI attributable. If these ever coincided, every
 * cross-program separation property downstream would be decoration.
 */
export async function runSeparationPhase(encodeBase58Sdk) {
  process.stdout.write("\nCore / Commerce separation\n");
  const { PublicKey } = await import("@solana/web3.js");
  const seed = new TextEncoder().encode("__event_authority");

  const core = PERMANENT_PROGRAM_IDS.ppv_core;
  const commerce = PERMANENT_PROGRAM_IDS.ppv_commerce;
  if (core === commerce) throw new SmokeFailure("the two permanent program ids are identical");
  record("permanent program ids are distinct", true, `${core} / ${commerce}`);

  const authorityOf = (id) =>
    PublicKey.findProgramAddressSync([seed], new PublicKey(id))[0].toBase58();
  const coreAuthority = authorityOf(core);
  const commerceAuthority = authorityOf(commerce);
  if (coreAuthority === commerceAuthority) {
    throw new SmokeFailure("both programs derive the same event authority");
  }
  record("event authorities are distinct", true, `${coreAuthority} / ${commerceAuthority}`);

  const { COMMERCE_AGREEMENT_DISCRIMINATOR } = await import("@gwap/ppv-sdk");
  const coreDisc = PROOF_RECORD_DISCRIMINATOR.toString("hex");
  const commerceDisc = Buffer.from(COMMERCE_AGREEMENT_DISCRIMINATOR).toString("hex");
  if (coreDisc === commerceDisc) {
    throw new SmokeFailure("ProofRecord and Agreement share an account discriminator");
  }
  record("account discriminators are distinct", true, `${coreDisc} / ${commerceDisc}`);
  return { coreAuthority, commerceAuthority };
}

/**
 * The SDK's view of ppv_core, checked against the permanent identity.
 *
 * Derivation and instruction targeting are deterministic, so this needs no
 * chain — but it is the check that catches an SDK pointed at a different
 * program than the one that is deployed, which would make every live read above
 * look fine while addressing nothing.
 */
export async function runSdkTargetingPhase(programId = PERMANENT_PROGRAM_IDS.ppv_core) {
  process.stdout.write("\nSDK targeting\n");
  const { createProofInstruction, devnetFixtures, proofAddress, instructionDiscriminator } =
    await import("./devnet-lifecycle.mjs");
  const { Keypair } = await import("@solana/web3.js");

  const fixtures = devnetFixtures();
  const authority = Keypair.generate().publicKey;
  const proof = proofAddress(authority, fixtures.proofId);
  const instruction = createProofInstruction({
    authority,
    proofId: fixtures.proofId,
    contentHash: fixtures.contentHash,
    contextHash: fixtures.contextHash,
    kind: "creation",
  });

  if (instruction.programId.toBase58() !== programId) {
    throw new SmokeFailure(
      `SDK create_proof targets ${instruction.programId.toBase58()}, not the permanent ${programId}`,
    );
  }
  record("ppv_core: SDK instruction targets the permanent program id", true, programId);

  const derived = instruction.keys[1].pubkey.toBase58();
  if (derived !== proof.toBase58()) {
    throw new SmokeFailure(`proof PDA disagrees with the instruction account: ${derived}`);
  }
  record("ppv_core: proof PDA derives under the permanent program id", true, derived);

  const discriminator = instruction.data.subarray(0, 8);
  if (!discriminator.equals(instructionDiscriminator("create_proof"))) {
    throw new SmokeFailure("create_proof discriminator is not Anchor's for that instruction name");
  }
  record("ppv_core: instruction discriminator is Anchor's for create_proof", true);
  return { proof: proof.toBase58(), programId };
}

/** The same check for ppv_commerce: derivation and targeting under its own id. */
export async function runCommerceTargetingPhase(programId = PERMANENT_PROGRAM_IDS.ppv_commerce) {
  process.stdout.write("\nSDK targeting — ppv_commerce\n");
  const { agreementAddress, createAgreementInstruction, devnetFixtures, instructionDiscriminator } =
    await import("./devnet-lifecycle.mjs");
  const { Keypair } = await import("@solana/web3.js");

  const fixtures = devnetFixtures();
  const partyA = Keypair.generate().publicKey;
  const partyB = Keypair.generate().publicKey;
  const agreement = agreementAddress(partyA, fixtures.agreementId);
  const instruction = createAgreementInstruction({
    partyA,
    partyB,
    agreementId: fixtures.agreementId,
    contentHash: fixtures.contentHash,
    termsHash: fixtures.termsHash,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

  if (instruction.programId.toBase58() !== programId) {
    throw new SmokeFailure(
      `SDK create_agreement targets ${instruction.programId.toBase58()}, not the permanent ${programId}`,
    );
  }
  record("ppv_commerce: SDK instruction targets the permanent program id", true, programId);

  const derived = instruction.keys[1].pubkey.toBase58();
  if (derived !== agreement.toBase58()) {
    throw new SmokeFailure(`agreement PDA disagrees with the instruction account: ${derived}`);
  }
  record("ppv_commerce: agreement PDA derives under the permanent program id", true, derived);

  const discriminator = instruction.data.subarray(0, 8);
  if (!discriminator.equals(instructionDiscriminator("create_agreement"))) {
    throw new SmokeFailure("create_agreement discriminator is not Anchor's for that instruction name");
  }
  record("ppv_commerce: instruction discriminator is Anchor's for create_agreement", true);
  return { agreement: agreement.toBase58(), programId };
}

export function reportCoverage(notReleased = [], released = []) {
  process.stdout.write("\nCoverage — what this run actually verified\n");
  const releasedSet = new Set(released);
  const rows = LIFECYCLE_COVERAGE.map((entry) => [coverageLabel(entry, releasedSet), entry]);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, entry] of rows) {
    process.stdout.write(`  ${label.padEnd(width)}  ${entry.step} — ${entry.how}\n`);
  }
  for (const name of notReleased) {
    process.stdout.write(`\n  ${name} has no devnet release record; nothing above claims to test it live.\n`);
  }
}

async function main() {
  const identityOnly = process.argv.includes("--identity-only");
  const endpoint = process.env.PPV_SMOKE_RPC_URL || "https://api.devnet.solana.com";
  const client = rpc(endpoint);

  const { encodeBase58: encodeBase58Sdk } = await import("@gwap/ppv-sdk");

  const released = releasedPrograms(
    process.env.PPV_EVIDENCE_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "deployments", "evidence"),
  );
  const { notReleased } = await runIdentityPhase(client, {
    expectedAuthority: process.env.PPV_SQUADS_VAULT_PDA || "",
    expectedGenesis: process.env.PPV_DEVNET_GENESIS_HASH || "",
    encodeBase58: encodeBase58Sdk,
    released,
  });

  if (!released.ppv_core) {
    throw new SmokeFailure(
      "no ppv_core devnet release record was found; there is nothing to smoke-test against",
    );
  }
  await runCoreReadPhase(client);
  await runSdkTargetingPhase();
  if (released.ppv_commerce) {
    await runCommerceReadPhase(client);
    await runCommerceTargetingPhase();
  }
  await runSeparationPhase(encodeBase58Sdk);

  reportCoverage(notReleased, Object.keys(released));

  if (identityOnly) {
    process.stdout.write("\nLive Core verification passed. No transaction was sent (--identity-only).\n");
    return;
  }

  const wallet = process.env.PPV_SMOKE_WALLET;
  if (!wallet) {
    throw new SmokeFailure(
      "PPV_SMOKE_WALLET is not set. The lifecycle phase needs a funded devnet keypair; " +
        "pass --identity-only to check identity and custody alone.",
    );
  }
  readFileSync(wallet); // fail early and loudly if the path is wrong
  const { runLifecyclePhase } = await import("./devnet-lifecycle.mjs");
  await runLifecyclePhase({ endpoint, walletPath: wallet, record, encoder: ENCODER });
}

// Only run when invoked directly; the tests import the phases above.
if (process.argv[1] && process.argv[1].endsWith("devnet-smoke.mjs")) {
  main()
    .then(() => {
      const failed = results.filter((r) => !r.ok);
      process.stdout.write(`\n${failed.length === 0 ? "DEVNET SMOKE PASSED" : "DEVNET SMOKE FAILED"}\n`);
      process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((error) => {
      process.stderr.write(`\nFAIL  ${error instanceof Error ? error.message : String(error)}\n`);
      process.stderr.write("DEVNET SMOKE FAILED\n");
      process.exit(1);
    });
}
