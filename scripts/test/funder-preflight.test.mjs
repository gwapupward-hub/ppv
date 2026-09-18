import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import { REPO } from "./helpers.mjs";

/**
 * The funder preflight, executed rather than grepped.
 *
 * This is the step nobody wants to debug by re-running: the live custody
 * execution is authorized one run at a time, and this step is where the one PPV
 * secret the workflow takes is handled. It used to live inline in the YAML as a
 * `node -e` script, which its test had to regex-dedent back out before it could
 * run anything. It is a file now, and this suite runs that file — against a
 * local stub that answers `getBalance`.
 *
 * A syntax error, a wrong comparison, or a secret reaching a log fails on a
 * pull request instead of burning an authorized run.
 *
 * The leak this suite exists for: in run 35393227976 the preflight printed
 * `JSON.parse`'s error message, and that message quotes the first ten
 * characters of whatever it rejected. So the assertions are not "malformed
 * input fails" — they are "when malformed input fails, no run of four or more
 * of its characters appears in stdout or stderr".
 */

const PREFLIGHT = join(REPO, "scripts", "funder-preflight.mjs");

/** A stub that answers getBalance with a fixed lamport count. */
async function stubRpc(lamports) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: method === "getBalance" ? { context: { slot: 1 }, value: lamports } : null,
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    // `close()` alone waits for keep-alive sockets the client is holding open,
    // which would leave this test process running after its last assertion.
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * Runs the preflight exactly as the workflow does: `node scripts/funder-preflight.mjs`
 * from the repository root.
 *
 * Two details, each of which cost a debugging round when this suite ran the
 * inline form:
 *
 *   * `spawn`, never `spawnSync`. `spawnSync` blocks this process's event loop,
 *     so the stub server never gets to answer the request the child is waiting
 *     on, and the child appears to hang — a false failure that looks exactly
 *     like a real one. `scripts/test/helpers.mjs` records the same trap.
 *   * stdout and stderr are collected as they arrive rather than after exit, so
 *     a child that does hang still reports what it managed to print.
 *
 * Keypairs are generated per fixture and thrown away with the temp directory.
 * None is ever a real funder.
 */
function runPreflight({ keypairPath, rpcUrl, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PREFLIGHT], {
      cwd: REPO,
      env: {
        ...process.env,
        PPV_CUSTODY_FUNDER: keypairPath,
        PPV_CUSTODY_RPC_URL: rpcUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`funder preflight did not exit within ${timeoutMs}ms\n${stdout}\n${stderr}`));
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ppv-funder-preflight-"));
  const keypair = Keypair.generate();
  const keypairPath = join(dir, "funder.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
  return { dir, keypair, keypairPath };
}

/** The shortest run of input characters we treat as a leak. */
const LEAK_WINDOW = 4;

function noFragmentLeaked(output, input, context) {
  for (let i = 0; i + LEAK_WINDOW <= input.length; i += 1) {
    const window = input.slice(i, i + LEAK_WINDOW);
    assert.ok(
      !output.includes(window),
      `${context}: the fragment ${JSON.stringify(window)} from the supplied secret reached the log`,
    );
  }
}

/**
 * The shapes a mis-set `PPV_CUSTODY_FUNDER_KEYPAIR` actually takes.
 *
 * Fixed strings rather than generated ones, so `noFragmentLeaked` is
 * deterministic: a random base58 blob could, once in a great while, share a
 * four-character run with the constant error message and fail for a reason
 * that has nothing to do with the code.
 */
const MALFORMED = Object.freeze({
  "a base58-looking private key string": "gWapUpwardFixtureNotAKeyJustNoiseWithTheBase58Shape",
  // Leading digit, which `JSON.parse` starts to read as a number before it
  // gives up — a different rejection path through the same function.
  "a base58 string that starts with a digit": "3zzPPVnotARealKeyJustBase58AlphabetNoiseForThisTest1",
  "malformed JSON": "[12, 34, 56",
  "a JSON object instead of an array": '{"secretKey":[1,2,3],"publicKey":"9xQeWvG8"}',
  "an out-of-range byte": JSON.stringify([...Array(63).fill(7), 256]),
  "a truncated array": JSON.stringify(Array(32).fill(7)),
});

/** The constant the preflight is allowed to print, and the only one. */
const FORMAT_ERROR =
  "::error::PPV_CUSTODY_FUNDER_KEYPAIR has invalid format; expected a Solana keypair JSON byte array";

/* ------------------------------------------------------------ the happy path */

test("a funder above the floor passes and reports its public address", async () => {
  const { keypair, keypairPath } = fixture();
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({ keypairPath, rpcUrl: rpc.url });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`funder public address: ${keypair.publicKey.toBase58()}`));
    assert.match(result.stdout, /funder devnet balance: 1\.5 SOL/);
  } finally {
    rpc.close();
  }
});

