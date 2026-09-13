#!/usr/bin/env node
/**
 * Verifies an already-deployed PPV program against a recorded release.
 *
 * This is the read-only half of a release: it never deploys, upgrades, closes,
 * transfers authority or signs anything, and it needs no wallet, no default
 * signer, no keypair and no Solana CLI. Everything it asserts is public chain
 * state read over JSON-RPC, so the release can be re-verified by anyone, at any
 * time, without touching private material — including after every person who
 * ran the deployment has lost their keys.
 *
 *   node scripts/verify-deployed-program.mjs deployments/evidence/<record>.json
 *
 *   PPV_RPC_URL            endpoint to read (default https://api.devnet.solana.com)
 *   PPV_VERIFY_RPC_URL     optional second endpoint; every check is repeated there
 *
 * Exit status is the verdict: 0 only when every check passed. Each check fails
 * closed, and each failure names the specific expectation that was violated
 * rather than a generic verification error, because "the upgrade authority is
 * not the Squads vault" and "the cluster is the wrong one" call for completely
 * different responses.
 */

import { readFileSync } from "node:fs";

import { MIN_SQUADS_THRESHOLD, PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID } from "./lib/identity.mjs";
import { isAddress, isProgramDerived } from "./lib/pubkey.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, readDeployedProgram, rpc, signatureStatus } from "./lib/rpc.mjs";

/** Genesis hash per cluster name. A record naming any other cluster is refused. */
const CLUSTER_GENESIS = Object.freeze({ devnet: DEVNET_GENESIS });

export class VerificationFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationFailure";
  }
}

/**
 * Checks the record itself before any chain read.
 *
 * A record that names the wrong permanent id, a threshold policy forbids, or an
 * upgrade authority that is an ordinary wallet rather than a vault PDA is not a
 * verification problem to be reported against the chain — it is a bad record,
 * and saying so is the only useful failure message.
 */
