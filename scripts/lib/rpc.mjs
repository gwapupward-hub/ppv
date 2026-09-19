/**
 * A minimal Solana JSON-RPC client.
 *
 * Dependency-free so the smoke suite's network guards can run before any
 * install, and so a test can point it at a local server and exercise the same
 * code path a real cluster would take.
 *
 * READ ONLY, and structurally so. Every method this client is allowed to send
 * is a query; the mutating ones are refused before a request is built. That is
 * what makes the bounded 429 retry below safe: a retry here can duplicate a
 * question, never an instruction. Value-moving transactions go through
 * `@solana/web3.js` in `scripts/lib/custody-runner.mjs` and inherit none of
 * this.
 */

import { createHash } from "node:crypto";

import { SAFE_ENDPOINT_LABEL } from "./endpoint-safety.mjs";
import { UPGRADEABLE_LOADER_ID } from "./identity.mjs";
import { encodeBase58 } from "./pubkey.mjs";

export class RpcError extends Error {
  constructor(message) {
    super(message);
    this.name = "RpcError";
  }
}

/** The classification a caller should report rather than a custody finding. */
export const RPC_RATE_LIMIT = "RPC_RATE_LIMIT";

/**
 * The endpoint refused to serve a read because this client asked too often.
 *
 * A distinct type because the response to it is distinct. It is a fact about
 * the public endpoint's rate limiter and about nothing else — not about the
 * deployed program, not about custody, and not about an invariant. Run
 * 35405785493 died of this and the run summary had no way to say so.
 */
export class RpcRateLimitError extends RpcError {
  constructor(message) {
    super(message);
    this.name = "RpcRateLimitError";
    this.classification = RPC_RATE_LIMIT;
  }
}

/** The one status this client retries. Not 4xx generally, and not 5xx. */
export const RATE_LIMIT_STATUS = 429;

/**
 * One request, then at most this many more.
 *
 * A ceiling rather than a policy knob: an unbounded retry against a rate
 * limiter is indistinguishable from a hang, and a live custody run that hangs
 * burns an authorization without producing evidence.
 */
export const RATE_LIMIT_MAX_RETRIES = 4;

/** Base delay before retry 1, 2, 3, 4. Doubling, and nothing beyond the last. */
export const RATE_LIMIT_BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000]);

/**
 * No single wait exceeds this, however long `Retry-After` asks for.
 *
 * A public endpoint that says "come back in an hour" is not something to sit
 * through inside a CI job; the run should fail and say why.
 */
export const RATE_LIMIT_MAX_DELAY_MS = 8_000;

/**
 * Methods that may be retried.
 *
 * An allowlist, not a denylist, so a method nobody has thought about gets zero
 * retries rather than the benefit of the doubt.
 */
export const RETRYABLE_READ_METHODS = Object.freeze([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTransaction",
  "getVersion",
]);

/**
 * Methods this client refuses to send at all.
 *
 * The retry above is only defensible because nothing that changes chain state
 * can reach it. Rather than leave that as a property of today's callers, it is
 * enforced here: a future caller that tries to submit through the read client
 * gets an error instead of an automatic resend of a value-moving transaction.
 */
export const REFUSED_MUTATING_METHODS = Object.freeze([
  "requestAirdrop",
  "sendTransaction",
  "simulateTransaction",
]);

/**
 * `Retry-After` in milliseconds, or null when it is absent or not sane.
 *
 * Both forms the header takes are accepted: delay-seconds, and an HTTP date.
 * Anything else — a negative delay, an unparseable date, junk — returns null
 * and the caller falls back to its own schedule rather than trusting a number
 * it could not read.
 */
