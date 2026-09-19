/**
 * The machinery a live custody run needs, separated from the scenarios it runs.
 *
 * Kept apart from `scripts/devnet-escrow-custody.mjs` so the scenario file reads
 * as protocol behaviour rather than as transaction plumbing, and so the parts
 * that can be exercised without a cluster — the cluster gate, the balance
 * bookkeeping, the refusal accounting, the evidence scrubber — are importable
 * on their own and covered by offline tests.
 *
 * Nothing here ever prints, returns, or serializes key material. That is
 * asserted, not intended: `assertNoSecrets` walks any object bound for the
 * evidence record and refuses anything that looks like a private key.
 */

import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

import { SAFE_ENDPOINT_LABEL, looksLikeCredentialUrl, redact } from "./endpoint-safety.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS } from "./rpc.mjs";
import {
  BalanceSnapshot,
  InvariantViolation,
  assertNoMovement,
  assertRefusalChangedNothing,
  toAmount,
} from "./custody-invariants.mjs";

export class CustodyHarnessFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "CustodyHarnessFailure";
  }
}

/**
 * A finding that is about the deployed program rather than about the harness.
 *
 * Separated by type because the two demand opposite responses: a harness bug is
 * fixed and the run repeated, and a custody defect stops the sprint. A run that
 * reported both the same way would invite the first response to the second
 * situation.
 */
export class CustodyDefect extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "CustodyDefect";
    this.detail = detail;
  }
}

/* --------------------------------------------------------- the cluster gate */

/**
 * Refuses anything that is not devnet, mainnet first and by name.
 *
 * This runs before a keypair is loaded, before a mint exists, and before any
 * instruction is built — not merely before one is signed. An endpoint is an
 * environment variable, and the distance between "wrong variable" and "signed a
 * mainnet transaction" should be as long as it can be made.
 */
export async function requireDevnet(client) {
  const genesis = await client.genesisHash();
  if (genesis === MAINNET_GENESIS) {
    throw new CustodyHarnessFailure(
      `${SAFE_ENDPOINT_LABEL} is mainnet-beta (genesis ${genesis}). This harness signs value-moving ` +
        "transactions and is authorized for devnet only. Refusing before anything is constructed.",
    );
  }
  if (genesis !== DEVNET_GENESIS) {
    throw new CustodyHarnessFailure(
      `${SAFE_ENDPOINT_LABEL} reports genesis ${genesis}, which is neither devnet ` +
        `(${DEVNET_GENESIS}) nor a cluster this harness recognises. Refusing.`,
    );
  }
  return genesis;
}

/**
 * The same refusal for an endpoint string, applied before a connection is even
 * opened. Genesis is authoritative and this is not a substitute for it — a
 * private endpoint can be pointed anywhere — but an endpoint that says mainnet
 * on its face should never get as far as a round trip.
 */
export function requireNoMainnetEndpoint(endpoint) {
  const lowered = String(endpoint).toLowerCase();
  for (const marker of ["mainnet", "main-net", "mainnet-beta"]) {
    if (lowered.includes(marker)) {
      // The marker is named; the endpoint is not. A dedicated RPC URL can
      // carry an API key, and "which endpoint" adds nothing an operator does
      // not already know — they set it.
      throw new CustodyHarnessFailure(
        `${SAFE_ENDPOINT_LABEL} names ${marker}; this harness is devnet-only and refuses it ` +
          "without asking the cluster",
      );
    }
  }
  return endpoint;
}

/* ------------------------------------------------------------- token reads */

/** Classic SPL token account: mint(32) owner(32) amount(u64 LE) … */
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
export const TOKEN_ACCOUNT_LEN = 165;

export function decodeTokenAmount(base64Data) {
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
    throw new CustodyHarnessFailure(
      `token account data is ${bytes.length} bytes, too short to hold an amount`,
    );
  }
  return bytes.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

export function decodeTokenMint(base64Data, encodeBase58) {
  return encodeBase58(Buffer.from(base64Data, "base64").subarray(0, 32));
}

export function decodeTokenOwner(base64Data, encodeBase58) {
  return encodeBase58(Buffer.from(base64Data, "base64").subarray(32, 64));
}

/**
 * Every watched account's balance, in one snapshot.
 *
 * An account that does not exist reads as 0 rather than erroring: a vault is a
 * real account with a real zero balance before it is funded and after it is
 * emptied, and a destination may legitimately not exist yet. A *missing* read,
 * by contrast — an RPC that returned nothing for a batch — is an error, because
 * silently treating it as zero would turn an outage into a fake balance change.
 */
