import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import {
  REDACTION,
  SAFE_ENDPOINT_LABEL,
  endpointFragments,
  looksLikeCredentialUrl,
  redact,
  registerSensitiveEndpoint,
  resetSensitiveEndpoints,
} from "../lib/endpoint-safety.mjs";
import { CustodyHarnessFailure, assertNoSecrets, describeError, requireDevnet, requireNoMainnetEndpoint } from "../lib/custody-runner.mjs";
import { MAINNET_GENESIS, RpcError, RpcRateLimitError, rpc, transportReason } from "../lib/rpc.mjs";
import { REPO } from "./helpers.mjs";

/**
 * A dedicated RPC endpoint is a credential, and this is what keeps it out of
 * the logs.
 *
 * The custody workflow used to read `https://api.devnet.solana.com`, a public
 * URL with nothing in it worth hiding, and the harness printed it freely — in
 * the mainnet refusal, in the genesis mismatch, and as `rpcEndpoint` in the
 * evidence record itself. A dedicated endpoint authenticates with a key inside
 * the URL, so every one of those became a way to publish it.
 *
 * Each test below plants the same unique token inside an endpoint and asserts
 * it does not come back out. The token is deliberately unlike anything the code
 * would produce on its own, so a match is a leak and never a coincidence.
 */

/** Distinctive enough that finding it anywhere in output means it leaked. */
const TOKEN = "PPVLEAKCANARY7f3a91c2";
const SECRET_ENDPOINT = `https://devnet-dedicated.example-rpc.invalid/v1/${TOKEN}?api-key=${TOKEN}`;

/**
 * Every fragment of the endpoint that would identify or authenticate it.
 *
 * Asserting against the fragments rather than the whole URL is the point: an
 * error almost never quotes a URL whole. A DNS failure names the host, a
 * provider names its path, a redirect names the origin.
 */
const LEAK_FRAGMENTS = Object.freeze([
  SECRET_ENDPOINT,
  TOKEN,
  "devnet-dedicated.example-rpc.invalid",
  `api-key=${TOKEN}`,
  `/v1/${TOKEN}`,
]);

function assertNoLeak(output, context) {
  for (const fragment of LEAK_FRAGMENTS) {
    assert.ok(
      !String(output).includes(fragment),
      `${context}: ${JSON.stringify(fragment)} reached the output\n--- output ---\n${output}`,
    );
  }
}

test.beforeEach(() => resetSensitiveEndpoints());
test.afterEach(() => resetSensitiveEndpoints());

/* ------------------------------------------------------------- the scrubber */

test("every identifying fragment of an endpoint is registered", () => {
  const fragments = endpointFragments(SECRET_ENDPOINT);
  for (const expected of [SECRET_ENDPOINT, TOKEN, "devnet-dedicated.example-rpc.invalid"]) {
    assert.ok(fragments.includes(expected), `${expected} was not registered`);
  }
  // Longest first, so redacting the host cannot leave a truncated href behind.
  const lengths = fragments.map((f) => f.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => b - a));
  // Short generic pieces are not registered: redacting "https" would turn every
  // message in the process into noise.
  assert.ok(!fragments.includes("https"));
  assert.ok(!fragments.includes("/"));
});

test("a registered endpoint is scrubbed out of text it never wrote", () => {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  const foreign = [
    `FetchError: request to ${SECRET_ENDPOINT} failed, reason: getaddrinfo ENOTFOUND`,
    `Error: connect ECONNREFUSED devnet-dedicated.example-rpc.invalid:443`,
    `failed to get balance for account: ${SECRET_ENDPOINT}`,
    `{"url":"${SECRET_ENDPOINT}"}`,
  ];
  for (const message of foreign) {
    const scrubbed = redact(message);
    assertNoLeak(scrubbed, "redact");
    assert.ok(scrubbed.includes(REDACTION), `nothing was redacted from: ${message}`);
  }
});

test("redaction is a no-op when nothing is registered, and never throws", () => {
  assert.equal(redact("plain text"), "plain text");
  assert.equal(redact(null), "");
  assert.equal(redact(undefined), "");
  assert.equal(redact(12), "12");
});

test("an endpoint that is not a URL is still registered verbatim", () => {
  registerSensitiveEndpoint(`not-a-url-${TOKEN}`);
  assertNoLeak(redact(`something went wrong with not-a-url-${TOKEN}`), "non-URL endpoint");
});

/* ------------------------------------------- what the repository's own messages say */

test("a malformed endpoint is refused without being quoted", () => {
  const malformed = `http://[${TOKEN}`;
  registerSensitiveEndpoint(malformed);
  assert.throws(
    () => rpc(malformed, { fetchImpl: null }),
    (error) => {
      assertNoLeak(`${error.message}\n${error.stack}`, "malformed endpoint");
      return true;
    },
  );
});

