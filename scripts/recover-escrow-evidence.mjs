#!/usr/bin/env node
/**
 * Signer-free recovery of the facts a failed evidence recorder never wrote.
 *
 * `ppv_escrow` deployed to devnet and transferred its upgrade authority to the
 * custody vault, and then `record-deployment.sh` died on an unbound variable —
 * so the canonical release record was never written. A deployment cannot be
 * repeated to produce its own evidence, so the facts have to be recovered from
 * the chain instead.
 *
 * Everything here is a public read. It takes no keypair, signs nothing, and
 * cannot move anything; anyone can run it against a devnet RPC and get the same
 * answer, which is the property that makes the recovered record checkable
 * rather than merely asserted.
 *
 *   node scripts/recover-escrow-evidence.mjs [--rpc <url>] [--json]
 *
 * The hard part is the authority-transfer transaction. It is not enough to take
 * the signature that happens to follow the deployment: "the next one" is a
 * guess, and a guess written into a release record is indistinguishable from a
 * fact later. So each candidate is fetched and decoded, and one is accepted
 * only if it actually carries a BPF-upgradeable-loader SetAuthority against
 * this ProgramData account, naming this new authority, and succeeded.
 */

import { createHash } from "node:crypto";

import { DEVNET_GENESIS, rpc } from "./lib/rpc.mjs";
import {
  ESCROW_CUSTODY_GOVERNANCE,
  PERMANENT_PROGRAM_IDS,
  UPGRADEABLE_LOADER_ID,
} from "./lib/identity.mjs";
import { decodeBase58, encodeBase58 } from "./lib/pubkey.mjs";

export const DEFAULT_RPC = "https://api.devnet.solana.com";
export const DEPLOY_SIGNATURE =
  "5xDmBitgkrQ1R9zVhvU3714VFE7arNeMJnhkimMWvP16cFmZVPytGad9j3XMa9CPMvTeoiRzAMJHPb3wmyazEzuA";

/**
 * BPF upgradeable loader instruction discriminants, little-endian u32.
 *
 * `SetAuthority` is the one this recovery is looking for. The deployment used
 * `--skip-new-upgrade-authority-signer-check`, which is the unchecked form (4)
 * rather than `SetAuthorityChecked` (7) — a Squads vault PDA cannot sign, so
 * the checked form is not available to it. Both are accepted here: which one a
 * future transfer uses is the tooling's choice, and a recovery that only knew
 * about one would silently fail to find the other.
 */
export const LOADER_SET_AUTHORITY = 4;
export const LOADER_SET_AUTHORITY_CHECKED = 7;

export class RecoveryFailure extends Error {}

/* --------------------------------------------------------- decoding */

/**
 * Whether one instruction is a loader authority change on `programData` that
 * installs `newAuthority`.
 *
 * Accepts both the `jsonParsed` shape, which Solana's RPC produces for the
 * upgradeable loader, and the raw shape, so the proof does not depend on the
 * node's parser being available or on its field names staying stable.
 */
export function isAuthorityChange(instruction, { programData, newAuthority, accountKeys }) {
  // jsonParsed form.
  const parsed = instruction.parsed;
  if (parsed && typeof parsed === "object") {
    const type = String(parsed.type ?? "").toLowerCase();
    if (!type.startsWith("setauthority")) return false;
    const info = parsed.info ?? {};
    const account = info.account ?? info.programData ?? info.programDataAccount;
    const installed = info.newAuthority ?? info.newAuthorityAccount;
    return account === programData && installed === newAuthority;
  }

  // Raw form: resolve the program and account indexes against the message keys.
  const programId = accountKeys[instruction.programIdIndex];
  if (programId !== UPGRADEABLE_LOADER_ID) return false;

  let data;
  try {
    data = decodeBase58(String(instruction.data ?? ""));
  } catch {
    return false;
  }
  if (data.length < 4) return false;
  const discriminant = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (discriminant !== LOADER_SET_AUTHORITY && discriminant !== LOADER_SET_AUTHORITY_CHECKED) {
    return false;
  }

  const accounts = (instruction.accounts ?? []).map((index) => accountKeys[index]);
  // [0] is the ProgramData being retargeted, [1] the current authority signing
  // it, [2] the authority being installed.
  if (accounts[0] !== programData) return false;
  return accounts[2] === newAuthority;
}

/** Every instruction of a transaction, including those run by inner CPI. */
export function allInstructions(transaction) {
  const message = transaction?.transaction?.message ?? {};
  const top = message.instructions ?? [];
  const inner = (transaction?.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? []);
  return [...top, ...inner];
}

