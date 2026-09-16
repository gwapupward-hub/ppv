#!/usr/bin/env node
/**
 * Reconstructs the canonical evidence record for an already-deployed program.
 *
 * Read-only and signer-free, like `verify-deployed-program.mjs`: it reads the
 * chain over JSON-RPC and the local build output, and writes a public JSON
 * record. It cannot deploy, upgrade or sign, and it holds no private material.
 *
 * This exists because a deployment can succeed while the step that was supposed
 * to write the evidence down fails. The chain still knows everything that
 * matters, so the record can be rebuilt afterwards from public state plus an
 * exact rebuild of the release commit — which is a stronger provenance claim
 * than a record written by the same job that did the deploying.
 *
 *   PPV_PROGRAM=ppv_core \
 *   PPV_RELEASE_COMMIT=<40-char sha> \
 *   PPV_DEPLOY_SIGNATURE=<base58> \
 *   PPV_AUTHORITY_TRANSFER_SIGNATURE=<base58> \
 *   PPV_UPGRADE_AUTHORITY_MEMBERS=<comma-separated pubkeys> \
 *   PPV_UPGRADE_AUTHORITY_THRESHOLD=2 \
 *   node scripts/collect-deployment-evidence.mjs <output.json>
 *
 * When the record is being reconstructed after a deployment's own evidence step
 * failed, set PPV_EVIDENCE_RECOVERY_COMMIT to the commit carrying the recovery
 * tooling (and optionally PPV_RECOVERY_WORKFLOW_RUN). It is written to its own
 * field and is refused if it equals PPV_RELEASE_COMMIT: the recovery tooling
 * did not build what is deployed, and a record saying otherwise would falsify
 * the release history in the one place a reader would trust it.
 *
 * PPV_BUILD_DIR points at the build output to compare (default `target`), so
 * the tooling and the release checkout it verifies can be separate trees.
 *
 * The rebuilt artifact is read from target/deploy and target/idl. The hard gate
 * is here: the rebuild's bytes must equal the bytes the loader is holding, or
 * the script fails and writes nothing.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { MIN_SQUADS_THRESHOLD, PERMANENT_PROGRAM_IDS, REQUIRED_TOOLCHAIN, UPGRADEABLE_LOADER_ID } from "./lib/identity.mjs";
import { isAddress, isProgramDerived } from "./lib/pubkey.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, readDeployedProgram, rpc, signatureStatus } from "./lib/rpc.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Refuses anything that is a path or looks like a keypair array rather than public data. */
function assertPublicData(values) {
  for (const value of values) {
    if (value.includes("[")) throw new Error("Refusing to run: an input looks like a keypair, not public data.");
  }
}

