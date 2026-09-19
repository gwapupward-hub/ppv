/**
 * The live custody transaction lifecycle, made explicit.
 *
 * Run 35430583241 reached almost the entire matrix — ordinary escrow, cancel,
 * refund, both dispute outcomes, milestones, bounty, and the proof path through
 * a live CPI into `ppv_core` — and then died on the final settlement with
 *
 *     Transaction simulation failed: Blockhash not found
 *     Logs: []
 *
 * `Logs: []` is the whole story. The transaction was rejected by *simulation*,
 * before broadcast. `ppv_escrow` never saw the instruction, never evaluated a
 * constraint, and never refused anything. The harness reported it as "expected
 * to succeed and did not", which reads like a protocol finding and is not one.
 *
 * `sendAndConfirmTransaction` cannot tell those apart, and this file exists
 * because two different failures were being wrapped in one sentence:
 *
 *   * a blockhash that expired *before* the transaction was sent — nothing
 *     happened, and sending again is safe;
 *   * everything else — a timeout, a reset socket, a 429, a program error —
 *     where the transaction may already be in flight, and sending again could
 *     move value twice.
 *
 * So the lifecycle here is written out step by step. The signature is computed
 * locally from the signed bytes *before* submission, which is what makes an
 * ambiguous send resolvable: whatever happens to the connection afterwards,
 * the chain can be asked about that exact signature rather than guessed at.
 *
 * Confirmation polls `getSignatureStatuses` over HTTP and never subscribes.
 * Run 35430583241 logged `ws error: Unexpected server response: 429` while the
 * matrix was running; a confirmation path that depends on websocket health
 * turns a provider's subscription quota into a custody finding.
 */

import { Transaction } from "@solana/web3.js";

import { redact } from "./endpoint-safety.mjs";
import { encodeBase58 } from "./pubkey.mjs";
import { signatureStatus } from "./rpc.mjs";

/**
 * What happened to a transaction, named precisely enough to act on.
 *
 * The distinction that matters is submission: everything before it is safe to
 * repeat, and nothing after it is.
 */
export const CLASSIFICATION = Object.freeze({
  /** Simulation rejected a stale blockhash. Nothing was broadcast. */
  PRE_SUBMISSION_BLOCKHASH_EXPIRED: "PRE_SUBMISSION_BLOCKHASH_EXPIRED",
  /** Landed, confirmed, `err == null`. */
  TRANSACTION_SUBMITTED_SUCCESS: "TRANSACTION_SUBMITTED_SUCCESS",
  /** Landed in a block and failed there. This is what a refusal looks like. */
  TRANSACTION_SUBMITTED_PROGRAM_FAILURE: "TRANSACTION_SUBMITTED_PROGRAM_FAILURE",
  /** It may or may not have been submitted. Resolve by signature; never resend. */
  TRANSACTION_CONFIRMATION_AMBIGUOUS: "TRANSACTION_CONFIRMATION_AMBIGUOUS",
  /** The endpoint refused to serve us. A fact about the provider. */
  RPC_RATE_LIMIT: "RPC_RATE_LIMIT",
  /** The endpoint failed some other way. Also a fact about the provider. */
  RPC_PROVIDER_FAILURE: "RPC_PROVIDER_FAILURE",
  /** A transaction that had to be refused was not. */
  CUSTODY_DEFECT: "CUSTODY_DEFECT",
  /** The harness asked for something impossible. */
  HARNESS_DEFECT: "HARNESS_DEFECT",
});

/**
 * One retry, and only for the one case where nothing can have happened.
 *
 * A stale blockhash rejected by simulation is the single failure where the
 * transaction provably did not exist yet. Every other failure gets zero
 * retries, because "try again" and "move the money twice" are the same
 * instruction when you cannot tell whether the first attempt landed.
 */
export const MAX_BLOCKHASH_RETRIES = 1;

