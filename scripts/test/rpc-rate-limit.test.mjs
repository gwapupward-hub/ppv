import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MAX_RETRIES,
  RATE_LIMIT_STATUS,
  REFUSED_MUTATING_METHODS,
  RETRYABLE_READ_METHODS,
  RPC_RATE_LIMIT,
  RpcError,
  RpcRateLimitError,
  parseRetryAfter,
  rateLimitDelayMs,
  rpc,
} from "../lib/rpc.mjs";
import { snapshotBalances } from "../lib/custody-runner.mjs";
import { REPO } from "./helpers.mjs";

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bounded handling of HTTP 429 on the read-only JSON-RPC client.
 *
 * Run 35405785493 reached execute mode, created its disposable wallets, mints
 * and token accounts, and then died on the first `getMultipleAccounts` of the
 * scenario matrix with HTTP 429. `@solana/web3.js` had already absorbed several
 * 429s during setup; this repository's own client had no handling at all and
 * threw on the first one. No PPV agreement existed, no vault was created, and
 * nothing entered custody — so the failure was the endpoint's rate limiter,
 * reported as though the run had found something.
 *
 * Every delay here is injected. No test in this file sleeps.
 */

/* ------------------------------------------------------------- a stub endpoint */

/**
 * More requests than any bounded policy could justify for a single call.
 *
 * Comfortably above `RATE_LIMIT_MAX_RETRIES + 1`, so raising the ceiling by a
 * sane amount is caught by the exact assertions rather than by this, and low
 * enough that a loop with no ceiling at all trips it at once.
 */
const REQUEST_CAP = 50;

/**
 * A fetch that plays a fixed script of responses.
 *
 * Each entry is `{ status }` plus optionally `headers` and `body`. The recorded
 * `requests` let a test assert how many times the client actually went out,
 * which is the property that distinguishes a bounded retry from a loop.
 */
function scriptedFetch(script) {
  const requests = [];
  let index = 0;
  const fetchImpl = async (endpoint, init) => {
    // The stub refuses to be asked forever.
    //
    // A deadline alone cannot catch an unbounded retry here: the injected sleep
    // resolves as a microtask, so a runaway loop never yields to the event loop
    // and no timer — not the test runner's — ever fires. It hangs rather than
    // fails. A hard cap in the endpoint turns that into an ordinary assertion
    // failure on the first request past any plausible policy.
    if (requests.length >= REQUEST_CAP) {
      throw new Error(
        `the client made more than ${REQUEST_CAP} requests for one call; the retry ceiling is gone`,
      );
    }
    requests.push({ endpoint, body: init.body });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return {
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      headers: { get: (name) => step.headers?.[name.toLowerCase()] ?? null },
      json: async () => step.body ?? { result: "ok" },
    };
  };
  return { fetchImpl, requests, attempts: () => requests.length };
}

/** A client whose sleeps are recorded rather than taken. */
function client(script, overrides = {}) {
  const stub = scriptedFetch(script);
  const waits = [];
  return {
    ...stub,
    waits,
    rpc: rpc("http://127.0.0.1:1/ppv-test", {
      fetchImpl: stub.fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      // `random: () => 1` puts equal jitter at the top of its range, which is
      // exactly the documented backoff schedule. Every delay below is therefore
      // an assertion about the policy, not about a coin flip.
      random: () => 1,
      now: () => Date.parse("2026-09-19T00:00:00Z"),
      ...overrides,
    }),
  };
}

/**
 * Every 429 test carries a deadline.
 *
 * All delays here are injected, so these finish in milliseconds; the deadline
 * exists for the one bug it is impossible to catch any other way. An unbounded
 * retry loop against a stub that always answers 429 never returns, and a test
 * that hangs is not a failing test — it is a CI job that times out twenty
 * minutes later with nothing to read. Removing the ceiling in `rpc.mjs` must
 * turn this file red, not quiet.
 */
const RETRY_DEADLINE = Object.freeze({ timeout: 10_000 });

