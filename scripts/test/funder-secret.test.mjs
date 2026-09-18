import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair } from "@solana/web3.js";

import {
  FUNDER_SECRET_FORMAT_ERROR,
  FUNDER_SECRET_UNREADABLE_ERROR,
  FunderSecretError,
  MAX_SECRET_BYTE,
  SUPPORTED_SECRET_KEY_LENGTHS,
  loadFunderSecretOrThrow,
  parseFunderSecret,
  readFunderSecret,
} from "../lib/funder-secret.mjs";

/**
 * The funder-secret validator, and the property that matters most about it:
 * nothing it says about a rejected value is derived from that value.
 *
 * Run 35393227976 failed here with a malformed `PPV_CUSTODY_FUNDER_KEYPAIR`,
 * and the old code printed `JSON.parse`'s message — which quotes the first ten
 * characters of whatever it rejected. A secret that is almost right therefore
 * leaks a prefix of a live key into a permanent Actions log.
 *
 * So the assertions below are not "it rejects bad input". They are "when it
 * rejects bad input, no run of four or more characters from that input appears
 * anywhere in what it produced".
 */

/**
 * Fixtures are fixed strings rather than generated ones, so that
 * `noFragmentLeaked` is a deterministic assertion. A random base58 blob could,
 * once in a great while, share a four-character run with the constant error
 * message and fail a test for a reason that has nothing to do with the code.
 *
 * None of these is a real key. The base58-shaped one is keyboard noise in the
 * base58 alphabet, which is exactly the mistake that produced the outage: a
 * `solana-keygen` public/private string pasted where the byte array goes.
 */
const MALFORMED = Object.freeze({
  "a base58-looking private key string": "gWapUpwardFixtureNotAKeyJustNoiseWithTheBase58Shape",
  // Leading digit, which `JSON.parse` starts to read as a number before it
  // gives up — a different rejection path through the same function.
  "a base58 string that starts with a digit": "3zzPPVnotARealKeyJustBase58AlphabetNoiseForThisTest1",
  "malformed JSON": "[12, 34, 56",
  "a JSON object instead of an array": '{"secretKey":[1,2,3],"publicKey":"9xQeWvG8"}',
  "an out-of-range byte": JSON.stringify([...Array(63).fill(7), 256]),
  "a truncated array": JSON.stringify(Array(32).fill(7)),
  "a quoted JSON string": '"NOT-A-REAL-KEY-BUT-TREAT-IT-AS-ONE"',
  "a non-integer element": JSON.stringify([...Array(63).fill(7), 1.5]),
  "a null element": JSON.stringify([...Array(63).fill(7), null]),
  "a numeric string element": JSON.stringify([...Array(63).fill(7), "12"]),
  "a negative byte": JSON.stringify([...Array(63).fill(7), -1]),
  "an over-long array": JSON.stringify(Array(65).fill(7)),
  "an empty array": "[]",
});

/** The shortest run of input characters we treat as a leak. */
const LEAK_WINDOW = 4;

/**
 * Asserts that no contiguous run of `LEAK_WINDOW` or more characters from
 * `input` appears in `output`.
 *
 * Checking every window of exactly `LEAK_WINDOW` is sufficient: any longer
 * shared run contains a shorter one, so a leak of any length trips this.
 */
function noFragmentLeaked(output, input, context) {
  for (let i = 0; i + LEAK_WINDOW <= input.length; i += 1) {
    const window = input.slice(i, i + LEAK_WINDOW);
    assert.ok(
      !output.includes(window),
      `${context}: the fragment ${JSON.stringify(window)} from the supplied secret reached the output`,
    );
  }
}

/* ------------------------------------------------------------- what it accepts */

test("a real 64-byte keypair array is accepted and returned verbatim", () => {
  const keypair = Keypair.generate();
  const result = parseFunderSecret(JSON.stringify(Array.from(keypair.secretKey)));
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.secretKey), Array.from(keypair.secretKey));
  // The bytes must survive as bytes: `Keypair.fromSecretKey` is next.
  assert.ok(result.secretKey instanceof Uint8Array);
  assert.equal(
    Keypair.fromSecretKey(result.secretKey).publicKey.toBase58(),
    keypair.publicKey.toBase58(),
  );
});

test("whitespace and a trailing newline are tolerated, as a file would carry them", () => {
  const keypair = Keypair.generate();
  const raw = ` ${JSON.stringify(Array.from(keypair.secretKey))}\n`;
  assert.equal(parseFunderSecret(raw).ok, true);
});

