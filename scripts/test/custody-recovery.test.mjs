import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { PROOF_ACCOUNT_DISCRIMINATOR } from "@gwap/ppv-sdk";

import { decodeBase58 } from "../lib/pubkey.mjs";
import { CustodyDefect, CustodyHarnessFailure } from "../lib/custody-runner.mjs";
import {
  PRIMARY_SCENARIOS,
  RR6_FAMILIES,
  lookupTransaction,
  parseArguments,
  readDiagnostic,
  collectProofBindings,
  verifyProofBindings,
  verifyRefusals,
  verifySuccesses,
} from "../recover-devnet-escrow-custody-evidence.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The read-only recovery command.
 *
 * Live run 35465469908 executed the whole value-moving custody matrix and then
 * failed in read-only history reconstruction on an HTTP 429. Repeating a
 * matrix of value-moving transactions because a *read* was rate limited would
 * spend real state to re-learn what the chain already records, so recovery
 * rebuilds the run instead.
 *
 * That makes one property load-bearing above all others: this command must be
 * incapable of sending a transaction. Not careful about it — incapable. The
 * structural tests below are the ones that hold that, and they are written to
 * fail on the edit that would break it rather than on its consequences.
 *
 * Nothing here touches a chain.
 */

const SCRIPT = join(REPO, "scripts", "recover-devnet-escrow-custody-evidence.mjs");
const SOURCE = readFileSync(SCRIPT, "utf8");

/** Comments stripped, so prose about sending is not read as a send. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const SIGNATURE = (n) => `${"1".repeat(80)}${String(n).padStart(8, "0")}`;

/** A read client whose getTransaction plays a fixed script. */
function stubClient(bySignature) {
  const seen = [];
  return {
    seen,
    client: {
      call: async (method, params) => {
        seen.push(method);
        assert.equal(method, "getTransaction", `recovery called ${method} while looking up a signature`);
        return bySignature[params[0]] ?? null;
      },
    },
  };
}

const landed = (err = null, slot = 400_000_001) => ({ slot, meta: { err } });

/* ================================== the command cannot send a transaction */

test("1. recovery imports no signer, transaction builder or send path", () => {
  const forbidden = [
    "Keypair",
    "Transaction",
    "sendRawTransaction",
    "sendAndConfirmTransaction",
    "sendTransaction",
    "requestAirdrop",
    "simulateTransaction",
    "transaction-lifecycle.mjs",
    "sendExpectingSuccess",
    "sendExpectingRefusal",
    "signTransaction",
    "partialSign",
  ];
  for (const name of forbidden) {
    // Whole identifiers, not substrings: `getTransaction` and
    // `lookupTransaction` are reads and must not be mistaken for `Transaction`.
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    assert.ok(
      !pattern.test(CODE),
      `scripts/recover-devnet-escrow-custody-evidence.mjs references ${name}; recovery must be ` +
        "structurally incapable of sending a transaction",
    );
  }
});

test("2. recovery imports nothing that could produce a signature", () => {
  const imports = [...CODE.matchAll(/^import\s+(?:\{([^}]*)\}|(\w+))\s+from\s+"([^"]+)"/gm)].map((match) => ({
    names: (match[1] ?? match[2] ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    from: match[3],
  }));
  assert.ok(imports.length > 0, "no imports were found; the scan is broken");

  // web3.js is allowed only for address arithmetic.
  const web3 = imports.find((entry) => entry.from === "@solana/web3.js");
  assert.deepEqual(web3?.names, ["PublicKey"], "recovery imports more of web3.js than PublicKey");

  // Nothing at all from the harness's sending machinery.
  for (const entry of imports) {
    assert.ok(
      !entry.from.includes("transaction-lifecycle"),
      `recovery imports ${entry.from}, which exists to send transactions`,
    );
  }
});