const RATE_LIMITED = { status: RATE_LIMIT_STATUS };
const OK = { status: 200, body: { result: { value: [] } } };

/* -------------------------------------------------------- 1. 429 then success */

test("getMultipleAccounts survives a single 429 and returns the success", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED, OK]);
  const result = await c.rpc.call("getMultipleAccounts", [["addr"], { encoding: "base64" }]);
  assert.deepEqual(result, { value: [] });
  assert.equal(c.attempts(), 2, "one retry, not more");
  assert.deepEqual(c.waits, [RATE_LIMIT_BACKOFF_MS[0]]);
});

/* ------------------------------------------------- 2. bounded, doubling backoff */

test("repeated 429s back off by doubling, and stop at the ceiling", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, OK]);
  await c.rpc.call("getMultipleAccounts", [["addr"]]);
  assert.equal(c.attempts(), 5, "the initial request plus four retries");
  assert.deepEqual(c.waits, [...RATE_LIMIT_BACKOFF_MS]);
  assert.equal(c.waits.length, RATE_LIMIT_MAX_RETRIES);
});

test("equal jitter keeps every delay inside half the documented base and the base", RETRY_DEADLINE, async () => {
  for (const r of [0, 0.5, 1]) {
    const c = client([RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, OK], {
      random: () => r,
    });
    await c.rpc.call("getMultipleAccounts", [["addr"]]);
    c.waits.forEach((wait, index) => {
      const base = RATE_LIMIT_BACKOFF_MS[index];
      assert.ok(wait >= base / 2 && wait <= base, `retry ${index + 1}: ${wait}ms outside [${base / 2}, ${base}]`);
    });
  }
});

/* ------------------------------------------------------ 3. Retry-After honoured */

test("a sane numeric Retry-After takes precedence over the schedule", RETRY_DEADLINE, async () => {
  const c = client([{ status: RATE_LIMIT_STATUS, headers: { "retry-after": "2" } }, OK]);
  await c.rpc.call("getMultipleAccounts", [["addr"]]);
  assert.deepEqual(c.waits, [2000], "the endpoint's own window must win over ours");
});

test("an HTTP-date Retry-After is honoured relative to now", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  assert.equal(parseRetryAfter("Sat, 19 Sep 2026 00:00:03 GMT", { now }), 3000);
  // Already in the past: retry immediately rather than waiting a negative time.
  assert.equal(parseRetryAfter("Sat, 19 Sep 2026 00:00:00 GMT", { now }), 0);
  assert.equal(parseRetryAfter("Fri, 18 Sep 2026 23:59:00 GMT", { now }), 0);
});

test("an absurd Retry-After is capped, not obeyed", RETRY_DEADLINE, async () => {
  const c = client([{ status: RATE_LIMIT_STATUS, headers: { "retry-after": "3600" } }, OK]);
  await c.rpc.call("getMultipleAccounts", [["addr"]]);
  assert.deepEqual(c.waits, [RATE_LIMIT_MAX_DELAY_MS], "an hour is not something to sit through in CI");
});

test("an unparseable or negative Retry-After falls back to the schedule", RETRY_DEADLINE, async () => {
  for (const header of ["soon", "-5", "", "  ", "NaN", "2 seconds"]) {
    assert.equal(parseRetryAfter(header), null, `${JSON.stringify(header)} was treated as sane`);
    const c = client([{ status: RATE_LIMIT_STATUS, headers: { "retry-after": header } }, OK]);
    await c.rpc.call("getMultipleAccounts", [["addr"]]);
    assert.deepEqual(c.waits, [RATE_LIMIT_BACKOFF_MS[0]], `${JSON.stringify(header)} changed the delay`);
  }
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
});

/* --------------------------------------------------------- 4. retry exhaustion */

