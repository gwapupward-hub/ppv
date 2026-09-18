#!/usr/bin/env node
/**
 * The custody funder preflight.
 *
 * Checks the disposable devnet funder before the live matrix starts, because
 * both failures it catches are cheap here and expensive later:
 *
 *   * a secret that is missing or malformed stops the job having created
 *     nothing;
 *   * a funder too thin for the full matrix stops the job here, rather than
 *     partway through — a run that halts between a `fund` and its settlement
 *     leaves tokens in a vault and burns an authorization that then has to be
 *     granted again.
 *
 * It used to live inline in the workflow as a `node -e` script, extracted back
 * out of the YAML by its test. That was testable only by regex-dedenting a
 * string, and it is the step that handles the one PPV secret this workflow
 * takes. It is a file now: the tests run the real thing, and the parsing it
 * depends on is a module with fixtures of its own.
 *
 * What it prints about the funder is its PUBLIC address and its balance.
 * Nothing else, on any path. See `scripts/lib/funder-secret.mjs` for why a
 * rejection prints a constant rather than a reason.
 *
 *   PPV_CUSTODY_FUNDER=<path to keypair json> \
 *   PPV_CUSTODY_RPC_URL=<devnet rpc> \
 *     node scripts/funder-preflight.mjs
 */

import { Connection, Keypair } from "@solana/web3.js";

import { FUNDER_SECRET_FORMAT_ERROR, readFunderSecret } from "./lib/funder-secret.mjs";

/**
 * The floor the full scenario matrix needs: ordinary escrow, cancel, refund,
 * both dispute outcomes, milestones, bounty and the negative probes, plus rent
 * for every account each of them creates.
 */
export const MINIMUM_FUNDER_LAMPORTS = 1_000_000_000;

/** GitHub Actions renders this as a job annotation. */
function annotate(message) {
  process.stderr.write(`::error::${message}\n`);
}

async function main() {
  const funderPath = process.env.PPV_CUSTODY_FUNDER;
  if (!funderPath) {
    annotate("PPV_CUSTODY_FUNDER is not set; the preflight has no keypair path to read");
    return 1;
  }

  const secret = readFunderSecret(funderPath);
  if (!secret.ok) {
    annotate(secret.error);
    return 1;
  }

  let funder;
  try {
    funder = Keypair.fromSecretKey(secret.secretKey);
  } catch {
    // Well-formed bytes can still fail ed25519's own check that the trailing
    // public key matches the seed. Reported as a format problem, with the same
    // constant: the bytes are the secret, and `web3.js` is under no obligation
    // to keep them out of its own message.
    annotate(FUNDER_SECRET_FORMAT_ERROR);
    return 1;
  }

  // Past this line nothing derived from the secret is in play, so ordinary
  // error text is safe again: what can fail now is the network.
  const connection = new Connection(process.env.PPV_CUSTODY_RPC_URL, "confirmed");
  const lamports = await connection.getBalance(funder.publicKey, "confirmed");
  const sol = lamports / 1e9;

  // Public address only. Never the secret, in any form.
  process.stdout.write(`funder public address: ${funder.publicKey.toBase58()}\n`);
  process.stdout.write(`funder devnet balance: ${sol} SOL\n`);

  if (lamports < MINIMUM_FUNDER_LAMPORTS) {
    annotate(`funder holds ${sol} SOL; the full scenario matrix needs at least 1 SOL`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // Reachable only from the network phase above — every secret-handling path
    // returns rather than throws. `FunderSecretError`'s message is a constant,
    // so even a future path that threw one would print no key material.
    annotate(`funder preflight failed: ${error?.message ?? "unknown error"}`);
    process.exit(1);
  });