/** The message's account keys as plain addresses, in index order. */
export function accountKeysOf(transaction) {
  const message = transaction?.transaction?.message ?? {};
  const keys = message.accountKeys ?? [];
  const resolved = keys.map((key) => (typeof key === "string" ? key : key?.pubkey));
  const loaded = transaction?.meta?.loadedAddresses ?? {};
  return [...resolved, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/**
 * Proves a transaction performed the expected authority change.
 *
 * Returns a reason on refusal rather than a bare false, because "the signature
 * after the deploy was not the transfer" is a thing an operator needs to read.
 */
export function provesAuthorityChange(transaction, { programData, newAuthority }) {
  if (!transaction) return { ok: false, reason: "transaction not found" };
  if (transaction.meta?.err) {
    return { ok: false, reason: `transaction failed on chain: ${JSON.stringify(transaction.meta.err)}` };
  }
  const accountKeys = accountKeysOf(transaction);
  const match = allInstructions(transaction).some((instruction) =>
    isAuthorityChange(instruction, { programData, newAuthority, accountKeys }),
  );
  if (!match) {
    return { ok: false, reason: "no loader SetAuthority instruction for this ProgramData and authority" };
  }
  return { ok: true, slot: transaction.slot ?? null, blockTime: transaction.blockTime ?? null };
}

/* ------------------------------------------------------------ phases */

/** Phase A: the cluster, the program, and the live ProgramData. */
export async function verifyLiveProgram(client, { programId, expectedProgramData, expectedAuthority }) {
  const genesis = await client.genesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new RecoveryFailure(`STOP — cluster genesis is ${genesis}, expected devnet ${DEVNET_GENESIS}`);
  }

  const program = await client.accountInfo(programId);
  if (!program) throw new RecoveryFailure(`STOP — no account exists at ${programId}`);
  if (program.executable !== true) {
    throw new RecoveryFailure(`STOP — ${programId} is not executable`);
  }
  if (program.owner !== UPGRADEABLE_LOADER_ID) {
    throw new RecoveryFailure(`STOP — ${programId} is owned by ${program.owner}, not the upgradeable loader`);
  }

  // Read ProgramData out of the Program account rather than trusting the
  // offline PDA derivation. They should agree; if they do not, the thing that
  // is wrong is the assumption, not the chain.
  const bytes = Buffer.from(program.data[0], "base64");
  if (bytes.readUInt32LE(0) !== 2) {
    throw new RecoveryFailure(`STOP — ${programId} is not a Program account`);
  }
  const programData = encodeBase58(bytes.subarray(4, 36));
  if (expectedProgramData && programData !== expectedProgramData) {
    throw new RecoveryFailure(
      `STOP — live ProgramData is ${programData}, expected ${expectedProgramData}`,
    );
  }

  const dataAccount = await client.accountInfo(programData);
  if (!dataAccount) throw new RecoveryFailure(`STOP — ProgramData ${programData} is missing`);
  const dataBytes = Buffer.from(dataAccount.data[0], "base64");
  if (dataBytes.readUInt32LE(0) !== 3) {
    throw new RecoveryFailure(`STOP — ${programData} is not a ProgramData account`);
  }
  const lastDeploySlot = Number(dataBytes.readBigUInt64LE(4));
  if (dataBytes[12] !== 1) {
    throw new RecoveryFailure(`STOP — ${programId} is immutable; its upgrade authority is revoked`);
  }
  const authority = encodeBase58(dataBytes.subarray(13, 45));
  if (authority !== expectedAuthority) {
    throw new RecoveryFailure(
      `STOP — CRITICAL_AUTHORITY_MISMATCH: live authority is ${authority}, expected ${expectedAuthority}`,
    );
  }

  return { genesis, programData, authority, lastDeploySlot, owner: program.owner, executable: true };
}

/**
 * Phase B: the authority-transfer transaction, identified by what it did.
 *
 * Walks the ProgramData account's signatures and returns the first that
 * actually proves the change. Every candidate that does not is reported with
 * its reason, so a run that finds nothing says why rather than going quiet.
 */
export async function findAuthorityTransfer(client, { programData, newAuthority, limit = 25 }) {
  const signatures = await client.call("getSignaturesForAddress", [
    programData,
    { limit, commitment: "finalized" },
  ]);
  const considered = [];
  // Oldest first: the transfer is the earliest change that installed this
  // authority, and a later re-transfer to the same vault should not shadow it.
  for (const entry of [...(signatures ?? [])].reverse()) {
    const transaction = await client.call("getTransaction", [
      entry.signature,
      { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]);
    const verdict = provesAuthorityChange(transaction, { programData, newAuthority });
    considered.push({ signature: entry.signature, ...verdict });
    if (verdict.ok) {
      return { signature: entry.signature, slot: verdict.slot, blockTime: verdict.blockTime, considered };
    }
  }
  return { signature: null, slot: null, blockTime: null, considered };
}

/** Phase C: the deployment transaction, reconciled with the live program. */
export async function verifyDeployment(client, { signature, programId }) {
  const transaction = await client.call("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
  ]);
  if (!transaction) return { ok: false, reason: "deployment transaction not found on this cluster" };
  if (transaction.meta?.err) {
    return { ok: false, reason: `deployment transaction failed: ${JSON.stringify(transaction.meta.err)}` };
  }
  const keys = accountKeysOf(transaction);
  if (!keys.includes(programId)) {
    return { ok: false, reason: `deployment transaction does not reference ${programId}` };
  }
  return { ok: true, slot: transaction.slot ?? null, blockTime: transaction.blockTime ?? null };
}

/* -------------------------------------------------------------- main */

export async function recover({ client, out = process.stdout, json = false } = {}) {
  const programId = PERMANENT_PROGRAM_IDS.ppv_escrow;
  const governance = ESCROW_CUSTODY_GOVERNANCE;
  if (!governance) throw new RecoveryFailure("no custody governance is frozen for ppv_escrow");

  const live = await verifyLiveProgram(client, {
    programId,
    expectedProgramData: "2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa",
    expectedAuthority: governance.vault,
  });

  const deployment = await verifyDeployment(client, { signature: DEPLOY_SIGNATURE, programId });
  const transfer = await findAuthorityTransfer(client, {
    programData: live.programData,
    newAuthority: governance.vault,
  });

  const result = {
    cluster: "devnet",
    genesis: live.genesis,
    programId,
    programData: live.programData,
    executable: live.executable,
    owner: live.owner,
    upgradeAuthority: live.authority,
    expectedUpgradeAuthority: governance.vault,
    authorityMatch: live.authority === governance.vault,
    custodyMultisig: governance.multisig,
    custodyThreshold: governance.threshold,
    custodyMembers: [...governance.members],
    deploymentSignature: DEPLOY_SIGNATURE,
    deploymentVerified: deployment.ok,
    deploymentReason: deployment.ok ? null : deployment.reason,
    deploymentSlot: deployment.slot ?? null,
    lastDeploySlot: live.lastDeploySlot,
    authorityTransferSignature: transfer.signature,
    authorityTransferVerified: Boolean(transfer.signature),
    authorityTransferSlot: transfer.slot,
    candidatesConsidered: transfer.considered,
  };

  if (json) {
    out.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  out.write("PPV Escrow evidence recovery (public reads only)\n\n");
  out.write(`CLUSTER_GENESIS=${result.genesis}\n`);
  out.write(`PROGRAM_ID=${result.programId}\n`);
  out.write(`PROGRAMDATA=${result.programData}\n`);
  out.write(`PROGRAM_EXECUTABLE=${result.executable}\n`);
  out.write(`PROGRAM_OWNER=${result.owner}\n`);
  out.write(`CURRENT_UPGRADE_AUTHORITY=${result.upgradeAuthority}\n`);
  out.write(`AUTHORITY_MATCH=${result.authorityMatch ? "YES" : "NO"}\n`);
  out.write(`LAST_DEPLOY_SLOT=${result.lastDeploySlot}\n`);
  out.write(`DEPLOYMENT_TX=${result.deploymentSignature}\n`);
  out.write(`DEPLOYMENT_TX_VERIFIED=${result.deploymentVerified ? "YES" : "NO"}\n`);
  if (!result.deploymentVerified) out.write(`  reason: ${result.deploymentReason}\n`);
  out.write(`DEPLOYMENT_SLOT=${result.deploymentSlot ?? "UNKNOWN"}\n`);
  out.write(`AUTHORITY_TRANSFER_TX=${result.authorityTransferSignature ?? "UNKNOWN"}\n`);
  out.write(`AUTHORITY_TRANSFER_TX_VERIFIED=${result.authorityTransferVerified ? "YES" : "NO"}\n`);
  out.write(`AUTHORITY_TRANSFER_SLOT=${result.authorityTransferSlot ?? "UNKNOWN"}\n`);
  if (!result.authorityTransferVerified) {
    out.write("\nNo candidate proved the authority change. Considered:\n");
    for (const candidate of result.candidatesConsidered) {
      out.write(`  ${candidate.signature}: ${candidate.reason}\n`);
    }
    out.write("\nDo not write canonical evidence with a guessed signature.\n");
  }
  return result;
}

const invokedDirectly = process.argv[1]?.endsWith("recover-escrow-evidence.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const rpcIndex = argv.indexOf("--rpc");
  const endpoint = rpcIndex >= 0 ? argv[rpcIndex + 1] : process.env.PPV_RPC_URL || DEFAULT_RPC;
  recover({ client: rpc(endpoint), json: argv.includes("--json") })
    .then((result) => process.exit(result.authorityTransferVerified && result.deploymentVerified ? 0 : 1))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