test("exhausted retries fail hard, classified as a rate limit", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED]);
  await assert.rejects(
    () => c.rpc.call("getMultipleAccounts", [["addr"]]),
    (error) => {
      assert.ok(error instanceof RpcRateLimitError, `got ${error?.name}`);
      assert.ok(error instanceof RpcError, "it must still be an RpcError for existing handlers");
      assert.equal(error.classification, RPC_RATE_LIMIT);
      assert.match(error.message, /getMultipleAccounts failed with HTTP 429 after 5 attempts/);
      assert.match(error.message, /RPC_RATE_LIMIT/);
      assert.match(error.message, /not about the deployed program/);
      return true;
    },
  );
  assert.equal(c.attempts(), RATE_LIMIT_MAX_RETRIES + 1, "the ceiling must bound the attempts");
});

/**
 * The tamper case for the ceiling.
 *
 * An accidental infinite retry is the failure mode that would look like a hang
 * in a live run rather than like a bug in a test, so it is asserted against a
 * stub that would answer 429 forever. If the loop ever stops being bounded this
 * test does not fail — it never returns — so it carries its own deadline.
 */
test("an endpoint that answers 429 forever still terminates", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED]);
  await assert.rejects(() => c.rpc.call("getMultipleAccounts", [["addr"]]), RpcRateLimitError);
  assert.ok(
    c.attempts() <= RATE_LIMIT_MAX_RETRIES + 1,
    `${c.attempts()} requests against an endpoint that never stops saying 429`,
  );
});

/* ------------------------------------------------- 5-6. other statuses: no retry */

test("HTTP 400 is not retried", RETRY_DEADLINE, async () => {
  const c = client([{ status: 400 }]);
  await assert.rejects(
    () => c.rpc.call("getMultipleAccounts", [["addr"]]),
    (error) => {
      assert.ok(error instanceof RpcError);
      assert.ok(!(error instanceof RpcRateLimitError));
      assert.match(error.message, /getMultipleAccounts failed with HTTP 400/);
      return true;
    },
  );
  assert.equal(c.attempts(), 1, "a malformed request repeated is still malformed");
  assert.deepEqual(c.waits, []);
});

test("HTTP 401 and 403 are not retried", RETRY_DEADLINE, async () => {
  for (const status of [401, 403]) {
    const c = client([{ status }]);
    await assert.rejects(() => c.rpc.call("getMultipleAccounts", [["addr"]]), RpcError);
    assert.equal(c.attempts(), 1, `HTTP ${status} was retried`);
    assert.deepEqual(c.waits, []);
  }
});

test("5xx is left alone by this patch, deliberately", RETRY_DEADLINE, async () => {
  // Not broadened without evidence: some endpoints answer 5xx for a request
  // they will never run, and retrying those buys nothing but latency.
  for (const status of [500, 502, 503]) {
    const c = client([{ status }]);
    await assert.rejects(() => c.rpc.call("getAccountInfo", ["addr"]), RpcError);
    assert.equal(c.attempts(), 1, `HTTP ${status} was retried`);
  }
});

/* ------------------------------------------------------- 7. success costs nothing */

test("a first-attempt success neither sleeps nor repeats", async () => {
  const c = client([OK]);
  await c.rpc.call("getMultipleAccounts", [["addr"]]);
  assert.equal(c.attempts(), 1);
  assert.deepEqual(c.waits, [], "a healthy endpoint must not pay for the retry policy");
});

/* ------------------------------------------- 8. JSON-RPC errors still fail closed */

test("a JSON-RPC error in a 200 response is not retried and still throws", async () => {
  const c = client([{ status: 200, body: { error: { message: "Invalid param: bad address" } } }]);
  await assert.rejects(
    () => c.rpc.call("getMultipleAccounts", [["addr"]]),
    (error) => {
      assert.ok(error instanceof RpcError);
      assert.ok(!(error instanceof RpcRateLimitError));
      assert.match(error.message, /getMultipleAccounts failed: Invalid param/);
      return true;
    },
  );
  assert.equal(c.attempts(), 1, "a protocol-level error is an answer, not a rate limit");
});

/* ------------------------------------------------------ 9. nothing leaks outward */

