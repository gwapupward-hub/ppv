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

/** An `RpcError` the endpoint caused by rate limiting, after the retries ran out. */
export class RpcRateLimitError extends RpcError {
  readonly attempts: number;

  constructor(message: string, attempts: number) {
    super(message);
    this.name = "RpcRateLimitError";
    this.attempts = attempts;
  }
}

/* ------------------------------------------------ bounded 429 tolerance */

/**
 * The only status this client retries.
 *
 * Run 35465469908 completed the whole live custody matrix and then failed in
 * read-only history reconstruction, because `getTransaction` returned HTTP 429
 * once and this client threw on the first one. Replaying a lifecycle reads one
 * transaction per signature, so a run that sends more transactions is more
 * likely to trip a provider's per-second ceiling — precisely when the history
 * is most worth reading.
 */
export const RATE_LIMIT_STATUS = 429;

/** One request, then at most this many more. Never unbounded. */
export const RATE_LIMIT_MAX_RETRIES = 4;

/** Base delay before retry 1, 2, 3, 4. Doubling, and nothing beyond the last. */
export const RATE_LIMIT_BACKOFF_MS: readonly number[] = Object.freeze([500, 1000, 2000, 4000]);

/** No single wait exceeds this, however long `Retry-After` asks for. */
export const RATE_LIMIT_MAX_DELAY_MS = 8_000;

/**
 * The methods this source may send, and therefore the only ones it may retry.
 *
 * An allowlist. A read is safe to repeat because it changes nothing; that is
 * the entire justification for retrying at all, and it does not extend to a
 * method nobody has considered. `sendTransaction` and friends are absent
 * because this source has no business sending one — `httpChainSource` exposes
 * two read methods and `call` is not reachable from outside.
 */
export const READ_ONLY_METHODS: readonly string[] = Object.freeze([
  "getSignaturesForAddress",
  "getTransaction",
]);

/**
 * `Retry-After` in milliseconds, or null when it is absent or not sane.
 *
 * Both forms are accepted: delay-seconds and an HTTP date. An HTTP-date always
 * carries a day or month name, and `Date.parse` is far too willing without
 * that check — `Date.parse("-5")` is not NaN, it is a date in 5 BC, so a
 * negative delay-seconds would be read as a timestamp long past and quietly
 * accepted.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  options: { now?: number; maxDelayMs?: number } = {},
): number | null {
  const now = options.now ?? Date.now();
  const maxDelayMs = options.maxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, maxDelayMs);
  }

  if (!/[A-Za-z]/.test(text)) return null;
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  const delta = when - now;
  if (delta <= 0) return 0;
  return Math.min(delta, maxDelayMs);
}

/**
 * How long to wait before retry number `attempt` (1-based).
 *
 * `Retry-After` wins when the endpoint gave a sane one — it knows its own
 * window and we do not. Otherwise the doubling schedule applies with equal
 * jitter, so two clients that hit the limit together do not come back
 * together. `random: () => 1` yields exactly the documented schedule.
 */
export function rateLimitDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  options: { now?: number; random?: () => number } = {},
): number {
  const now = options.now ?? Date.now();
  const random = options.random ?? Math.random;
  const honoured = parseRetryAfter(retryAfterHeader, { now });
  if (honoured !== null) return honoured;
  const index = Math.max(1, Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length)) - 1;
  const base = RATE_LIMIT_BACKOFF_MS[index] ?? RATE_LIMIT_MAX_DELAY_MS;
  const capped = Math.min(base, RATE_LIMIT_MAX_DELAY_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * One safe word for why a request never got an answer.
 *
 * Drawn from a fixed list rather than from the error's own text: a transport
 * error carries the full request, endpoint included, and a dedicated endpoint
 * may carry a credential in its URL. The message is classified, never quoted.
 */
export function transportReason(error: unknown): string {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = String(candidate?.cause?.code ?? candidate?.code ?? "");
  const known: Record<string, string> = {
    ENOTFOUND: "the host could not be resolved",
    EAI_AGAIN: "the host could not be resolved",
    ECONNREFUSED: "the connection was refused",
    ECONNRESET: "the connection was reset",
    ETIMEDOUT: "the connection timed out",
    UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
    UND_ERR_HEADERS_TIMEOUT: "the response headers timed out",
    UND_ERR_BODY_TIMEOUT: "the response body timed out",
    CERT_HAS_EXPIRED: "the TLS certificate is not valid",
    ERR_TLS_CERT_ALTNAME_INVALID: "the TLS certificate is not valid",
  };
  return known[code] ?? "the request could not be completed";
}

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  json(): Promise<unknown>;
}>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A `ChainSource` backed by an HTTP JSON-RPC endpoint.
 *
 * Reads tolerate a bounded run of HTTP 429 and nothing else. `sleep` and
 * `random` are injectable so the tests prove the schedule without spending it.
 */
export function httpChainSource(
  endpoint: string,
  options?: {
    commitment?: "confirmed" | "finalized";
    fetchImpl?: Fetch;
    maxRateLimitRetries?: number;
    sleepImpl?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
  },
): ChainSource {
  const commitment = options?.commitment ?? "confirmed";
  const doFetch = options?.fetchImpl ?? (globalThis.fetch as unknown as Fetch);
  if (!doFetch) throw new RpcError("no fetch implementation available");
  const maxRateLimitRetries = options?.maxRateLimitRetries ?? RATE_LIMIT_MAX_RETRIES;
  const doSleep = options?.sleepImpl ?? sleep;
  const random = options?.random ?? Math.random;
  const now = options?.now ?? Date.now;

  let nextId = 1;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    // Structural, not advisory. This function is not reachable from outside
    // the source, and the only two callers below name read methods; the guard
    // exists so a future edit that adds a third caller has to think about it.
    if (!READ_ONLY_METHODS.includes(method)) {
      throw new RpcError(
        `${method} is not a read method; this chain source sends reads only and cannot submit ` +
          "a transaction",
      );
    }

    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        });
      } catch (error) {
        // The endpoint may carry a credential in its URL and a transport error
        // quotes the whole request, so the reason is classified, never quoted.
        throw new RpcError(`${method} could not reach the configured RPC endpoint: ${transportReason(error)}`);
      }

      if (response.status === RATE_LIMIT_STATUS) {
        if (attempt >= maxRateLimitRetries) {
          throw new RpcRateLimitError(
            `${method} failed with HTTP ${RATE_LIMIT_STATUS} after ${attempt + 1} attempts. The ` +
              "configured RPC endpoint is rate limiting this client; this is a fact about the " +
              "endpoint and not about the chain.",
            attempt + 1,
          );
        }
        await doSleep(
          rateLimitDelayMs(attempt + 1, response.headers?.get?.("retry-after"), { now: now(), random }),
        );
        continue;
      }

      // Every other status, 4xx and 5xx alike, is final. A read that is
      // refused, unauthorized or served by a broken backend is not made
      // correct by asking again, and a retry loop over it hides the cause.
      if (!response.ok) throw new RpcError(`${method} failed with HTTP ${response.status}`);

      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      // A JSON-RPC error arrived with HTTP 200: the endpoint answered, and the
      // answer is "no". Retrying it is not proven safe, so it is not retried.
      if (body.error) throw new RpcError(`${method} failed: ${body.error.message ?? "unknown error"}`);
      return body.result as T;
    }
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
