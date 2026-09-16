import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
 * It lives inline in the custody workflow as a `node -e` script, which is the
 * right place for it — it needs the secret, and the secret must not travel any
 * further than the step that uses it. But an inline workflow script is code
 * that only ever runs on a runner, in the one job nobody wants to debug by
 * re-running: the live custody execution is authorized one run at a time.
 *
 * So the script is extracted from the YAML and actually run here, against a
 * local stub that answers `getBalance`. A syntax error, a wrong comparison, or
 * a secret reaching stdout fails on a pull request instead of burning an
 * authorized run.
 */

const WORKFLOW = join(REPO, ".github", "workflows", "devnet-escrow-custody-validation.yml");

/** The inline script, dedented out of the YAML block that carries it. */
function extractPreflightScript() {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const match = yaml.match(/node -e '\n([\s\S]*?)\n {10}'\n/);
  assert.ok(match, "the funder preflight's inline node script was not found in the workflow");
  return match[1]
    .split("\n")
    .map((line) => (line.startsWith(" ".repeat(12)) ? line.slice(12) : line))
    .join("\n");
}

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
 * Runs the extracted script exactly as the workflow does: `node -e` from the
 * repository root.
 *
 * Three details, each of which cost a debugging round:
 *
 *   * `node -e` is the form the workflow uses, and the repository root is where
 *     its `require` calls resolve from. Running the same text as a file in a
 *     temp directory cannot find `@solana/web3.js` and tests nothing.
 *   * `spawn`, never `spawnSync`. `spawnSync` blocks this process's event loop,
 *     so the stub server below never gets to answer the request the child is
 *     waiting on, and the child appears to hang — a false failure that looks
 *     exactly like a real one. `scripts/test/helpers.mjs` records the same trap.
 *   * stdout and stderr are collected as they arrive rather than after exit, so
 *     a child that does hang still reports what it managed to print.
 *
 * The keypair is generated per fixture and thrown away with the temp directory.
 * It is never a real funder.
 */
function runPreflight({ script, keypairPath, rpcUrl, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
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
  const script = extractPreflightScript();
  const keypair = Keypair.generate();
  const keypairPath = join(dir, "funder.json");
  writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
  return { dir, script, keypair, keypairPath };
}

test("the inline script parses as CommonJS, which is what `node -e` runs", () => {
  const { dir, script } = fixture();
  const path = join(dir, "syntax-check.cjs");
  writeFileSync(path, script);
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("a funder above the floor passes and reports its public address", async () => {
  const { script, keypair, keypairPath } = fixture();
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({ script, keypairPath, rpcUrl: rpc.url });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`funder public address: ${keypair.publicKey.toBase58()}`));
    assert.match(result.stdout, /funder devnet balance: 1\.5 SOL/);
  } finally {
    rpc.close();
  }
});

test("a funder below the floor fails, naming the shortfall", async () => {
  const { script, keypairPath } = fixture();
  const rpc = await stubRpc(500_000_000);
  try {
    const result = await runPreflight({ script, keypairPath, rpcUrl: rpc.url });
    assert.equal(result.status, 1, "an underfunded funder must stop the job");
    assert.match(result.stderr, /funder holds 0\.5 SOL; the full scenario matrix needs at least 1 SOL/);
  } finally {
    rpc.close();
  }
});

test("exactly the floor is accepted; one lamport under is not", async () => {
  const { script, keypairPath } = fixture();
  for (const [lamports, expected] of [
    [1_000_000_000, 0],
    [999_999_999, 1],
  ]) {
    const rpc = await stubRpc(lamports);
    try {
      const result = await runPreflight({ script, keypairPath, rpcUrl: rpc.url });
      assert.equal(result.status, expected, `${lamports} lamports: ${result.stdout}${result.stderr}`);
    } finally {
      rpc.close();
    }
  }
});

test("no part of the keypair reaches stdout or stderr, on success or failure", async () => {
  const { script, keypair, keypairPath } = fixture();
  const secretBytes = Array.from(keypair.secretKey);
  const asJson = JSON.stringify(secretBytes);
  const fileContents = readFileSync(keypairPath, "utf8");

  for (const lamports of [1_500_000_000, 500_000_000]) {
    const rpc = await stubRpc(lamports);
    try {
      const result = await runPreflight({ script, keypairPath, rpcUrl: rpc.url });
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

test("a malformed keypair file fails without echoing what it tried to parse", async () => {
  // The specific hazard: `JSON.parse` throws an error whose message can quote
  // the input. Printing the caught error object would put a secret in a log the
  // moment the file was subtly wrong.
  const { script, dir } = fixture();
  const badPath = join(dir, "bad.json");
  const notSecret = "NOT-A-REAL-KEY-BUT-TREAT-IT-AS-ONE";
  writeFileSync(badPath, notSecret);
  const rpc = await stubRpc(1_500_000_000);
  try {
    const result = await runPreflight({ script, keypairPath: badPath, rpcUrl: rpc.url });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /funder preflight failed/);
    assert.ok(
      !result.stderr.includes(notSecret),
      "the failing input was echoed into the log; print error.message, never the input",
    );
  } finally {
    rpc.close();
  }
});
