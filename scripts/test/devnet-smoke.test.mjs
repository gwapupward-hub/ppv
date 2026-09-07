import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { PublicKey, SystemProgram } from "@solana/web3.js";

import { REPO } from "./helpers.mjs";
import { PERMANENT_PROGRAM_IDS, UPGRADEABLE_LOADER_ID } from "../lib/identity.mjs";
import { decodeBase58 } from "../lib/pubkey.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, rpc } from "../lib/rpc.mjs";
import { SmokeFailure, assertDevnet, checkProgram, runIdentityPhase } from "../devnet-smoke.mjs";
import {
  agreementAddress,
  cancelAgreementInstruction,
  createAgreementInstruction,
  createProofInstruction,
  eventCpiAccounts,
  instructionDiscriminator,
  proofAddress,
  signAgreementInstruction,
} from "../devnet-lifecycle.mjs";

/**
 * The smoke suite's guards, exercised against a stub cluster.
 *
 * The suite itself cannot run here — there is no devnet reachable from CI and
 * no funded wallet — so what is tested is the part that decides whether it is
 * safe to run at all: the cluster check, the identity check, and the authority
 * check. Those are the checks that stand between a smoke test and a signed
 * transaction on the wrong network.
 */

const VAULT = "3cFRkTFrpmNXetfLJka5q1owRffk1tjWVo8SDLPyWB7w";
const WRONG_AUTHORITY = "55y7B46ZUAyeYaMFUPxHAg9UUcwrfZ2eZDFDabxinhjp";
const encodeBase58Sdk = (bytes) => new PublicKey(bytes).toBase58();

/** A program account: 4-byte tag 2, then its ProgramData address. */
function programAccount(programDataAddress) {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  Buffer.from(new PublicKey(programDataAddress).toBytes()).copy(data, 4);
  return { executable: true, owner: UPGRADEABLE_LOADER_ID, data: [data.toString("base64"), "base64"] };
}

/** A ProgramData account: tag 3, slot, Option<Pubkey> authority. */
function programDataAccount(authority) {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(12345n, 4);
  if (authority) {
    data[12] = 1;
    Buffer.from(new PublicKey(authority).toBytes()).copy(data, 13);
  }
  return { executable: false, owner: UPGRADEABLE_LOADER_ID, data: [data.toString("base64"), "base64"] };
}

const CORE_DATA = "6ASf5EcmiEXZoc4LGdxHTqLA1ykMuVjNoJDbNSuGf5Nr";
const COMMERCE_DATA = "DyqdftdT3vo2SMvHaKVU2Pmb1zBfJ8wCpYYJQ7idnoAR";

let server;
let endpoint;
let state;

function defaultState() {
  return {
    genesis: DEVNET_GENESIS,
    accounts: {
      [PERMANENT_PROGRAM_IDS.ppv_core]: programAccount(CORE_DATA),
      [PERMANENT_PROGRAM_IDS.ppv_commerce]: programAccount(COMMERCE_DATA),
      [CORE_DATA]: programDataAccount(VAULT),
      [COMMERCE_DATA]: programDataAccount(VAULT),
    },
  };
}

