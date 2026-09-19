import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { Keypair, SystemProgram } from "@solana/web3.js";

import { CustodyHarnessFailure, send, stepWithoutValue } from "../lib/custody-runner.mjs";
import { REPO } from "./helpers.mjs";

/**
 * The read client, followed from a custody step to the confirmation poll.
 *
 * Live run 35439828941 proved ordinary escrow, cancel, refund and both dispute
 * outcomes against the deployed program, then stopped on
 *
 *     milestones: submit_milestone 0 was sent without a read client;
 *     confirmation polls getSignatureStatuses and cannot fall back to a
 *     websocket subscription
 *
 * PR #38 made `send()` require the read-only RPC client, because confirmation
 * polls `getSignatureStatuses` over HTTP and deliberately never subscribes.
 * Every direct caller was updated. `stepWithoutValue()` — which already *holds*
 * a client, and uses it either side of the send to snapshot balances — was not,
 * so it passed `{ label }` and nothing else.
 *
 * The defect is one missing word in an object literal, and no test could see
 * it: the unit tests exercised `send()` directly, and the path through
 * `stepWithoutValue()` only runs against a chain. So there are two guards here.
 * The first runs the real function with a stub client and proves the client
 * reaches the confirmation poll. The second reads the sources and refuses any
 * call site that does not name `client` in its options.
 *
 * Nothing here touches a chain.
 */

const SIGNER = Keypair.generate();
const WATCHED = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
const INSTRUCTIONS = [
  SystemProgram.transfer({ fromPubkey: SIGNER.publicKey, toPubkey: SIGNER.publicKey, lamports: 1 }),
];

/**
 * A connection that can submit and nothing else.
 *
 * It has no `confirmTransaction`, no `onSignature` and no `onLogs`: if the
 * lifecycle ever fell back to a websocket subscription rather than polling the
 * read client, it would fail here rather than quietly pass.
 */
function stubConnection() {
  const state = { submits: 0 };
  return {
    state,
    connection: {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1000,
      }),
      sendRawTransaction: async () => {
        state.submits += 1;
        return "signature-from-node";
      },
    },
  };
}

/**
 * A read client that records every call, so the test can say which method saw
 * it rather than merely that some call happened.
 */
function stubReadClient() {
  const state = { methods: [], polledSignatures: [] };
  return {
    state,
    client: {
      call: async (method, params) => {
        state.methods.push(method);
        if (method === "getMultipleAccounts") {
          // Every watched account reads as a real zero balance.
          return { value: params[0].map(() => null) };
        }
        if (method === "getSignatureStatuses") {
          state.polledSignatures.push(...params[0]);
          return { value: [{ err: null, confirmationStatus: "confirmed", slot: 1 }] };
        }
        throw new Error(`unexpected read-client method ${method}`);
      },
    },
  };
}

const step = (connection, client) =>
  stepWithoutValue(connection, client, {
    label: "milestones: submit_milestone 0",
    instructions: INSTRUCTIONS,
    signers: [SIGNER],
    watched: WATCHED,
  });

/* ============================================ 1. the client actually arrives */

test("1. stepWithoutValue forwards its read client into transaction confirmation", async () => {
  const { connection, state: sent } = stubConnection();
  const { client, state: read } = stubReadClient();

  const result = await step(connection, client);

  assert.equal(sent.submits, 1, "the transaction must be submitted exactly once");
  assert.ok(
    read.methods.includes("getSignatureStatuses"),
    "the read client never saw getSignatureStatuses; the client did not reach confirmation",
  );
  assert.deepEqual(
    read.polledSignatures,
    [result.signature],
    "confirmation polled a signature other than the one the step returned",
  );
  // And the step still did its own job: a state-only step reports the balances
  // it compared, and both are empty because nothing moved.
  assert.equal(result.label, "milestones: submit_milestone 0");
  assert.deepEqual(Object.keys(result.balancesBefore).sort(), [...WATCHED].sort());
});

test("2. the balance snapshots and the confirmation poll use the same client", async () => {
  const { connection } = stubConnection();
  const { client, state: read } = stubReadClient();

  await step(connection, client);

  // getMultipleAccounts, getSignatureStatuses, getMultipleAccounts — one
  // client, used before, during and after. A step that snapshotted on this
  // client and confirmed on some other one would not produce this sequence.
  assert.deepEqual(read.methods, [
    "getMultipleAccounts",
    "getSignatureStatuses",
    "getMultipleAccounts",
  ]);
});