/** Bounded confirmation polling. No websocket, no subscription, no `onLogs`. */
export const CONFIRMATION_POLL_INTERVAL_MS = 700;
export const CONFIRMATION_TIMEOUT_MS = 90_000;

/**
 * A short, bounded gap between live submissions.
 *
 * Run 35430583241 drew repeated HTTP 429s and a websocket 429 from a dedicated
 * endpoint. This takes the edge off the burst; it is not a fix for an endpoint
 * that cannot serve the matrix, and it is deliberately too short to be one.
 * `docs/ppv-escrow-release-runbook.md` records the capability the run needs.
 */
export const SUBMISSION_PACING_MS = 250;

/** Confirmation levels that count as landed for custody assertions. */
const ACCEPTED_CONFIRMATIONS = Object.freeze(["confirmed", "finalized"]);

export class TransactionLifecycleError extends Error {
  constructor(message, { classification, signature = null, detail = {} } = {}) {
    super(message);
    this.name = "TransactionLifecycleError";
    this.classification = classification;
    this.signature = signature;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------ classification */

/**
 * Whether a thrown error is simulation rejecting a stale blockhash.
 *
 * Deliberately narrow. It must match the case where the node told us, during
 * preflight, that it does not know the blockhash — and nothing else, because
 * this is the one classification that authorises a resend.
 */
export function isPreSubmissionBlockhashExpiry(error) {
  const text = describeForClassification(error);
  if (!/blockhash not found/i.test(text) && !/BlockhashNotFound/.test(text)) return false;
  // Simulation says so explicitly. An empty log array is the corroborating
  // detail from run 35430583241: no instruction ran.
  if (/simulation failed/i.test(text)) return true;
  // Some providers answer the submit RPC itself with this before broadcasting.
  return /failed to send transaction|sendTransaction/i.test(text);
}

export function isRateLimited(error) {
  const text = describeForClassification(error);
  return /\b429\b/.test(text) || /too many requests/i.test(text);
}

/** Transport-level failure: the request did not complete, one way or another. */
export function isTransportFailure(error) {
  const text = describeForClassification(error);
  return /(fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network error|timed? out|TLS|certificate)/i.test(
    text,
  );
}

function describeForClassification(error) {
  if (!error) return "";
  const parts = [error.message ?? String(error), error.cause?.message ?? "", error.code ?? ""];
  const logs = Array.isArray(error.logs) ? error.logs.join(" ") : "";
  return `${parts.join(" ")} ${logs}`;
}

/** The pieces of an error a public record may carry: no endpoint, no key. */
export function describeSafely(error) {
  if (!error) return "unknown error";
  const logs = Array.isArray(error.logs) ? ` :: ${error.logs.join(" | ")}` : "";
  return redact(`${error.message ?? String(error)}${logs}`);
}

/**
 * The program error code out of an on-chain `err`, not out of a message.
 *
 * Reading the structured status is the point. Run 35430583241 recorded every
 * refusal as `code null` because the code was being scraped from a client
 * exception's prose; the chain reports it as data.
 */
export function extractOnChainErrorCode(err) {
  if (!err || typeof err !== "object") return { name: null, number: null, kind: null };
  const instruction = err.InstructionError;
  if (!Array.isArray(instruction)) {
    return { name: null, number: null, kind: Object.keys(err)[0] ?? null };
  }
  const [, detail] = instruction;
  if (detail && typeof detail === "object" && Number.isInteger(detail.Custom)) {
    return { name: null, number: detail.Custom, kind: "Custom" };
  }
  if (typeof detail === "string") return { name: detail, number: null, kind: detail };
  return { name: null, number: null, kind: "InstructionError" };
}

/* ------------------------------------------------------------- the lifecycle */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds, signs, and returns the transaction together with the signature it
 * will have — before anything is sent.
 *
 * `lastValidBlockHeight` is carried alongside `recentBlockhash` so a caller can
 * reason about expiry rather than discover it. The signature is derived from
 * the signed bytes, so it is known even if the submission call never returns.
 */
export async function prepareTransaction({ connection, instructions, signers, commitment = "confirmed" }) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
  const transaction = new Transaction().add(...instructions);
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = signers[0].publicKey;
  transaction.sign(...signers);
  if (!transaction.signature) {
    throw new TransactionLifecycleError("the transaction did not produce a signature after signing", {
      classification: CLASSIFICATION.HARNESS_DEFECT,
    });
  }
  return {
    transaction,
    signature: encodeBase58(transaction.signature),
    blockhash,
    lastValidBlockHeight,
  };
}

/**
 * Polls `getSignatureStatuses` until the signature resolves or the clock runs out.
 *
 * HTTP only, through the read client that already carries the bounded 429
 * policy. A `null` status means the node has not seen it yet, which is not the
 * same as "it does not exist" — hence the deadline rather than a single look.
 */
export async function confirmBySignature(
  client,
  signature,
  {
    timeoutMs = CONFIRMATION_TIMEOUT_MS,
    intervalMs = CONFIRMATION_POLL_INTERVAL_MS,
    now = () => Date.now(),
    wait = sleep,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await signatureStatus(client, signature);
    if (last) {
      const level = last.confirmationStatus ?? null;
      const landed = level === null ? Boolean(last.confirmations === null) : ACCEPTED_CONFIRMATIONS.includes(level);
      if (landed || last.err) {
        return { found: true, status: last, confirmationStatus: level, err: last.err ?? null };
      }
    }
    if (now() >= deadline) {
      return { found: Boolean(last), status: last, confirmationStatus: last?.confirmationStatus ?? null, err: last?.err ?? null, timedOut: true };
    }
    await wait(intervalMs);
  }
}

/**
 * A transaction that must succeed.
 *
 * The only automatic retry is a fresh blockhash after simulation rejected a
 * stale one, and it is taken at most `MAX_BLOCKHASH_RETRIES` times. Anything
 * else that goes wrong after the submit call is entered is treated as possibly
 * submitted: the known signature is looked up on chain, and the transaction is
 * never sent a second time.
 */
export async function sendExpectingSuccess({
  connection,
  client,
  instructions,
  signers,
  label,
  maxBlockhashRetries = MAX_BLOCKHASH_RETRIES,
  pacingMs = SUBMISSION_PACING_MS,
  confirmOptions = {},
  wait = sleep,
}) {
  let blockhashAttempts = 0;

  for (;;) {
    const prepared = await prepareTransaction({ connection, instructions, signers });
    if (pacingMs > 0) await wait(pacingMs);

    let submitted = false;
    try {
      await connection.sendRawTransaction(prepared.transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 0,
      });
      submitted = true;
    } catch (error) {
      // Nothing was broadcast: simulation refused the blockhash before the
      // node accepted the transaction. This is the one safe resend.
      if (isPreSubmissionBlockhashExpiry(error)) {
        if (blockhashAttempts >= maxBlockhashRetries) {
          throw new TransactionLifecycleError(
            `${label} could not be submitted: the blockhash expired before simulation ` +
              `${blockhashAttempts + 1} times. The instruction never reached the program, so this ` +
              "is a finding about the RPC endpoint and not about custody.",
            { classification: CLASSIFICATION.PRE_SUBMISSION_BLOCKHASH_EXPIRED },
          );
        }
        blockhashAttempts += 1;
        continue;
      }

      // Everything else may already be in flight. Ask the chain about the
      // signature we computed before sending; never send it again.
      const resolved = await confirmBySignature(client, prepared.signature, confirmOptions);
      if (resolved.found && !resolved.err) {
        return {
          signature: prepared.signature,
          classification: CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS,
          confirmationStatus: resolved.confirmationStatus,
          resolvedAfterAmbiguity: true,
        };
      }
      throw new TransactionLifecycleError(
        `${label} may or may not have been submitted, and its signature did not resolve to a ` +
          `confirmed success. It was NOT resent. ${describeSafely(error)}`,
        {
          classification: classifyAmbiguity(error, resolved),
          signature: prepared.signature,
          detail: { err: resolved.err ?? null, found: resolved.found },
        },
      );
    }

    if (!submitted) continue;

    const resolved = await confirmBySignature(client, prepared.signature, confirmOptions);
    if (!resolved.found || resolved.timedOut) {
      throw new TransactionLifecycleError(
        `${label} was submitted but did not confirm within the deadline. Its signature is known ` +
          "and it was NOT resent; resolve it from chain state before doing anything else.",
        {
          classification: CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS,
          signature: prepared.signature,
        },
      );
    }
    if (resolved.err) {
      throw new TransactionLifecycleError(
        `${label} was expected to succeed and the program rejected it on chain: ` +
          `${JSON.stringify(resolved.err)}`,
        {
          classification: CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE,
          signature: prepared.signature,
          detail: { err: resolved.err, errorCode: extractOnChainErrorCode(resolved.err) },
        },
      );
    }
    return {
      signature: prepared.signature,
      classification: CLASSIFICATION.TRANSACTION_SUBMITTED_SUCCESS,
      confirmationStatus: resolved.confirmationStatus,
      resolvedAfterAmbiguity: false,
    };
  }
}

