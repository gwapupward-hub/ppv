import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { Keypair, SystemProgram } from "@solana/web3.js";

import {
  CLASSIFICATION,
  MAX_BLOCKHASH_RETRIES,
  SUBMISSION_PACING_MS,
  TransactionLifecycleError,
  assertProvenRefusal,
  confirmBySignature,
  extractOnChainErrorCode,
  isPreSubmissionBlockhashExpiry,
  isRateLimited,
  prepareTransaction,
  sendExpectingRefusal,
  sendExpectingSuccess,
} from "../lib/transaction-lifecycle.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The transaction lifecycle, exercised without a chain.
 *
 * Run 35430583241 reached almost the whole matrix and then reported
 *
 *     proofs: settle citing the approved proof was expected to succeed and did
 *     not: Simulation failed. Message: Transaction simulation failed:
 *     Blockhash not found. Logs: [].
 *
 * `Logs: []` means no instruction ran. The transaction was refused by
 * simulation, before broadcast, so `ppv_escrow` never saw it — yet the sentence
 * reads like a custody finding, because `sendAndConfirmTransaction` gave the
 * harness one way to describe every possible outcome.
 *
 * These tests are about the distinction that sentence was missing: what may be
 * retried (a blockhash that expired before submission, and nothing else), what
 * must be resolved rather than repeated (anything that might already be in
 * flight), and what may be called a refusal (a signature on chain carrying an
 * error, and nothing else).
 *
 * Every connection here is a stub. Nothing sleeps.
 */

const SIGNER = Keypair.generate();
const INSTRUCTIONS = [
  SystemProgram.transfer({ fromPubkey: SIGNER.publicKey, toPubkey: SIGNER.publicKey, lamports: 1 }),
];

/** The error web3.js raises when preflight rejects a stale blockhash. */
function simulationBlockhashError() {
  const error = new Error(
    "Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: \n[].",
  );
  error.logs = [];
  return error;
}

/**
 * A distinct, VALID base58 blockhash per call.
 *
 * It has to be real base58: `Transaction.serialize()` decodes
 * `recentBlockhash`, so a placeholder string fails inside the code under test
 * rather than in the stub, which is a confusing way to learn this.
 */
function freshBlockhash() {
  return Keypair.generate().publicKey.toBase58();
}

/**
 * A connection that records what it was asked to do.
 *
 * `blockhashes` counts how many times a fresh one was fetched, and `submits`
 * records every serialized submission — which is what distinguishes "resolved
 * the signature" from "sent it again".
 */
function stubConnection({ onSubmit = () => {}, blockhash = freshBlockhash } = {}) {
  const state = { blockhashes: 0, submits: [], options: [] };
  return {
    state,
    connection: {
      getLatestBlockhash: async () => {
        state.blockhashes += 1;
        return { blockhash: blockhash(state.blockhashes), lastValidBlockHeight: 1000 + state.blockhashes };
      },
      sendRawTransaction: async (raw, options) => {
        state.submits.push(raw);
        state.options.push(options);
        const result = onSubmit(state.submits.length, options);
        if (result instanceof Error) throw result;
        return "signature-from-node";
      },
    },
  };
}

/** A read client whose `getSignatureStatuses` plays a fixed script. */
function stubClient(statuses) {
  const state = { polls: 0 };
  const queue = [...statuses];
  return {
    state,
    client: {
      call: async (method, params) => {
        assert.equal(method, "getSignatureStatuses", `the lifecycle called ${method} on the read client`);
        assert.ok(Array.isArray(params?.[0]), "getSignatureStatuses takes an array of signatures");
        state.polls += 1;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return { value: [next ?? null] };
      },
    },
  };
}

const CONFIRMED_OK = { err: null, confirmationStatus: "confirmed", slot: 1 };
const CONFIRMED_FAILED = {
  err: { InstructionError: [0, { Custom: 6003 }] },
  confirmationStatus: "confirmed",
  slot: 1,
};

/** No real waiting, and no real deadline drift. */
const NO_WAIT = { wait: async () => {} };
const FAST_CONFIRM = { intervalMs: 0, timeoutMs: 0, wait: async () => {} };

const base = (overrides) => ({
  instructions: INSTRUCTIONS,
  signers: [SIGNER],
  label: "test transaction",
  pacingMs: 0,
  ...NO_WAIT,
  ...overrides,
});