test("no error carries the request body, the params or the response text", RETRY_DEADLINE, async () => {
  const secretish = "PPV-SENTINEL-NOT-A-KEY-9f3a2b";
  const cases = [
    [RATE_LIMITED, /HTTP 429/],
    [{ status: 400 }, /HTTP 400/],
    [{ status: 200, body: { error: { message: "upstream said no" } } }, /failed:/],
  ];
  for (const [step, expected] of cases) {
    const c = client([step]);
    const error = await c.rpc.call("getMultipleAccounts", [[secretish], { encoding: "base64" }]).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error, "the call should have failed");
    assert.match(error.message, expected);
    const surface = `${error.message}\n${error.stack}`;
    assert.ok(!surface.includes(secretish), "a parameter reached the error");
    assert.ok(!surface.includes("jsonrpc"), "the request body reached the error");
    assert.ok(!surface.includes("\"method\""), "the serialized request reached the error");
    // The body really did contain it, so the assertion above is not vacuous.
    assert.ok(c.requests[0].body.includes(secretish));
  }
});

/* ------------------------------ 10. value-moving sends inherit none of this */

test("the read client refuses to send a transaction at all", async () => {
  for (const method of REFUSED_MUTATING_METHODS) {
    const c = client([OK]);
    await assert.rejects(
      () => c.rpc.call(method, ["base64tx"]),
      (error) => {
        assert.ok(error instanceof RpcError);
        assert.match(error.message, /not available on the read-only RPC client/);
        assert.match(error.message, /value-moving transaction twice/);
        return true;
      },
    );
    assert.equal(c.attempts(), 0, `${method} reached the network`);
  }
  assert.ok(REFUSED_MUTATING_METHODS.includes("sendTransaction"));
});

test("no mutating method is on the retry allowlist", () => {
  for (const method of RETRYABLE_READ_METHODS) {
    assert.match(method, /^get/, `${method} is not a getter and must not be auto-retried`);
  }
  for (const method of REFUSED_MUTATING_METHODS) {
    assert.ok(!RETRYABLE_READ_METHODS.includes(method), `${method} is retryable`);
  }
});

test("a method nobody allowlisted gets zero retries rather than the benefit of the doubt", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED]);
  await assert.rejects(() => c.rpc.call("getSomethingNewNobodyAudited", []), RpcRateLimitError);
  assert.equal(c.attempts(), 1, "an unaudited method must not retry");
  assert.deepEqual(c.waits, []);
});

test("the value-moving path does not go through this client", () => {
  const runner = readFileSync(join(REPO, "scripts", "lib", "custody-runner.mjs"), "utf8");
  // Sends are web3.js, and web3.js is constructed from a Connection the read
  // client knows nothing about. If this ever changes, the retry policy above
  // stops being safe and this assertion is the thing that says so.
  assert.match(runner, /import \{ Transaction, sendAndConfirmTransaction \} from "@solana\/web3\.js";/);
  for (const sender of ["export async function send(", "export async function sendExpectingFailure("]) {
    const body = runner.slice(runner.indexOf(sender), runner.indexOf(sender) + 1200);
    assert.ok(body.length > 0, `${sender} was not found`);
    assert.ok(!body.includes("client.call"), `${sender} routes a send through the read client`);
    assert.ok(!/retr/i.test(body), `${sender} grew a retry; an ambiguous send must not be resent`);
  }
});

/* ----------------------------------------------- the failure run's exact call */

test("snapshotBalances, the call that failed in run 35405785493, now survives a 429", RETRY_DEADLINE, async () => {
  const token = Buffer.alloc(72);
  token.writeBigUInt64LE(4_200n, 64);
  const account = { data: [token.toString("base64"), "base64"] };

  const c = client([
    RATE_LIMITED,
    RATE_LIMITED,
    { status: 200, body: { result: { value: [account] } } },
  ]);
  const snapshot = await snapshotBalances(c.rpc, ["vault"]);
  assert.equal(snapshot.get("vault"), 4_200n);
  assert.equal(c.attempts(), 3);
  assert.deepEqual(c.waits, [RATE_LIMIT_BACKOFF_MS[0], RATE_LIMIT_BACKOFF_MS[1]]);
});