export async function snapshotBalances(client, addresses) {
  const entries = {};
  const list = [...addresses];
  const chunkSize = 100;
  for (let i = 0; i < list.length; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const result = await client.call("getMultipleAccounts", [
      chunk,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const values = result?.value;
    if (!Array.isArray(values) || values.length !== chunk.length) {
      throw new CustodyHarnessFailure(
        `getMultipleAccounts returned ${values?.length ?? "no"} entries for ${chunk.length} ` +
          "addresses; a missing read must not be recorded as a zero balance",
      );
    }
    chunk.forEach((address, index) => {
      const account = values[index];
      entries[address] = account ? decodeTokenAmount(account.data[0]) : 0n;
    });
  }
  return new BalanceSnapshot(entries);
}

/* ---------------------------------------------------- sending transactions */

/**
 * A transaction that is expected to succeed.
 *
 * Confirmed at `confirmed` before anything is asserted about it, because a
 * balance read against a slot that has not seen the transaction is not evidence
 * of anything, and the resulting "no movement" failure would look like a
 * protocol defect.
 */
export async function send(connection, instructions, signers, { label }) {
  const transaction = new Transaction().add(...instructions);
  try {
    return await sendAndConfirmTransaction(connection, transaction, signers, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
  } catch (error) {
    throw new CustodyHarnessFailure(
      `${label} was expected to succeed and did not: ${describeError(error)}`,
    );
  }
}

/**
 * A transaction that is expected to fail, sent so that it actually reaches the
 * program.
 *
 * `skipPreflight` is on deliberately. With preflight, the RPC node's simulator
 * rejects the transaction and it never lands — which proves the simulator
 * agrees, not that the deployed program refuses. The whole point of a live
 * negative test is the second claim, so the transaction is submitted, lands in
 * a block, and fails there, leaving a signature that anyone can look up.
 */
export async function sendExpectingFailure(connection, instructions, signers, { label }) {
  const transaction = new Transaction().add(...instructions);
  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, signers, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    throw new CustodyDefect(
      `${label} was expected to fail and SUCCEEDED (signature ${signature}). ` +
        "A guard the repository claims exists did not refuse this.",
      { label, signature },
    );
  } catch (error) {
    if (error instanceof CustodyDefect) throw error;
    return {
      signature: extractSignature(error) ?? null,
      error: describeError(error),
      errorCode: extractAnchorErrorCode(error),
    };
  }
}

/**
 * Every failure the harness reports passes through here.
 *
 * Which makes it the place to scrub. `@solana/web3.js` wraps transport errors
 * without knowing or caring that the URL inside one may be a credential, so a
 * message this repository never wrote can still publish the endpoint. Redaction
 * happens on the way out rather than at each throw site, because the throw
 * sites belong to a dependency.
 */
export function describeError(error) {
  if (!error) return "unknown error";
  const logs = Array.isArray(error.logs) ? error.logs.join(" | ") : "";
  return redact(`${error.message ?? String(error)}${logs ? ` :: ${logs}` : ""}`);
}

/** Anchor's `Error Code: X. Error Number: N` and the raw custom-program code. */
export function extractAnchorErrorCode(error) {
  const text = describeError(error);
  const named = text.match(/Error Code: (\w+)\. Error Number: (\d+)/);
  if (named) return { name: named[1], number: Number(named[2]) };
  const custom = text.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (custom) return { name: null, number: Number.parseInt(custom[1], 16) };
  const constraint = text.match(/(ConstraintSeeds|AccountNotInitialized|AccountOwnedByWrongProgram|already in use)/);
  if (constraint) return { name: constraint[1], number: null };
  return { name: null, number: null };
}

export function extractSignature(error) {
  const text = describeError(error);
  return text.match(/[1-9A-HJ-NP-Za-km-z]{86,88}/)?.[0] ?? null;
}

/* ------------------------------------------------ the refusal bookkeeping */

/**
 * One expected-failure attempt, recorded in full.
 *
 * The record is deliberately larger than "it failed": a negative test proves
 * something only if the state and every watched balance are identical before
 * and after, and the evidence has to contain enough for a reader to check that
 * claim rather than take it.
 */
export async function attemptRefusal(
  connection,
  client,
  {
    label,
    invariant,
    instructions,
    signers,
    watched,
    readAgreement,
  },
) {
  const before = await snapshotBalances(client, watched);
  const stateBefore = readAgreement ? await readAgreement() : null;

  const outcome = await sendExpectingFailure(connection, instructions, signers, { label });

  const after = await snapshotBalances(client, watched);
  const stateAfter = readAgreement ? await readAgreement() : null;

  assertRefusalChangedNothing({
    label,
    before,
    after,
    stateBefore: stateBefore?.state ?? null,
    stateAfter: stateAfter?.state ?? null,
    settledTotalBefore: stateBefore?.settledTotal ?? 0n,
    settledTotalAfter: stateAfter?.settledTotal ?? 0n,
  });

  return {
    label,
    invariant,
    expected: "failure",
    result: "refused",
    signature: outcome.signature,
    errorCode: outcome.errorCode,
    error: outcome.error,
    stateBefore: stateBefore?.state ?? null,
    stateAfter: stateAfter?.state ?? null,
    settledTotalBefore: stateBefore ? String(stateBefore.settledTotal) : null,
    settledTotalAfter: stateAfter ? String(stateAfter.settledTotal) : null,
    balancesBefore: before.toJSON(),
    balancesAfter: after.toJSON(),
  };
}

/** A state-only step: it must succeed and it must move no tokens at all. */
export async function stepWithoutValue(
  connection,
  client,
  { label, instructions, signers, watched },
) {
  const before = await snapshotBalances(client, watched);
  const signature = await send(connection, instructions, signers, { label });
  const after = await snapshotBalances(client, watched);
  assertNoMovement(before, after, { label });
  return { label, signature, balancesBefore: before.toJSON(), balancesAfter: after.toJSON() };
}

/* ------------------------------------------------------ the secret scrubber */

/**
 * Anything that could be key material, refused before it can be serialized.
 *
 * The evidence record is a public artifact that gets committed, so the question
 * is not whether the harness *intends* to write a secret — it does not — but
 * whether a future edit could. A 64-byte number array is an ed25519 keypair; a
 * 32-byte one is a seed or a secret scalar; and the field names below are what
 * the Solana ecosystem calls them. Any of those in an object bound for the
 * record stops the run.
 *
 * Deliberately not a redactor. Redaction would let a run that tried to write a
 * key still produce a record, and the next reviewer would be reading a document
 * whose generator is known to have handled secrets.
 */
const SECRET_FIELD_NAMES = [
  "secretkey",
  "secret_key",
  "privatekey",
  "private_key",
  "keypair",
  "seed",
  "seedphrase",
  "mnemonic",
  "passphrase",
  "password",
  "token",
  "credential",
  "credentials",
  "apikey",
  "api_key",
];

export function assertNoSecrets(value, path = "$") {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    // A byte array of exactly keypair or seed length, whatever it is called.
    const allBytes =
      value.length > 0 &&
      value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255);
    if (allBytes && (value.length === 64 || value.length === 32)) {
      throw new CustodyHarnessFailure(
        `${path} is a ${value.length}-byte array, which is the shape of ed25519 key material. ` +
          "Evidence records hold public addresses, signatures and balances only.",
      );
    }
    value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
    return value;
  }

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    throw new CustodyHarnessFailure(
      `${path} is raw bytes; encode public values as base58 strings and never put bytes in evidence`,
    );
  }

  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z_]/g, "");
      if (SECRET_FIELD_NAMES.includes(normalized)) {
        throw new CustodyHarnessFailure(
          `${path}.${key} names secret material; it must not appear in an evidence record`,
        );
      }
      assertNoSecrets(entry, `${path}.${key}`);
    }
    return value;
  }

  if (typeof value === "string") {
    // A base58 string long enough to be a 64-byte secret key. Signatures are
    // also 64 bytes and are legitimate, so this is not decided by length alone
    // — it fires only on the JSON-array-in-a-string shape a careless
    // `JSON.stringify(keypair.secretKey)` produces.
    if (/^\[\s*\d+\s*(,\s*\d+\s*){31,}\]$/.test(value)) {
      throw new CustodyHarnessFailure(
        `${path} holds a serialized byte array, which is how a keypair file is written`,
      );
    }

    // A dedicated RPC endpoint authenticates with a key in its query string or
    // its path. Evidence is published, so a URL shaped like that is refused
    // rather than trimmed: this record names a cluster by genesis hash and has
    // no reason to carry an endpoint at all.
    if (looksLikeCredentialUrl(value)) {
      throw new CustodyHarnessFailure(
        `${path} holds a URL carrying credentials or an opaque path; an evidence record names ` +
          "the cluster by genesis hash and never the endpoint that was read",
      );
    }
  }

  return value;
}

/** Amounts are BigInt throughout and JSON cannot hold one. */
export function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  }
  return value;
}

export { BalanceSnapshot, InvariantViolation, toAmount };