/* ======================================================= SUCCESS PATH (1-8) */

test("1. a fresh blockhash is fetched immediately before signing", async () => {
  const { connection, state } = stubConnection();
  const { client } = stubClient([CONFIRMED_OK]);
  const prepared = await prepareTransaction({ connection, instructions: INSTRUCTIONS, signers: [SIGNER] });
  assert.equal(state.blockhashes, 1);
  assert.ok(prepared.blockhash, "the transaction carries a blockhash");
  assert.equal(prepared.lastValidBlockHeight, 1001, "lastValidBlockHeight travels with it");
  // The signature is known before anything is sent. This is what makes an
  // ambiguous submission resolvable rather than a guess.
  assert.equal(typeof prepared.signature, "string");
  assert.ok(prepared.signature.length >= 86);

  const outcome = await sendExpectingSuccess(base({ connection, client }));
  assert.equal(outcome.signature, prepared.signature.length ? outcome.signature : null);
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS);
});

test("2. a pre-submit BlockhashNotFound gets exactly one fresh-blockhash retry", async () => {
  const { connection, state } = stubConnection({
    onSubmit: (attempt) => (attempt === 1 ? simulationBlockhashError() : undefined),
  });
  const { client } = stubClient([CONFIRMED_OK]);
  const outcome = await sendExpectingSuccess(base({ connection, client }));
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS);
  assert.equal(state.submits.length, 2, "one retry, not more");
  assert.equal(state.blockhashes, 2, "the retry fetched a NEW blockhash rather than reusing the stale one");
  assert.notEqual(state.submits[0].toString("base64"), state.submits[1].toString("base64"));
});

test("3. a second BlockhashNotFound is terminal", async () => {
  const { connection, state } = stubConnection({ onSubmit: () => simulationBlockhashError() });
  const { client } = stubClient([CONFIRMED_OK]);
  await assert.rejects(
    () => sendExpectingSuccess(base({ connection, client })),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.PRE_SUBMISSION_BLOCKHASH_EXPIRED);
      assert.match(error.message, /never reached the program/);
      assert.match(error.message, /not about custody/);
      return true;
    },
  );
  // Two, absolutely: the initial attempt and one retry. Written as a literal
  // rather than as `MAX_BLOCKHASH_RETRIES + 1`, because a test that derives its
  // expectation from the constant it is guarding moves when the constant does
  // and proves nothing about the policy.
  assert.equal(state.submits.length, 2, "exactly one retry, then stop");
  assert.equal(MAX_BLOCKHASH_RETRIES, 1, "the documented ceiling is one retry");
});

test("4. a program error is never retried", async () => {
  const { connection, state } = stubConnection();
  const { client } = stubClient([CONFIRMED_FAILED]);
  await assert.rejects(
    () => sendExpectingSuccess(base({ connection, client, confirmOptions: FAST_CONFIRM })),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE);
      assert.equal(error.detail.errorCode.number, 6003);
      return true;
    },
  );
  assert.equal(state.submits.length, 1, "a program rejection must never be resent");
});

test("5. a generic transport error is never blindly retried", async () => {
  for (const message of ["fetch failed", "socket hang up", "ECONNRESET", "Server responded with 429"]) {
    const { connection, state } = stubConnection({ onSubmit: () => new Error(message) });
    const { client } = stubClient([null]);
    await assert.rejects(
      () => sendExpectingSuccess(base({ connection, client, confirmOptions: FAST_CONFIRM })),
      (error) => {
        assert.match(error.message, /was NOT resent/);
        return true;
      },
    );
    assert.equal(state.submits.length, 1, `${message} caused a resend`);
  }
});

test("6. a known signature is queried after an ambiguous submission", async () => {
  // The submit call blew up, but the transaction had in fact landed. Asking
  // the chain about the locally known signature is what turns that from a
  // failed run into a completed step.
  const { connection, state } = stubConnection({ onSubmit: () => new Error("socket hang up") });
  const { client, state: clientState } = stubClient([CONFIRMED_OK]);
  const outcome = await sendExpectingSuccess(base({ connection, client }));
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS);
  assert.equal(outcome.resolvedAfterAmbiguity, true);
  assert.ok(clientState.polls >= 1, "the signature was never looked up");
  assert.equal(state.submits.length, 1, "it was resolved, not resent");
});

