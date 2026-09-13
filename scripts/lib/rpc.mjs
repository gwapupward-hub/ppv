/**
 * A minimal Solana JSON-RPC client.
 *
 * Dependency-free so the smoke suite's network guards can run before any
 * install, and so a test can point it at a local server and exercise the same
 * code path a real cluster would take.
 */

import { createHash } from "node:crypto";

import { UPGRADEABLE_LOADER_ID } from "./identity.mjs";
import { encodeBase58 } from "./pubkey.mjs";

export class RpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcError";
  }
}

/** Genesis hashes that identify a cluster. Mainnet is here to be refused. */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function rpc(endpoint, { fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new RpcError("no fetch implementation available");
  let nextId = 1;

  async function call(method, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!response.ok) throw new RpcError(`${method} failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new RpcError(`${method} failed: ${body.error.message ?? "unknown error"}`);
    return body.result;
  }

  return {
    endpoint,
    genesisHash: () => call("getGenesisHash"),
    accountInfo: (address) =>
      call("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]).then(
        (result) => result?.value ?? null,
      ),
    call,
  };
}

/**
 * Reads a program's upgrade authority out of its ProgramData account.
 *
 * The layout is fixed by the BPF upgradeable loader: a 4-byte enum tag (3 =
 * ProgramData), an 8-byte slot, then an Option<Pubkey> for the authority. Read
 * directly rather than through `solana program show`, so verification needs
 * only an RPC endpoint and no CLI.
 */
export function decodeProgramDataAuthority(base64Data) {
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.length < 45) throw new RpcError("ProgramData account is too short");
  const tag = bytes.readUInt32LE(0);
  if (tag !== 3) throw new RpcError(`account is not ProgramData (tag ${tag})`);
  const slot = Number(bytes.readBigUInt64LE(4));
  const hasAuthority = bytes[12];
  if (hasAuthority === 0) return { slot, authority: null };
  if (hasAuthority !== 1) throw new RpcError("invalid Option tag in ProgramData");
  return { slot, authority: bytes.subarray(13, 45) };
}

/** The Program account points at its ProgramData: a 4-byte tag, then a pubkey. */
export function decodeProgramDataAddress(base64Data) {
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.length < 36) throw new RpcError("Program account is too short");
  const tag = bytes.readUInt32LE(0);
  if (tag !== 2) throw new RpcError(`account is not a Program (tag ${tag})`);
  return bytes.subarray(4, 36);
}

/** Bytes the upgradeable loader puts in front of the ELF inside ProgramData. */
export const PROGRAMDATA_HEADER_LEN = 45;

/**
 * Reads the whole deployed state of an upgradeable program: the Program
 * account, the ProgramData account it points at, and the ELF the loader holds.
 *
 * Everything here is a public read. No signer, no wallet and no CLI are
 * involved, which is the property that makes this runnable by anyone who wants
 * to check the release rather than take our word for it.
 *
 * `binaryLength` is the length of the release artifact being checked. The
 * loader allocates ProgramData larger than the program it holds so a later
 * upgrade has room, so the account's tail is zero padding rather than code.
 * Passing the expected length lets the caller compare exactly the deployed ELF
 * and separately assert that the remainder really is padding — which is a
 * stronger statement than trimming trailing zeros and hoping.
 */
export async function readDeployedProgram(client, programId, { binaryLength = null } = {}) {
  const program = await client.accountInfo(programId);
  if (!program) return { exists: false, programId };

  const state = {
    exists: true,
    programId,
    executable: Boolean(program.executable),
    owner: program.owner,
    programDataAddress: null,
    lastDeploySlot: null,
    upgradeAuthority: null,
  };
  if (state.owner !== UPGRADEABLE_LOADER_ID) return state;

  state.programDataAddress = encodeBase58(decodeProgramDataAddress(program.data[0]));
  const programData = await client.accountInfo(state.programDataAddress);
  if (!programData) return state;

  state.programDataOwner = programData.owner;
  const { slot, authority } = decodeProgramDataAuthority(programData.data[0]);
  state.lastDeploySlot = slot;
  state.upgradeAuthority = authority ? encodeBase58(authority) : null;

  const bytes = Buffer.from(programData.data[0], "base64");
  state.programDataLength = bytes.length;
  const elf = bytes.subarray(PROGRAMDATA_HEADER_LEN);
  if (binaryLength !== null) {
    if (elf.length < binaryLength) {
      throw new RpcError(
        `ProgramData holds ${elf.length} bytes, shorter than the ${binaryLength}-byte release artifact`,
      );
    }
    const padding = elf.subarray(binaryLength);
    if (padding.some((byte) => byte !== 0)) {
      throw new RpcError(
        `ProgramData holds ${elf.length} bytes of which only the first ${binaryLength} were expected ` +
          "to be program code, but the remainder is not zero padding",
      );
    }
    state.deployedBinary = elf.subarray(0, binaryLength);
    state.paddingLength = padding.length;
  } else {
    state.deployedBinary = elf;
    state.paddingLength = null;
  }
  state.deployedBinaryHash = createHash("sha256").update(state.deployedBinary).digest("hex");
  return state;
}

/**
 * The confirmation status of one already-submitted transaction.
 *
 * `searchTransactionHistory` is required: a deployment signature is old by the
 * time a release is being verified and has long fallen out of the node's recent
 * status cache.
 */
export async function signatureStatus(client, signature) {
  const result = await client.call("getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  return result?.value?.[0] ?? null;
}
