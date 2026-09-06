import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { RpcError, httpChainSource } from "../src/rpc.js";
import { replayAgreement } from "../src/replay.js";
import {
  FIXTURE_ADDRESSES,
  LIFECYCLE_FIXTURE,
  PROGRAM_ID,
  signatureFor,
  transactionFor,
} from "./helpers/chain-fixtures.js";

/**
 * The JSON-RPC client, exercised against a real HTTP server rather than a
 * mocked fetch. The claim this package makes is "any Solana RPC endpoint is
 * enough", and a stubbed transport cannot check the request that claim rests
 * on: the method names, the parameter shapes, and the version guard that keeps
 * a versioned transaction from being refused.
 */

const AGREEMENT = FIXTURE_ADDRESSES.AGREEMENT;
const transactions = LIFECYCLE_FIXTURE.map((event, index) =>
  transactionFor({ signature: signatureFor(index + 1), slot: 100 + index, events: [event] }),
);

let server: Server;
let endpoint: string;
const requests: Array<{ method: string; params: unknown[] }> = [];
let failNext = false;

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      requests.push({ method, params });

      const reply = (payload: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(payload as object) }));
      };

      if (failNext) {
        failNext = false;
        return reply({ error: { code: -32004, message: "node is behind" } });
      }
      if (method === "getSignaturesForAddress") {
        const [address] = params as [string, { before?: string; limit?: number }];
        if (address !== AGREEMENT) return reply({ result: [] });
        const entries = transactions
          .map((tx) => ({
            signature: tx.transaction.signatures[0],
            slot: tx.slot,
            err: null,
            blockTime: tx.blockTime,
          }))
          .reverse();
        return reply({ result: entries });
      }
      if (method === "getTransaction") {
        const [signature] = params as [string];
        return reply({
          result: transactions.find((tx) => tx.transaction.signatures[0] === signature) ?? null,
        });
      }
      return reply({ error: { message: `unexpected method ${method}` } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  endpoint = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("a lifecycle is rebuilt over plain JSON-RPC", async () => {
  const result = await replayAgreement(httpChainSource(endpoint), AGREEMENT, {
    programId: PROGRAM_ID,
  });
  assert.equal(result.lifecycle.state, "Settled");
  assert.equal(result.lifecycle.receipts.length, 4);
});

test("transactions are requested in a form a versioned chain can answer", () => {
  const getTransaction = requests.find((entry) => entry.method === "getTransaction");
  assert.ok(getTransaction);
  const [, config] = getTransaction.params as [string, Record<string, unknown>];
  // Without maxSupportedTransactionVersion the RPC refuses every v0
  // transaction outright, which would look like an agreement with no history.
  assert.equal(config.maxSupportedTransactionVersion, 0);
  assert.equal(config.encoding, "json");
  assert.equal(config.commitment, "confirmed");
});

test("an RPC error surfaces instead of being read as an empty history", async () => {
  failNext = true;
  await assert.rejects(
    replayAgreement(httpChainSource(endpoint), AGREEMENT, { programId: PROGRAM_ID }),
    RpcError,
  );
});

test("an address the chain does not know is an empty history, not an error", async () => {
  const source = httpChainSource(endpoint);
  assert.deepEqual(await source.signaturesForAddress(FIXTURE_ADDRESSES.BUYER), []);
});
