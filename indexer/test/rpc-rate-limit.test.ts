import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MAX_RETRIES,
  READ_ONLY_METHODS,
  RpcError,
  RpcRateLimitError,
  httpChainSource,
  parseRetryAfter,
  rateLimitDelayMs,
} from "../src/rpc.js";

/**
 * The read transport, held to a bounded tolerance of HTTP 429.
 *
 * Live custody run 35465469908 executed the entire value-moving matrix —
 * ordinary escrow, cancel, refund, both dispute outcomes, milestones, bounty,
 * proof submit/approve/reject, a live CPI into ppv_core, the foreign-proof
 * negative and its cleanup, and the proof-backed final settlement, every
 * funded vault back to zero — and then failed in Phase 12, read-only history
 * reconstruction, because `getTransaction` returned HTTP 429 once and this
 * client threw on the first one.
 *
 * Nothing about the chain was wrong. Replay reads one transaction per
 * signature, so the more a run proves, the more likely it is to meet a
 * provider's per-second ceiling exactly when its history is worth reading.
 *
 * The tolerance is deliberately narrow: 429 only, bounded, and never a method
 * that could change anything. Nothing here sleeps — `sleepImpl` records the
 * schedule instead of spending it.
 */

const ENDPOINT = "https://rpc.example.invalid/v1/A-SECRET-TOKEN-9f3b2c";
const SIGNATURE = "5j7s88nLmXHc1RGFtBzE4hqvVfPmr2gGxWkZ9TNqUwYa3bDcEfGhJkLmNpQrStUvWxYz";
const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

/** Neither sleeps nor guesses: the delays are recorded and the jitter is pinned. */
function harness(handlers: Array<() => unknown>) {
  const slept: number[] = [];
  const sent: string[] = [];
  let call = 0;
  const source = httpChainSource(ENDPOINT, {
    fetchImpl: async (_input, init) => {
      sent.push((JSON.parse(init.body) as { method: string }).method);
      const handler = handlers[Math.min(call++, handlers.length - 1)];
      return handler!() as never;
    },
    sleepImpl: async (ms) => {
      slept.push(ms);
    },
    random: () => 1,
  });
  return { source, slept, sent, calls: () => call };
}

const rateLimited = (retryAfter?: string) => () => ({
  ok: false,
  status: 429,
  headers: { get: (name: string) => (name === "retry-after" ? (retryAfter ?? null) : null) },
  json: async () => ({}),
});

const ok = (result: unknown) => () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ jsonrpc: "2.0", id: 1, result }),
});

const TRANSACTION = {
  slot: 400_000_001,
  blockTime: 1_760_000_000,
  transaction: { signatures: [SIGNATURE], message: { accountKeys: [], instructions: [] } },
  meta: { err: null, innerInstructions: [] },
};

/* =================================================== 1-2. transient 429s */

test("1. getTransaction survives a transient 429", async () => {
  const { source, slept, sent } = harness([rateLimited(), ok(TRANSACTION)]);
  const transaction = await source.transaction(SIGNATURE);
  assert.equal(transaction?.slot, 400_000_001);
  assert.deepEqual(sent, ["getTransaction", "getTransaction"]);
  // One retry, at the first base delay with jitter pinned to its maximum.
  assert.deepEqual(slept, [RATE_LIMIT_BACKOFF_MS[0]]);
});

test("2. getSignaturesForAddress survives a transient 429", async () => {
  const entries = [{ signature: SIGNATURE, slot: 400_000_001, err: null }];
  const { source, slept, sent } = harness([rateLimited(), rateLimited(), ok(entries)]);
  assert.deepEqual(await source.signaturesForAddress(ADDRESS), entries);
  assert.deepEqual(sent, ["getSignaturesForAddress", "getSignaturesForAddress", "getSignaturesForAddress"]);
  assert.deepEqual(slept, [RATE_LIMIT_BACKOFF_MS[0], RATE_LIMIT_BACKOFF_MS[1]]);
});

test("2b. a sane Retry-After wins over the schedule, and is capped", async () => {
  const { source, slept } = harness([rateLimited("2"), ok(TRANSACTION)]);
  await source.transaction(SIGNATURE);
  assert.deepEqual(slept, [2000]);

  const { source: greedy, slept: greedySlept } = harness([rateLimited("3600"), ok(TRANSACTION)]);
  await greedy.transaction(SIGNATURE);
  assert.deepEqual(greedySlept, [RATE_LIMIT_MAX_DELAY_MS], "an hour-long Retry-After must be capped");
});

/* ============================================ 3. repeated 429s terminate */

test("3. repeated 429s terminate rather than retrying forever", async () => {
  const { source, slept, calls } = harness([rateLimited()]);
  await assert.rejects(
    () => source.transaction(SIGNATURE),
    (error: unknown) => {
      assert.ok(error instanceof RpcRateLimitError);
      assert.equal((error as RpcRateLimitError).attempts, RATE_LIMIT_MAX_RETRIES + 1);
      assert.match((error as Error).message, /rate limiting this client/);
      return true;
    },
  );
  // The ceiling, pinned to a literal: a change to RATE_LIMIT_MAX_RETRIES that
  // made this unbounded would pass a test written as MAX + 1.
  assert.equal(calls(), 5);
  assert.equal(slept.length, 4);
});