export async function collect({ client, env, buildDir = "target", now = () => new Date() }) {
  const program = env.PPV_PROGRAM;
  const programId = PERMANENT_PROGRAM_IDS[program];
  if (!programId) throw new Error(`${program} is not a known PPV program`);

  const releaseCommit = env.PPV_RELEASE_COMMIT;
  if (!/^[0-9a-f]{40}$/.test(releaseCommit)) {
    throw new Error(`PPV_RELEASE_COMMIT ${releaseCommit} is not a full 40-character git sha`);
  }

  // Recovery provenance, present only when this record is being reconstructed
  // after the fact rather than written by the deployment that produced it.
  //
  // `releaseCommit` means one thing and must keep meaning it: the source that
  // produced the deployed program. When evidence is recovered later, a second
  // commit exists — the one carrying the recovery tooling — and the two are
  // easy to confuse precisely because the recovery is what is running. Recording
  // the recovery commit in its own field is how a reader can tell which is
  // which; the refusal below is how the record cannot claim the recovery
  // tooling built the program.
  const recoveryCommit = env.PPV_EVIDENCE_RECOVERY_COMMIT || null;
  if (recoveryCommit && !/^[0-9a-f]{40}$/.test(recoveryCommit)) {
    throw new Error(
      `PPV_EVIDENCE_RECOVERY_COMMIT ${recoveryCommit} is not a full 40-character git sha`,
    );
  }
  if (recoveryCommit && recoveryCommit === releaseCommit) {
    throw new Error(
      "PPV_EVIDENCE_RECOVERY_COMMIT equals PPV_RELEASE_COMMIT. The recovery tooling did not " +
        "produce the deployed program; recording it as the deployed source would falsify the " +
        "release history.",
    );
  }
  const recovery = recoveryCommit
    ? {
        recoveredAfterFailedRecording: true,
        recoveryCommit,
        recoveryWorkflowRun: env.PPV_RECOVERY_WORKFLOW_RUN || null,
        note:
          "Evidence reconstructed from public chain state after the deployment run's evidence " +
          "step failed. releaseCommit is the deployed source; recoveryCommit is the tooling that " +
          "recovered the facts and built nothing that is deployed.",
      }
    : null;


  const members = env.PPV_UPGRADE_AUTHORITY_MEMBERS.split(",").map((m) => m.trim()).filter(Boolean);
  const threshold = Number(env.PPV_UPGRADE_AUTHORITY_THRESHOLD);
  if (!Number.isInteger(threshold) || threshold < MIN_SQUADS_THRESHOLD) {
    throw new Error(`PPV_UPGRADE_AUTHORITY_THRESHOLD is '${env.PPV_UPGRADE_AUTHORITY_THRESHOLD}'; policy requires at least ${MIN_SQUADS_THRESHOLD}.`);
  }
  if (members.length < threshold) {
    throw new Error(`${members.length} authority members were given for a ${threshold}-of-N authority`);
  }
  for (const member of members) {
    if (!isAddress(member)) throw new Error(`authority member ${member} is not an address`);
  }
  // A threshold counts distinct keys, not list entries. Two copies of one
  // member in a "2-of-3" is a 1-of-2 that reads like a 2-of-3 forever after,
  // because this record is what every later verification compares against.
  const distinct = new Set(members);
  if (distinct.size !== members.length) {
    throw new Error(
      `authority members contain duplicates: ${members.length} entries, ${distinct.size} distinct keys. ` +
        `A ${threshold}-of-${members.length} whose members repeat does not require ${threshold} holders.`,
    );
  }

  // The built artifact must name the permanent identity, or the record would
  // describe a deployment of something else under this program's name.
  const idlPath = `${buildDir}/idl/${program}.json`;
  const binaryPath = `${buildDir}/deploy/${program}.so`;
  const idlBytes = readFileSync(idlPath);
  const binary = readFileSync(binaryPath);
  const idlAddress = JSON.parse(idlBytes.toString("utf8")).address;
  if (idlAddress !== programId) {
    throw new Error(`Built ${program} IDL names ${idlAddress}, permanent id is ${programId}`);
  }

  const genesisHash = await client.genesisHash();
  if (genesisHash === MAINNET_GENESIS) {
    throw new Error(`${client.endpoint} is mainnet-beta, which is not an authorized PPV cluster`);
  }
  if (genesisHash !== DEVNET_GENESIS) {
    throw new Error(`${client.endpoint} reports genesis ${genesisHash}, expected devnet ${DEVNET_GENESIS}`);
  }

  const state = await readDeployedProgram(client, programId, { binaryLength: binary.length });
  if (!state.exists) throw new Error(`no account at ${programId}: the program is not deployed`);
  if (!state.executable) throw new Error(`${programId} exists but is not executable`);
  if (state.owner !== UPGRADEABLE_LOADER_ID) {
    throw new Error(`${programId} is owned by ${state.owner}, not the BPF upgradeable loader`);
  }
  if (!state.programDataAddress) throw new Error(`could not resolve ProgramData for ${programId}`);
  if (state.programDataOwner !== UPGRADEABLE_LOADER_ID) {
    throw new Error(`ProgramData ${state.programDataAddress} is owned by ${state.programDataOwner}`);
  }
  if (!state.upgradeAuthority) {
    throw new Error(`${program} is immutable: its upgrade authority has been revoked`);
  }
  // The vault is not one of its own signers. A member list that names the
  // authority itself would make the threshold unsatisfiable by people, or —
  // worse — satisfiable by whatever can make the vault sign.
  if (members.includes(state.upgradeAuthority)) {
    throw new Error(
      `SECURITY: the upgrade authority ${state.upgradeAuthority} is listed as one of its own members`,
    );
  }
  if (!isProgramDerived(state.upgradeAuthority)) {
    throw new Error(
      `SECURITY: live upgrade authority ${state.upgradeAuthority} is on the ed25519 curve, ` +
        "so it is a signer wallet rather than a multisig vault",
    );
  }

  // The hard gate. If the exact release rebuild is not byte-identical to what
  // the loader is holding, the deployed program is not this source and nothing
  // downstream of this record may be believed.
  const builtHash = sha256(binary);
  if (builtHash !== state.deployedBinaryHash) {
    throw new Error(
      `BINARY MISMATCH: rebuild of ${releaseCommit} is sha256:${builtHash}, ` +
        `the live program is sha256:${state.deployedBinaryHash}. Do not redeploy; investigate provenance.`,
    );
  }

  const signatures = {};
  for (const [key, signature] of [
    ["deployment", env.PPV_DEPLOY_SIGNATURE],
    ["authorityTransfer", env.PPV_AUTHORITY_TRANSFER_SIGNATURE],
  ]) {
    if (!signature) continue;
    const status = await signatureStatus(client, signature);
    if (!status) throw new Error(`${key} signature ${signature} is not in transaction history`);
    if (status.err !== null) {
      throw new Error(`${key} signature ${signature} is recorded with error ${JSON.stringify(status.err)}`);
    }
    signatures[key] = {
      signature,
      slot: status.slot,
      status: status.confirmationStatus ?? "confirmed",
    };
  }

  return {
    cluster: "devnet",
    genesisHash,
    program,
    programId,
    programDataAddress: state.programDataAddress,
    programOwner: state.owner,
    programDataOwner: state.programDataOwner,
    programExecutable: state.executable,
    releaseCommit,
    deploymentSignature: signatures.deployment?.signature ?? null,
    deploymentSlot: signatures.deployment?.slot ?? null,
    deploymentStatus: signatures.deployment?.status ?? null,
    lastDeploySlot: state.lastDeploySlot,
    authorityTransferSignature: signatures.authorityTransfer?.signature ?? null,
    authorityTransferSlot: signatures.authorityTransfer?.slot ?? null,
    authorityTransferStatus: signatures.authorityTransfer?.status ?? null,
    upgradeAuthority: state.upgradeAuthority,
    upgradeAuthorityKind: "squads-multisig",
    upgradeAuthorityThreshold: threshold,
    upgradeAuthorityMembers: members,
    binaryLength: binary.length,
    binaryHash: `sha256:${builtHash}`,
    builtBinaryHash: `sha256:${builtHash}`,
    onChainBinaryHash: `sha256:${state.deployedBinaryHash}`,
    binaryHashesMatch: true,
    programDataLength: state.programDataLength,
    programDataPaddingLength: state.paddingLength,
    idlAddress,
    idlHash: `sha256:${sha256(idlBytes)}`,
    toolchain: {
      anchor: REQUIRED_TOOLCHAIN.anchor,
      solana: REQUIRED_TOOLCHAIN.solana,
      rustHost: REQUIRED_TOOLCHAIN.rustHost,
      rustSbf: "1.75.0",
    },
    verificationMethod: "raw-solana-json-rpc-read-only",
    verificationRpc: client.endpoint,
    verificationTimestamp: now().toISOString(),
    sourceWorkflowRun: env.PPV_SOURCE_WORKFLOW_RUN || null,
    evidenceWorkflowRun: env.PPV_EVIDENCE_WORKFLOW_RUN || null,
    evidenceRecovery: recovery,
  };
}

