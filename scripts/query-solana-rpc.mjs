#!/usr/bin/env node

import {
  getGenesisHash,
  getSignatureStatus,
  getUpgradeableProgramState,
  programExists,
} from "./lib/solana-rpc.mjs";

const [command, value, rpcArg] = process.argv.slice(2);
const rpcUrl = rpcArg || process.env.PPV_RPC_URL || "https://api.devnet.solana.com";

try {
  switch (command) {
    case "genesis":
      process.stdout.write(await getGenesisHash(rpcUrl));
      break;
    case "exists":
      if (!value) throw new Error("exists requires a program id");
      process.stdout.write(String(await programExists(rpcUrl, value)));
      break;
    case "program":
      if (!value) throw new Error("program requires a program id");
      process.stdout.write(JSON.stringify(await getUpgradeableProgramState(rpcUrl, value)));
      break;
    case "signature":
      if (!value) throw new Error("signature requires a transaction signature");
      process.stdout.write(JSON.stringify(await getSignatureStatus(rpcUrl, value)));
      break;
    default:
      throw new Error("usage: query-solana-rpc.mjs <genesis|exists|program|signature> [value] [rpc-url]");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
