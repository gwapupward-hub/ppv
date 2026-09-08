/**
 * Rebuilds a PPV agreement's entire lifecycle from a public RPC endpoint.
 *
 * This script is the Phase 2 definition of done, made runnable. It takes a
 * program id, an agreement (by address, or by creator and number), and an RPC
 * URL. It has no access to a GWAP database, no API key, and no privileged
 * endpoint — and it still answers every question in the PPV success criteria:
 * who took part, what state was reached, what funds moved, and what receipt
 * represents each transition.
 *
 * Run `npm run build` first: the script consumes @gwap/ppv-sdk and
 * @gwap/ppv-indexer exactly as an outside integrator would.
 *
 *   node --import tsx scripts/replay-agreement.mts \
 *     --rpc https://api.devnet.solana.com \
 *     --program <PPV_ESCROW_PROGRAM_ID> \
 *     --creator <WALLET> --id 42
 *
 *   node --import tsx scripts/replay-agreement.mts \
 *     --rpc http://127.0.0.1:8899 \
 *     --program <PPV_ESCROW_PROGRAM_ID> \
 *     --agreement <AGREEMENT_ADDRESS> --json
 */

import { deriveAgreementAddresses } from "@gwap/ppv-sdk";
import { httpChainSource, replayAgreement } from "@gwap/ppv-indexer";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function main(): Promise<void> {
  const rpc = required("rpc");
  const programId = required("program");
  const asJson = process.argv.includes("--json");

  let agreement = argument("agreement");
  if (!agreement) {
    const creator = required("creator");
    const id = required("id");
    const derived = deriveAgreementAddresses(programId, creator, BigInt(id));
    agreement = derived.agreement;
    if (!asJson) {
      console.log(`agreement       ${derived.agreement}`);
      console.log(`vault authority ${derived.vaultAuthority}`);
      console.log(`vault           ${derived.vault}`);
      console.log("");
    }
  }

  const result = await replayAgreement(httpChainSource(rpc), agreement, { programId });

  if (asJson) {
    console.log(JSON.stringify(result, jsonSafe, 2));
    return;
  }

  const { lifecycle } = result;
  console.log(`agreement   ${lifecycle.agreement}`);
  console.log(`id          ${lifecycle.agreementId}`);
  console.log(`buyer       ${lifecycle.buyer}`);
  console.log(`seller      ${lifecycle.seller}`);
  console.log(`mint        ${lifecycle.mint}`);
  console.log(`state       ${lifecycle.state}`);
  console.log(`funded      ${lifecycle.fundedAmount ?? "—"}`);
  console.log(`settled     ${lifecycle.settledAmount ?? "—"}`);
  console.log(`destination ${lifecycle.settlementDestination ?? "—"}`);
  console.log("");
  console.log(
    `${result.transactionsScanned} transactions read, ` +
      `${result.failedTransactionsSkipped} failed and skipped`,
  );
  console.log("");

  for (const receipt of lifecycle.receipts) {
    const movement = receipt.amount === null ? "no custody movement" : `${receipt.amount} → ${receipt.destination}`;
    console.log(`${receipt.action}`);
    console.log(`  receipt     ${receipt.receiptId}`);
    console.log(`  transition  ${receipt.previousState ?? "—"} → ${receipt.newState}`);
    console.log(`  actor       ${receipt.actor}`);
    console.log(`  custody     ${movement}`);
    console.log(`  at          ${receipt.occurredAt} (slot ${receipt.slot})`);
    console.log(`  transaction ${receipt.transactionSignature}`);
    console.log("");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