test("snapshotBalances still fails closed when the rate limit outlasts the retries", RETRY_DEADLINE, async () => {
  const c = client([RATE_LIMITED]);
  await assert.rejects(
    () => snapshotBalances(c.rpc, ["vault"]),
    (error) => {
      // Not a CustodyHarnessFailure and not an InvariantViolation: the
      // classification has to survive the call it failed inside, or the run
      // summary is back to guessing.
      assert.equal(error.name, "RpcRateLimitError");
      assert.equal(error.classification, RPC_RATE_LIMIT);
      return true;
    },
  );
});

/* ------------------------------------------------- against a real HTTP server */

/**
 * The same policy once more, over a real socket.
 *
 * The scripted fetch above proves the logic; this proves the logic survives an
 * actual `Response` — `headers.get` is case-insensitive, the body is a stream,
 * and an undrained 429 body does not wedge the next request.
 */
test("a real server that 429s twice then answers is handled end to end", RETRY_DEADLINE, async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (hits <= 2) {
        res.writeHead(429, { "Retry-After": "0", "content-type": "text/plain" });
        res.end("slow down");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { value: [] } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const waits = [];
    const live = rpc(`http://127.0.0.1:${server.address().port}`, {
      sleep: async (ms) => {
        waits.push(ms);
      },
      random: () => 1,
    });
    assert.deepEqual(await live.call("getMultipleAccounts", [["addr"]]), { value: [] });
    assert.equal(hits, 3);
    assert.deepEqual(waits, [0, 0], "Retry-After: 0 means retry now");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/* ------------------------------------------------------------ the policy itself */

test("the documented policy is one request and at most four retries", () => {
  assert.equal(RATE_LIMIT_MAX_RETRIES, 4);
  assert.deepEqual([...RATE_LIMIT_BACKOFF_MS], [500, 1000, 2000, 4000]);
  assert.equal(RATE_LIMIT_BACKOFF_MS.length, RATE_LIMIT_MAX_RETRIES);
  assert.ok(RATE_LIMIT_MAX_DELAY_MS >= RATE_LIMIT_BACKOFF_MS.at(-1));
  assert.equal(RATE_LIMIT_STATUS, 429);
  // Beyond the last entry the schedule holds rather than growing without end.
  assert.equal(rateLimitDelayMs(99, null, { random: () => 1 }), RATE_LIMIT_BACKOFF_MS.at(-1));
});

test("the harness names a terminal rate limit as infrastructure, not custody", () => {
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  assert.match(harness, /error instanceof RpcRateLimitError/);
  assert.match(harness, /CLASSIFICATION=\$\{RPC_RATE_LIMIT\}/);
  assert.match(harness, /not a defect, not an invariant violation/);

  // The rate-limit branch must come before, and be separate from, the custody
  // defect branch: a 429 must never print the "finding about the DEPLOYED
  // PROGRAM" notice.
  const rateLimit = harness.indexOf("error instanceof RpcRateLimitError");
  const defect = harness.indexOf("error instanceof CustodyDefect", rateLimit);
  assert.ok(rateLimit > -1 && defect > rateLimit);
  const branch = harness.slice(rateLimit, defect);
  assert.ok(!branch.includes("DEPLOYED PROGRAM"));
});

test("a short cooldown separates the setup burst from the first scenario read", () => {
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  const setup = harness.indexOf("  await setup(ctx);");
  const cooldown = harness.indexOf("await cooldownBeforeScenarios()", setup);
  assert.ok(setup > -1 && cooldown > setup, "the cooldown must follow setup, before the matrix");
  // Bounded and short on purpose: the fix is the 429 policy, not the sleep.
  const declared = Number(harness.match(/SCENARIO_COOLDOWN_MS = (\d+)/)?.[1]);
  assert.ok(declared >= 500 && declared <= 1000, `cooldown is ${declared}ms, outside 500-1000ms`);
});