before(async () => {
  state = defaultState();
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (result) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      };
      if (method === "getGenesisHash") return reply(state.genesis);
      if (method === "getAccountInfo") {
        return reply({ context: { slot: 1 }, value: state.accounts[params[0]] ?? null });
      }
      reply(null);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

test("mainnet is refused before anything else is considered", async () => {
  // The suite signs transactions. Being pointed at mainnet by an environment
  // variable must be a hard stop, not a warning.
  state.genesis = MAINNET_GENESIS;
  await assert.rejects(assertDevnet(rpc(endpoint), DEVNET_GENESIS), /is mainnet-beta/);
  await assert.rejects(
    runIdentityPhase(rpc(endpoint), {
      expectedAuthority: VAULT,
      expectedGenesis: MAINNET_GENESIS,
      encodeBase58: encodeBase58Sdk,
    }),
    /is mainnet-beta/,
    "even naming mainnet as the expected cluster must not authorize it",
  );
  state = defaultState();
});

test("any cluster that is not the expected devnet is refused", async () => {
  state.genesis = "9tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
  await assert.rejects(assertDevnet(rpc(endpoint), DEVNET_GENESIS), /expected/);
  state = defaultState();
});

test("a healthy devnet deployment passes the identity phase", async () => {
  const result = await runIdentityPhase(rpc(endpoint), {
    expectedAuthority: VAULT,
    expectedGenesis: DEVNET_GENESIS,
    encodeBase58: encodeBase58Sdk,
  });
  assert.equal(result.genesis, DEVNET_GENESIS);
  assert.equal(result.programs.ppv_core.authorityAddress, VAULT);
  assert.equal(result.programs.ppv_commerce.authorityAddress, VAULT);
});

test("an undeployed program stops the suite", async () => {
  delete state.accounts[PERMANENT_PROGRAM_IDS.ppv_commerce];
  await assert.rejects(
    runIdentityPhase(rpc(endpoint), {
      expectedAuthority: VAULT,
      expectedGenesis: DEVNET_GENESIS,
      encodeBase58: encodeBase58Sdk,
    }),
    /ppv_commerce is not deployed/,
  );
  state = defaultState();
});

test("a non-executable or wrongly-owned account is not a program", async () => {
  state.accounts[PERMANENT_PROGRAM_IDS.ppv_core].executable = false;
  await assert.rejects(
    checkProgram(rpc(endpoint), "ppv_core", PERMANENT_PROGRAM_IDS.ppv_core, VAULT, encodeBase58Sdk),
    /is not executable/,
  );
  state = defaultState();

  state.accounts[PERMANENT_PROGRAM_IDS.ppv_core].owner = SystemProgram.programId.toBase58();
  await assert.rejects(
    checkProgram(rpc(endpoint), "ppv_core", PERMANENT_PROGRAM_IDS.ppv_core, VAULT, encodeBase58Sdk),
    /not the upgradeable loader/,
  );
  state = defaultState();
});

test("an unexpected upgrade authority is reported as a security failure", async () => {
  // Not configuration drift: somebody other than the expected multisig can
  // replace this program's code.
  state.accounts[CORE_DATA] = programDataAccount(WRONG_AUTHORITY);
  await assert.rejects(
    checkProgram(rpc(endpoint), "ppv_core", PERMANENT_PROGRAM_IDS.ppv_core, VAULT, encodeBase58Sdk),
    /SECURITY: ppv_core upgrade authority is/,
  );
  state = defaultState();
});

test("a revoked upgrade authority is refused rather than treated as safe", async () => {
  state.accounts[CORE_DATA] = programDataAccount(null);
  await assert.rejects(
    checkProgram(rpc(endpoint), "ppv_core", PERMANENT_PROGRAM_IDS.ppv_core, VAULT, encodeBase58Sdk),
    /immutable — its upgrade authority has been revoked/,
  );
  state = defaultState();
});

test("a signer wallet as the expected authority is refused", async () => {
  await assert.rejects(
    runIdentityPhase(rpc(endpoint), {
      expectedAuthority: WRONG_AUTHORITY,
      expectedGenesis: DEVNET_GENESIS,
      encodeBase58: encodeBase58Sdk,
    }),
    /is not a program-derived address/,
  );
  await assert.rejects(
    runIdentityPhase(rpc(endpoint), {
      expectedAuthority: "",
      expectedGenesis: DEVNET_GENESIS,
      encodeBase58: encodeBase58Sdk,
    }),
    /PPV_SQUADS_VAULT_PDA is not set/,
  );
});

/**
 * The lifecycle phase cannot run without a cluster, but the part most likely to
 * be wrong — the encoding an outside integrator would have to reproduce — is
 * checkable against the committed program source right here.
 */

function accountsStructOrder(program, structName) {
  const source = readFileSync(join(REPO, "programs", program, "src", "lib.rs"), "utf8");
  const start = source.indexOf(`pub struct ${structName}<'info>`);
  assert.notEqual(start, -1, `${structName} not found in ${program}`);
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^\s+pub (\w+):/gm)].map((match) => match[1]);
}

test("instruction discriminators are Anchor's, derived from the instruction name", () => {
  for (const name of ["create_proof", "create_agreement", "sign_agreement", "cancel_agreement"]) {
    assert.deepEqual(
      instructionDiscriminator(name),
      createHash("sha256").update(`global:${name}`).digest().subarray(0, 8),
    );
  }
});

