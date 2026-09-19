import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CustodyDefect, CustodyHarnessFailure } from "../lib/custody-runner.mjs";
import {
  PRIMARY_SCENARIOS,
  RR6_FAMILIES,
  lookupTransaction,
  parseArguments,
  readDiagnostic,
  replayProofAddresses,
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

test("16. the proof-record check cannot pass vacuously", () => {
  // No reconstructed history naming a proof means no addresses to verify, and
  // `recover` refuses that rather than reporting zero records as a pass.
  assert.deepEqual(replayProofAddresses({ ordinaryEscrow: { proofAddresses: [] } }), []);
  assert.match(CODE, /proofAddresses\.length === 0/);
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