test("a funder below the floor fails, naming the shortfall", async () => {
  const { keypairPath } = fixture();
  const rpc = await stubRpc(500_000_000);
  try {
    const result = await runPreflight({ keypairPath, rpcUrl: rpc.url });
    assert.equal(result.status, 1, "an underfunded funder must stop the job");
    assert.match(result.stderr, /funder holds 0\.5 SOL; the full scenario matrix needs at least 1 SOL/);
  } finally {
    rpc.close();
  }
});

test("exactly the floor is accepted; one lamport under is not", async () => {
  const { keypairPath } = fixture();
  for (const [lamports, expected] of [
    [1_000_000_000, 0],
    [999_999_999, 1],
  ]) {
    const rpc = await stubRpc(lamports);
    try {
      const result = await runPreflight({ keypairPath, rpcUrl: rpc.url });
      assert.equal(result.status, expected, `${lamports} lamports: ${result.stdout}${result.stderr}`);
    } finally {
      rpc.close();
    }
  }
});

test("no part of a valid keypair reaches stdout or stderr, on success or failure", async () => {
  const { keypair, keypairPath } = fixture();
  const secretBytes = Array.from(keypair.secretKey);
  const asJson = JSON.stringify(secretBytes);
  const fileContents = readFileSync(keypairPath, "utf8");

  for (const lamports of [1_500_000_000, 500_000_000]) {
    const rpc = await stubRpc(lamports);
    try {
      const result = await runPreflight({ keypairPath, rpcUrl: rpc.url });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(!output.includes(asJson), "the secret key array reached the log");
      assert.ok(!output.includes(fileContents.slice(0, 40)), "the keypair file's contents reached the log");
      // A long run of the secret's bytes, in case a future edit prints a slice.
      assert.ok(!output.includes(secretBytes.slice(0, 8).join(",")), "secret bytes reached the log");
    } finally {
      rpc.close();
    }
  }
});

/* ------------------------------------------------- malformed secrets, in the log */

for (const [description, supplied] of Object.entries(MALFORMED)) {
  test(`${description} fails with the constant message and no fragment of itself`, async () => {
    const { dir } = fixture();
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, supplied);
    const rpc = await stubRpc(1_500_000_000);
    try {
      const result = await runPreflight({ keypairPath: badPath, rpcUrl: rpc.url });
      assert.equal(result.status, 1, `${description} did not stop the job`);

      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(output.includes(FORMAT_ERROR), `${description}: the constant message was not printed`);
      noFragmentLeaked(output, supplied, description);

      // Nothing about the funder can have been printed either: the key was
      // never loaded, so there is no public address to report.
      assert.ok(!output.includes("funder public address"), `${description}: reported an address anyway`);
    } finally {
      rpc.close();
    }
  });
}

test("the balance is never fetched for a secret that failed validation", async () => {
  // A request to the RPC would mean the preflight got as far as constructing a
  // Keypair from bytes it had not accepted.
  const { dir } = fixture();
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, "[12, 34, 56");

  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runPreflight({
      keypairPath: badPath,
      rpcUrl: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(result.status, 1);
    assert.equal(requests, 0, "the preflight talked to the RPC with an unvalidated secret");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/**
 * The exact regression from run 35393227976.
 *
 * `JSON.parse` quotes the first ten characters of its input, the old preflight
 * printed that message, and so ten characters of the supplied secret reached a
 * permanent Actions log.
 */
test("the ten-character JSON.parse fragment no longer reaches the log", async () => {
  const supplied = "NOT-A-REAL-KEY-BUT-TREAT-IT-AS-ONE";
  const { dir } = fixture();
  const badPath = join(dir, "bad.json");
  writeFileSync(badPath, supplied);
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({ keypairPath: badPath, rpcUrl: rpc.url });
    assert.equal(result.status, 1);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(
      !output.includes(supplied.slice(0, 10)),
      "the parser's quoted prefix of the secret is back in the log",
    );
    assert.ok(!output.includes("is not valid JSON"), "the parser's own message reached the log");
    noFragmentLeaked(output, supplied, "run 35393227976 fixture");
  } finally {
    rpc.close();
  }
});

test("a missing keypair file is reported without the parser's errno text", async () => {
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({
      keypairPath: join(tmpdir(), "ppv-no-such-funder", "funder.json"),
      rpcUrl: rpc.url,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::the funder keypair file could not be read/);
    assert.ok(!result.stderr.includes("ENOENT"));
  } finally {
    rpc.close();
  }
});

test("an unset PPV_CUSTODY_FUNDER stops the preflight before it reads anything", async () => {
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({ keypairPath: "", rpcUrl: rpc.url });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::PPV_CUSTODY_FUNDER is not set/);
  } finally {
    rpc.close();
  }
});
