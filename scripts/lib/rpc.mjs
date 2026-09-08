/**
 * A minimal Solana JSON-RPC client.
 *
 * Dependency-free so the smoke suite's network guards can run before any
 * install, and so a test can point it at a local server and exercise the same
 * code path a real cluster would take.
 */

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