function classifyAmbiguity(error, resolved) {
  if (resolved?.found && resolved.err) return CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE;
  if (isRateLimited(error)) return CLASSIFICATION.RPC_RATE_LIMIT;
  if (isTransportFailure(error)) return CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS;
  return CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS;
}

/**
 * A transaction that must be refused, proved by a failed transaction on chain.
 *
 * `skipPreflight` is on so the transaction actually reaches the program: with
 * preflight, the node's simulator rejects it and it never lands, which proves
 * the simulator agrees rather than that the deployed program refuses.
 *
 * The old implementation caught any thrown error and called it a refusal. That
 * is not evidence. A 429, a reset socket or an expired blockhash would have
 * been recorded as "the program refused this" — in a run that was, at the time,
 * being served 429s. A refusal is now only a refusal when the signature is
 * found on chain carrying an error.
 */
export async function sendExpectingRefusal({
  connection,
  client,
  instructions,
  signers,
  label,
  maxBlockhashRetries = MAX_BLOCKHASH_RETRIES,
  pacingMs = SUBMISSION_PACING_MS,
  confirmOptions = {},
  fetchLogs = null,
  escrowProgramId = null,
  wait = sleep,
}) {
  let blockhashAttempts = 0;

  for (;;) {
    const prepared = await prepareTransaction({ connection, instructions, signers });
    if (pacingMs > 0) await wait(pacingMs);

    try {
      await connection.sendRawTransaction(prepared.transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });
    } catch (error) {
      if (isPreSubmissionBlockhashExpiry(error)) {
        if (blockhashAttempts >= maxBlockhashRetries) {
          throw new TransactionLifecycleError(
            `${label} could not be submitted: the blockhash expired before broadcast. This is NOT ` +
              "a refusal — the program never saw the instruction.",
            { classification: CLASSIFICATION.PRE_SUBMISSION_BLOCKHASH_EXPIRED },
          );
        }
        blockhashAttempts += 1;
        continue;
      }
      // The submit call failed for some other reason. It may still have
      // reached the node, so the signature is checked rather than assumed —
      // but a throw here is never by itself evidence of a refusal.
      const resolved = await confirmBySignature(client, prepared.signature, confirmOptions);
      if (!resolved.found) {
        throw new TransactionLifecycleError(
          `${label} never landed on chain, so nothing was refused. This is a finding about the ` +
            `RPC endpoint, not about the program. ${describeSafely(error)}`,
          {
            classification: isRateLimited(error)
              ? CLASSIFICATION.RPC_RATE_LIMIT
              : CLASSIFICATION.RPC_PROVIDER_FAILURE,
            signature: prepared.signature,
          },
        );
      }
      return finishRefusal({ label, prepared, resolved, fetchLogs, escrowProgramId });
    }

    const resolved = await confirmBySignature(client, prepared.signature, confirmOptions);
    if (!resolved.found || resolved.timedOut) {
      throw new TransactionLifecycleError(
        `${label} was submitted but no status for its signature appeared within the deadline. A ` +
          "transaction that did not land refuses nothing; this is infrastructure, not a negative " +
          "test result.",
        {
          classification: CLASSIFICATION.TRANSACTION_CONFIRMATION_AMBIGUOUS,
          signature: prepared.signature,
        },
      );
    }
    return finishRefusal({ label, prepared, resolved, fetchLogs, escrowProgramId });
  }
}

