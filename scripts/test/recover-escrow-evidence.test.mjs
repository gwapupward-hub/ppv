import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DEPLOY_SIGNATURE,
  LOADER_SET_AUTHORITY,
  LOADER_SET_AUTHORITY_CHECKED,
  RecoveryFailure,
  accountKeysOf,
  findAuthorityTransfer,
  isAuthorityChange,
  provesAuthorityChange,
  recover,
  verifyDeployment,
  verifyLiveProgram,
} from "../recover-escrow-evidence.mjs";
import { ESCROW_CUSTODY_GOVERNANCE, PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID } from "../lib/identity.mjs";
import { encodeBase58 } from "../lib/pubkey.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS } from "../lib/rpc.mjs";
import { REPO } from "./helpers.mjs";

/**
 * Recovery of the facts a crashed evidence recorder never wrote.
 *
 * The property that matters is not that the happy path works. It is that the
 * authority-transfer transaction is identified by *what it did* rather than by
 * where it sat in the signature list. "The one right after the deploy" is a
 * guess, and a guess written into a release record becomes indistinguishable
 * from a fact the moment it is committed — so the tests below spend most of
 * their effort on transactions that look right and are not.
 *
 * Every test runs against a stub RPC. No network, no keypair, no secrets.
 */

const PROGRAM_ID = PERMANENT_PROGRAM_IDS.ppv_escrow;
const PROGRAM_DATA = "2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa";
const VAULT = ESCROW_CUSTODY_GOVERNANCE.vault;
const DEPLOYER = "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV";
const OTHER_VAULT = "B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX";

/* ------------------------------------------------------------ fixtures */

function programAccount(programData) {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2, 0);
  Buffer.from(bs58ToBytes(programData)).copy(bytes, 4);
  return { executable: true, owner: UPGRADEABLE_LOADER_ID, data: [bytes.toString("base64"), "base64"] };
}

function programDataAccount(authority, slot = 424242) {
  const bytes = Buffer.alloc(45);
  bytes.writeUInt32LE(3, 0);
  bytes.writeBigUInt64LE(BigInt(slot), 4);
  bytes[12] = authority ? 1 : 0;
  if (authority) Buffer.from(bs58ToBytes(authority)).copy(bytes, 13);
  return { executable: false, owner: UPGRADEABLE_LOADER_ID, data: [bytes.toString("base64"), "base64"] };
}

function bs58ToBytes(address) {
  // Round-trips through the repository's own codec so fixtures cannot drift
  // from what the recovery script decodes.
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const ch of address) num = num * 58n + BigInt(ALPHABET.indexOf(ch));
  const out = [];
  while (num > 0n) { out.push(Number(num & 0xffn)); num >>= 8n; }
  out.reverse();
  let zeros = 0;
  for (const ch of address) { if (ch !== "1") break; zeros += 1; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...out]);
}

/** A raw (non-jsonParsed) loader SetAuthority instruction. */
function rawSetAuthority({ discriminant = LOADER_SET_AUTHORITY, accounts, programIdIndex = 3 } = {}) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(discriminant, 0);
  return { programIdIndex, accounts, data: encodeBase58(data) };
}

function transaction({ instructions, accountKeys, err = null, slot = 500000 }) {
  return {
    slot,
    blockTime: 1_770_000_000,
    meta: { err, innerInstructions: [] },
    transaction: { message: { accountKeys, instructions } },
  };
}

/** A stub RPC whose answers each test states for itself. */
function stubClient({ genesis = DEVNET_GENESIS, accounts = {}, signatures = [], transactions = {} } = {}) {
  return {
    endpoint: "stub://devnet",
    genesisHash: async () => genesis,
    accountInfo: async (address) => accounts[address] ?? null,
    call: async (method, params) => {
      if (method === "getSignaturesForAddress") return signatures;
      if (method === "getTransaction") return transactions[params[0]] ?? null;
      throw new Error(`unexpected RPC call ${method}`);
    },
  };
}

