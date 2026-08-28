import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import fs from "node:fs";

const GOVERNANCE_SEED = Buffer.from("governance");
const VAULT_SEED = Buffer.from("vault");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseMembers(raw: string): PublicKey[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.map((value) => new PublicKey(value));
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) fs.appendFileSync(output, `${name}=${value}\n`);
}

const rpcUrl = process.env.PPV_RPC_URL ?? "https://api.devnet.solana.com";
const keypairPath = required("PPV_DEPLOYER_KEYPAIR_PATH");
const idl = JSON.parse(fs.readFileSync("target/idl/ppv_governance.json", "utf8"));
const programId = new PublicKey(idl.address);
const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
);
const members = parseMembers(required("PPV_GOVERNANCE_MEMBER_PUBKEYS"));
const threshold = Number(required("PPV_GOVERNANCE_THRESHOLD"));
const minDelaySlots = new BN(required("PPV_GOVERNANCE_MIN_DELAY_SLOTS"));
const proposalLifetimeSlots = new BN(
  required("PPV_GOVERNANCE_PROPOSAL_LIFETIME_SLOTS"),
);
const treasury = new PublicKey(required("PPV_GOVERNANCE_TREASURY"));

if (!Number.isSafeInteger(threshold)) throw new Error("invalid governance threshold");

const connection = new Connection(rpcUrl, "confirmed");
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(deployer),
  anchor.AnchorProvider.defaultOptions(),
);
const program = new anchor.Program(idl, provider) as any;
const [governance] = PublicKey.findProgramAddressSync(
  [GOVERNANCE_SEED],
  programId,
);
const [vault] = PublicKey.findProgramAddressSync(
  [VAULT_SEED, governance.toBuffer()],
  programId,
);

if (await connection.getAccountInfo(governance, "confirmed")) {
  throw new Error(`governance account ${governance.toBase58()} already exists`);
}

const signature = await program.methods
  .initializeGovernance(
    members,
    threshold,
    minDelaySlots,
    proposalLifetimeSlots,
    treasury,
  )
  .accounts({
    payer: deployer.publicKey,
    governance,
    vault,
    systemProgram: SystemProgram.programId,
  })
  .signers([deployer])
  .rpc();

console.log(`governance program: ${programId.toBase58()}`);
console.log(`governance PDA:     ${governance.toBase58()}`);
console.log(`vault PDA:          ${vault.toBase58()}`);
console.log(`initialization tx:  ${signature}`);
console.log(`members:            ${members.map((member) => member.toBase58()).join(",")}`);
console.log(`threshold:          ${threshold}`);

appendOutput("governance_pda", governance.toBase58());
appendOutput("vault_pda", vault.toBase58());
appendOutput("initialization_signature", signature);
