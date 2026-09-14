#!/usr/bin/env node
/**
 * Creates the dedicated Squads V4 custody multisig that will hold `ppv_escrow`'s
 * upgrade authority (Sprint 4, RR-11).
 *
 * `ppv_escrow` is the one PPV program that holds value, and the custody gate in
 * docs/deployment-gates.md requires its upgrade authority to be a multisig
 * *separate* from the one governing the non-custodial programs. This script is
 * the ceremony that brings that multisig into existence, and nothing else: it
 * creates governance, it does not deploy Escrow and it does not transfer any
 * authority to what it creates.
 *
 * The dangerous property of a creation ceremony is that its output is permanent
 * — a multisig at the wrong address, with the wrong members, is not edited
 * afterwards, it is abandoned and redone. So the script is split in two:
 *
 *   node scripts/create-escrow-custody-multisig.mjs --preflight
 *   node scripts/create-escrow-custody-multisig.mjs --execute
 *
 * `--preflight` proves the cluster is devnet, proves the Squads program is
 * there, derives the exact multisig and vault addresses, runs every offline
 * safety check, and stops. `--execute` is a separate, explicit operator action
 * that repeats all of it and then broadcasts. No argument, and any argument
 * that is not exactly `--execute`, refuses to broadcast. That is the execution
 * boundary, and it is asserted by scripts/test/escrow-custody-multisig.test.mjs
 * rather than left as a convention.
 *
 * Key material: this script never prints a secret key, and never accepts one as
 * an argument or in source. The operator/funding signer is read from a keypair
 * file whose path is given in PPV_OPERATOR_KEYPAIR, and the ceremony `createKey`
 * from PPV_CUSTODY_CREATE_KEY. Only public addresses are ever written to stdout.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

import { DEVNET_GENESIS } from "./lib/rpc.mjs";

/**
 * The cluster, fixed here rather than read from the Solana CLI's config.
 *
 * `solana config get` is operator state: whatever the last command set. A
 * ceremony that inherits it can be pointed at mainnet by a config file nobody
 * reread, so the endpoint is a constant and the genesis hash is checked against
 * it before anything is built.
 */
export const DEVNET_ENDPOINT = "https://api.devnet.solana.com";

/** Squads V4. Compared against the installed SDK's own id, not trusted alone. */
export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/** The three custody signers, in their canonical order. */
export const CUSTODY_MEMBERS = Object.freeze([
  "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
  "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
]);

export const CUSTODY_THRESHOLD = 2;

/**
 * Vault index 0: the account that will later become `ppv_escrow`'s upgrade
 * authority. Derived and recorded now so the address is known before it holds
 * anything; this ceremony does not give it that authority.
 */
export const CUSTODY_VAULT_INDEX = 0;

/**
 * No time lock. `docs/deployment-gates.md` and the Escrow release runbook
 * require a separate multisig at a 2-of-N threshold and state no delay
 * requirement, so a non-zero value here would be invented policy — and a time
 * lock chosen carelessly is a real cost in an incident, when the fix everyone
 * agrees on has to wait.
 */
export const CUSTODY_TIME_LOCK = 0;

/**
 * The permissions each member needs for the ordinary Squads proposal lifecycle:
 * propose a change, vote on it, execute it once the threshold is met. Built
 * from the SDK's own `Permission` constants so the serialized mask is whatever
 * the installed program expects, rather than a number copied from a doc.
 */
export function custodyPermissions() {
  const { Permission, Permissions } = multisig.types;
  return Permissions.fromPermissions([
    Permission.Initiate,
    Permission.Vote,
    Permission.Execute,
  ]);
}

/** The member list in the shape `multisigCreateV2` takes. */
export function buildMembers(addresses = CUSTODY_MEMBERS) {
  const permissions = custodyPermissions();
  return addresses.map((address) => ({
    key: new PublicKey(address),
    permissions,
  }));
}

export class CeremonyError extends Error {}

/* ------------------------------------------------------------------ modes */

/**
 * The execution boundary.
 *
 * Every input that is not exactly `--execute` resolves to a mode that cannot
 * broadcast, including no argument at all. Written as an explicit allow-list
 * rather than a `!== "--execute"` test so that adding a mode later cannot make
 * broadcasting the fallthrough.
 */
