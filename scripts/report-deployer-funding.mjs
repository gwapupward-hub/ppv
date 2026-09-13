#!/usr/bin/env node
/**
 * Reports whether a deployer address meets the deployment funding policy.
 *
 * Read-only and public: a balance is public chain state, and the address is a
 * public key. Nothing here reads a keypair or signs, and it deliberately cannot
 * fund anything.
 *
 * The deploy workflow enforces this policy itself and fails closed. This exists
 * because failing closed *during* a deployment window is the expensive way to
 * find out: a devnet faucet is rate-limited, so "top it up and retry" can cost
 * hours. Answering the question beforehand is the point.
 *
 *   node scripts/report-deployer-funding.mjs <address> [min-lamports]
 *
 * Exit status is the verdict, so a caller can gate on it: 0 funded, 1 short.
 */

import { isAddress } from "./lib/pubkey.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, rpc } from "./lib/rpc.mjs";

const DEFAULT_MIN_LAMPORTS = 2_000_000_000; // 2 SOL, the deploy workflow's policy
const LAMPORTS_PER_SOL = 1_000_000_000;

const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4);

async function main() {
  const [address, minimum] = process.argv.slice(2);
  if (!address) {
    process.stderr.write("usage: report-deployer-funding.mjs <address> [min-lamports]\n");
    process.exit(2);
  }
  if (!isAddress(address)) throw new Error(`${address} is not a Solana address`);

  const minLamports = minimum ? Number(minimum) : DEFAULT_MIN_LAMPORTS;
  if (!Number.isInteger(minLamports) || minLamports <= 0) {
    throw new Error(`minimum lamports must be a positive integer, got ${minimum}`);
  }

  const client = rpc(process.env.PPV_RPC_URL || "https://api.devnet.solana.com");
  const genesis = await client.genesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new Error(`${client.endpoint} is mainnet-beta, which is not an authorized PPV cluster`);
  }
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`${client.endpoint} reports genesis ${genesis}, expected devnet`);
  }

  const result = await client.call("getBalance", [address, { commitment: "confirmed" }]);
  const lamports = result?.value;
  if (!Number.isInteger(lamports)) {
    // Fail closed. "I could not read the balance" must never read as "funded".
    throw new Error(`could not read a balance for ${address}`);
  }

  const funded = lamports >= minLamports;
  process.stdout.write(
    [
      "PPV devnet deployer funding",
      `  address   ${address}`,
      `  balance   ${lamports} lamports (${sol(lamports)} SOL)`,
      `  required  ${minLamports} lamports (${sol(minLamports)} SOL)`,
      `  result    ${funded ? "funded" : "UNDERFUNDED"}`,
      "",
    ].join("\n"),
  );

  if (!funded) {
    process.stderr.write(
      `${address} needs ${minLamports - lamports} more lamports ` +
        `(${sol(minLamports - lamports)} SOL) before a deployment can run.\n`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL  ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