test("a mainnet-looking endpoint is refused by name, naming no endpoint", () => {
  const mainnetish = `https://mainnet-dedicated.example-rpc.invalid/v1/${TOKEN}?api-key=${TOKEN}`;
  registerSensitiveEndpoint(mainnetish);
  assert.throws(
    () => requireNoMainnetEndpoint(mainnetish),
    (error) => {
      assert.ok(error instanceof CustodyHarnessFailure);
      assert.match(error.message, /names mainnet/);
      assert.ok(error.message.includes(SAFE_ENDPOINT_LABEL), "the safe label must replace the URL");
      assertNoLeak(`${error.message}\n${error.stack}`, "mainnet refusal");
      return true;
    },
  );
});

test("a mainnet genesis hash is refused without naming the endpoint", async () => {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  const client = { endpoint: SECRET_ENDPOINT, genesisHash: async () => MAINNET_GENESIS };
  await assert.rejects(
    () => requireDevnet(client),
    (error) => {
      assert.match(error.message, /is mainnet-beta/);
      assertNoLeak(`${error.message}\n${error.stack}`, "genesis refusal");
      return true;
    },
  );
});

test("an unexpected genesis hash is refused without naming the endpoint", async () => {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  const client = { endpoint: SECRET_ENDPOINT, genesisHash: async () => "SomeOtherGenesisHash1111" };
  await assert.rejects(
    () => requireDevnet(client),
    (error) => {
      assertNoLeak(`${error.message}\n${error.stack}`, "unexpected genesis");
      return true;
    },
  );
});

/* ------------------------------------------- what the HTTP layer says, per status */

/** A client pointed at the secret endpoint, answering with a fixed status. */
function statusClient(step) {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  return rpc(SECRET_ENDPOINT, {
    sleep: async () => {},
    random: () => 1,
    fetchImpl: async () => ({
      status: step.status,
      ok: step.status >= 200 && step.status < 300,
      headers: { get: () => null },
      json: async () => step.body ?? {},
    }),
  });
}

for (const status of [400, 401, 403, 404, 500]) {
  test(`HTTP ${status} names the method and the status, never the endpoint`, async () => {
    const client = statusClient({ status });
    const error = await client.call("getMultipleAccounts", [["addr"]]).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof RpcError);
    assert.match(error.message, new RegExp(`HTTP ${status}`));
    assertNoLeak(`${error.message}\n${error.stack}`, `HTTP ${status}`);
  });
}

test("429 exhaustion names the method and the status, never the endpoint", async () => {
  const client = statusClient({ status: 429 });
  const error = await client.call("getMultipleAccounts", [["addr"]]).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof RpcRateLimitError);
  assert.match(error.message, /HTTP 429 after 5 attempts/);
  assertNoLeak(`${error.message}\n${error.stack}`, "429 exhaustion");
});

test("a JSON-RPC error inside a 200 does not carry the endpoint", async () => {
  const client = statusClient({ status: 200, body: { error: { message: "Invalid param" } } });
  const error = await client.call("getMultipleAccounts", [["addr"]]).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof RpcError);
  assert.match(error.message, /failed: Invalid param/);
  assertNoLeak(`${error.message}\n${error.stack}`, "JSON-RPC error");
});

/**
 * The transport failure is the one this repository does not write.
 *
 * undici puts the whole request — endpoint included — inside the error it
 * throws for a DNS or TLS failure, so the message is classified rather than
 * quoted, and the original is not chained: a `cause` is exactly what a future
 * `console.error(error)` would print.
 */
test("a transport failure is classified, not quoted", async () => {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  const client = rpc(SECRET_ENDPOINT, {
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.cause = Object.assign(
        new Error(`getaddrinfo ENOTFOUND devnet-dedicated.example-rpc.invalid (${SECRET_ENDPOINT})`),
        { code: "ENOTFOUND" },
      );
      throw error;
    },
  });
  const error = await client.call("getGenesisHash").then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof RpcError);
  assert.match(error.message, /could not reach the configured RPC endpoint/);
  assert.match(error.message, /the host could not be resolved/);
  assert.equal(error.cause, undefined, "chaining the cause would republish the request");
  assertNoLeak(`${error.message}\n${error.stack}`, "transport failure");
});

test("an unrecognised transport code still yields a safe generic reason", () => {
  assert.equal(transportReason(undefined), "the request failed before a response arrived");
  assert.equal(
    transportReason({ cause: { code: `WEIRD_${TOKEN}` } }),
    "the request failed before a response arrived",
  );
  assertNoLeak(transportReason({ message: SECRET_ENDPOINT }), "transportReason");
});