export function parseMode(argv = []) {
  const flags = argv.filter((token) => token.startsWith("--"));
  if (flags.length === 1 && flags[0] === "--execute") return "execute";
  if (flags.length === 1 && flags[0] === "--preflight") return "preflight";
  if (flags.length === 0) return "none";
  return "unknown";
}

/** Whether a mode is permitted to send a transaction. Exactly one is. */
export function mayBroadcast(mode) {
  return mode === "execute";
}

/* ------------------------------------------------------- offline safety */

/**
 * Every check that needs no network, returned as a list rather than thrown one
 * at a time so an operator sees the whole verdict at once.
 *
 * These are the invariants that make the printed summary meaningful: a
 * threshold no single key can satisfy, three distinct real members, and neither
 * the multisig account nor its vault sitting in its own member list — which
 * would make the threshold satisfiable by whatever can make those PDAs sign,
 * or unsatisfiable by people at all.
 */
export function checkSafety({ multisigPda, vaultPda, threshold, members }) {
  const failures = [];

  if (threshold !== CUSTODY_THRESHOLD) {
    failures.push(`threshold is ${threshold}, expected ${CUSTODY_THRESHOLD}`);
  }
  if (members.length !== 3) {
    failures.push(`${members.length} members, expected 3`);
  }
  for (const member of members) {
    try {
      // eslint-disable-next-line no-new
      new PublicKey(member);
    } catch {
      failures.push(`member ${member} is not a valid public key`);
    }
  }
  if (threshold > members.length) {
    failures.push(`a threshold of ${threshold} cannot be met by ${members.length} members`);
  }

  // A threshold counts distinct keys. Two copies of one member in a "2-of-3"
  // is a 1-of-2 that reads like a 2-of-3 forever after.
  const distinct = new Set(members);
  if (distinct.size !== members.length) {
    failures.push(
      `members contain duplicates: ${members.length} entries, ${distinct.size} distinct keys`,
    );
  }

  if (distinct.has(vaultPda)) failures.push(`the vault ${vaultPda} is one of its own members`);
  if (distinct.has(multisigPda)) {
    failures.push(`the multisig ${multisigPda} is one of its own members`);
  }
  if (multisigPda === vaultPda) failures.push("the multisig and its vault are the same address");

  return failures;
}

/* ------------------------------------------------------------- preflight */

/**
 * Proves the connection really reaches devnet.
 *
 * The endpoint string is not evidence — a URL can be proxied, mocked, or point
 * somewhere that merely answers. The genesis hash is the cluster's identity, so
 * it is required to match exactly and the ceremony stops if it does not.
 */
export async function assertDevnet(connection) {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS) {
    throw new CeremonyError(
      `STOP — WRONG CLUSTER\n` +
        `  endpoint ${connection.rpcEndpoint}\n` +
        `  genesis  ${genesisHash}\n` +
        `  expected ${DEVNET_GENESIS} (devnet)\n` +
        "Nothing was created.",
    );
  }
  return genesisHash;
}

/**
 * Proves the Squads V4 program is present and executable on this cluster.
 *
 * Without this, a creation transaction on a cluster where the program is absent
 * fails in a way that reads like a transient RPC problem, and an operator
 * retries instead of stopping.
 */
export async function assertSquadsProgram(connection, programId = SQUADS_V4_PROGRAM_ID) {
  const account = await connection.getAccountInfo(new PublicKey(programId));
  if (!account) {
    throw new CeremonyError(
      `STOP — the Squads V4 program ${programId} does not exist on ${connection.rpcEndpoint}`,
    );
  }
  if (account.executable !== true) {
    throw new CeremonyError(
      `STOP — the account at ${programId} exists but is not executable; it is not the Squads program`,
    );
  }
  return { exists: true, executable: true };
}

/**
 * The addresses this ceremony will create, derived through the SDK's canonical
 * PDA helpers rather than by re-deriving Squads' seeds here. Re-implementing the
 * seeds means a silent mismatch the first time upstream changes them, and the
 * failure mode is a multisig at an address nothing else agrees on.
 */