/**
 * Turns a landed status into a refusal record, or into a custody defect.
 *
 * A landed transaction with `err == null` is the case this whole path exists to
 * catch: something the repository claims is impossible succeeded.
 */
async function finishRefusal({ label, prepared, resolved, fetchLogs, escrowProgramId }) {
  if (!resolved.err) {
    throw new TransactionLifecycleError(
      `${label} was expected to be refused and SUCCEEDED on chain (signature ${prepared.signature}). ` +
        "A guard the repository claims exists did not refuse this.",
      {
        classification: CLASSIFICATION.CUSTODY_DEFECT,
        signature: prepared.signature,
        detail: { label },
      },
    );
  }

  // Best effort, and recorded as such. The hard requirement is already met —
  // the signature landed and carries an error — and a rate-limited log read
  // must not turn a proven refusal into a failure.
  let logs = null;
  let programAttributed = "unverified";
  if (fetchLogs) {
    try {
      logs = await fetchLogs(prepared.signature);
    } catch {
      logs = null;
    }
    if (Array.isArray(logs) && escrowProgramId) {
      programAttributed = logs.some((line) => line.includes(escrowProgramId)) ? "ppv_escrow" : "other";
    }
  }

  return {
    signature: prepared.signature,
    onChain: true,
    err: resolved.err,
    errorCode: extractOnChainErrorCode(resolved.err),
    confirmationStatus: resolved.confirmationStatus,
    classification: CLASSIFICATION.TRANSACTION_SUBMITTED_PROGRAM_FAILURE,
    programAttributed,
    logs: Array.isArray(logs) ? logs.map((line) => redact(line)) : null,
  };
}

