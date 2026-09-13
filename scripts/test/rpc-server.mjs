#!/usr/bin/env node
/**
 * The deterministic JSON-RPC stub, as its own process.
 *
 * The shell scripts on the release path are tested by running them for real,
 * which means `spawnSync` — and that blocks the calling process's event loop, so
 * a stub server living in the test process would never answer. It therefore
 * runs here instead, prints the URL it bound on its first line, and serves
 * until it is killed.
 *
 *   node scripts/test/rpc-server.mjs <fixture.json>
 *
 * The fixture is the same shape `makeRpcTransport` takes, with account data as
 * base64 strings rather than Buffers so it survives JSON.
 */

import { readFileSync } from "node:fs";

import { makeRpcTransport } from "./helpers.mjs";
import { createServer } from "node:http";

const fixture = JSON.parse(readFileSync(process.argv[2], "utf8"));
const accounts = Object.fromEntries(
  Object.entries(fixture.accounts ?? {}).map(([address, account]) => [
    address,
    { ...account, data: Buffer.from(account.data, "base64") },
  ]),
);
const programAccounts = Object.fromEntries(
  Object.entries(fixture.programAccounts ?? {}).map(([program, entries]) => [
    program,
    entries.map((entry) => ({ ...entry, account: { ...entry.account, data: Buffer.from(entry.account.data, "base64") } })),
  ]),
);
const transport = makeRpcTransport({ ...fixture, accounts, programAccounts });

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const stub = await transport("stub", { body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(stub.status, { "content-type": "application/json" });
    response.end(JSON.stringify(await stub.json()));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