const healthyAccounts = {
  [PROGRAM_ID]: programAccount(PROGRAM_DATA),
  [PROGRAM_DATA]: programDataAccount(VAULT),
};

/* ------------------------------------------------- Phase A: live state */

test("a healthy live program resolves ProgramData from the chain", async () => {
  const live = await verifyLiveProgram(stubClient({ accounts: healthyAccounts }), {
    programId: PROGRAM_ID,
    expectedProgramData: PROGRAM_DATA,
    expectedAuthority: VAULT,
  });
  assert.equal(live.programData, PROGRAM_DATA);
  assert.equal(live.authority, VAULT);
  assert.equal(live.owner, UPGRADEABLE_LOADER_ID);
  assert.equal(live.lastDeploySlot, 424242);
});

test("a ProgramData that disagrees with the offline derivation stops the recovery", async () => {
  // The derived PDA is an assumption. If the chain says otherwise, the
  // assumption is what is wrong, and continuing would record a guess.
  const accounts = {
    [PROGRAM_ID]: programAccount(OTHER_VAULT),
    [OTHER_VAULT]: programDataAccount(VAULT),
  };
  await assert.rejects(
    () => verifyLiveProgram(stubClient({ accounts }), {
      programId: PROGRAM_ID,
      expectedProgramData: PROGRAM_DATA,
      expectedAuthority: VAULT,
    }),
    /live ProgramData is .*expected/,
  );
});

test("a wrong live authority is a CRITICAL_AUTHORITY_MISMATCH stop", async () => {
  const accounts = {
    [PROGRAM_ID]: programAccount(PROGRAM_DATA),
    [PROGRAM_DATA]: programDataAccount(OTHER_VAULT),
  };
  await assert.rejects(
    () => verifyLiveProgram(stubClient({ accounts }), {
      programId: PROGRAM_ID,
      expectedProgramData: PROGRAM_DATA,
      expectedAuthority: VAULT,
    }),
    (error) => {
      assert.ok(error instanceof RecoveryFailure);
      assert.match(error.message, /CRITICAL_AUTHORITY_MISMATCH/);
      return true;
    },
  );
});

test("an immutable program stops the recovery", async () => {
  const accounts = {
    [PROGRAM_ID]: programAccount(PROGRAM_DATA),
    [PROGRAM_DATA]: programDataAccount(null),
  };
  await assert.rejects(
    () => verifyLiveProgram(stubClient({ accounts }), {
      programId: PROGRAM_ID, expectedProgramData: PROGRAM_DATA, expectedAuthority: VAULT,
    }),
    /immutable/,
  );
});

test("a wrong cluster stops before anything is read", async () => {
  await assert.rejects(
    () => verifyLiveProgram(stubClient({ genesis: MAINNET_GENESIS, accounts: healthyAccounts }), {
      programId: PROGRAM_ID, expectedProgramData: PROGRAM_DATA, expectedAuthority: VAULT,
    }),
    /cluster genesis is/,
  );
});

test("a non-executable or wrongly-owned program stops the recovery", async () => {
  for (const [label, account] of [
    ["not executable", { ...programAccount(PROGRAM_DATA), executable: false }],
    ["wrong owner", { ...programAccount(PROGRAM_DATA), owner: "11111111111111111111111111111111" }],
  ]) {
    await assert.rejects(
      () => verifyLiveProgram(stubClient({ accounts: { [PROGRAM_ID]: account, [PROGRAM_DATA]: programDataAccount(VAULT) } }), {
        programId: PROGRAM_ID, expectedProgramData: PROGRAM_DATA, expectedAuthority: VAULT,
      }),
      /STOP/,
      label,
    );
  }
});

/* ------------------------- Phase B: the transfer, proved not guessed */

test("a jsonParsed setAuthority naming this ProgramData and vault proves the change", () => {
  const tx = transaction({
    accountKeys: [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID],
    instructions: [{
      program: "bpf-upgradeable-loader",
      parsed: { type: "setAuthority", info: { account: PROGRAM_DATA, authority: DEPLOYER, newAuthority: VAULT } },
    }],
  });
  const verdict = provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.slot, 500000);
});