/**
 * The shape every refusal row in published evidence must have.
 *
 * Asserted at the point of writing rather than trusted, because the whole
 * argument of the negative suite is that these rows are backed by transactions
 * anyone can look up.
 */
export function assertProvenRefusal(row) {
  if (!row || typeof row !== "object") {
    throw new TransactionLifecycleError("a refusal record is missing entirely", {
      classification: CLASSIFICATION.HARNESS_DEFECT,
    });
  }
  if (!row.signature) {
    throw new TransactionLifecycleError(
      `the refusal "${row.label ?? "unnamed"}" has no transaction signature; an exception thrown by ` +
        "the client is not evidence that the program refused anything",
      { classification: CLASSIFICATION.HARNESS_DEFECT },
    );
  }
  if (row.onChain !== true) {
    throw new TransactionLifecycleError(
      `the refusal "${row.label ?? "unnamed"}" was not proved to have landed on chain`,
      { classification: CLASSIFICATION.HARNESS_DEFECT, signature: row.signature },
    );
  }
  if (row.err === null || row.err === undefined) {
    throw new TransactionLifecycleError(
      `the refusal "${row.label ?? "unnamed"}" landed without an error, which is a custody defect ` +
        "rather than a refusal",
      { classification: CLASSIFICATION.CUSTODY_DEFECT, signature: row.signature },
    );
  }
  return row;
}