export function checkRecord(record) {
  const failures = [];
  const expectedId = PERMANENT_PROGRAM_IDS[record.program];
  if (!expectedId) {
    failures.push(`${record.program} is not a known PPV program`);
  } else if (record.programId !== expectedId) {
    failures.push(
      `record names ${record.program} at ${record.programId}; the permanent id is ${expectedId}`,
    );
  }

  const expectedGenesis = CLUSTER_GENESIS[record.cluster];
  if (!expectedGenesis) {
    failures.push(`record names cluster ${record.cluster}, which this verifier does not accept`);
  } else if (record.genesisHash !== expectedGenesis) {
    failures.push(
      `record claims ${record.cluster} genesis ${record.genesisHash}, expected ${expectedGenesis}`,
    );
  }
  if (record.genesisHash === MAINNET_GENESIS) {
    failures.push("record names mainnet-beta; mainnet is not an authorized PPV cluster");
  }

  if (!isAddress(record.upgradeAuthority) || !isProgramDerived(record.upgradeAuthority)) {
    failures.push(
      `recorded upgrade authority ${record.upgradeAuthority} is not a program-derived address, ` +
        "so it is a signer wallet rather than a multisig vault",
    );
  }
  const threshold = record.upgradeAuthorityThreshold;
  if (!Number.isInteger(threshold) || threshold < MIN_SQUADS_THRESHOLD) {
    failures.push(
      `recorded authority threshold ${threshold} is below the policy minimum of ${MIN_SQUADS_THRESHOLD}`,
    );
  }
  const members = record.upgradeAuthorityMembers ?? [];
  if (!Array.isArray(members) || members.length < threshold) {
    failures.push(`record lists ${members.length} authority members for a ${threshold}-of-N authority`);
  }
  for (const member of members) {
    if (!isAddress(member)) failures.push(`authority member ${member} is not an address`);
  }

  for (const field of ["releaseCommit", "deploymentSignature", "programDataAddress", "binaryHash"]) {
    if (!record[field]) failures.push(`record has no ${field}`);
  }
  if (!/^[0-9a-f]{40}$/.test(record.releaseCommit ?? "")) {
    failures.push(`releaseCommit ${record.releaseCommit} is not a full 40-character git sha`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(record.binaryHash ?? "")) {
    failures.push(`binaryHash ${record.binaryHash} is not a sha256:<hex> digest`);
  }
  if (!Number.isInteger(record.binaryLength) || record.binaryLength <= 0) {
    failures.push(`record has no usable binaryLength (${record.binaryLength})`);
  }
  return failures;
}

/** Every live check, against one endpoint. Returns the failures it found. */
export async function checkChain(client, record, report) {
  const failures = [];
  const fail = (message) => {
    failures.push(message);
    report(false, message);
  };

  const genesis = await client.genesisHash();
  if (genesis === MAINNET_GENESIS) {
    // Refused first and unconditionally: nothing else about this endpoint
    // matters once it is mainnet.
    throw new VerificationFailure(`${client.endpoint} is mainnet-beta, which is not authorized`);
  }
  if (genesis !== record.genesisHash) {
    fail(`cluster genesis ${genesis} does not match the recorded ${record.genesisHash}`);
  } else {
    report(true, `cluster is ${record.cluster} (${genesis})`);
  }

  const state = await readDeployedProgram(client, record.programId, {
    binaryLength: record.binaryLength,
  });
  if (!state.exists) {
    fail(`no account at ${record.programId}: the program is not deployed`);
    return failures;
  }
  if (!state.executable) fail(`${record.programId} exists but is not executable`);
  else report(true, `program ${record.programId} exists and is executable`);

  if (state.owner !== UPGRADEABLE_LOADER_ID) {
    fail(`${record.programId} is owned by ${state.owner}, not the BPF upgradeable loader`);
    return failures;
  }
  report(true, `owned by the BPF upgradeable loader`);

  if (state.programDataAddress !== record.programDataAddress) {
    fail(
      `ProgramData is ${state.programDataAddress}, the record says ${record.programDataAddress}`,
    );
  } else {
    report(true, `ProgramData ${state.programDataAddress} resolves and exists`);
  }
  if (state.programDataOwner !== UPGRADEABLE_LOADER_ID) {
    fail(`ProgramData ${state.programDataAddress} is owned by ${state.programDataOwner}`);
  }

  if (state.upgradeAuthority === null) {
    fail(`${record.program} is immutable: its upgrade authority has been revoked`);
  } else if (state.upgradeAuthority !== record.upgradeAuthority) {
    // A security incident, not drift: somebody other than the recorded vault
    // can replace this program's code.
    fail(
      `SECURITY: live upgrade authority is ${state.upgradeAuthority}, ` +
        `the recorded Squads vault is ${record.upgradeAuthority}`,
    );
  } else {
    report(true, `upgrade authority is the recorded Squads vault ${state.upgradeAuthority}`);
  }

  const liveHash = `sha256:${state.deployedBinaryHash}`;
  if (liveHash !== record.binaryHash) {
    fail(`live binary is ${liveHash}, the recorded release binary is ${record.binaryHash}`);
  } else {
    report(
      true,
      `live binary matches the recorded release binary (${record.binaryLength} bytes` +
        `${state.paddingLength ? `, ${state.paddingLength} bytes of loader padding` : ""})`,
    );
  }

  const signatures = [
    ["deployment", record.deploymentSignature],
    ["authority transfer", record.authorityTransferSignature],
  ];
  for (const [label, signature] of signatures) {
    if (!signature) continue;
    const status = await signatureStatus(client, signature);
    if (!status) fail(`${label} transaction ${signature} is not in transaction history`);
    else if (status.err !== null) fail(`${label} transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    else report(true, `${label} transaction succeeded (slot ${status.slot})`);
  }

  return failures;
}

export async function verify(record, { endpoints, fetchImpl, report }) {
  const recordFailures = checkRecord(record);
  for (const failure of recordFailures) report(false, `record: ${failure}`);
  if (recordFailures.length > 0) return recordFailures;

  report(true, `record is internally consistent for ${record.program} @ ${record.releaseCommit}`);

  const failures = [...recordFailures];
  for (const endpoint of endpoints) {
    report(null, `via ${endpoint}`);
    const client = rpc(endpoint, fetchImpl ? { fetchImpl } : {});
    failures.push(...(await checkChain(client, record, report)));
  }
  return failures;
}

/**
 * Prints the live state of a program without checking it against a record.
 *
 * Used when there is no record yet — the case this release is in, because the
 * deployment succeeded and the evidence step did not. Reports rather than
 * asserts, so it states what is there and never implies it is what was
 * intended.
 */
export async function inspect(client, programId) {
  const genesis = await client.genesisHash();
  const state = await readDeployedProgram(client, programId);
  return {
    endpoint: client.endpoint,
    genesisHash: genesis,
    cluster: genesis === DEVNET_GENESIS ? "devnet" : genesis === MAINNET_GENESIS ? "mainnet-beta" : "unknown",
    programId,
    exists: state.exists,
    executable: state.executable ?? null,
    owner: state.owner ?? null,
    programDataAddress: state.programDataAddress ?? null,
    programDataOwner: state.programDataOwner ?? null,
    programDataLength: state.programDataLength ?? null,
    lastDeploySlot: state.lastDeploySlot ?? null,
    upgradeAuthority: state.upgradeAuthority ?? null,
    programDataPayloadLength: state.deployedBinary?.length ?? null,
    programDataPayloadHash: state.deployedBinaryHash ? `sha256:${state.deployedBinaryHash}` : null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const inspectIndex = args.indexOf("--inspect");
  if (inspectIndex !== -1) {
    const programId = args[inspectIndex + 1] || PERMANENT_PROGRAM_IDS.ppv_core;
    const client = rpc(process.env.PPV_RPC_URL || "https://api.devnet.solana.com");
    const state = await inspect(client, programId);
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  const [recordPath] = args;
  if (!recordPath) {
    process.stderr.write(
      "usage: verify-deployed-program.mjs <evidence-record.json>\n" +
        "       verify-deployed-program.mjs --inspect [program-id]\n",
    );
    process.exit(2);
  }
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const endpoints = [process.env.PPV_RPC_URL || "https://api.devnet.solana.com"];
  if (process.env.PPV_VERIFY_RPC_URL) endpoints.push(process.env.PPV_VERIFY_RPC_URL);

  const report = (ok, message) => {
    if (ok === null) process.stdout.write(`\n${message}\n`);
    else process.stdout.write(`  ${ok ? "ok  " : "FAIL"}  ${message}\n`);
  };

  process.stdout.write(`Verifying ${record.program} from ${recordPath}\n`);
  const failures = await verify(record, { endpoints, report });

  if (failures.length > 0) {
    process.stdout.write(`\nresult=failed\n`);
    process.stderr.write(`${failures.length} check(s) failed. The release is NOT verified.\n`);
    process.exit(1);
  }

  // A single compact block a reader can quote, with no secret material in it.
  process.stdout.write(
    [
      "",
      `${record.program.toUpperCase()}_${record.cluster.toUpperCase()}_VERIFIED`,
      `program_id=${record.programId}`,
      `program_data=${record.programDataAddress}`,
      `release_commit=${record.releaseCommit}`,
      `binary_hash=${record.binaryHash}`,
      `upgrade_authority=${record.upgradeAuthority}`,
      `deployment_signature=${record.deploymentSignature}`,
      "result=verified",
      "",
    ].join("\n"),
  );
}

if (process.argv[1] && process.argv[1].endsWith("verify-deployed-program.mjs")) {
  main().catch((error) => {
    process.stderr.write(`\nFAIL  ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("result=failed\n");
    process.exit(1);
  });
}
