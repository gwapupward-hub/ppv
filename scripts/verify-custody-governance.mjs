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
import {
  PERMISSION_ALL,
  SQUADS_V4_PROGRAM_ID,
  SquadsDecodeError,
  compareToPolicy,
  deriveVault,
  permissionNames,
  readMultisig,
} from "./lib/squads.mjs";

/**
 * The vault governing the non-custodial programs. A custody vault equal to it
 * is not a separate governance structure, whatever it is called.
 */
export const NON_CUSTODY_VAULT = "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX";

/**
 * Members of that vault, so signer overlap can be reported rather than guessed.
 *
 * An empty list here is not "no overlap" — it is a check that passes because it
 * was never given anything to compare against, which is the failure mode this
 * verifier exists to prevent. These are the three signers the Core and Commerce
 * releases were approved under, and they are duplicated from
 * `scripts/verify-devnet-release-approval.mjs` deliberately: the two lists are
 * asserted equal in `scripts/test/custody-governance.test.mjs`, so a change to
 * the non-custodial governance that is not mirrored here fails the suite rather
 * than silently turning the shared-signer check back off.
 */
export const NON_CUSTODY_MEMBERS = Object.freeze([
  "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
  "2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
]);

/**
 * How many custody signers may also govern the non-custodial programs, even
 * when the overlap is deliberately accepted.
 *
 * One is the approved devnet exception, and the arithmetic is the whole reason
 * it is tolerable: one shared key cannot reach a 2-of-3 threshold by itself, so
 * compromising the people who govern Core and Commerce still does not reach the
 * custody vault. Two shared keys in a 2-of-3 ends that property completely —
 * the "separate" multisig would fall to exactly the same compromise. So
 * `--allow-shared-signers` accepts the approved overlap; it does not accept
 * however many overlaps a future configuration happens to contain.
 */
