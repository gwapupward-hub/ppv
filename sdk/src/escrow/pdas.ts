import { createHash } from "node:crypto";

import { decodeBase58, encodeBase58 } from "../reputation/base58.js";
import { isOnCurve } from "./curve.js";

/**
 * Deterministic PPV addresses.
 *
 * The program id is part of every derivation, which is why a PPV program id is
 * protocol architecture and not a disposable deployment artifact: changing it
 * changes the address of every agreement, vault authority, and vault that has
 * ever existed.
 */

export const AGREEMENT_SEED = new TextEncoder().encode("agreement");
export const VAULT_AUTHORITY_SEED = new TextEncoder().encode("vault");
export const VAULT_TOKEN_SEED = new TextEncoder().encode("vault_token");

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

export class PdaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdaError";
  }
}

export type Address = string;

function addressBytes(address: Address): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) throw new PdaError(`not a 32-byte address: ${address}`);
  return bytes;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The raw derivation, with the bump already chosen. Throws when the result is
 * on the curve, exactly as the runtime's `create_program_address` does.
 */
export function createProgramAddress(seeds: readonly Uint8Array[], programId: Address): Address {
  if (seeds.length > MAX_SEEDS) throw new PdaError("too many seeds");
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) throw new PdaError("seed longer than 32 bytes");
  }

  const digest = createHash("sha256")
    .update(concat([...seeds, addressBytes(programId), PDA_MARKER]))
    .digest();
  const bytes = new Uint8Array(digest);
  if (isOnCurve(bytes)) throw new PdaError("derived address is on the ed25519 curve");
  return encodeBase58(bytes);
}

/** The canonical (highest) bump, matching `Pubkey::find_program_address`. */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Address,
): { address: Address; bump: number } {
  for (let bump = 255; bump >= 0; bump -= 1) {
    try {
      const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
      return { address, bump };
    } catch (error) {
      if (error instanceof PdaError && error.message.includes("on the ed25519 curve")) continue;
      throw error;
    }
  }
  throw new PdaError("no off-curve bump exists for these seeds");
}

/** `agreement_id` is a u64 encoded little-endian, as the program seeds it. */
export function agreementIdSeed(agreementId: bigint | number): Uint8Array {
  const value = BigInt(agreementId);
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new PdaError("agreement id out of u64 range");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function deriveAgreement(
  programId: Address,
  creator: Address,
  agreementId: bigint | number,
): { address: Address; bump: number } {
  return findProgramAddress(
    [AGREEMENT_SEED, addressBytes(creator), agreementIdSeed(agreementId)],
    programId,
  );
}

/**
 * Every agreement gets its own vault authority. There is deliberately no
 * global authority to derive, so there is no single derivation whose compromise
 * would reach more than one agreement's funds.
 */
export function deriveVaultAuthority(
  programId: Address,
  agreement: Address,
): { address: Address; bump: number } {
  return findProgramAddress([VAULT_AUTHORITY_SEED, addressBytes(agreement)], programId);
}

export function deriveVault(programId: Address, agreement: Address): { address: Address; bump: number } {
  return findProgramAddress([VAULT_TOKEN_SEED, addressBytes(agreement)], programId);
}

export type AgreementAddresses = {
  agreement: Address;
  agreementBump: number;
  vaultAuthority: Address;
  vaultAuthorityBump: number;
  vault: Address;
  vaultBump: number;
};

/** Every address one agreement occupies, derived from public inputs alone. */
export function deriveAgreementAddresses(
  programId: Address,
  creator: Address,
  agreementId: bigint | number,
): AgreementAddresses {
  const agreement = deriveAgreement(programId, creator, agreementId);
  const vaultAuthority = deriveVaultAuthority(programId, agreement.address);
  const vault = deriveVault(programId, agreement.address);
  return {
    agreement: agreement.address,
    agreementBump: agreement.bump,
    vaultAuthority: vaultAuthority.address,
    vaultAuthorityBump: vaultAuthority.bump,
    vault: vault.address,
    vaultBump: vault.bump,
  };
}
