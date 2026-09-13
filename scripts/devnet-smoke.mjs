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

import { PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID } from "./lib/identity.mjs";
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
  { step: "ppv_core permanent identity", coverage: "live", how: "program account at the permanent id" },
  { step: "ppv_core executable + loader owner", coverage: "live", how: "account flags and owner read from chain" },
  { step: "ppv_core ProgramData", coverage: "live", how: "resolved from the Program account and read" },
  { step: "ppv_core Squads upgrade authority", coverage: "live", how: "ProgramData authority equals the vault" },
  { step: "ppv_core deployed bytes", coverage: "live", how: "live ProgramData bytes hashed and compared to the release record" },
  { step: "ppv_core account layout", coverage: "live", how: "ProofRecord discriminator and layout over live program accounts" },
  { step: "SDK PDA derivation for ppv_core", coverage: "live", how: "proof PDAs derived under the permanent Core id" },
  { step: "SDK ppv_core instruction targeting", coverage: "live", how: "built instructions address the permanent Core id" },
  { step: "proof creation", coverage: "need-wallet", how: "ppv_core create_proof; needs PPV_SMOKE_WALLET" },
  { step: "proof revocation", coverage: "need-wallet", how: "ppv_core revoke_proof; needs PPV_SMOKE_WALLET" },
  { step: "contract / proof binding", coverage: "validator", how: "canonical hash vs on-chain content and terms hashes" },
  { step: "normalized reputation event", coverage: "validator", how: "SDK normalizeChainEvent over the emitted events" },
  { step: "receipt / credential derivation", coverage: "validator", how: "SDK receipts and seal state from those events" },
  { step: "agreement creation", coverage: "need-commerce", how: "ppv_commerce create_agreement" },
  { step: "cancellation", coverage: "need-commerce", how: "ppv_commerce cancel_agreement" },
  { step: "funding", coverage: "need-escrow", how: "requires ppv_escrow custody" },
  { step: "approval", coverage: "need-escrow", how: "requires ppv_escrow approve_proof" },
  { step: "milestone release", coverage: "need-escrow", how: "requires ppv_escrow milestones" },
  { step: "settlement", coverage: "need-escrow", how: "requires ppv_escrow settle" },
  { step: "refund", coverage: "need-escrow", how: "requires ppv_escrow refund" },
  { step: "concession / dispute", coverage: "need-escrow", how: "requires ppv_escrow disputes" },
  { step: "bounty counterparty selection", coverage: "need-escrow", how: "requires ppv_escrow bounties" },
];

const COVERAGE_LABELS = Object.freeze({
  live: "LIVE VERIFIED",
  validator: "LOCAL-VALIDATOR VERIFIED",
  "need-escrow": "NOT TESTABLE UNTIL ESCROW",
  "need-commerce": "NOT TESTABLE UNTIL COMMERCE",
  "need-wallet": "NOT RUN — NEEDS A FUNDED DEVNET WALLET",
});

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

  // Default to the whole identity table, which is what a caller that has not
  // thought about release state wants: every program is required.
  const expected = released ?? Object.fromEntries(Object.keys(PERMANENT_PROGRAM_IDS).map((n) => [n, {}]));

  process.stdout.write("\nPrograms\n");
  const programs = {};
  const notReleased = [];
  for (const [name, id] of Object.entries(PERMANENT_PROGRAM_IDS)) {
    if (!(name in expected)) {
      notReleased.push(name);
      process.stdout.write(`  n/a   ${name}: no devnet release record — not expected on chain yet\n`);
      continue;
    }
    programs[name] = await checkProgram(client, name, id, expectedAuthority, encodeBase58);
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

export function reportCoverage(notReleased = []) {
  process.stdout.write("\nCoverage — what this run actually verified\n");
  const width = Math.max(...Object.values(COVERAGE_LABELS).map((l) => l.length));
  for (const entry of LIFECYCLE_COVERAGE) {
    const label = COVERAGE_LABELS[entry.coverage] ?? entry.coverage;
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

  reportCoverage(notReleased);

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
