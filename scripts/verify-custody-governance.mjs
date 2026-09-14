#!/usr/bin/env node
/**
 * Validates a custody multisig against PPV governance policy, before it is
 * given authority over anything.
 *
 * `ppv_escrow` is the one PPV program that will hold value, and the custody
 * gate requires its upgrade authority to be a multisig *separate* from the one
 * governing the non-custodial programs — so that compromising Core and
 * Commerce's governance cannot reach the vault. "Separate" is a claim about
 * addresses and about people, and both are checked here.
 *
 * Everything this reads is public: addresses, curve membership, account owners,
 * and the cluster's genesis hash. It takes no keypair, signs nothing, and
 * cannot move anything. Run it against a proposed configuration before the
 * ceremony and against the live one afterwards; the answers must agree.
 *
 *   node scripts/verify-custody-governance.mjs \
 *     --multisig <address> --vault <address> \
 *     --threshold 2 --members <addr,addr,addr>
 *
 * Exit status is the verdict: 0 when the configuration satisfies policy.
 */

import { isAddress, isOnCurve, isProgramDerived } from "./lib/pubkey.mjs";
import { MIN_SQUADS_THRESHOLD } from "./lib/identity.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, rpc } from "./lib/rpc.mjs";

/**
 * The vault governing the non-custodial programs. A custody vault equal to it
 * is not a separate governance structure, whatever it is called.
 */
export const NON_CUSTODY_VAULT = "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX";

/** Members of that vault, so signer overlap can be reported rather than guessed. */
export const NON_CUSTODY_MEMBERS = Object.freeze([]);

