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

import { readFileSync } from "node:fs";

import { PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID } from "./lib/identity.mjs";
import { isAddress, isProgramDerived } from "./lib/pubkey.mjs";
import {
  DEVNET_GENESIS,
  MAINNET_GENESIS,
  decodeProgramDataAddress,
  decodeProgramDataAuthority,
  rpc,
} from "./lib/rpc.mjs";

const ENCODER = new TextEncoder();

/**
 * Every lifecycle step the sprint asks the suite to cover, and where each one
 * actually stands in this release. Recorded here rather than in prose so the
 * suite reports its own coverage and cannot quietly claim more than it checks.
 */
export const LIFECYCLE_COVERAGE = [
  { step: "proof creation", status: "covered", how: "ppv_core create_proof" },
  { step: "agreement creation", status: "covered", how: "ppv_commerce create_agreement" },
  { step: "funding", status: "not-in-release", how: "requires ppv_escrow" },
  { step: "proof submission", status: "covered", how: "ppv_core create_proof + SDK deliverable reference" },
  { step: "approval", status: "not-in-release", how: "requires ppv_escrow approve_proof" },
  { step: "milestone release", status: "not-in-release", how: "requires ppv_escrow milestones" },
  { step: "settlement", status: "not-in-release", how: "requires ppv_escrow settle" },
  { step: "cancellation / refund", status: "partial", how: "ppv_commerce cancel_agreement; refund requires ppv_escrow" },
  { step: "concession / dispute", status: "not-in-release", how: "requires ppv_escrow disputes" },
  { step: "bounty counterparty selection", status: "not-in-release", how: "requires ppv_escrow bounties" },
  { step: "contract / proof binding", status: "covered", how: "canonical hash vs on-chain content and terms hashes" },
  { step: "normalized reputation event", status: "covered", how: "SDK normalizeChainEvent over the emitted events" },
  { step: "receipt / credential derivation", status: "covered", how: "SDK receipts and seal state from those events" },
];

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

export async function runIdentityPhase(client, { expectedAuthority, expectedGenesis, encodeBase58 }) {
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

  process.stdout.write("\nPrograms\n");
  const programs = {};
  for (const [name, id] of Object.entries(PERMANENT_PROGRAM_IDS)) {
    programs[name] = await checkProgram(client, name, id, expectedAuthority, encodeBase58);
  }
  return { genesis, programs };
}

function reportCoverage() {
  process.stdout.write("\nLifecycle coverage in this release\n");
  for (const entry of LIFECYCLE_COVERAGE) {
    const mark = entry.status === "covered" ? "ok  " : entry.status === "partial" ? "part" : "n/a ";
    process.stdout.write(`  ${mark}  ${entry.step} — ${entry.how}\n`);
  }
}

async function main() {
  const identityOnly = process.argv.includes("--identity-only");
  const endpoint = process.env.PPV_SMOKE_RPC_URL || "https://api.devnet.solana.com";
  const client = rpc(endpoint);

  const { encodeBase58 } = await import("@gwap/ppv-sdk");

  await runIdentityPhase(client, {
    expectedAuthority: process.env.PPV_SQUADS_VAULT_PDA || "",
    expectedGenesis: process.env.PPV_DEVNET_GENESIS_HASH || "",
    encodeBase58,
  });

  reportCoverage();

  if (identityOnly) {
    process.stdout.write("\nIdentity phase passed. Lifecycle not run (--identity-only).\n");
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