test("3. send() still refuses a call with no read client, in the words run 35439828941 printed", async () => {
  const { connection } = stubConnection();
  await assert.rejects(
    () => send(connection, INSTRUCTIONS, [SIGNER], { label: "milestones: submit_milestone 0" }),
    (error) => {
      assert.ok(error instanceof CustodyHarnessFailure);
      assert.match(error.message, /was sent without a read client/);
      assert.match(error.message, /cannot fall back to a websocket subscription/);
      return true;
    },
  );
});

test("4. a step the program rejected on chain is a failure, not a silent pass", async () => {
  // The guard above is about a missing client. This is about the client being
  // present and answering: what the poll says must decide the step's outcome,
  // which is the whole reason the client has to be there.
  const { connection } = stubConnection();
  const client = {
    call: async (method, params) => {
      if (method === "getMultipleAccounts") return { value: params[0].map(() => null) };
      return {
        value: [{ err: { InstructionError: [0, { Custom: 6003 }] }, confirmationStatus: "confirmed", slot: 1 }],
      };
    },
  };
  await assert.rejects(
    () => step(connection, client),
    /TRANSACTION_SUBMITTED_PROGRAM_FAILURE/,
  );
});

/* ================================= 5. no call site can lose the client again */

const SOURCES = [
  join("scripts", "lib", "custody-runner.mjs"),
  join("scripts", "devnet-escrow-custody.mjs"),
];

/** The two custody helpers that require a read client to confirm anything. */
const GUARDED = ["send", "sendExpectingFailure"];

/** Comments are stripped so prose naming a helper is not read as a call. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The arguments of one call, sliced by counting parentheses.
 *
 * Not a regular expression: a lazy `\(([\s\S]*?)\)` stops at the first inner
 * `)` — `serialize()`, `publicKey.toBase58()` — and would hand back a truncated
 * argument list that happens not to mention the client, or one that does.
 */
function callArguments(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses from index ${openIndex}`);
}

/** Every call to a guarded helper, excluding the helpers' own declarations. */
function guardedCalls(source) {
  const stripped = withoutComments(source);
  const calls = [];
  for (const name of GUARDED) {
    const pattern = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, "g");
    for (const match of stripped.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const before = stripped.slice(Math.max(0, match.index - 30), match.index + match[0].length);
      if (/function\s+$/.test(before.slice(0, before.length - match[0].length + match[1].length))) {
        continue; // the declaration itself
      }
      if (/\bfunction\s+[\w]*\s*$/.test(stripped.slice(0, open - name.length))) continue;
      calls.push({ name, args: callArguments(stripped, open) });
    }
  }
  return calls;
}

test("5. every custody send call site names a read client", () => {
  let audited = 0;
  for (const relative of SOURCES) {
    const source = readFileSync(join(REPO, relative), "utf8");
    for (const call of guardedCalls(source)) {
      audited += 1;
      // `client` must be a key of the options object, so that a `ctx.client`
      // mentioned incidentally somewhere in the arguments cannot satisfy this.
      assert.match(
        call.args,
        /[{,]\s*client\s*[,:}]/,
        `${relative}: ${call.name}(${call.args.trim().slice(0, 80)}...) is called without a read client`,
      );
    }
  }
  // If the extraction ever silently matches nothing, this test would pass
  // while checking nothing at all. Run 35439828941 cost a live matrix; the
  // guard against it is not allowed to be vacuous.
  assert.ok(audited >= 6, `only ${audited} custody send call sites were found; the scan is broken`);
});

test("6. the audited call sites are the ones this repair knows about", () => {
  const counts = SOURCES.map((relative) => guardedCalls(readFileSync(join(REPO, relative), "utf8")).length);
  // custody-runner: stepWithoutValue -> send, attemptRefusal ->
  // sendExpectingFailure. devnet-escrow-custody: five direct sends.
  assert.deepEqual(counts, [2, 5], `custody send call sites moved: ${counts.join(", ")}`);
});

test("7. stepWithoutValue passes the client it was given, in the source as well as at runtime", () => {
  const source = withoutComments(
    readFileSync(join(REPO, "scripts", "lib", "custody-runner.mjs"), "utf8"),
  );
  const body = source.slice(source.indexOf("export async function stepWithoutValue"));
  const open = body.indexOf("send(", body.indexOf("snapshotBalances"));
  assert.ok(open > 0, "stepWithoutValue no longer calls send()");
  assert.match(
    callArguments(body, open + "send".length),
    /[{,]\s*client\s*[,:}]/,
    "stepWithoutValue calls send() without a client; this is exactly run 35439828941",
  );
});