export function deriveAddresses(createKeyPublicKey, programId = SQUADS_V4_PROGRAM_ID) {
  const squads = new PublicKey(programId);
  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKeyPublicKey,
    programId: squads,
  });
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: CUSTODY_VAULT_INDEX,
    programId: squads,
  });
  return { multisigPda, vaultPda };
}

/* -------------------------------------------------------- key material */

/**
 * Loads a keypair from a file path held in an environment variable.
 *
 * The variable holds a *path*, never the key itself: a secret in an environment
 * variable is a secret in every child process's environment and in any crash
 * dump that captures it. Nothing about the loaded key is returned to a caller
 * that prints, and the error messages name only the variable and the path.
 */
export function loadKeypairFromEnv(variable, { env = process.env, readFile = readFileSync } = {}) {
  const path = env[variable];
  if (!path) {
    throw new CeremonyError(
      `${variable} is not set. It must hold the *path* to a keypair JSON file, never the key itself.`,
    );
  }
  let raw;
  try {
    raw = readFile(resolve(path), "utf8");
  } catch {
    throw new CeremonyError(`${variable} points at ${path}, which could not be read.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CeremonyError(`the file at ${variable} is not a JSON keypair array.`);
  }
  if (!Array.isArray(parsed)) {
    throw new CeremonyError(`the file at ${variable} is not a JSON keypair array.`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {
    throw new CeremonyError(`the file at ${variable} is not a valid ed25519 keypair.`);
  }
}

/**
 * The ceremony `createKey`.
 *
 * Squads derives the multisig address from this key, so it is what makes the
 * address predictable — and it is *not* one of the three governance members: it
 * signs the creation transaction and then governs nothing.
 *
 * It has to survive between the two halves of the ceremony. The whole point of
 * stopping after `--preflight` is that an operator reviews the exact address
 * that `--execute` will create, and a freshly generated key in each process
 * would derive a different address every run, making that review meaningless.
 * So PPV_CUSTODY_CREATE_KEY names a file: preflight creates it if absent,
 * execute requires it to already exist.
 */
export function resolveCreateKey(mode, { env = process.env, fs = { existsSync, readFileSync, writeFileSync, mkdirSync } } = {}) {
  const path = env.PPV_CUSTODY_CREATE_KEY;

  if (!path) {
    if (mayBroadcast(mode)) {
      throw new CeremonyError(
        "PPV_CUSTODY_CREATE_KEY is not set. --execute requires the createKey file reviewed during " +
          "--preflight, so that the multisig is created at the address the operator approved.",
      );
    }
    return { keypair: Keypair.generate(), persisted: false, path: null };
  }

  const full = resolve(path);
  if (fs.existsSync(full)) {
    const keypair = loadKeypairFromEnv("PPV_CUSTODY_CREATE_KEY", {
      env,
      readFile: fs.readFileSync,
    });
    return { keypair, persisted: true, path: full };
  }

  if (mayBroadcast(mode)) {
    throw new CeremonyError(
      `PPV_CUSTODY_CREATE_KEY points at ${path}, which does not exist. --execute must reuse the ` +
        "createKey generated during --preflight, not make a new one; a new one creates a different " +
        "multisig address than the one that was reviewed.",
    );
  }

  const keypair = Keypair.generate();
  fs.mkdirSync(dirname(full), { recursive: true });
  // 0600: the ceremony's own key, readable by the operator running it and
  // nobody else on the machine.
  fs.writeFileSync(full, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return { keypair, persisted: true, path: full, created: true };
}

/* ----------------------------------------------------------- reporting */

/**
 * The summary an operator reads before authorizing `--execute`. Public
 * information only: addresses, a threshold, a genesis hash and the verdicts of
 * the offline checks.
 */
export function formatSummary({
  genesisHash,
  multisigPda,
  vaultPda,
  createKeyPublic,
  members = CUSTODY_MEMBERS,
  threshold = CUSTODY_THRESHOLD,
  failures = [],
}) {
  const distinct = new Set(members);
  const lines = [
    "NETWORK=devnet",
    `GENESIS_HASH=${genesisHash}`,
    `SQUADS_PROGRAM_ID=${SQUADS_V4_PROGRAM_ID}`,
    `THRESHOLD=${threshold}`,
  ];
  members.forEach((member, index) => lines.push(`MEMBER_${index + 1}=${member}`));
  lines.push(
    `MEMBER_PERMISSIONS=Initiate+Vote+Execute (mask ${custodyPermissions().mask})`,
    `TIME_LOCK=${CUSTODY_TIME_LOCK}`,
    `VAULT_INDEX=${CUSTODY_VAULT_INDEX}`,
    `CREATE_KEY_PUBLIC=${createKeyPublic}`,
    `EXPECTED_CUSTODY_MULTISIG=${multisigPda}`,
    `EXPECTED_CUSTODY_VAULT=${vaultPda}`,
    `THRESHOLD_VALID=${threshold === CUSTODY_THRESHOLD ? "yes" : "no"}`,
    `MEMBERS_UNIQUE=${distinct.size === members.length ? "yes" : "no"}`,
    `VAULT_NOT_MEMBER=${distinct.has(vaultPda) ? "no" : "yes"}`,
    `MULTISIG_NOT_MEMBER=${distinct.has(multisigPda) ? "no" : "yes"}`,
    `SAFETY_CHECKS=${failures.length === 0 ? "pass" : "FAIL"}`,
  );
  for (const failure of failures) lines.push(`  failure: ${failure}`);
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------- on-chain read-back */

/**
 * Re-reads the created multisig from the cluster and compares it, field by
 * field, with what was intended.
 *
 * A confirmed signature says a transaction landed, not that it created what was
 * meant — so the account is fetched back and every field that governance
 * depends on is compared: the address itself, the threshold, the member set and
 * each member's permission mask.
 */
export async function verifyOnChain(connection, { multisigPda, vaultPda }) {
  const account = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    new PublicKey(multisigPda),
  );

  const expectedMask = custodyPermissions().mask;
  const onChainMembers = account.members.map((member) => member.key.toBase58());
  const { vaultPda: rederivedVault } = deriveAddresses(account.createKey);

  const thresholdOk = account.threshold === CUSTODY_THRESHOLD;
  const membersOk =
    onChainMembers.length === CUSTODY_MEMBERS.length &&
    CUSTODY_MEMBERS.every((member) => onChainMembers.includes(member)) &&
    new Set(onChainMembers).size === onChainMembers.length;
  const permissionsOk = account.members.every((member) => member.permissions.mask === expectedMask);
  const vaultOk = rederivedVault.toBase58() === vaultPda;

  return {
    thresholdOk,
    membersOk,
    permissionsOk,
    vaultOk,
    threshold: account.threshold,
    timeLock: account.timeLock,
    members: onChainMembers,
  };
}

/* ----------------------------------------------------------------- main */

export async function main({
  argv = [],
  out = process.stdout,
  env = process.env,
  connectionFactory = (endpoint) => new Connection(endpoint, "confirmed"),
} = {}) {
  const mode = parseMode(argv);

  if (mode === "none" || mode === "unknown") {
    out.write(
      "PPV Escrow custody multisig ceremony\n\n" +
        (mode === "unknown" ? `Unrecognized arguments: ${argv.join(" ")}\n\n` : "") +
        "  node scripts/create-escrow-custody-multisig.mjs --preflight   prove and derive, create nothing\n" +
        "  node scripts/create-escrow-custody-multisig.mjs --execute     create the multisig on devnet\n\n" +
        "Nothing was created. --execute is an explicit operator action and is never the default.\n",
    );
    return { ok: false, mode, broadcast: false };
  }

  // Cross-check the SDK's own program id against the one policy names, before
  // deriving anything from it. A mismatch means the installed SDK targets a
  // different deployment of Squads, and every address below would be wrong.
  const sdkProgramId = multisig.PROGRAM_ID.toBase58();
  if (sdkProgramId !== SQUADS_V4_PROGRAM_ID) {
    throw new CeremonyError(
      `STOP — the installed @sqds/multisig targets ${sdkProgramId}, not ${SQUADS_V4_PROGRAM_ID}`,
    );
  }

  const connection = connectionFactory(DEVNET_ENDPOINT);
  const genesisHash = await assertDevnet(connection);
  await assertSquadsProgram(connection);

  const createKey = resolveCreateKey(mode, { env });
  const { multisigPda, vaultPda } = deriveAddresses(createKey.keypair.publicKey);
  const multisigAddress = multisigPda.toBase58();
  const vaultAddress = vaultPda.toBase58();

  const failures = checkSafety({
    multisigPda: multisigAddress,
    vaultPda: vaultAddress,
    threshold: CUSTODY_THRESHOLD,
    members: [...CUSTODY_MEMBERS],
  });

  out.write(
    formatSummary({
      genesisHash,
      multisigPda: multisigAddress,
      vaultPda: vaultAddress,
      createKeyPublic: createKey.keypair.publicKey.toBase58(),
      failures,
    }),
  );

  if (failures.length > 0) {
    out.write("\nSAFETY CHECKS FAILED — nothing was created.\n");
    return { ok: false, mode, broadcast: false, failures };
  }

  if (!createKey.persisted) {
    out.write(
      "\nNOTE: PPV_CUSTODY_CREATE_KEY is not set, so the createKey above is ephemeral and the\n" +
        "derived addresses are PROVISIONAL — a later run derives different ones. Set\n" +
        "PPV_CUSTODY_CREATE_KEY to a path (ending in -keypair.json, which .gitignore excludes)\n" +
        "and re-run --preflight to fix the addresses before authorizing --execute.\n",
    );
  }

  if (!mayBroadcast(mode)) {
    out.write(
      "\nPREFLIGHT ONLY — no transaction was built or sent.\n" +
        "Review the addresses above, then run --execute to create the multisig.\n",
    );
    return {
      ok: true,
      mode,
      broadcast: false,
      multisig: multisigAddress,
      vault: vaultAddress,
      createKeyPublic: createKey.keypair.publicKey.toBase58(),
      genesisHash,
    };
  }

  /* ------------------------------------------------------- execute only */

  const operator = loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env });

  // The V2 creation instruction pays a protocol fee to the treasury named by
  // the program's own config account, so it is read from the chain rather than
  // hardcoded — the fee and its destination are Squads' to change.
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda,
  );

  const instruction = multisig.instructions.multisigCreateV2({
    treasury: programConfig.treasury,
    creator: operator.publicKey,
    multisigPda,
    // No config authority: the multisig governs itself through proposals that
    // meet its own threshold. An external config authority could rewrite the
    // member set unilaterally, which is the whole thing this is meant to prevent.
    configAuthority: null,
    threshold: CUSTODY_THRESHOLD,
    members: buildMembers(),
    timeLock: CUSTODY_TIME_LOCK,
    createKey: createKey.keypair.publicKey,
    rentCollector: null,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: operator.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([operator, createKey.keypair]);

  out.write("\nBROADCASTING…\n");
  const signature = await connection.sendTransaction(transaction);
  // Confirm against the same blockhash the transaction was signed with, so the
  // wait ends when that blockhash expires rather than hanging indefinitely.
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  const onChain = await verifyOnChain(connection, {
    multisigPda: multisigAddress,
    vaultPda: vaultAddress,
  });

  out.write(
    [
      "",
      `CUSTODY_CREATION_TX=${signature}`,
      `CUSTODY_MULTISIG=${multisigAddress}`,
      `CUSTODY_VAULT=${vaultAddress}`,
      `ONCHAIN_THRESHOLD_VERIFIED=${onChain.thresholdOk ? "yes" : "no"}`,
      `ONCHAIN_MEMBERS_VERIFIED=${onChain.membersOk ? "yes" : "no"}`,
      `ONCHAIN_PERMISSIONS_VERIFIED=${onChain.permissionsOk ? "yes" : "no"}`,
      `ONCHAIN_VAULT_VERIFIED=${onChain.vaultOk ? "yes" : "no"}`,
      "",
    ].join("\n"),
  );

  return {
    ok: onChain.thresholdOk && onChain.membersOk && onChain.permissionsOk && onChain.vaultOk,
    mode,
    broadcast: true,
    signature,
    multisig: multisigAddress,
    vault: vaultAddress,
    onChain,
  };
}

const invokedDirectly = process.argv[1]?.endsWith("create-escrow-custody-multisig.mjs");
if (invokedDirectly) {
  main({ argv: process.argv.slice(2) })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