test("3. the only RPC methods recovery names are reads", () => {
  const methods = [...CODE.matchAll(/call\("(\w+)"/g)].map((match) => match[1]);
  assert.ok(methods.length > 0, "no RPC methods were found; the scan is broken");
  for (const method of methods) {
    assert.ok(
      method.startsWith("get"),
      `recovery sends ${method}; only read methods (get*) are permitted`,
    );
  }
});

test("4. recovery requires no private key of any kind", () => {
  for (const secret of [
    "PPV_CUSTODY_FUNDER",
    "secretKey",
    "fromSecretKey",
    "funder-secret.mjs",
    "readFunderSecret",
    "loadFunderSecretOrThrow",
  ]) {
    assert.ok(!CODE.includes(secret), `recovery references ${secret}; it must need no signer material`);
  }
  // The one environment value it does read is the endpoint.
  const env = [...CODE.matchAll(/process\.env\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(env)], ["PPV_CUSTODY_RPC_URL"]);
});

/* ============================================ the diagnostic is an input */

test("5. a record that claims to be validation evidence is refused as input", () => {
  const path = join(REPO, "package.json"); // any readable JSON
  assert.throws(() => readDiagnostic(path), /is not a custody failure diagnostic/);
});

test("6. --diagnostic is required", () => {
  assert.throws(() => parseArguments([]), /--diagnostic <path> is required/);
  assert.throws(() => parseArguments(["--nonsense"]), /unknown option/);
  assert.deepEqual(parseArguments(["--diagnostic", "d.json", "--out", "o.json"]), {
    diagnostic: "d.json",
    out: "o.json",
    commit: null,
  });
});

/* ======================= successes and refusals, decided by the chain */

test("7. a success the chain never recorded fails", async () => {
  const { client } = stubClient({});
  await assert.rejects(
    () => verifySuccesses(client, [{ step: "ordinaryEscrow: settle", signature: SIGNATURE(1) }]),
    (error) => {
      assert.ok(error instanceof CustodyDefect);
      assert.match(error.message, /is not on chain/);
      return true;
    },
  );
});

test("8. a 'success' that landed carrying an error fails", async () => {
  const { client } = stubClient({ [SIGNATURE(1)]: landed({ InstructionError: [0, { Custom: 6003 }] }) });
  await assert.rejects(
    () => verifySuccesses(client, [{ step: "ordinaryEscrow: settle", signature: SIGNATURE(1) }]),
    /recorded it as a success/,
  );
});

test("9. a success that landed clean is accepted, with its slot", async () => {
  const { client } = stubClient({ [SIGNATURE(1)]: landed(null, 123) });
  assert.deepEqual(await verifySuccesses(client, [{ step: "fund", signature: SIGNATURE(1) }]), [
    { step: "fund", signature: SIGNATURE(1), onChain: true, err: null, slot: 123 },
  ]);
});

test("10. a refusal with no signature is infrastructure, not evidence", async () => {
  const { client } = stubClient({});
  await assert.rejects(
    () => verifyRefusals(client, [{ label: "outsider cannot settle", signature: null }]),
    (error) => {
      assert.ok(error instanceof CustodyHarnessFailure);
      assert.ok(!(error instanceof CustodyDefect), "a missing signature is not a custody defect");
      assert.match(error.message, /infrastructure gap, not a proven refusal/);
      return true;
    },
  );
});

test("11. a refusal whose signature is absent from chain proves nothing", async () => {
  const { client } = stubClient({});
  await assert.rejects(
    () => verifyRefusals(client, [{ label: "outsider cannot settle", signature: SIGNATURE(2) }]),
    /a refusal that did not land proves nothing/,
  );
});

test("12. a refusal that landed with NO error is a custody defect", async () => {
  const { client } = stubClient({ [SIGNATURE(2)]: landed(null) });
  await assert.rejects(
    () => verifyRefusals(client, [{ label: "outsider cannot settle", signature: SIGNATURE(2) }]),
    (error) => {
      assert.ok(error instanceof CustodyDefect, "the program accepting a forbidden instruction is a defect");
      assert.match(error.message, /accepted an instruction it must have refused/);
      return true;
    },
  );
});

test("13. a refusal that landed carrying an error is accepted", async () => {
  const err = { InstructionError: [0, { Custom: 6010 }] };
  const { client } = stubClient({ [SIGNATURE(2)]: landed(err) });
  const rows = await verifyRefusals(client, [
    { label: "outsider cannot settle", signature: SIGNATURE(2), errorCode: 6010 },
  ]);
  assert.deepEqual(rows, [
    { label: "outsider cannot settle", signature: SIGNATURE(2), onChain: true, err, errorCode: 6010, slot: 400_000_001 },
  ]);
});

test("14. lookupTransaction reports absence rather than inventing an outcome", async () => {
  const { client } = stubClient({});
  assert.deepEqual(await lookupTransaction(client, SIGNATURE(9)), {
    signature: SIGNATURE(9),
    found: false,
    err: null,
    slot: null,
  });
});

/* =============================================== the RR-6 criterion itself */

test("15. RR-6 names every lifecycle family, and each maps to a primary scenario", () => {
  assert.deepEqual(Object.keys(RR6_FAMILIES).sort(), [
    "bountySelection",
    "cancellation",
    "disputeToBuyer",
    "disputeToSeller",
    "funding",
    "milestoneRelease",
    "proofApproval",
    "refund",
    "settlement",
  ]);
  for (const [family, scenario] of Object.entries(RR6_FAMILIES)) {
    assert.ok(PRIMARY_SCENARIOS.includes(scenario), `${family} maps to ${scenario}, not a primary scenario`);
  }
  assert.deepEqual([...PRIMARY_SCENARIOS].sort(), [
    "bounty",
    "cancel",
    "disputeToBuyer",
    "disputeToSeller",
    "milestones",
    "ordinaryEscrow",
    "proofs",
    "refund",
  ]);
});

test("16. the proof-binding check cannot pass vacuously", async () => {
  // No reconstructed history binding a proof means nothing to verify, and
  // recovery refuses that rather than reporting zero bindings as a pass.
  await assert.rejects(
    () => verifyProofBindings({ accountInfo: async () => null }, new Map()),
    /must not pass vacuously/,
  );
  assert.match(CODE, /must not pass vacuously/);
});

test("17. recovery refuses to run without the dedicated endpoint", () => {
  assert.match(CODE, /DEDICATED_DEVNET_RPC=MISSING/);
  assert.ok(
    !CODE.includes("api.devnet.solana.com"),
    "recovery offers the shared public endpoint; there is deliberately no fallback",
  );
});

test("18. the recovered record states how it was produced", () => {
  for (const claim of [
    'recoveryMode: "READ_ONLY"',
    "liveMatrixExecuted: true",
    "liveMatrixRepeated: false",
    "valueMovingTransactionsSentDuringRecovery: 0",
  ]) {
    assert.ok(CODE.includes(claim), `the recovered record does not state ${claim}`);
  }
  // And it is scrubbed before it can be written.
  assert.match(CODE, /return assertNoSecrets\(record\);/);
});

/* ======================================================= PHASE R5 (19-27) */

/**
 * The escrow proof, the ppv_core record it minted, and the link between them.
 *
 * Recovery run 35474019085 passed R1–R4 against live chain state — every
 * primary scenario terminal, every primary vault 0, 43 refusals proved on
 * chain, both disposable fixtures at 0, all eight histories reconstructed —
 * and then failed in Phase R5 with
 *
 *     proof record CkQ2svTDYnKftVG36Ds12zfBwngakmAooLKro9QPKnLo
 *     is owned by ppv_escrow instead of ppv_core
 *
 * The question was right and the address was wrong.
 * `AgreementLifecycle.proofs[].proof` is the ESCROW-side Proof PDA and is
 * supposed to be owned by `ppv_escrow`. The record under `ppv_core` is a
 * different account, published by the escrow events themselves as `coreProof`.
 *
 * Nothing in the SDK or the indexer changed to accommodate this: the consumer
 * was reading one half of a relationship and asking the other half's question
 * of it.
 */

const ESCROW_ID = "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4";
const CORE_ID = "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU";
const PROOF_PDA = "CkQ2svTDYnKftVG36Ds12zfBwngakmAooLKro9QPKnLo";
const CORE_PROOF = "H4vMrZ8kLpQxNbWfDcJ2yTgAeRsUvXn6BmKt3PqZwYcE";

const proofEvent = (name, overrides = {}) => ({
  event: {
    program: "ppv_escrow",
    name,
    agreement: AGREEMENT_FOR_PROOFS,
    timestamp: 1_760_000_000,
    proof: PROOF_PDA,
    coreProof: CORE_PROOF,
    proofIndex: 0,
    ...overrides,
  },
  programId: ESCROW_ID,
  transactionSignature: SIGNATURE(3),
  slot: 400_000_010,
  instructionIndex: 0,
  innerInstructionIndex: 1,
  blockTime: 1_760_000_000,
});

const AGREEMENT_FOR_PROOFS = "5ZRmnSJVPKb9gWsDkL5jMiTkZwCmT2r1xHN8nJ2pQ4Vu";

/**
 * A chain whose two proof accounts are owned by whoever the test says.
 *
 * The escrow account's bytes are real: `decodeProofAccount` runs over them, so
 * a test that claimed a stored `coreProof` the encoding could not produce
 * would fail in the decoder rather than in the assertion.
 */
function proofChain({ escrowOwner = ESCROW_ID, coreOwner = CORE_ID, storedCoreProof = CORE_PROOF, missing = [] } = {}) {
  return {
    accountInfo: async (address) => {
      if (missing.includes(address)) return null;
      if (address === PROOF_PDA) {
        return { owner: escrowOwner, data: [encodeProofAccount(storedCoreProof), "base64"] };
      }
      if (address === CORE_PROOF) return { owner: coreOwner, data: ["", "base64"] };
      return null;
    },
  };
}

/** A `ppv_escrow` Proof account, byte for byte as the program lays it out. */
function encodeProofAccount(coreProof) {
  const discriminator = Buffer.from(PROOF_ACCOUNT_DISCRIMINATOR);
  const body = Buffer.alloc(2 + 32 + 32 + 32 + 4 + 1 + 8 + 8 + 32 + 32);
  let offset = 0;
  body.writeUInt8(1, offset); offset += 1; // schemaVersion
  body.writeUInt8(255, offset); offset += 1; // bump
  decodeBase58(AGREEMENT_FOR_PROOFS).forEach((byte, i) => (body[offset + i] = byte)); offset += 32;
  decodeBase58(coreProof).forEach((byte, i) => (body[offset + i] = byte)); offset += 32;
  decodeBase58(PROOF_PDA).forEach((byte, i) => (body[offset + i] = byte)); offset += 32; // submitter
  body.writeUInt32LE(0, offset); offset += 4; // proofIndex
  body.writeUInt8(1, offset); offset += 1; // status
  body.writeBigInt64LE(0n, offset); offset += 8; // createdAt
  body.writeBigInt64LE(0n, offset); offset += 8; // decidedAt
  offset += 32; // decidedBy
  offset += 32; // reserved
  return Buffer.concat([discriminator, body]).toString("base64");
}

const bindingsFrom = (...events) => collectProofBindings(new Map(), "proofs", events);

test("19. ProofRecord.proof is the ESCROW Proof PDA, and is expected to be escrow-owned", async () => {
  // The exact address run 35474019085 rejected, now accepted for the reason it
  // was rejected: ppv_escrow owning it is correct.
  const [row] = await verifyProofBindings(proofChain(), bindingsFrom(proofEvent("ProofSubmitted")));
  assert.equal(row.proof, PROOF_PDA);
  assert.equal(row.escrowOwner, ESCROW_ID);
  assert.notEqual(row.proof, row.coreProof);
});

test("20. the coreProof named by the event is the account checked against ppv_core", async () => {
  const [row] = await verifyProofBindings(proofChain(), bindingsFrom(proofEvent("ProofSubmitted")));
  assert.equal(row.coreProof, CORE_PROOF);
  assert.equal(row.coreOwner, CORE_ID);
  assert.equal(row.storedCoreProofMatchesEvent, true);
});

test("21. a coreProof owned by anything but ppv_core fails", async () => {
  for (const owner of [ESCROW_ID, "11111111111111111111111111111111"]) {
    await assert.rejects(
      () => verifyProofBindings(proofChain({ coreOwner: owner }), bindingsFrom(proofEvent("ProofSubmitted"))),
      (error) => {
        assert.ok(error instanceof CustodyDefect);
        assert.match(error.message, /not the permanent ppv_core/);
        return true;
      },
      `coreProof owned by ${owner} was accepted`,
    );
  }
});

test("22. an escrow proof owned by anything but ppv_escrow fails", async () => {
  for (const owner of [CORE_ID, "11111111111111111111111111111111"]) {
    await assert.rejects(
      () => verifyProofBindings(proofChain({ escrowOwner: owner }), bindingsFrom(proofEvent("ProofSubmitted"))),
      /not the permanent ppv_escrow/,
      `escrow proof owned by ${owner} was accepted`,
    );
  }
});

test("23. ProofSubmitted and a later decision disagreeing on coreProof fails", () => {
  // Refused while the binding is being built, before any account is read: a
  // conflicting pair is a finding, never a last-writer-wins overwrite.
  const other = "4XChfxgexHJ5EZ8ytcStSAZnC2htZsKFuaLgZ7ac69Wa";
  assert.throws(
    () => bindingsFrom(proofEvent("ProofSubmitted"), proofEvent("ProofApproved", { coreProof: other })),
    (error) => {
      assert.ok(error instanceof CustodyDefect);
      assert.match(error.message, /one escrow proof mints exactly one ppv_core record/);
      return true;
    },
  );
  // And in the other order, so neither event is privileged.
  assert.throws(
    () => bindingsFrom(proofEvent("ProofApproved"), proofEvent("ProofSubmitted", { coreProof: other })),
    /one escrow proof mints exactly one ppv_core record/,
  );
});

test("24. duplicate deliveries of the same event introduce no conflict", async () => {
  const bindings = bindingsFrom(
    proofEvent("ProofSubmitted"),
    proofEvent("ProofSubmitted"),
    proofEvent("ProofApproved"),
    proofEvent("ProofApproved"),
  );
  assert.equal(bindings.size, 1);
  const [row] = await verifyProofBindings(proofChain(), bindings);
  assert.deepEqual(row.decisions, ["ProofApproved"]);
});

test("25. a decision with no ProofSubmitted to establish the binding fails", async () => {
  await assert.rejects(
    () => verifyProofBindings(proofChain(), bindingsFrom(proofEvent("ProofApproved"))),
    /no ProofSubmitted event established its ppv_core binding/,
  );
});

test("25b. an event missing either side of the relationship fails", () => {
  assert.throws(() => bindingsFrom(proofEvent("ProofSubmitted", { proof: "" })), /names no escrow proof/);
  assert.throws(() => bindingsFrom(proofEvent("ProofSubmitted", { coreProof: "" })), /names no coreProof/);
});

test("26. recovery can never substitute proof for coreProof", async () => {
  // The substitution the old defect amounted to: asking ppv_core about the
  // escrow PDA. Refused explicitly rather than left to the owner check.
  await assert.rejects(
    () =>
      verifyProofBindings(proofChain(), bindingsFrom(proofEvent("ProofSubmitted", { coreProof: PROOF_PDA }))),
    /names itself as its ppv_core record; recovery must never substitute one for the other/,
  );
});

test("26b. a missing account on either side fails", async () => {
  await assert.rejects(
    () => verifyProofBindings(proofChain({ missing: [PROOF_PDA] }), bindingsFrom(proofEvent("ProofSubmitted"))),
    /escrow proof account .* does not exist on chain/,
  );
  await assert.rejects(
    () => verifyProofBindings(proofChain({ missing: [CORE_PROOF] }), bindingsFrom(proofEvent("ProofSubmitted"))),
    /does not exist on chain/,
  );
});

test("26c. an escrow account storing a different coreProof than the event fails", async () => {
  const other = "4XChfxgexHJ5EZ8ytcStSAZnC2htZsKFuaLgZ7ac69Wa";
  await assert.rejects(
    () => verifyProofBindings(proofChain({ storedCoreProof: other }), bindingsFrom(proofEvent("ProofSubmitted"))),
    (error) => {
      assert.ok(error instanceof CustodyDefect);
      assert.match(error.message, /stores ppv_core record .* but its events published/);
      return true;
    },
  );
});

test("27. Phase R5 never asks ppv_core about lifecycle.proofs[].proof again", () => {
  // The structural guard on the exact defect. `proofAddresses` may still be
  // recorded — it is the escrow-side list and the record keeps it — but it
  // must not feed the ppv_core ownership check.
  const phaseR5 = CODE.slice(CODE.indexOf("export async function verifyProofBindings"));
  assert.ok(phaseR5.length > 0, "verifyProofBindings is gone; the scan is broken");
  assert.ok(
    !/proofAddresses/.test(phaseR5),
    "the ppv_core verification reads proofAddresses, which are escrow-side Proof PDAs",
  );
  // Each side's ownership check reads that side's account, proved by where
  // each check sits relative to each read. Anchored on code, not on comments:
  // CODE has comments stripped.
  const readEscrow = phaseR5.indexOf("accountInfo(row.proof)");
  const readCore = phaseR5.indexOf("accountInfo(row.coreProof)");
  const escrowVerdict = phaseR5.indexOf("ppv_escrow ${escrowOwner}");
  const coreVerdict = phaseR5.indexOf("ppv_core ${coreOwner}");
  for (const [name, index] of [
    ["accountInfo(row.proof)", readEscrow],
    ["accountInfo(row.coreProof)", readCore],
    ["the ppv_escrow verdict", escrowVerdict],
    ["the ppv_core verdict", coreVerdict],
  ]) {
    assert.ok(index >= 0, `${name} was not found in verifyProofBindings; the scan is broken`);
  }
  assert.ok(readEscrow < escrowVerdict, "the ppv_escrow verdict does not follow the escrow account read");
  assert.ok(
    escrowVerdict < readCore,
    "the escrow account is read after the ppv_core verdict; the two checks are crossed",
  );
  assert.ok(
    readCore < coreVerdict,
    "the ppv_core verdict does not follow the ppv_core account read — this is exactly run 35474019085",
  );
  // Both verdicts exist. The strings are split across lines in the source, so
  // they are matched by their template-literal tails rather than whole.
  assert.match(phaseR5, /not the permanent ` \+\s*`ppv_escrow \$\{escrowOwner\}/);
  assert.match(phaseR5, /not the permanent ` \+\s*`ppv_core \$\{coreOwner\}/);
  // And the stored-field cross-check that makes this more than two lookups.
  assert.match(phaseR5, /decodeProofAccount/);
  assert.match(phaseR5, /decoded\.coreProof !== row\.coreProof/);
});
