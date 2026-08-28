import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const GOVERNANCE_SEED = Buffer.from("governance");
const VAULT_SEED = Buffer.from("vault");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function appendOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output) fs.appendFileSync(output, `${name}=${value}\n`);
}

const rpcUrl = process.env.PPV_RPC_URL ?? "https://api.devnet.solana.com";
const idl = JSON.parse(fs.readFileSync("target/idl/ppv_governance.json", "utf8"));
const programId = new PublicKey(idl.address);
const expectedMembers = required("PPV_GOVERNANCE_MEMBER_PUBKEYS")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const expectedThreshold = Number(required("PPV_GOVERNANCE_THRESHOLD"));
const expectedMinDelay = required("PPV_GOVERNANCE_MIN_DELAY_SLOTS");
const expectedLifetime = required("PPV_GOVERNANCE_PROPOSAL_LIFETIME_SLOTS");
const expectedTreasury = new PublicKey(required("PPV_GOVERNANCE_TREASURY"));

const connection = new Connection(rpcUrl, "confirmed");
const programAccount = await connection.getAccountInfo(programId, "confirmed");
if (!programAccount?.executable) {
  throw new Error(`ppv_governance is not executable at ${programId.toBase58()}`);
}

const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(Keypair.generate()),
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

const config = await program.account.governance.fetch(governance);
const vaultState = await program.account.governanceVault.fetch(vault);
const memberCount = Number(config.memberCount);
const actualMembers = config.members
  .slice(0, memberCount)
  .map((member: PublicKey) => member.toBase58());

if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) {
  throw new Error(
    `governance members do not match environment: chain=${actualMembers.join(",")} env=${expectedMembers.join(",")}`,
  );
}
if (Number(config.threshold) !== expectedThreshold) {
  throw new Error(
    `governance threshold ${config.threshold} does not match ${expectedThreshold}`,
  );
}
if (config.minDelaySlots.toString() !== expectedMinDelay) {
  throw new Error(
    `governance delay ${config.minDelaySlots} does not match ${expectedMinDelay}`,
  );
}
if (config.proposalLifetimeSlots.toString() !== expectedLifetime) {
  throw new Error(
    `proposal lifetime ${config.proposalLifetimeSlots} does not match ${expectedLifetime}`,
  );
}
if (!config.treasury.equals(expectedTreasury)) {
  throw new Error(
    `governance treasury ${config.treasury.toBase58()} does not match ${expectedTreasury.toBase58()}`,
  );
}
if (!vaultState.governance.equals(governance)) {
  throw new Error("governance vault is not bound to the canonical governance PDA");
}

console.log(`governance program: ${programId.toBase58()}`);
console.log(`governance PDA:     ${governance.toBase58()}`);
console.log(`vault PDA:          ${vault.toBase58()}`);
console.log(`members:            ${actualMembers.join(",")}`);
console.log(`threshold:          ${expectedThreshold}`);
console.log(`epoch:              ${config.epoch.toString()}`);

appendOutput("governance_pda", governance.toBase58());
appendOutput("vault_pda", vault.toBase58());
appendOutput("governance_program_id", programId.toBase58());