async function main() {
  const [output] = process.argv.slice(2);
  if (!output) {
    process.stderr.write("usage: collect-deployment-evidence.mjs <output.json>\n");
    process.exit(2);
  }
  const env = {
    PPV_PROGRAM: required("PPV_PROGRAM"),
    PPV_RELEASE_COMMIT: required("PPV_RELEASE_COMMIT"),
    PPV_DEPLOY_SIGNATURE: required("PPV_DEPLOY_SIGNATURE"),
    PPV_AUTHORITY_TRANSFER_SIGNATURE: process.env.PPV_AUTHORITY_TRANSFER_SIGNATURE || "",
    PPV_UPGRADE_AUTHORITY_MEMBERS: required("PPV_UPGRADE_AUTHORITY_MEMBERS"),
    PPV_UPGRADE_AUTHORITY_THRESHOLD: required("PPV_UPGRADE_AUTHORITY_THRESHOLD"),
    PPV_SOURCE_WORKFLOW_RUN: process.env.PPV_SOURCE_WORKFLOW_RUN || "",
    PPV_EVIDENCE_WORKFLOW_RUN: process.env.PPV_EVIDENCE_WORKFLOW_RUN || "",
    // Set only when reconstructing a record the deployment failed to write.
    PPV_EVIDENCE_RECOVERY_COMMIT: process.env.PPV_EVIDENCE_RECOVERY_COMMIT || "",
    PPV_RECOVERY_WORKFLOW_RUN: process.env.PPV_RECOVERY_WORKFLOW_RUN || "",
  };
  assertPublicData(Object.values(env));

  const client = rpc(process.env.PPV_RPC_URL || "https://api.devnet.solana.com");
  const record = await collect({ client, env, buildDir: process.env.PPV_BUILD_DIR || "target" });
  writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("collect-deployment-evidence.mjs")) {
  main().catch((error) => {
    process.stderr.write(`\nFAIL  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