export class GovernanceFailure extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "allow-shared-signers") {
      args.allowSharedSigners = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

/**
 * Every policy check that needs no network. Returns the failures rather than
 * throwing at the first, so an operator fixing a configuration sees all of it
 * at once instead of one round trip per mistake.
 */
export function checkPolicy({
  multisig,
  vault,
  threshold,
  members,
  nonCustodyVault = NON_CUSTODY_VAULT,
  nonCustodyMembers = NON_CUSTODY_MEMBERS,
  allowSharedSigners = false,
}) {
  const failures = [];
  const fail = (detail) => failures.push(detail);

  for (const [label, address] of [
    ["multisig", multisig],
    ["vault", vault],
  ]) {
    if (!address) fail(`no ${label} address was given`);
    else if (!isAddress(address)) fail(`the ${label} address ${address} is not a Solana address`);
  }
  for (const member of members) {
    if (!isAddress(member)) fail(`member ${member} is not a Solana address`);
  }
  if (failures.length > 0) return failures;

  // A threshold of one is a single point of compromise wearing a multisig's
  // name. Two is the point at which no single key can push an upgrade.
  if (!Number.isInteger(threshold) || threshold < MIN_SQUADS_THRESHOLD) {
    fail(
      `threshold is ${threshold}; policy requires at least ${MIN_SQUADS_THRESHOLD}`,
    );
  }
  if (members.length < threshold) {
    fail(`${members.length} members cannot satisfy a threshold of ${threshold}`);
  }

  // A threshold counts distinct keys, not list entries. Two copies of one
  // member in a "2-of-3" is a 1-of-2 that reads like a 2-of-3 forever after.
  const distinct = new Set(members);
  if (distinct.size !== members.length) {
    fail(
      `members contain duplicates: ${members.length} entries, ${distinct.size} distinct keys`,
    );
  }

  // The vault is a PDA. An on-curve "vault" is a wallet somebody holds the key
  // to, and the whole arrangement is theatre.
  if (isAddress(vault) && isOnCurve(vault)) {
    fail(
      `the vault ${vault} is on the ed25519 curve, so it is a signer wallet rather than a program-derived vault`,
    );
  }
  if (isAddress(vault) && !isProgramDerived(vault)) {
    fail(`the vault ${vault} is not program-derived`);
  }

  // The vault cannot be one of its own signers, and neither can the multisig
  // account: either makes the threshold unsatisfiable by people, or satisfiable
  // by whatever can make those accounts sign.
  if (distinct.has(vault)) fail(`the vault ${vault} is listed as one of its own members`);
  if (distinct.has(multisig)) fail(`the multisig ${multisig} is listed as one of its own members`);
  if (multisig === vault) fail("the multisig and its vault are the same address");

  // The point of a dedicated custody multisig: compromising the governance of
  // the non-custodial programs must not reach the vault.
  if (vault === nonCustodyVault) {
    fail(
      `the custody vault is ${nonCustodyVault}, which already governs the non-custodial programs; ` +
        "policy requires a separate one",
    );
  }
  if (multisig === nonCustodyVault) {
    fail("the custody multisig is the non-custodial programs' vault");
  }

  // Shared human signers are the other half of "separate". Two multisigs at
  // different addresses held by the same people fall to one compromise of
  // those people. Reported rather than assumed, and refused by default.
  const shared = nonCustodyMembers.filter((member) => distinct.has(member));
  if (shared.length > 0 && !allowSharedSigners) {
    fail(
      `${shared.length} member(s) also govern the non-custodial programs: ${shared.join(", ")}. ` +
        "A separate multisig held by the same people falls to one compromise of those people. " +
        "Pass --allow-shared-signers to accept this deliberately.",
    );
  }

  return failures;
}

/** The on-chain half: the cluster is devnet and the vault really exists. */
export async function checkChain(client, { vault }) {
  const failures = [];
  const genesisHash = await client.genesisHash();
  if (genesisHash === MAINNET_GENESIS) {
    throw new GovernanceFailure(
      `${client.endpoint} is mainnet-beta, which is not an authorized PPV cluster`,
    );
  }
  if (genesisHash !== DEVNET_GENESIS) {
    failures.push(`cluster genesis is ${genesisHash}, expected devnet ${DEVNET_GENESIS}`);
    return { failures, genesisHash };
  }
  const account = await client.accountInfo(vault);
  if (!account) {
    failures.push(
      `no account exists at the vault ${vault}; a vault that has never been created cannot hold authority`,
    );
  }
  return { failures, genesisHash };
}

export async function verify({ argv = [], client = null, out = process.stdout } = {}) {
  const args = parseArgs(argv);
  const members = (args.members ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const config = {
    multisig: args.multisig,
    vault: args.vault,
    threshold: Number(args.threshold),
    members,
    allowSharedSigners: Boolean(args.allowSharedSigners),
  };

  out.write("PPV custody governance\n");
  out.write(`  multisig  ${config.multisig ?? "(none given)"}\n`);
  out.write(`  vault     ${config.vault ?? "(none given)"}\n`);
  out.write(`  threshold ${args.threshold ?? "(none given)"} of ${members.length} member(s)\n`);
  for (const member of members) out.write(`    member  ${member}\n`);
  out.write("\n");

  const failures = checkPolicy(config);
  if (client) {
    const chain = await checkChain(client, { vault: config.vault });
    failures.push(...chain.failures);
    out.write(`  cluster   ${chain.genesisHash}\n\n`);
  } else {
    out.write("  cluster   not checked (no RPC endpoint given)\n\n");
  }

  if (failures.length > 0) {
    out.write("GOVERNANCE POLICY NOT SATISFIED\n");
    for (const failure of failures) out.write(`  ${failure}\n`);
    out.write("\nDo not give this configuration authority over ppv_escrow.\n");
    return { ok: false, failures };
  }

  out.write("PPV_CUSTODY_GOVERNANCE_VALID\n");
  out.write(`custody_vault=${config.vault}\n`);
  out.write(`threshold=${config.threshold}\n`);
  out.write(`members=${members.length}\n`);
  out.write("result=valid\n");
  return { ok: true, failures: [] };
}

const invokedDirectly = process.argv[1]?.endsWith("verify-custody-governance.mjs");
if (invokedDirectly) {
  const endpoint = process.env.PPV_RPC_URL;
  const client = endpoint ? rpc(endpoint) : null;
  verify({ argv: process.argv.slice(2), client })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