test("7. confirmation never requires a websocket", async () => {
  // Run 35430583241 logged `ws error: Unexpected server response: 429` while
  // the matrix ran. A connection with no subscription methods at all must
  // still confirm.
  const { connection } = stubConnection();
  const { client } = stubClient([CONFIRMED_OK]);
  assert.equal(connection.onSignature, undefined);
  assert.equal(connection.confirmTransaction, undefined);
  const outcome = await sendExpectingSuccess(base({ connection, client }));
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS);

  // Scanned with comments stripped: the file's own docstring names these in
  // order to say it does not use them, and a check that cannot tell prose from
  // code would fail on the sentence promising the property it is testing.
  const lifecycle = readFileSync(join(REPO, "scripts", "lib", "transaction-lifecycle.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  for (const forbidden of ["onSignature", "onLogs", "onAccountChange", "confirmTransaction", "removeSignatureListener"]) {
    assert.ok(!lifecycle.includes(forbidden), `the lifecycle uses ${forbidden}, a websocket subscription`);
  }
});

test("8. a confirmed successful signature proceeds", async () => {
  const { connection } = stubConnection();
  const { client } = stubClient([CONFIRMED_OK]);
  const outcome = await sendExpectingSuccess(base({ connection, client }));
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS);
  assert.equal(outcome.confirmationStatus, "confirmed");
  assert.ok(outcome.signature);
});

test("a submitted transaction that never confirms is ambiguous, not a success", async () => {
  const { connection, state } = stubConnection();
  const { client } = stubClient([null]);
  await assert.rejects(
    () => sendExpectingSuccess(base({ connection, client, confirmOptions: FAST_CONFIRM })),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS);
      assert.match(error.message, /NOT resent/);
      assert.ok(error.signature, "the signature must be reported so it can be resolved by hand");
      return true;
    },
  );
  assert.equal(state.submits.length, 1);
});

test("web3.js is never allowed to rebroadcast on our behalf", async () => {
  const { connection, state } = stubConnection();
  const { client } = stubClient([CONFIRMED_OK]);
  await sendExpectingSuccess(base({ connection, client }));
  assert.equal(state.options[0].maxRetries, 0, "maxRetries must be pinned to 0");
  assert.equal(state.options[0].skipPreflight, false, "a success path keeps preflight");
});

/* ====================================================== NEGATIVE PATH (9-16) */

const refusal = (overrides) => base({ escrowProgramId: "PPVEscrow1111", ...overrides });

test("9. a landed signature with err != null is a valid refusal", async () => {
  const { connection, state } = stubConnection();
  const { client } = stubClient([CONFIRMED_FAILED]);
  const outcome = await sendExpectingRefusal(refusal({ connection, client }));
  assert.equal(outcome.onChain, true);
  assert.ok(outcome.signature);
  assert.deepEqual(outcome.err, CONFIRMED_FAILED.err);
  assert.equal(outcome.errorCode.number, 6003, "the code comes from the chain, not from prose");
  assert.equal(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE);
  assert.equal(state.options[0].skipPreflight, true, "a negative must actually reach the program");
});

test("10. a landed signature with err == null is a custody defect", async () => {
  const { connection } = stubConnection();
  const { client } = stubClient([CONFIRMED_OK]);
  await assert.rejects(
    () => sendExpectingRefusal(refusal({ connection, client })),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.CUSTODY_DEFECT);
      assert.match(error.message, /expected to be refused and SUCCEEDED on chain/);
      assert.ok(error.signature);
      return true;
    },
  );
});

test("11. no landed signature is an infrastructure failure, never a refusal", async () => {
  const { connection } = stubConnection();
  const { client } = stubClient([null]);
  await assert.rejects(
    () => sendExpectingRefusal(refusal({ connection, client, confirmOptions: FAST_CONFIRM })),
    (error) => {
      assert.equal(error.classification, CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS);
      assert.match(error.message, /did not land refuses nothing/);
      return true;
    },
  );
});

/**
 * 12-14. The three failures that used to be recorded as refusals.
 *
 * The old `sendExpectingFailure` caught essentially anything and returned it as
 * `result: "refused"`. Run 35430583241's negative suite ran while the endpoint
 * was answering 429s, which is exactly when that matters.
 */