test("a raw loader SetAuthority proves the change without jsonParsed", () => {
  // The proof must not depend on the node's parser being available.
  const keys = [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID];
  for (const discriminant of [LOADER_SET_AUTHORITY, LOADER_SET_AUTHORITY_CHECKED]) {
    const tx = transaction({
      accountKeys: keys,
      instructions: [rawSetAuthority({ discriminant, accounts: [1, 0, 2] })],
    });
    assert.equal(provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT }).ok, true);
  }
});

test("a transaction that merely follows the deploy is NOT accepted", () => {
  // The exact wrong heuristic, stated as a test: adjacency is not evidence.
  const tx = transaction({
    accountKeys: [DEPLOYER, PROGRAM_DATA, UPGRADEABLE_LOADER_ID],
    instructions: [{ programIdIndex: 2, accounts: [1], data: encodeBase58(Buffer.from([1, 0, 0, 0])) }],
  });
  const verdict = provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no loader SetAuthority/);
});

test("a setAuthority installing a different authority is refused", () => {
  const tx = transaction({
    accountKeys: [DEPLOYER, PROGRAM_DATA, OTHER_VAULT, UPGRADEABLE_LOADER_ID],
    instructions: [rawSetAuthority({ accounts: [1, 0, 2] })],
  });
  assert.equal(provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT }).ok, false);
});

test("a setAuthority against a different ProgramData is refused", () => {
  const tx = transaction({
    accountKeys: [DEPLOYER, OTHER_VAULT, VAULT, UPGRADEABLE_LOADER_ID],
    instructions: [rawSetAuthority({ accounts: [1, 0, 2] })],
  });
  assert.equal(provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT }).ok, false);
});

test("a failed transaction is refused even if it carries the right instruction", () => {
  const tx = transaction({
    accountKeys: [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID],
    instructions: [rawSetAuthority({ accounts: [1, 0, 2] })],
    err: { InstructionError: [0, "Custom"] },
  });
  const verdict = provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /failed on chain/);
});

test("an instruction from a program other than the loader is refused", () => {
  const tx = transaction({
    accountKeys: [DEPLOYER, PROGRAM_DATA, VAULT, "11111111111111111111111111111111"],
    instructions: [rawSetAuthority({ accounts: [1, 0, 2] })],
  });
  assert.equal(provesAuthorityChange(tx, { programData: PROGRAM_DATA, newAuthority: VAULT }).ok, false);
});

test("findAuthorityTransfer picks the proving transaction, not the newest", () => {
  const decoy = "DecoySig11111111111111111111111111111111111";
  const real = "RealTransferSig1111111111111111111111111111";
  const keys = [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID];
  const client = stubClient({
    accounts: healthyAccounts,
    signatures: [{ signature: decoy }, { signature: real }],
    transactions: {
      [decoy]: transaction({ accountKeys: keys, instructions: [{ programIdIndex: 3, accounts: [1], data: encodeBase58(Buffer.from([1, 0, 0, 0])) }] }),
      [real]: transaction({ accountKeys: keys, instructions: [rawSetAuthority({ accounts: [1, 0, 2] })], slot: 499999 }),
    },
  });
  return findAuthorityTransfer(client, { programData: PROGRAM_DATA, newAuthority: VAULT }).then((found) => {
    assert.equal(found.signature, real);
    assert.equal(found.slot, 499999);
  });
});

test("when nothing proves the change the signature stays UNKNOWN", async () => {
  const only = "NothingProvesThis11111111111111111111111111";
  const client = stubClient({
    accounts: healthyAccounts,
    signatures: [{ signature: only }],
    transactions: { [only]: transaction({ accountKeys: [DEPLOYER, PROGRAM_DATA], instructions: [] }) },
  });
  const found = await findAuthorityTransfer(client, { programData: PROGRAM_DATA, newAuthority: VAULT });
  assert.equal(found.signature, null);
  assert.equal(found.considered.length, 1);
  assert.match(found.considered[0].reason, /no loader SetAuthority/);
});

