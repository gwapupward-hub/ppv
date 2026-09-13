#!/usr/bin/env node
/**
 * One public chain read per invocation, for the shell scripts on the release
 * path.
 *
 * This exists because the Solana CLI wants a configured default signer even for
 * commands that only read — which is what broke the PPV Core deployment's
 * evidence step on a GitHub runner that has no wallet. Reading public state
 * should not require the ability to sign, so these reads go straight to
 * JSON-RPC and there is nothing here that could sign if it wanted to.
 *
 *   node scripts/query-chain.mjs genesis [rpc-url]
 *   node scripts/query-chain.mjs program <program-id> [rpc-url]
 *   node scripts/query-chain.mjs signature <signature> [rpc-url]
 */

import { readDeployedProgram, rpc, signatureStatus } from "./lib/rpc.mjs";

const [command, ...rest] = process.argv.slice(2);
// `genesis` takes no value, so its first positional argument is the endpoint.
const value = command === "genesis" ? null : rest[0];
const url = (command === "genesis" ? rest[0] : rest[1]) ||
  process.env.PPV_RPC_URL ||
  "https://api.devnet.solana.com";

try {
  const client = rpc(url);
  switch (command) {
    case "genesis":
      process.stdout.write(await client.genesisHash());
      break;
    case "program": {
      if (!value) throw new Error("program requires a program id");
      const state = await readDeployedProgram(client, value);
      // The ELF itself is megabytes and no caller of this path needs it.
      delete state.deployedBinary;
      process.stdout.write(JSON.stringify(state));
      break;
    }
    case "signature":
      if (!value) throw new Error("signature requires a transaction signature");
      process.stdout.write(JSON.stringify(await signatureStatus(client, value)));
      break;
    default:
      throw new Error("usage: query-chain.mjs <genesis|program|signature> [value] [rpc-url]");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
