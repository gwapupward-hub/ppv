/**
 * Reading a Squads V4 multisig off the chain, instead of being told what it is.
 *
 * Every PPV verifier until now took the threshold and the member list as
 * *inputs* — from a workflow variable, an environment value, or a frozen record
 * in this repository — and checked them against policy. That answers "is the
 * configuration we believe in acceptable", which is a useful question and not
 * the one that matters for custody. The one that matters is "is the account
 * that actually holds the upgrade authority the configuration we believe in",
 * and only the chain can answer it. RR-7 is exactly that gap.
 *
 * So this module does two things and nothing else:
 *
 *   1. Decodes the Squads V4 `Multisig` account, byte for byte.
 *   2. Derives a vault PDA from a multisig address and a vault index.
 *
 * It is dependency-free on purpose, like the rest of `scripts/lib`, so it runs
 * before `npm ci` and inside the read-only verifiers. That would normally mean
 * hand-writing a layout and hoping — which is the failure mode the sprint brief
 * calls out by name. It does not, because the layout is not asserted here: it
 * is asserted in `scripts/test/squads-decode.test.mjs` against the pinned
 * `@sqds/multisig` 2.1.4 serializer, which is the same code the Squads clients
 * use. A layout drift fails that test rather than producing a confident wrong
 * answer about who can upgrade the program holding custody.
 *
 * Nothing here signs, and nothing here can move anything. It reads.
 */

import { createHash } from "node:crypto";

import { decodeBase58, encodeBase58, isOnCurve } from "./pubkey.mjs";

/**
 * The canonical Squads V4 program. Pinned rather than passed in: a verifier
 * that decoded "whatever program the caller named" would happily read a
 * look-alike account under an attacker's program and report a 2-of-3.
 *
 * Cross-checked against `@sqds/multisig`'s own `PROGRAM_ID` in the test suite.
 */
export const SQUADS_V4_PROGRAM_ID = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/** Anchor's account discriminator for the Squads V4 `Multisig` account. */
export const MULTISIG_DISCRIMINATOR = Uint8Array.of(224, 116, 121, 186, 68, 161, 79, 236);

/** Squads V4 member permission bits. */
export const PERMISSION_INITIATE = 1;
export const PERMISSION_VOTE = 2;
export const PERMISSION_EXECUTE = 4;
/** Initiate + Vote + Execute. A full custody signer. */
export const PERMISSION_ALL = PERMISSION_INITIATE | PERMISSION_VOTE | PERMISSION_EXECUTE;

const SEED_PREFIX = new TextEncoder().encode("multisig");
const SEED_VAULT = new TextEncoder().encode("vault");
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export class SquadsDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SquadsDecodeError";
  }
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** `Pubkey::create_program_address`, including its refusal of on-curve results. */
function createProgramAddress(seeds, programId) {
  const digest = createHash("sha256")
    .update(concat([...seeds, decodeBase58(programId), PDA_MARKER]))
    .digest();
  const address = encodeBase58(new Uint8Array(digest));
  if (isOnCurve(address)) return null;
  return address;
}

/** `Pubkey::find_program_address`: the highest bump whose address is off-curve. */
export function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (address) return { address, bump };
  }
  throw new SquadsDecodeError("no off-curve bump exists for these seeds");
}

/**
 * The vault a multisig controls at a given index.
 *
 * Index 0 is the default vault and the one PPV's custody ceremony used. The
 * index is part of the derivation, so "the vault" is only meaningful alongside
 * the number — a different index is a different account with different money.
 */
export function deriveVault(multisig, index = 0, programId = SQUADS_V4_PROGRAM_ID) {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new SquadsDecodeError(`vault index ${index} is not a u8`);
  }
  return findProgramAddress(
    [SEED_PREFIX, decodeBase58(multisig), SEED_VAULT, Uint8Array.of(index)],
    programId,
  );
}

/** The permission bits a mask carries, named. */
export function permissionNames(mask) {
  const names = [];
  if (mask & PERMISSION_INITIATE) names.push("Initiate");
  if (mask & PERMISSION_VOTE) names.push("Vote");
  if (mask & PERMISSION_EXECUTE) names.push("Execute");
  return names;
}

/**
 * Decodes a Squads V4 `Multisig` account.
 *
 * The layout, in the order the program writes it:
 *
 *   discriminator          8
 *   create_key            32
 *   config_authority      32
 *   threshold              2   u16 little-endian
 *   time_lock              4   u32 little-endian
 *   transaction_index      8   u64 little-endian
 *   stale_transaction_index 8  u64 little-endian
 *   rent_collector         1 + 32 when Some, 1 when None
 *   bump                   1
 *   members                4 + 33·n   (u32 count, then {pubkey, u8 mask})
 *
 * Every length is checked before it is read. A truncated account is an error,
 * never a short member list that would read as a smaller multisig than it is.
 */