/* ------------------------------------------ Phase C: the deployment tx */

test("the deployment transaction must exist, succeed and name the program", async () => {
  const keys = [DEPLOYER, PROGRAM_ID, UPGRADEABLE_LOADER_ID];
  const ok = await verifyDeployment(
    stubClient({ transactions: { [DEPLOY_SIGNATURE]: transaction({ accountKeys: keys, instructions: [] }) } }),
    { signature: DEPLOY_SIGNATURE, programId: PROGRAM_ID },
  );
  assert.equal(ok.ok, true);

  const missing = await verifyDeployment(stubClient({}), { signature: DEPLOY_SIGNATURE, programId: PROGRAM_ID });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not found/);

  const unrelated = await verifyDeployment(
    stubClient({ transactions: { [DEPLOY_SIGNATURE]: transaction({ accountKeys: [DEPLOYER], instructions: [] }) } }),
    { signature: DEPLOY_SIGNATURE, programId: PROGRAM_ID },
  );
  assert.equal(unrelated.ok, false);
  assert.match(unrelated.reason, /does not reference/);
});

/* ------------------------------------------------------ whole recovery */

test("a full recovery reports every fact and exits clean", async () => {
  const real = "RealTransferSig1111111111111111111111111111";
  const keys = [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID];
  let output = "";
  const result = await recover({
    out: { write: (text) => (output += text) },
    client: stubClient({
      accounts: healthyAccounts,
      signatures: [{ signature: real }],
      transactions: {
        [real]: transaction({ accountKeys: keys, instructions: [rawSetAuthority({ accounts: [1, 0, 2] })] }),
        [DEPLOY_SIGNATURE]: transaction({ accountKeys: [DEPLOYER, PROGRAM_ID, UPGRADEABLE_LOADER_ID], instructions: [] }),
      },
    }),
  });
  assert.equal(result.authorityMatch, true);
  assert.equal(result.authorityTransferVerified, true);
  assert.equal(result.deploymentVerified, true);
  assert.match(output, /AUTHORITY_MATCH=YES/);
  assert.match(output, new RegExp(`AUTHORITY_TRANSFER_TX=${real}`));
  assert.match(output, /DEPLOYMENT_TX_VERIFIED=YES/);
});

test("recovery needs no key material of any kind", () => {
  const source = readFileSync(join(REPO, "scripts", "recover-escrow-evidence.mjs"), "utf8");
  for (const pattern of [/secretKey/, /-keypair\.json/, /PPV_DEPLOYER_KEYPAIR/, /PPV_ESCROW_PROGRAM_KEYPAIR/, /Keypair\./]) {
    assert.doesNotMatch(source, pattern, `recovery references key material: ${pattern}`);
  }
  assert.doesNotMatch(source, /(\d+,\s*){20,}\d+/);
  // And it only ever reads.
  assert.doesNotMatch(source, /sendTransaction|signTransaction|program deploy|set-upgrade-authority/);
});

test("account keys include addresses loaded from lookup tables", () => {
  const tx = {
    transaction: { message: { accountKeys: [{ pubkey: DEPLOYER }], instructions: [] } },
    meta: { loadedAddresses: { writable: [PROGRAM_DATA], readonly: [VAULT] } },
  };
  assert.deepEqual(accountKeysOf(tx), [DEPLOYER, PROGRAM_DATA, VAULT]);
});

test("isAuthorityChange rejects malformed instruction data without throwing", () => {
  const keys = [DEPLOYER, PROGRAM_DATA, VAULT, UPGRADEABLE_LOADER_ID];
  for (const data of ["", "!!!not base58!!!", encodeBase58(Buffer.from([1, 2]))]) {
    assert.doesNotThrow(() =>
      isAuthorityChange({ programIdIndex: 3, accounts: [1, 0, 2], data }, {
        programData: PROGRAM_DATA, newAuthority: VAULT, accountKeys: keys,
      }),
    );
  }
});
