/**
 * Reading the custody funder's keypair without ever quoting it back.
 *
 * Run 35393227976 stopped at the funder preflight because
 * `PPV_CUSTODY_FUNDER_KEYPAIR` was not keypair JSON. That much was correct: a
 * bad secret should stop the job before anything is signed. What was not
 * correct is what the job then printed.
 *
 * The preflight caught the error and printed `error.message`, on the stated
 * reasoning that the message was safer than the error object. For `JSON.parse`
 * the opposite is true — the message is the part that quotes the input:
 *
 *     Unexpected token 'N', "NOT-A-REAL"... is not valid JSON
 *
 * Ten characters of the supplied secret, in a log that outlives the run. A
 * value that parses *almost* correctly leaks a prefix of a live key.
 *
 * So this module never produces a diagnostic derived from its input. Every
 * rejection returns the same constant, whatever went wrong and wherever in the
 * value it went wrong. That is a deliberate loss of debuggability: the operator
 * reformats their secret rather than reading which byte offended, and the log
 * says nothing either way.
 *
 * Nothing here imports `@solana/web3.js`. Validation is byte arithmetic, and
 * keeping it dependency-free is what lets `scripts/test/funder-secret.test.mjs`
 * hammer it with malformed fixtures directly instead of only through a process.
 */

import { readFileSync } from "node:fs";

/**
 * The only thing any caller may print about a rejected secret.
 *
 * It names the variable and the expected shape — enough to fix the secret —
 * and says nothing whatsoever about the value that was supplied. No offset, no
 * length, no prefix, no parser text.
 */
export const FUNDER_SECRET_FORMAT_ERROR =
  "PPV_CUSTODY_FUNDER_KEYPAIR has invalid format; expected a Solana keypair JSON byte array";

/**
 * Distinct from the format error because it is not about the value at all: the
 * file the workflow wrote could not be read back. It is derived from nothing
 * the secret contains.
 */
export const FUNDER_SECRET_UNREADABLE_ERROR =
  "the funder keypair file could not be read; PPV_CUSTODY_FUNDER_KEYPAIR was not written to disk";

/**
 * Secret-key lengths a Solana keypair may have.
 *
 * ed25519 keeps the 32-byte seed and the 32-byte public key side by side, so
 * `Keypair.fromSecretKey` takes 64 bytes and only 64. Written as a list because
 * "the supported lengths" is the concept being asserted; a 32-byte seed is not
 * silently accepted and padded, it is rejected.
 */
export const SUPPORTED_SECRET_KEY_LENGTHS = Object.freeze([64]);

/** Every byte must be an integer in this inclusive range. */
export const MIN_SECRET_BYTE = 0;
export const MAX_SECRET_BYTE = 255;

/**
 * An error whose message is a constant.
 *
 * Carries no `cause`, no offset and no fragment, so there is nothing for a
 * caller to accidentally unwrap and print. A caller that prints
 * `error.message` on one of these prints exactly the constant above.
 */
export class FunderSecretError extends Error {
  constructor(message) {
    super(message);
    this.name = "FunderSecretError";
  }
}

/**
 * Validates `raw` as a Solana keypair JSON byte array.
 *
 * Returns `{ ok: true, secretKey }` or `{ ok: false, error }` where `error` is
 * one of the constants above. It does not throw on bad input — a thrown parse
 * error is precisely the thing that leaked — and it never returns a reason
 * computed from the input.
 *
 * The checks run in this order because each one is what makes the next one
 * meaningful:
 *
 *   1. it is JSON at all;
 *   2. it is an array, not an object with a `secretKey` field, not a string;
 *   3. it is a supported length — checked before the elements, so a truncated
 *      array is rejected without ever iterating what it does contain;
 *   4. every element is an integer (not `1.5`, not `"12"`, not `null`);
 *   5. every element is a byte.
 */
export function parseFunderSecret(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The caught error is dropped on the floor, unread. This empty block is
    // the fix: `JSON.parse`'s message quotes the input it rejected.
    return { ok: false, error: FUNDER_SECRET_FORMAT_ERROR };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: FUNDER_SECRET_FORMAT_ERROR };
  }
  if (!SUPPORTED_SECRET_KEY_LENGTHS.includes(parsed.length)) {
    return { ok: false, error: FUNDER_SECRET_FORMAT_ERROR };
  }
  for (const element of parsed) {
    if (!Number.isInteger(element)) {
      return { ok: false, error: FUNDER_SECRET_FORMAT_ERROR };
    }
    if (element < MIN_SECRET_BYTE || element > MAX_SECRET_BYTE) {
      return { ok: false, error: FUNDER_SECRET_FORMAT_ERROR };
    }
  }

  return { ok: true, secretKey: Uint8Array.from(parsed) };
}

/**
 * `parseFunderSecret` against a file, with the read failure kept separate.
 *
 * The contents are never held anywhere but the local `raw`, and never appear
 * in a return value except as validated bytes.
 */
export function readFunderSecret(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: FUNDER_SECRET_UNREADABLE_ERROR };
  }
  return parseFunderSecret(raw);
}

/**
 * The throwing form, for callers that are already inside a try/catch.
 *
 * Throws `FunderSecretError` — whose message is a constant — so a top-level
 * handler that prints `error.message` stays safe by construction.
 */
export function loadFunderSecretOrThrow(path) {
  const result = readFunderSecret(path);
  if (!result.ok) {
    throw new FunderSecretError(result.error);
  }
  return result.secretKey;
}