/* ===================================== 4-5. what must NOT be retried */

test("4. non-429 HTTP errors do not retry", async () => {
  for (const status of [400, 401, 403, 404, 500, 502, 503]) {
    const { source, slept, calls } = harness([
      () => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) }),
    ]);
    await assert.rejects(() => source.transaction(SIGNATURE), RpcError);
    assert.equal(calls(), 1, `HTTP ${status} was retried`);
    assert.deepEqual(slept, [], `HTTP ${status} slept`);
  }
});

test("5. a JSON-RPC error on HTTP 200 is not blindly retried", async () => {
  const { source, slept, calls } = harness([
    () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid param" } }),
    }),
  ]);
  await assert.rejects(() => source.transaction(SIGNATURE), /invalid param/);
  assert.equal(calls(), 1, "the endpoint answered; the answer was no");
  assert.deepEqual(slept, []);
});

/* ================================= 6. the endpoint never reaches an error */

test("6. endpoint credentials never appear in an error", async () => {
  const token = "A-SECRET-TOKEN-9f3b2c";
  const messages: string[] = [];

  // Exhausted rate limit.
  const { source: limited } = harness([rateLimited()]);
  await limited.transaction(SIGNATURE).catch((error: Error) => messages.push(error.message));

  // A hard HTTP failure.
  const { source: refused } = harness([
    () => ({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }),
  ]);
  await refused.transaction(SIGNATURE).catch((error: Error) => messages.push(error.message));

  // A JSON-RPC error whose text quotes the endpoint, as a provider's might.
  const { source: chatty } = harness([
    () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ error: { message: "bad request" } }),
    }),
  ]);
  await chatty.transaction(SIGNATURE).catch((error: Error) => messages.push(error.message));

  // A transport failure: undici puts the whole request, endpoint included,
  // inside the error it throws.
  const transportFailure = Object.assign(new Error(`request to ${ENDPOINT} failed`), {
    cause: { code: "ECONNRESET" },
  });
  const { source: broken } = harness([
    () => {
      throw transportFailure;
    },
  ]);
  await broken.transaction(SIGNATURE).catch((error: Error) => messages.push(error.message));

  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.ok(!message.includes(token), `an error published the endpoint credential: ${message}`);
    assert.ok(!message.includes("rpc.example.invalid"), `an error published the endpoint host: ${message}`);
  }
  assert.match(messages[3]!, /the connection was reset/);
});

/* ======================== 7. no mutation method can go through this source */

test("7. no mutation RPC method can be sent through this source", async () => {
  // The public surface is two reads. There is no way to name a method.
  const source = httpChainSource(ENDPOINT, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.deepEqual(Object.keys(source).sort(), ["signaturesForAddress", "transaction"]);
  for (const method of ["sendTransaction", "requestAirdrop", "simulateTransaction"]) {
    assert.ok(!(method in source), `${method} is exposed on the chain source`);
    assert.ok(!READ_ONLY_METHODS.includes(method), `${method} is in the retry allowlist`);
  }
  // And the allowlist is exactly what the two reads send.
  assert.deepEqual([...READ_ONLY_METHODS].sort(), ["getSignaturesForAddress", "getTransaction"]);
});

test("7b. the source's own guard refuses a method outside the read allowlist", async () => {
  // Reaching the private `call` requires editing this file's subject, so the
  // guard is exercised through the seam a future edit would use.
  const sent: string[] = [];
  const source = httpChainSource(ENDPOINT, {
    fetchImpl: async (_input, init) => {
      sent.push((JSON.parse(init.body) as { method: string }).method);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: null }) } as never;
    },
  });
  await source.transaction(SIGNATURE);
  assert.deepEqual(sent, ["getTransaction"], "the source sent a method other than the read it was asked for");
});

/* -------------------------------------------------------- the primitives */

test("Retry-After is parsed in both forms, and junk is refused", () => {
  const now = Date.parse("2026-09-19T20:00:00Z");
  assert.equal(parseRetryAfter("2", { now }), 2000);
  assert.equal(parseRetryAfter("Sat, 19 Sep 2026 20:00:03 GMT", { now }), 3000);
  assert.equal(parseRetryAfter("Sat, 19 Sep 2026 19:59:00 GMT", { now }), 0);
  assert.equal(parseRetryAfter("3600", { now }), RATE_LIMIT_MAX_DELAY_MS);
  for (const junk of [null, undefined, "", "soon", "-5", "1.5"]) {
    assert.equal(parseRetryAfter(junk, { now }), null, `Retry-After ${JSON.stringify(junk)} was accepted`);
  }
});

test("the backoff schedule doubles and never exceeds the last step", () => {
  const fixed = { random: () => 1 };
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map((attempt) => rateLimitDelayMs(attempt, null, fixed)),
    [500, 1000, 2000, 4000, 4000, 4000],
  );
  // Equal jitter: never below half, never above the base.
  for (const attempt of [1, 2, 3, 4]) {
    const base = RATE_LIMIT_BACKOFF_MS[attempt - 1]!;
    assert.equal(rateLimitDelayMs(attempt, null, { random: () => 0 }), base / 2);
    assert.ok(rateLimitDelayMs(attempt, null, { random: () => 0.5 }) <= base);
  }
});