export function decodeMultisig(data) {
  // `Buffer.from(view.buffer)` would silently ignore a typed array's byteOffset
  // and length and decode the whole backing store, so a caller passing a
  // subarray would get an answer about bytes it never handed over.
  let bytes;
  if (typeof data === "string") bytes = Buffer.from(data, "base64");
  else if (Buffer.isBuffer(data)) bytes = data;
  else if (ArrayBuffer.isView(data)) {
    bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
  else throw new SquadsDecodeError("account data must be base64, a Buffer or a typed array");

  const need = (offset, length, what) => {
    if (bytes.length < offset + length) {
      throw new SquadsDecodeError(
        `Multisig account is ${bytes.length} bytes, too short to hold ${what}`,
      );
    }
  };

  need(0, 8, "an account discriminator");
  const discriminator = bytes.subarray(0, 8);
  if (!discriminator.equals(Buffer.from(MULTISIG_DISCRIMINATOR))) {
    throw new SquadsDecodeError(
      `account discriminator is ${discriminator.toString("hex")}, not the Squads V4 Multisig ` +
        `discriminator ${Buffer.from(MULTISIG_DISCRIMINATOR).toString("hex")}`,
    );
  }

  need(8, 86, "the multisig header");
  const createKey = encodeBase58(bytes.subarray(8, 40));
  const configAuthority = encodeBase58(bytes.subarray(40, 72));
  const threshold = bytes.readUInt16LE(72);
  const timeLock = bytes.readUInt32LE(74);
  const transactionIndex = bytes.readBigUInt64LE(78);
  const staleTransactionIndex = bytes.readBigUInt64LE(86);

  let offset = 94;
  need(offset, 1, "the rent-collector option tag");
  const rentCollectorTag = bytes[offset];
  offset += 1;
  let rentCollector = null;
  if (rentCollectorTag === 1) {
    need(offset, 32, "a rent-collector address");
    rentCollector = encodeBase58(bytes.subarray(offset, offset + 32));
    offset += 32;
  } else if (rentCollectorTag !== 0) {
    throw new SquadsDecodeError(`invalid Option tag ${rentCollectorTag} for rent_collector`);
  }

  need(offset, 1, "the multisig bump");
  const bump = bytes[offset];
  offset += 1;

  need(offset, 4, "the member count");
  const memberCount = bytes.readUInt32LE(offset);
  offset += 4;
  need(offset, memberCount * 33, `${memberCount} member(s)`);

  const members = [];
  for (let i = 0; i < memberCount; i += 1) {
    const key = encodeBase58(bytes.subarray(offset, offset + 32));
    const mask = bytes[offset + 32];
    offset += 33;
    members.push({ key, mask, permissions: permissionNames(mask) });
  }

  return {
    createKey,
    configAuthority,
    threshold,
    timeLock,
    transactionIndex,
    staleTransactionIndex,
    rentCollector,
    bump,
    members,
    trailingBytes: bytes.length - offset,
  };
}

/**
 * The live account, decoded, with the one thing a decoder cannot check for
 * itself: that the account is owned by the Squads program.
 *
 * An account holding Squads-shaped bytes under some other program's ownership
 * is not a multisig. It is a file somebody wrote, and the Squads program will
 * never act on it — so reading a threshold out of it and believing it is the
 * precise mistake this function exists to prevent.
 */
export async function readMultisig(client, address, { programId = SQUADS_V4_PROGRAM_ID } = {}) {
  const account = await client.accountInfo(address);
  if (!account) throw new SquadsDecodeError(`no account exists at ${address}`);
  if (account.owner !== programId) {
    throw new SquadsDecodeError(
      `${address} is owned by ${account.owner}, not the Squads V4 program ${programId}; ` +
        "it is not a multisig whatever its bytes say",
    );
  }
  if (account.executable) {
    throw new SquadsDecodeError(`${address} is executable; a multisig account is not a program`);
  }
  const decoded = decodeMultisig(account.data[0]);
  return { ...decoded, address, owner: account.owner, lamports: account.lamports };
}

/**
 * The live account against what the repository claims about it.
 *
 * Returns every disagreement rather than the first, because an operator
 * comparing a configuration wants the whole picture, and because a verifier
 * that stops at the first mismatch hides the others behind it.
 */
export function compareToPolicy(
  decoded,
  {
    multisig,
    threshold,
    members,
    vault,
    vaultIndex = 0,
    requiredPermissionMask = PERMISSION_ALL,
    programId,
  },
) {
  const failures = [];

  if (decoded.threshold !== threshold) {
    failures.push(
      `live threshold is ${decoded.threshold}, the declared threshold is ${threshold}`,
    );
  }
  if (decoded.members.length !== members.length) {
    failures.push(
      `the live multisig has ${decoded.members.length} member(s), ${members.length} were declared`,
    );
  }

  const liveKeys = decoded.members.map((member) => member.key);
  const liveSet = new Set(liveKeys);
  if (liveSet.size !== liveKeys.length) {
    failures.push("the live member list contains duplicate keys");
  }
  for (const declared of members) {
    if (!liveSet.has(declared)) failures.push(`declared member ${declared} is not a live member`);
  }
  for (const live of liveKeys) {
    if (!members.includes(live)) {
      failures.push(`live member ${live} is not in the declared member set`);
    }
  }

  for (const member of decoded.members) {
    if (member.mask !== requiredPermissionMask) {
      failures.push(
        `live member ${member.key} has permission mask ${member.mask} ` +
          `(${member.permissions.join(" + ") || "none"}), policy requires mask ` +
          `${requiredPermissionMask} (${permissionNames(requiredPermissionMask).join(" + ")})`,
      );
    }
  }

  if (vault) {
    const multisigAddress = multisig ?? decoded.address;
    if (!multisigAddress) {
      throw new SquadsDecodeError(
        "cannot derive a vault without the multisig address; pass `multisig`",
      );
    }
    const derived = deriveVault(
      multisigAddress,
      vaultIndex,
      programId ?? SQUADS_V4_PROGRAM_ID,
    );
    if (derived.address !== vault) {
      failures.push(
        `vault index ${vaultIndex} of the live multisig derives to ${derived.address}, ` +
          `not the declared custody vault ${vault}`,
      );
    }
  }

  return failures;
}