for (const [name, message] of [
  ["12. HTTP 429", "Server responded with 429 Too Many Requests"],
  ["13. BlockhashNotFound", "Transaction simulation failed: Blockhash not found"],
  ["14. a DNS/transport failure", "fetch failed: getaddrinfo ENOTFOUND"],
]) {
  test(`${name} does not become a refusal`, async () => {
    const { connection } = stubConnection({ onSubmit: () => new Error(message) });
    const { client } = stubClient([null]);
    const outcome = await sendExpectingRefusal(
      refusal({ connection, client, confirmOptions: FAST_CONFIRM }),
    ).then(
      (value) => value,
      (error) => error,
    );
    assert.ok(outcome instanceof TransactionLifecycleError, `${name} returned a refusal record`);
    assert.notEqual(outcome.classification, CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE);
    assert.notEqual(outcome.classification, CLASSIFICATION.CUSTODY_DEFECT);
  });
}

test("15-16. every refusal evidence row carries a signature and proves it landed", () => {
  assert.throws(
    () => assertProvenRefusal({ label: "x", signature: null, onChain: true, err: {} }),
    /no transaction signature/,
  );
  assert.throws(
    () => assertProvenRefusal({ label: "x", signature: "sig", onChain: false, err: {} }),
    /not proved to have landed on chain/,
  );
  assert.throws(
    () => assertProvenRefusal({ label: "x", signature: "sig", onChain: true, err: null }),
    /landed without an error, which is a custody defect/,
  );
  const good = { label: "x", signature: "sig", onChain: true, err: { InstructionError: [0, { Custom: 1 }] } };
  assert.equal(assertProvenRefusal(good), good);
});