export function parseRetryAfter(value, { now = Date.now(), maxDelayMs = RATE_LIMIT_MAX_DELAY_MS } = {}) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, maxDelayMs);
  }

  // An HTTP-date always carries a day or month name, and `Date.parse` is far
  // too willing without that check: `Date.parse("-5")` is not NaN, it is a
  // date in the year 5 BC, so a negative delay-seconds would be read as a
  // timestamp long past and quietly accepted.
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
 * window and we do not. Otherwise the doubling schedule applies, with equal
 * jitter: half the base delay plus a random share of the other half, so two
 * clients that hit the limit together do not come back together. `random` is
 * injectable, and `random: () => 1` yields exactly the documented schedule,
 * which is what the tests assert against.
 */
export function rateLimitDelayMs(attempt, retryAfterHeader, { now = Date.now(), random = Math.random } = {}) {
  const honoured = parseRetryAfter(retryAfterHeader, { now });
  if (honoured !== null) return honoured;
  const base = RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length) - 1];
  const capped = Math.min(base, RATE_LIMIT_MAX_DELAY_MS);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/**
 * One safe word for why a request never got an answer.
 *
 * Drawn from a fixed list rather than from the error's own text: undici puts
 * the full request — endpoint included — inside a transport error, so the
 * message is classified, never quoted.
 */
export function transportReason(error) {
  const code = String(error?.cause?.code ?? error?.code ?? "");
  const known = {
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
  return known[code] ?? "the request failed before a response arrived";
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Genesis hashes that identify a cluster. Mainnet is here to be refused. */
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function rpc(
  endpoint,
  {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    random = Math.random,
    maxRateLimitRetries = RATE_LIMIT_MAX_RETRIES,
  } = {},
) {
  if (!fetchImpl) throw new RpcError("no fetch implementation available");
  let nextId = 1;

  /**
   * One JSON-RPC call, retried only when the endpoint says "too many requests".
   *
   * Everything else fails on the first response. A 400 is a malformed request
   * and repeating it changes nothing; a 401 or 403 is an authorization answer
   * and repeating it is worse than useless; a 5xx might be transient but is
   * also how some endpoints report a request they could not run, so it is left
   * alone here rather than broadened without evidence.
   *
   * No error raised here contains the request body, the parameters, or the
   * endpoint's response text — only the method name and the status.
   */
  async function call(method, params = []) {
    if (REFUSED_MUTATING_METHODS.includes(method)) {
      throw new RpcError(
        `${method} is not available on the read-only RPC client. It retries safe reads, and ` +
          "retrying a submission could send a value-moving transaction twice.",
      );
    }
    const retryable = RETRYABLE_READ_METHODS.includes(method);
    const maxRetries = retryable ? maxRateLimitRetries : 0;

    let waitedMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        });
      } catch (error) {
        // A transport failure — DNS, TLS, a refused connection — is reported by
        // undici with the request in the error, and for a dedicated endpoint
        // that request carries a credential. Only the method and a one-word
        // reason survive; the original is not chained, because a `cause` is
        // exactly what a future `console.error(error)` would print.
        throw new RpcError(`${method} could not reach ${SAFE_ENDPOINT_LABEL}: ${transportReason(error)}`);
      }

      if (response.status === RATE_LIMIT_STATUS) {
        if (attempt >= maxRetries) {
          throw new RpcRateLimitError(
            `${method} failed with HTTP ${RATE_LIMIT_STATUS} after ${attempt + 1} ` +
              `attempt${attempt === 0 ? "" : "s"}` +
              (waitedMs > 0 ? ` and ${waitedMs}ms of backoff` : "") +
              `. The endpoint is rate limiting this client. This is ${RPC_RATE_LIMIT}: a ` +
              "finding about the RPC endpoint, not about the deployed program.",
          );
        }
        const delay = rateLimitDelayMs(attempt + 1, response.headers?.get?.("retry-after"), {
          now: now(),
          random,
        });
        waitedMs += delay;
        await sleep(delay);
        continue;
      }

      if (!response.ok) throw new RpcError(`${method} failed with HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) {
        throw new RpcError(`${method} failed: ${body.error.message ?? "unknown error"}`);
      }
      return body.result;
    }
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