/* ---------------------------------------- what a dependency's error says, via describeError */

test("describeError scrubs a web3.js message that quotes the endpoint", () => {
  registerSensitiveEndpoint(SECRET_ENDPOINT);
  const error = Object.assign(
    new Error(`failed to send transaction: request to ${SECRET_ENDPOINT} failed`),
    { logs: [`Program log: endpoint ${SECRET_ENDPOINT}`] },
  );
  const described = describeError(error);
  assertNoLeak(described, "describeError");
  assert.ok(described.includes(REDACTION));
});

/* ------------------------------------------------------- what evidence may hold */

test("an evidence record carrying an RPC URL is refused, not trimmed", () => {
  assert.throws(
    () => assertNoSecrets({ cluster: "devnet", rpcEndpoint: SECRET_ENDPOINT }),
    (error) => {
      assert.ok(error instanceof CustodyHarnessFailure);
      assert.match(error.message, /URL carrying credentials or an opaque path/);
      assert.match(error.message, /names the cluster by genesis hash/);
      return true;
    },
  );
});

test("credential-shaped URLs are recognised, and plain public ones are not", () => {
  for (const credentialed of [
    SECRET_ENDPOINT,
    "https://user:pass@rpc.example.invalid/",
    "https://rpc.example.invalid/?api-key=abcdefgh",
    "https://rpc.example.invalid/0123456789abcdef",
  ]) {
    assert.ok(looksLikeCredentialUrl(credentialed), `${credentialed} was not recognised`);
  }
  for (const harmless of [
    "https://api.devnet.solana.com",
    "https://explorer.solana.com/tx",
    "7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4",
    "not a url at all",
    "",
  ]) {
    assert.ok(!looksLikeCredentialUrl(harmless), `${harmless} was wrongly flagged`);
  }
  // A base58 address must never be mistaken for a credential: evidence is full
  // of them and flagging one would make the record unwritable.
  assert.ok(!looksLikeCredentialUrl("GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46"));
});

test("the harness no longer writes the endpoint into the evidence record", () => {
  const harness = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  assert.ok(
    !/rpcEndpoint:\s*ctx\.endpoint/.test(harness),
    "the evidence record carries the endpoint again",
  );
  assert.match(harness, /genesisHash: preflightFacts\.genesis/);
});

/* ------------------------------------------- the harness, run end to end */

test("the harness fails closed when the dedicated endpoint is absent", async () => {
  const result = await runHarness({ PPV_CUSTODY_RPC_URL: "" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /DEDICATED_DEVNET_RPC=MISSING/);
  assert.ok(
    !/api\.devnet\.solana\.com/.test(`${result.stdout}${result.stderr}`),
    "the harness fell back to the shared public endpoint",
  );
});

test("the harness never prints the endpoint when it cannot be reached", async () => {
  const result = await runHarness({ PPV_CUSTODY_RPC_URL: SECRET_ENDPOINT });
  assert.equal(result.status, 1, "an unreachable endpoint must fail the run");
  assertNoLeak(`${result.stdout}\n${result.stderr}`, "harness against an unreachable endpoint");
});

test("the funder preflight never prints the endpoint when it cannot be reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppv-endpoint-safety-"));
  const keypairPath = join(dir, "funder.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const result = await runScript(join(REPO, "scripts", "funder-preflight.mjs"), {
    PPV_CUSTODY_RPC_URL: SECRET_ENDPOINT,
    PPV_CUSTODY_FUNDER: keypairPath,
  });
  assert.equal(result.status, 1);
  assertNoLeak(`${result.stdout}\n${result.stderr}`, "funder preflight against an unreachable endpoint");
});

test("the funder preflight fails closed without the dedicated endpoint", async () => {
  const result = await runScript(join(REPO, "scripts", "funder-preflight.mjs"), {
    PPV_CUSTODY_RPC_URL: "",
    PPV_CUSTODY_FUNDER: "/nonexistent/funder.json",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEDICATED_DEVNET_RPC=MISSING/);
});

function runHarness(env) {
  return runScript(join(REPO, "scripts", "devnet-escrow-custody.mjs"), env);
}

/**
 * Runs a script the way the workflow does.
 *
 * `spawn`, never `spawnSync`: `spawnSync` blocks this process's event loop, and
 * `scripts/test/helpers.mjs` records what that costs. The endpoint resolves to
 * `.invalid`, which is reserved by RFC 2606 and never resolves, so these tests
 * make no network request they could be blamed for.
 */
function runScript(script, env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} did not exit within ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
