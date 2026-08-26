/**
 * Claims the admin seat on the unrecognized devnet `ppv_core` at
 * 9D2JUUB2vUTtfxSZNGzrUXk1AFmvvqSbxZiXWLBYaBHB by calling `initialize_core`.
 *
 * Why this exists: that program's `initialize_core` constrains its admin signer
 * to nothing and its `CoreConfig` is `init`, so the first caller becomes admin
 * permanently and a second call can never displace them. The program is not
 * ours and is not being adopted — see docs/devnet-artifact-audit.md — but the
 * seat is worth holding rather than leaving open. This script does that one
 * thing and nothing else. It cannot create proofs, register issuers, pause, or
 * upgrade anything.
 *
 * The audited program's IDL is deliberately NOT committed to this repository,
 * so the instruction is built by hand from its published discriminator. That
 * keeps this script from being a back door through which a foreign interface
 * enters the tree.
 *
 * Usage — simulate (the default; sends nothing):
 *
 *   PPV_CLAIM_KEYPAIR=~/.config/solana/your-key.json \
 *     npm run claim:core-admin
 *
 * Usage — actually send:
 *
 *   PPV_CLAIM_KEYPAIR=~/.config/solana/your-key.json \
 *   PPV_CLAIM_CONFIRM=claim \
 *     npm run claim:core-admin
 *
 * Optional:
 *   PPV_CLAIM_RPC_URL     defaults to https://api.devnet.solana.com
 *   PPV_CLAIM_PROGRAM_ID  defaults to the audited program id
 *
 * The keypair is read from the path given, used to sign, and never printed,
 * logged, or copied. Run it from an operator machine, not from CI.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/** The audited devnet program. Not a PPV deployment; see the audit doc. */
const AUDITED_PROGRAM_ID = "9D2JUUB2vUTtfxSZNGzrUXk1AFmvvqSbxZiXWLBYaBHB";

/** sha256("global:initialize_core")[0..8], from the published IDL. */
const INITIALIZE_CORE_DISCRIMINATOR = Uint8Array.from([
  26, 107, 177, 14, 71, 136, 11, 91,
]);

const CONFIG_SEED = new TextEncoder().encode("config");

/**
 * CoreConfig layout from the published IDL:
 *   8 discriminator | 1 bump | 1 version | 32 admin | 32 pending_admin
 *   | 1 paused | 8 created_at
 */
const ADMIN_OFFSET = 8 + 1 + 1;
const PENDING_ADMIN_OFFSET = ADMIN_OFFSET + 32;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. See the header of this script.`);
  }
  return value;
}

function expandUser(path: string): string {
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
}

function loadKeypair(path: string): Keypair {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(expandUser(path), "utf8"));
  } catch (cause) {
    throw new Error(`Could not read a keypair from ${path}`, { cause });
  }
  if (!Array.isArray(parsed) || parsed.some((b) => typeof b !== "number")) {
    throw new Error(`${path} is not a Solana JSON keypair (byte array)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

async function main(): Promise<void> {
  const programId = new PublicKey(
    process.env.PPV_CLAIM_PROGRAM_ID?.trim() || AUDITED_PROGRAM_ID,
  );
  const rpcUrl =
    process.env.PPV_CLAIM_RPC_URL?.trim() || "https://api.devnet.solana.com";
  const admin = loadKeypair(required("PPV_CLAIM_KEYPAIR"));
  const send = process.env.PPV_CLAIM_CONFIRM?.trim() === "claim";

  const connection = new Connection(rpcUrl, "confirmed");
  const [config] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);

  console.log(`RPC:        ${rpcUrl}`);
  console.log(`Program:    ${programId.toBase58()}`);
  console.log(`Config PDA: ${config.toBase58()}`);
  console.log(`Admin:      ${admin.publicKey.toBase58()}`);
  console.log();

  // Refuse to touch a program that is not the upgradeable executable we expect.
  const programAccount = await connection.getAccountInfo(programId);
  if (programAccount === null) {
    throw new Error(`No account at ${programId.toBase58()} on ${rpcUrl}`);
  }
  if (!programAccount.executable) {
    throw new Error(`${programId.toBase58()} is not executable`);
  }

  // If the seat is already taken there is nothing to do, and nothing this
  // script could do about it — CoreConfig is `init` and has no reset path.
  const existing = await connection.getAccountInfo(config);
  if (existing !== null) {
    const currentAdmin = new PublicKey(
      existing.data.subarray(ADMIN_OFFSET, ADMIN_OFFSET + 32),
    );
    const pendingAdmin = new PublicKey(
      existing.data.subarray(PENDING_ADMIN_OFFSET, PENDING_ADMIN_OFFSET + 32),
    );
    console.log("Core is already initialized. Nothing to claim.");
    console.log(`  admin:         ${currentAdmin.toBase58()}`);
    console.log(`  pending_admin: ${pendingAdmin.toBase58()}`);
    console.log();
    console.log("Record this in docs/devnet-artifact-audit.md. If the admin is");
    console.log("not an address you control, treat it as an unknown party.");
    return;
  }

  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(INITIALIZE_CORE_DISCRIMINATOR),
  });

  const transaction = new Transaction().add(instruction);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = admin.publicKey;

  const simulation = await connection.simulateTransaction(transaction, [admin]);
  if (simulation.value.err !== null) {
    console.error("Simulation failed:", JSON.stringify(simulation.value.err));
    for (const line of simulation.value.logs ?? []) console.error(`  ${line}`);
    process.exitCode = 1;
    return;
  }
  console.log("Simulation succeeded.");

  if (!send) {
    console.log();
    console.log("Dry run — nothing was sent. Re-run with PPV_CLAIM_CONFIRM=claim");
    console.log("to submit. The seat is permanent once claimed.");
    return;
  }

  transaction.sign(admin);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  console.log();
  console.log(`Claimed. Signature: ${signature}`);
  console.log("Record the signature and the admin address in");
  console.log("docs/devnet-artifact-audit.md.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