export const MAX_APPROVED_SHARED_SIGNERS = 1;

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
    if (key === "live-squads") {
      args.liveSquads = true;
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
  vaultIndex = 0,
  squadsProgramId = SQUADS_V4_PROGRAM_ID,
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

  // The vault must be *this* multisig's vault, at the declared index.
  //
  // Offline and exact: a Squads vault address is `find_program_address` over
  // ["multisig", multisig, "vault", index] under the Squads V4 program, so a
  // declared pair that does not derive is a configuration naming somebody
  // else's vault — or a vault at a different index, which is a different
  // account holding different money. This is what replaced the chain-side
  // "does an account exist at the vault" check, which could not answer the
  // question and answered it wrongly; see `checkChain`.
  if (isAddress(multisig) && isAddress(vault)) {
    const derived = deriveVault(multisig, vaultIndex, squadsProgramId);
    if (derived.address !== vault) {
      fail(
        `vault index ${vaultIndex} of multisig ${multisig} derives to ${derived.address}, ` +
          `not the declared vault ${vault}`,
      );
    }
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
  // The override accepts the approved exception, not an arbitrary overlap. Two
  // shared signers in a 2-of-3 is one compromise away from the vault, which is
  // the exact property the separate multisig exists to provide.
  if (shared.length > MAX_APPROVED_SHARED_SIGNERS) {
    fail(
      `${shared.length} member(s) also govern the non-custodial programs: ${shared.join(", ")}. ` +
        `At most ${MAX_APPROVED_SHARED_SIGNERS} shared signer is approved, and ` +
        "--allow-shared-signers does not raise that limit: a second shared key can reach a " +
        "2-of-3 threshold together with the first, which ends the separation entirely.",
    );
  }

  return failures;
}

/**
 * The on-chain half: the cluster is devnet, the vault really exists, and —
 * when asked — the multisig really says what the configuration claims.
 *
 * The live decode is opt-in (`--live-squads`) rather than automatic because it
 * is a strictly stronger check that needs a reachable RPC endpoint, and a
 * verifier that silently degraded from "read from chain" to "took your word for
 * it" whenever the network was unavailable would be the worst of both. When it
 * is requested and cannot be completed, that is a failure, not a skip.
 */
export async function checkChain(
  client,
  { multisig, vault, threshold, members, liveSquads = false, vaultIndex = 0 },
) {
  const failures = [];
  const genesisHash = await client.genesisHash();
  if (genesisHash === MAINNET_GENESIS) {
    throw new GovernanceFailure(
      `${client.endpoint} is mainnet-beta, which is not an authorized PPV cluster`,
    );
  }
  if (genesisHash !== DEVNET_GENESIS) {
    failures.push(`cluster genesis is ${genesisHash}, expected devnet ${DEVNET_GENESIS}`);
    return { failures, genesisHash, squads: null };
  }
  // Whether an account exists at the vault address is *reported*, not required.
  //
  // This check used to fail the run on a missing account, on the reasoning that
  // "a vault that has never been created cannot hold authority". Running it
  // against the live custody vault for the first time showed the premise is
  // false: a Squads V4 vault is a pure signer PDA. It holds no account unless
  // somebody funds it, and it does not need one — the BPF loader stores the
  // authority as a bare pubkey, and Squads signs with `invoke_signed`, which
  // needs a derivation and a seed, not lamports.
  //
  // `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` is the live upgrade
  // authority of the deployed `ppv_escrow` program — read from ProgramData in
  // the same run that reported "no account exists" here — so the check was
  // producing a false negative about the single most important fact in this
  // file. Its absence disproves nothing, and its presence would have proved
  // nothing either: anyone can send a lamport to any address.
  //
  // What replaces it is strictly stronger and lives in `checkPolicy`: the vault
  // must *derive* from the multisig at the declared index. That is a fact about
  // the two addresses, it needs no network, and it cannot be faked by funding
  // an account.
  const account = await client.accountInfo(vault);
  const vaultAccountExists = Boolean(account);

  if (!liveSquads) return { failures, genesisHash, squads: null, vaultAccountExists };

  // RR-7: stop treating the threshold and the member set as declared facts.
  let decoded;
  try {
    decoded = await readMultisig(client, multisig);
  } catch (error) {
    if (error instanceof SquadsDecodeError) {
      failures.push(`the live Squads multisig could not be read: ${error.message}`);
      return { failures, genesisHash, squads: null, vaultAccountExists };
    }
    throw error;
  }

  failures.push(
    ...compareToPolicy(decoded, {
      multisig,
      threshold,
      members,
      vault,
      vaultIndex,
      requiredPermissionMask: PERMISSION_ALL,
    }),
  );

  return { failures, genesisHash, squads: decoded, vaultAccountExists };
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
    liveSquads: Boolean(args.liveSquads),
  };

  out.write("PPV custody governance\n");
  out.write(`  multisig  ${config.multisig ?? "(none given)"}\n`);
  out.write(`  vault     ${config.vault ?? "(none given)"}\n`);
  out.write(`  threshold ${args.threshold ?? "(none given)"} of ${members.length} member(s)\n`);
  for (const member of members) out.write(`    member  ${member}\n`);
  out.write("\n");

  const failures = checkPolicy(config);
  let squads = null;
  if (client) {
    const chain = await checkChain(client, {
      multisig: config.multisig,
      vault: config.vault,
      threshold: config.threshold,
      members,
      liveSquads: config.liveSquads,
    });
    failures.push(...chain.failures);
    squads = chain.squads;
    out.write(`  cluster   ${chain.genesisHash}\n`);
    // Reported because it is interesting, never required: see checkChain.
    out.write(
      `  vault acct ${chain.vaultAccountExists ? "exists" : "none (a Squads vault is a pure signer PDA)"}\n`,
    );
    if (squads) {
      const derived = deriveVault(config.multisig, 0);
      out.write("\nLive Squads multisig, decoded from chain state\n");
      out.write(`  program    ${SQUADS_V4_PROGRAM_ID}\n`);
      out.write(`  account    ${config.multisig}\n`);
      out.write(`  threshold  ${squads.threshold} of ${squads.members.length} member(s)\n`);
      for (const member of squads.members) {
        out.write(
          `    member   ${member.key}  mask ${member.mask} ` +
            `(${member.permissions.join(" + ") || "none"})\n`,
        );
      }
      out.write(`  vault[0]   ${derived.address} (bump ${derived.bump})\n`);
      out.write(`  timeLock   ${squads.timeLock}\n`);
    } else if (config.liveSquads) {
      out.write("  squads    NOT DECODED\n");
    }
    out.write("\n");
  } else if (config.liveSquads) {
    out.write("  cluster   not checked (no RPC endpoint given)\n\n");
    failures.push(
      "--live-squads was requested but no RPC endpoint was given (set PPV_RPC_URL); " +
        "a live decode that did not happen is not a live decode",
    );
  } else {
    out.write("  cluster   not checked (no RPC endpoint given)\n\n");
  }

  if (failures.length > 0) {
    out.write("GOVERNANCE POLICY NOT SATISFIED\n");
    for (const failure of failures) out.write(`  ${failure}\n`);
    out.write("\nDo not give this configuration authority over ppv_escrow.\n");
    return { ok: false, failures, squads };
  }

  out.write("PPV_CUSTODY_GOVERNANCE_VALID\n");
  out.write(`custody_vault=${config.vault}\n`);
  out.write(`threshold=${config.threshold}\n`);
  out.write(`members=${members.length}\n`);
  // The distinction RR-7 is about: whether the two numbers above were read off
  // the chain or handed to this process on the command line.
  out.write(`squads_live_decode=${squads ? "read-from-chain" : "declared-only"}\n`);
  if (squads) {
    out.write(`squads_live_threshold=${squads.threshold}\n`);
    out.write(`squads_live_members=${squads.members.map((m) => m.key).join(",")}\n`);
    out.write(`squads_live_permissions=${squads.members.map((m) => m.mask).join(",")}\n`);
    out.write(`squads_vault_derived=${deriveVault(config.multisig, 0).address}\n`);
  }
  out.write("result=valid\n");
  return { ok: true, failures: [], squads };
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
