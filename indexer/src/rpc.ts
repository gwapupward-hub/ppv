/**
 * The shape of the Solana JSON-RPC responses this indexer reads, and a minimal
 * client for them.
 *
 * Deliberately the raw RPC shapes rather than a client library's objects: the
 * indexer is the demonstration that PPV history is reconstructible from a
 * public RPC endpoint and the PPV SDK, with no privileged access and no
 * proprietary database. A dependency here would make that claim harder to
 * check, not easier.
 */

export type RpcInstruction = {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
};

export type RpcInnerInstructions = {
  /** Index of the outer instruction these were invoked from. */
  index: number;
  instructions: RpcInstruction[];
};

export type RpcTransaction = {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: RpcInstruction[];
    };
  };
  meta: {
    err: unknown | null;
    innerInstructions?: RpcInnerInstructions[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
};

export type RpcSignatureEntry = {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime?: number | null;
};

export type SignaturePage = {
  /** Return signatures older than this one. Paging runs newest to oldest. */
  before?: string;
  limit?: number;
};

/**
 * Everything the indexer needs from a chain. Narrow on purpose: tests supply a
 * fixture implementation, and no test needs a validator to run.
 */
export type ChainSource = {
  signaturesForAddress(address: string, page?: SignaturePage): Promise<RpcSignatureEntry[]>;
  transaction(signature: string): Promise<RpcTransaction | null>;
};

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** A `ChainSource` backed by an HTTP JSON-RPC endpoint. */
export function httpChainSource(
  endpoint: string,
  options?: { commitment?: "confirmed" | "finalized"; fetchImpl?: Fetch },
): ChainSource {
  const commitment = options?.commitment ?? "confirmed";
  const doFetch = options?.fetchImpl ?? (globalThis.fetch as unknown as Fetch);
  if (!doFetch) throw new RpcError("no fetch implementation available");

  let nextId = 1;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!response.ok) throw new RpcError(`${method} failed with HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new RpcError(`${method} failed: ${body.error.message ?? "unknown error"}`);
    return body.result as T;
  }

  return {
    async signaturesForAddress(address, page) {
      return call<RpcSignatureEntry[]>("getSignaturesForAddress", [
        address,
        { commitment, ...(page?.before ? { before: page.before } : {}), ...(page?.limit ? { limit: page.limit } : {}) },
      ]);
    },
    async transaction(signature) {
      return call<RpcTransaction | null>("getTransaction", [
        signature,
        { commitment, encoding: "json", maxSupportedTransactionVersion: 0 },
      ]);
    },
  };
}