test("the harness cannot record a refusal without asking the chain", () => {
  const runner = readFileSync(join(REPO, "scripts", "lib", "custody-runner.mjs"), "utf8");
  // `attemptRefusal` must hand the read client down: without it there is no
  // getSignatureStatuses and therefore no proof.
  assert.match(runner, /sendExpectingFailure\(connection, instructions, signers, \{ label, client \}\)/);
  assert.match(runner, /assertProvenRefusal\(/);
  // The row carried into evidence must include the proof fields.
  for (const field of ["onChain: outcome.onChain", "err: outcome.err", "signature: outcome.signature"]) {
    assert.ok(runner.includes(field), `the refusal record omits ${field}`);
  }
});

test("a rate-limited log read does not demote a proven refusal", async () => {
  const { connection } = stubConnection();
  const { client } = stubClient([CONFIRMED_FAILED]);
  const outcome = await sendExpectingRefusal(
    refusal({
      connection,
      client,
      fetchLogs: async () => {
        throw new Error("Server responded with 429 Too Many Requests");
      },
    }),
  );
  // The hard requirement is already met — it landed carrying an error.
  assert.equal(outcome.onChain, true);
  assert.equal(outcome.programAttributed, "unverified", "and it says so rather than claiming more");
});

test("logs attribute the refusal to ppv_escrow when they can be read", async () => {
  const { connection } = stubConnection();
  const { client } = stubClient([CONFIRMED_FAILED]);
  const outcome = await sendExpectingRefusal(
    refusal({
      connection,
      client,
      fetchLogs: async () => ["Program PPVEscrow1111 invoke [1]", "Program PPVEscrow1111 failed"],
    }),
  );
  assert.equal(outcome.programAttributed, "ppv_escrow");
  assert.ok(Array.isArray(outcome.logs));
});

/* ============================================== FAILURE ARTIFACT (17-19) */

test("17. a failed live execution produces a public diagnostic", async () => {
  const harness = await import("../devnet-escrow-custody.mjs");
  const ctx = {
    runId: "abcd1234",
    commit: "deadbeef",
    scenarios: { ordinary: { agreement: "Agr1", vault: "Vault1", finalState: "Settled", signatures: [] } },
    negatives: [{ label: "n", signature: "sig", onChain: true, errorCode: { number: 6000 } }],
    watched: new Set(["Vault1"]),
    foreignAgreements: [{ label: "foreign-proof-source", agreement: "Agr2", vault: "Vault2" }],
  };
  const error = Object.assign(new Error("boom"), {
    classification: CLASSIFICATION.PRE_SUBMISSION_BLOCKHASH_EXPIRED,
    signature: "sig2",
  });
  const diagnostic = harness.buildFailureDiagnostic(ctx, error, { runId: "35430583241" });

  assert.equal(diagnostic.artifact, "ppv-escrow-devnet-custody-failure");
  assert.equal(diagnostic.isValidationEvidence, false);
  assert.equal(diagnostic.classification, CLASSIFICATION.PRE_SUBMISSION_BLOCKHASH_EXPIRED);
  assert.equal(diagnostic.workflowRunId, "35430583241");
  assert.equal(diagnostic.knownSignature, "sig2");
  assert.deepEqual(diagnostic.unfinishedFixtures, [
    { label: "foreign-proof-source", agreement: "Agr2", vault: "Vault2" },
  ]);
  assert.equal(diagnostic.lastCompletedPhase, "ordinary");
});

test("18. a diagnostic cannot contain secrets", async () => {
  const harness = await import("../devnet-escrow-custody.mjs");
  const keyShaped = Array.from({ length: 64 }, (_, i) => i);

  // Planted where the record actually carries structure through — the
  // per-scenario signature list — rather than somewhere the builder happens to
  // stringify. `assertNoSecrets` walks the finished record, so this is the
  // path a real mistake would take.
  assert.throws(
    () =>
      harness.buildFailureDiagnostic(
        {
          runId: "abcd",
          scenarios: { ordinary: { agreement: "A", vault: "V", signatures: keyShaped } },
          negatives: [],
          watched: new Set(),
        },
        new Error("x"),
      ),
    /key material|byte array|raw bytes/i,
  );

  // And a credential-bearing endpoint, which is the mistake this repository
  // already made once in the evidence record.
  assert.throws(
    () =>
      harness.buildFailureDiagnostic(
        {
          runId: "abcd",
          scenarios: { ordinary: { agreement: "https://rpc.example.invalid/?api-key=SECRET123" } },
          negatives: [],
          watched: new Set(),
        },
        new Error("x"),
      ),
    /URL carrying credentials/i,
  );
});

test("19. a diagnostic is never accepted as PASS evidence", () => {
  const workflow = readFileSync(
    join(REPO, ".github", "workflows", "devnet-escrow-custody-validation.yml"),
    "utf8",
  );
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");

  // Different directory, so the validation upload's glob cannot reach it.
  assert.match(harness, /"deployments", "diagnostics"/);
  assert.match(workflow, /path: deployments\/diagnostics\/\*\.json/);
  assert.match(workflow, /path: deployments\/validation\/\*\.json/);

  // Different artifact name, and the validation artifact only on success.
  assert.match(workflow, /name: ppv-escrow-devnet-custody-failure-diagnostic/);
  const validationUpload = workflow.slice(
    workflow.indexOf("- name: Upload the validation evidence"),
    workflow.indexOf("- name: Upload the failure diagnostic"),
  );
  assert.match(validationUpload, /if: \$\{\{ success\(\) && !inputs\.preflight_only \}\}/);

  // The diagnostic uploads whatever happened, which is the point.
  const diagnosticUpload = workflow.slice(workflow.indexOf("- name: Upload the failure diagnostic"));
  assert.match(diagnosticUpload, /if: \$\{\{ always\(\) && !inputs\.preflight_only \}\}/);

  // And the record announces what it is not.
  assert.match(harness, /isValidationEvidence: false/);
});

test("the publish guard scans diagnostics too, and rejects a credential URL", () => {
  const workflow = readFileSync(
    join(REPO, ".github", "workflows", "devnet-escrow-custody-validation.yml"),
    "utf8",
  );
  const guard = workflow.slice(
    workflow.indexOf("- name: Refuse to publish an artifact containing key material"),
    workflow.indexOf("- name: Require that a successful run produced evidence"),
  );
  assert.match(guard, /deployments\/validation\/\*\.json deployments\/diagnostics\/\*\.json/);
  assert.match(guard, /always\(\)/, "a failed run's diagnostic must be scanned before upload");
  // `-?` here is the workflow's own literal grep pattern, not regex syntax of
  // this assertion.
  assert.match(guard, /api-\?key\|token\|apikey/);
  assert.match(guard, /rpcEndpoint\|rpcUrl/);
});

/* ============================================== FOREIGN FIXTURE (20-21) */

test("20. the foreign proof source is wound down before the main settlement", () => {
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  const scenario = harness.slice(harness.indexOf("export async function scenarioProofs("));

  const created = scenario.indexOf('label: "foreign-proof-source"');
  const refunded = scenario.indexOf('label: "foreign-proof-source: refund"');
  const settled = scenario.indexOf('label: "proofs: settle citing the approved proof"');
  assert.ok(created > -1, "the foreign proof fixture is not created inside scenarioProofs");
  assert.ok(refunded > created, "it must be refunded after it is created");
  assert.ok(
    settled > refunded,
    "the foreign fixture must be emptied BEFORE the settlement that failed in run 35430583241",
  );

  // And it must no longer be opened at the top of the run, where a mid-matrix
  // failure stranded it.
  const runFn = harness.slice(harness.indexOf("export async function run({"));
  const beforeScenarios = runFn.slice(0, runFn.indexOf("await scenarioOrdinaryEscrow(ctx)"));
  assert.ok(
    !beforeScenarios.includes('label: "foreign-proof-source"'),
    "the funded foreign proof fixture is created before the scenarios again",
  );
});

test("21. its vault is explicitly checked at zero", () => {
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  const scenario = harness.slice(harness.indexOf("export async function scenarioProofs("));
  const check = scenario.indexOf("foreignVaultAfter");
  const settled = scenario.indexOf('label: "proofs: settle citing the approved proof"');
  assert.ok(check > -1, "nothing asserts the foreign vault is empty");
  assert.ok(check < settled, "the zero check must precede the main settlement");
  assert.match(scenario, /if \(foreignVaultAfter !== 0n\)/);
  assert.match(scenario, /CustodyDefect\(/);
});

/* ============================================================= classification */

test("only a pre-submission blockhash expiry is classified as retryable", () => {
  assert.ok(isPreSubmissionBlockhashExpiry(simulationBlockhashError()));
  assert.ok(isPreSubmissionBlockhashExpiry(new Error("failed to send transaction: Blockhash not found")));
  // A blockhash mentioned in any other context must not buy a resend.
  assert.ok(!isPreSubmissionBlockhashExpiry(new Error("block height exceeded")));
  assert.ok(!isPreSubmissionBlockhashExpiry(new Error("Transaction was not confirmed in 30s")));
  assert.ok(!isPreSubmissionBlockhashExpiry(new Error("custom program error: 0x1771")));
  assert.ok(!isPreSubmissionBlockhashExpiry(new Error("Server responded with 429")));
  assert.ok(!isPreSubmissionBlockhashExpiry(null));
});

test("a rate limit is recognised wherever the provider puts it", () => {
  assert.ok(isRateLimited(new Error("Server responded with 429 Too Many Requests")));
  assert.ok(isRateLimited(new Error("Too Many Requests")));
  assert.ok(!isRateLimited(new Error("fetch failed")));
});

test("the error code is read from the chain's structured status", () => {
  assert.deepEqual(extractOnChainErrorCode({ InstructionError: [0, { Custom: 6001 }] }), {
    name: null,
    number: 6001,
    kind: "Custom",
  });
  assert.deepEqual(extractOnChainErrorCode({ InstructionError: [1, "MissingRequiredSignature"] }), {
    name: "MissingRequiredSignature",
    number: null,
    kind: "MissingRequiredSignature",
  });
  assert.equal(extractOnChainErrorCode(null).number, null);
  assert.equal(extractOnChainErrorCode({ InsufficientFundsForRent: {} }).kind, "InsufficientFundsForRent");
});

test("confirmation polls rather than looking once, and gives up on a deadline", async () => {
  const { client, state } = stubClient([null, null, CONFIRMED_OK]);
  let clock = 0;
  const resolved = await confirmBySignature(client, "sig", {
    intervalMs: 1,
    timeoutMs: 100,
    now: () => (clock += 1),
    wait: async () => {},
  });
  assert.equal(resolved.found, true);
  assert.ok(state.polls >= 3, "it must keep asking while the node has not seen it");

  const { client: quiet } = stubClient([null]);
  const timedOut = await confirmBySignature(quiet, "sig", {
    intervalMs: 0,
    timeoutMs: 0,
    now: () => 1,
    wait: async () => {},
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.found, false);
});

test("the pacing between submissions is short and bounded", () => {
  assert.ok(SUBMISSION_PACING_MS > 0, "some pacing, so the burst is not maximal");
  assert.ok(
    SUBMISSION_PACING_MS <= 1000,
    `pacing is ${SUBMISSION_PACING_MS}ms; a long sleep hides a low-capacity endpoint rather than fixing it`,
  );
  assert.equal(MAX_BLOCKHASH_RETRIES, 1);
});