test("the boundary bytes 0 and 255 are valid values, not rejected as sentinels", () => {
  const bytes = Array(64).fill(7);
  bytes[0] = 0;
  bytes[1] = MAX_SECRET_BYTE;
  const result = parseFunderSecret(JSON.stringify(bytes));
  assert.equal(result.ok, true);
  assert.equal(result.secretKey[1], 255);
});

test("64 is the only supported length", () => {
  assert.deepEqual([...SUPPORTED_SECRET_KEY_LENGTHS], [64]);
  // A 32-byte seed is a real thing that is not a keypair. It must be rejected
  // rather than padded into one.
  assert.equal(parseFunderSecret(JSON.stringify(Array(32).fill(7))).ok, false);
});

/* ------------------------------------------------------------- what it rejects */

for (const [description, raw] of Object.entries(MALFORMED)) {
  test(`${description} is rejected with the constant message`, () => {
    const result = parseFunderSecret(raw);
    assert.equal(result.ok, false, `${description} was accepted`);
    assert.equal(result.error, FUNDER_SECRET_FORMAT_ERROR);
    assert.equal(result.secretKey, undefined, "a rejected value must not return bytes");
  });

  test(`${description} leaks no fragment of itself`, () => {
    const result = parseFunderSecret(raw);
    // Everything the function produced, not just the message: a reason, a
    // cause or an offset smuggled onto the result object would surface here.
    noFragmentLeaked(JSON.stringify(result), raw, description);
  });
}

test("rejection never throws, so no parser message can escape to a caller", () => {
  for (const raw of [...Object.values(MALFORMED), "", undefined, null, 12]) {
    assert.doesNotThrow(() => parseFunderSecret(raw));
  }
});

/**
 * The specific regression.
 *
 * `JSON.parse` quotes the first ten characters of what it rejected. The
 * previous funder preflight printed that message, so this exact fragment
 * reached the Actions log in run 35393227976's failure mode.
 */
test("the JSON.parse fragment that leaked in run 35393227976 is gone", () => {
  const supplied = "NOT-A-REAL-KEY-BUT-TREAT-IT-AS-ONE";
  let parserMessage = "";
  try {
    JSON.parse(supplied);
  } catch (error) {
    parserMessage = error.message;
  }
  // Confirm the hazard is real before asserting it is handled: if a future
  // Node stops quoting the input, this test should say so rather than pass
  // vacuously.
  assert.ok(
    parserMessage.includes(supplied.slice(0, 10)),
    "this Node no longer quotes the input; the assertion below proves less than it did",
  );

  const result = parseFunderSecret(supplied);
  assert.equal(result.error, FUNDER_SECRET_FORMAT_ERROR);
  assert.ok(!result.error.includes(supplied.slice(0, 10)));
  noFragmentLeaked(JSON.stringify(result), supplied, "run 35393227976 fixture");
});

test("the constant message names the variable and the shape, and no value", () => {
  assert.equal(
    FUNDER_SECRET_FORMAT_ERROR,
    "PPV_CUSTODY_FUNDER_KEYPAIR has invalid format; expected a Solana keypair JSON byte array",
  );
  // No format specifier by which a caller could interpolate the input.
  assert.ok(!/[%{$]/.test(FUNDER_SECRET_FORMAT_ERROR));
});

/* ---------------------------------------------------------------- file reading */

test("an unreadable file is reported as unreadable, not as bad format", () => {
  const result = readFunderSecret("/nonexistent/ppv/custody-funder.json");
  assert.equal(result.ok, false);
  assert.equal(result.error, FUNDER_SECRET_UNREADABLE_ERROR);
  // The read error's message carries the path and the errno. Neither is
  // secret, but neither is reproduced either — the message is a constant.
  assert.ok(!result.error.includes("ENOENT"));
  assert.ok(!result.error.includes("/nonexistent"));
});

test("the throwing form throws a constant, so a top-level handler stays safe", () => {
  const supplied = "NOT-A-REAL-KEY-BUT-TREAT-IT-AS-ONE";
  const path = join(mkdtempSync(join(tmpdir(), "ppv-funder-secret-")), "funder.json");
  writeFileSync(path, supplied);

  assert.throws(
    () => loadFunderSecretOrThrow(path),
    (error) => {
      assert.ok(error instanceof FunderSecretError);
      assert.equal(error.message, FUNDER_SECRET_FORMAT_ERROR);
      // `devnet-escrow-custody.mjs` prints `error.message` and `error.cause`
      // is the obvious place a future edit would stash the real reason.
      assert.equal(error.cause, undefined);
      noFragmentLeaked(`${error.message}\n${error.stack}`, supplied, "thrown error");
      return true;
    },
  );
});