test("PDA derivations match the seeds the programs use", () => {
  const authority = new PublicKey(WRONG_AUTHORITY);
  const proofId = Array.from({ length: 16 }, (_, i) => i);
  assert.equal(
    proofAddress(authority, proofId).toBase58(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("proof"), authority.toBytes(), Buffer.from(proofId)],
      new PublicKey(PERMANENT_PROGRAM_IDS.ppv_core),
    )[0].toBase58(),
  );
  assert.equal(
    agreementAddress(authority, proofId).toBase58(),
    PublicKey.findProgramAddressSync(
      [Buffer.from("agreement"), authority.toBytes(), Buffer.from(proofId)],
      new PublicKey(PERMANENT_PROGRAM_IDS.ppv_commerce),
    )[0].toBase58(),
  );
});

test("built instructions use the account order the programs declare", () => {
  // The failure this catches: an account list that looks right and addresses
  // the wrong slot, which the runtime reports as a constraint violation far
  // from its cause.
  const authority = new PublicKey(WRONG_AUTHORITY);
  const fixtureId = Array.from({ length: 16 }, () => 1);
  const hash = Array.from({ length: 32 }, () => 2);

  const proofIx = createProofInstruction({
    authority,
    proofId: fixtureId,
    contentHash: hash,
    contextHash: hash,
    kind: "deliverable",
  });
  // `#[event_cpi]` appends event_authority and program after the declared ones.
  assert.deepEqual(accountsStructOrder("ppv_core", "CreateProof"), [
    "authority",
    "proof",
    "system_program",
  ]);
  assert.equal(proofIx.keys.length, 5);
  assert.equal(proofIx.keys[0].pubkey.toBase58(), authority.toBase58());
  assert.equal(proofIx.keys[0].isSigner, true);
  assert.equal(proofIx.keys[1].pubkey.toBase58(), proofAddress(authority, fixtureId).toBase58());
  assert.equal(proofIx.keys[2].pubkey.toBase58(), SystemProgram.programId.toBase58());
  assert.deepEqual(
    proofIx.keys.slice(3).map((k) => k.pubkey.toBase58()),
    eventCpiAccounts(new PublicKey(PERMANENT_PROGRAM_IDS.ppv_core)).map((k) => k.pubkey.toBase58()),
  );

  assert.deepEqual(accountsStructOrder("ppv_commerce", "CreateAgreement"), [
    "party_a",
    "agreement",
    "system_program",
  ]);
  assert.deepEqual(accountsStructOrder("ppv_commerce", "MutateAgreement"), ["signer", "agreement"]);

  const signIx = signAgreementInstruction({
    signer: authority,
    agreement: agreementAddress(authority, fixtureId),
    version: 1,
    contentHash: hash,
    termsHash: hash,
  });
  assert.equal(signIx.keys.length, 4, "signer, agreement, event_authority, program");
  assert.equal(signIx.keys[0].isSigner, true);
  assert.equal(signIx.keys[1].isWritable, true);

  const cancelIx = cancelAgreementInstruction({
    signer: authority,
    agreement: agreementAddress(authority, fixtureId),
  });
  assert.equal(cancelIx.data.length, 8, "cancel_agreement takes no arguments");
});

test("instruction data is the discriminator followed by borsh arguments", () => {
  const authority = new PublicKey(WRONG_AUTHORITY);
  const agreementId = Array.from({ length: 16 }, (_, i) => i);
  const contentHash = Array.from({ length: 32 }, () => 7);
  const termsHash = Array.from({ length: 32 }, () => 8);
  const expiresAt = 1_800_000_000;

  const ix = createAgreementInstruction({
    partyA: authority,
    partyB: new PublicKey(VAULT),
    agreementId,
    contentHash,
    termsHash,
    expiresAt,
  });

  let offset = 0;
  const take = (n) => ix.data.subarray(offset, (offset += n));
  assert.deepEqual(take(8), instructionDiscriminator("create_agreement"));
  assert.deepEqual([...take(16)], agreementId);
  assert.deepEqual([...take(32)], [...decodeBase58(VAULT)]);
  assert.deepEqual([...take(32)], contentHash);
  assert.deepEqual([...take(32)], termsHash);
  assert.equal(take(8).readBigInt64LE(0), BigInt(expiresAt));
  assert.equal(offset, ix.data.length, "no trailing bytes");
});
