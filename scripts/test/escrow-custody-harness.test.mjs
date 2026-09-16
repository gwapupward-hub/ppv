import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import * as sqds from "@sqds/multisig";
import { Keypair, PublicKey } from "@solana/web3.js";

import { REPO, ESCROW_ID } from "./helpers.mjs";
import { programAccount, programDataAccount } from "./helpers.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS, rpc } from "../lib/rpc.mjs";
import { PERMISSION_ALL, SQUADS_V4_PROGRAM_ID } from "../lib/squads.mjs";
import {
  BalanceSnapshot,
  InvariantViolation,
  assertAccountingConsistent,
  assertDeltas,
  assertFunding,
  assertNoMovement,
  assertPayout,
  assertRefusalChangedNothing,
  assertTerminal,
} from "../lib/custody-invariants.mjs";
import {
  CustodyDefect,
  CustodyHarnessFailure,
  assertNoSecrets,
  decodeTokenAmount,
  jsonSafe,
  requireDevnet,
  requireNoMainnetEndpoint,
  snapshotBalances,
} from "../lib/custody-runner.mjs";
import { EXPECTED, buildEvidence, preflight } from "../devnet-escrow-custody.mjs";

/**
 * The live custody harness, exercised without a cluster.
 *
 * A harness that sends value-moving transactions is only as trustworthy as its
 * refusals, and its refusals are exactly the paths a live run never takes. So
 * they are taken here instead, against stubs: mainnet, an unknown cluster, an
 * upgrade authority that is not the custody vault, bytes that are not the
 * reviewed binary, a multisig whose live threshold or membership disagrees with
 * the record, a second shared signer, a balance that moved by the wrong amount,
 * an expected-failure transaction that changed something, and an evidence
 * record carrying key material.
 *
 * Every one of those is a case where the correct behaviour is to stop. None of
 * them would be exercised by a passing live run, which is precisely why they
 * need their own coverage: the first time they run must not be the first time
 * they matter.
 */

const PROGRAM_DATA = EXPECTED.programDataAddress;
const VAULT = EXPECTED.upgradeAuthority;
const MULTISIG = EXPECTED.multisig;

/** A binary whose sha256 is what the fixtures declare, so hashes really match. */
const BINARY = Buffer.from("ppv_escrow reviewed release artifact");
const BINARY_HASH = createHash("sha256").update(BINARY).digest("hex");

function multisigData({
  threshold = 2,
  members = EXPECTED.members.map((key) => ({ key, mask: PERMISSION_ALL })),
} = {}) {
  const [buffer] = sqds.accounts.multisigBeet.serialize({
    accountDiscriminator: Array.from(sqds.accounts.multisigDiscriminator),
    createKey: new PublicKey(EXPECTED.members[0]),
    configAuthority: PublicKey.default,
    threshold,
    timeLock: 0,
    transactionIndex: 0n,
    staleTransactionIndex: 0n,
    rentCollector: null,
    bump: 255,
    members: members.map((member) => ({
      key: new PublicKey(member.key),
      permissions: { mask: member.mask },
    })),
  });
  return buffer;
}

/** A cluster that is correct in every respect, with named things to break. */
function fixture({
  genesis = DEVNET_GENESIS,
  authority = VAULT,
  binary = BINARY,
  executable = true,
  programDataAddress = PROGRAM_DATA,
  multisig = multisigData(),
  multisigOwner = SQUADS_V4_PROGRAM_ID,
} = {}) {
  const accounts = {
    [ESCROW_ID]: { ...programAccount(programDataAddress), executable },
    [programDataAddress]: programDataAccount({ authority, binary, slot: 498656161 }),
    [MULTISIG]: { owner: multisigOwner, executable: false, data: multisig },
  };
  return {
    endpoint: "stub://devnet",
    genesisHash: async () => genesis,
    accountInfo: async (address) => {
      const account = accounts[address];
      if (!account) return null;
      return {
        lamports: account.lamports ?? 4_000_000,
        owner: account.owner,
        executable: account.executable ?? false,
        data: [Buffer.from(account.data).toString("base64"), "base64"],
      };
    },
    call: async () => {
      throw new Error("unexpected RPC call");
    },
  };
}

const EXPECT = Object.freeze({ ...EXPECTED, binaryHash: BINARY_HASH });
const EVIDENCE = Object.freeze({
  programId: EXPECTED.programId,
  releaseCommit: EXPECTED.releaseCommit,
});

/** Preflight prints; the tests do not need to see it. */
function quiet(fn) {
  const original = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = original;
    });
}

/* ------------------------------------------------------- the cluster gate */

test("mainnet is refused by genesis hash, before anything is constructed", async () => {
  await assert.rejects(
    requireDevnet({ endpoint: "stub://x", genesisHash: async () => MAINNET_GENESIS }),
    (error) =>
      error instanceof CustodyHarnessFailure && /is mainnet-beta/.test(error.message),
  );
});

test("an unknown cluster is refused, not assumed to be devnet", async () => {
  await assert.rejects(
    requireDevnet({
      endpoint: "stub://x",
      genesisHash: async () => "11111111111111111111111111111111",
    }),
    /neither devnet .* nor a cluster this harness recognises/s,
  );
});

test("an endpoint that names mainnet is refused without a round trip", () => {
  for (const endpoint of [
    "https://api.mainnet-beta.solana.com",
    "https://SOME-MAINNET-node.example",
    "https://rpc.example/main-net",
  ]) {
    assert.throws(() => requireNoMainnetEndpoint(endpoint), CustodyHarnessFailure);
  }
  assert.equal(
    requireNoMainnetEndpoint("https://api.devnet.solana.com"),
    "https://api.devnet.solana.com",
  );
});

test("preflight refuses mainnet before it reads the program", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ genesis: MAINNET_GENESIS }), { evidence: EVIDENCE, expected: EXPECT }),
      /is mainnet-beta/,
    ),
  );
});

/* ---------------------------------------------- the deployment preconditions */

test("a correct cluster passes preflight and reports the live facts", async () => {
  const facts = await quiet(() =>
    preflight(fixture(), { evidence: EVIDENCE, expected: EXPECT }),
  );
  assert.equal(facts.genesis, DEVNET_GENESIS);
  assert.equal(facts.programId, ESCROW_ID);
  assert.equal(facts.programDataAddress, PROGRAM_DATA);
  assert.equal(facts.upgradeAuthority, VAULT);
  assert.equal(facts.binaryHash, `sha256:${BINARY_HASH}`);
  assert.equal(facts.squads.threshold, 2);
  assert.deepEqual(facts.squads.members, [...EXPECTED.members]);
  assert.deepEqual(facts.squads.permissions, [7, 7, 7]);
  assert.equal(facts.squads.vaultDerived, VAULT);
  assert.equal(facts.squads.decodedFrom, "live-chain-state");
  assert.equal(facts.sharedSignerCount, 1);
});

test("an upgrade authority that is not the custody vault stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ authority: EXPECTED.members[0] }), {
        evidence: EVIDENCE,
        expected: EXPECT,
      }),
      /SECURITY: the live upgrade authority is/,
    ),
  );
});

test("a revoked upgrade authority stops the run rather than reading as absent", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ authority: null }), { evidence: EVIDENCE, expected: EXPECT }),
      /the live upgrade authority is/,
    ),
  );
});

test("bytes that are not the reviewed binary stop the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ binary: Buffer.from("something else entirely") }), {
        evidence: EVIDENCE,
        expected: EXPECT,
      }),
      /SECURITY: the deployed bytes hash to/,
    ),
  );
});

test("a non-executable program account stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ executable: false }), { evidence: EVIDENCE, expected: EXPECT }),
      /is not executable/,
    ),
  );
});

test("a ProgramData account at an unexpected address stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ programDataAddress: EXPECTED.members[1] }), {
        evidence: EVIDENCE,
        expected: EXPECT,
      }),
      /ProgramData resolves to/,
    ),
  );
});

test("evidence naming a different release commit stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture(), {
        evidence: { ...EVIDENCE, releaseCommit: "0".repeat(40) },
        expected: EXPECT,
      }),
      /names release commit/,
    ),
  );
});

/* ------------------------------------------------ the live Squads decode */

test("a live threshold that is not 2 stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ multisig: multisigData({ threshold: 3 }) }), {
        evidence: EVIDENCE,
        expected: EXPECT,
      }),
      /live threshold is 3/,
    ),
  );
});

test("a live member set that is not the recorded one stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(
        fixture({
          multisig: multisigData({
            members: [
              { key: EXPECTED.members[0], mask: PERMISSION_ALL },
              { key: EXPECTED.members[1], mask: PERMISSION_ALL },
              { key: "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV", mask: PERMISSION_ALL },
            ],
          }),
        }),
        { evidence: EVIDENCE, expected: EXPECT },
      ),
      /is not a live member/,
    ),
  );
});

test("a live member short of Initiate + Vote + Execute stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(
        fixture({
          multisig: multisigData({
            members: [
              { key: EXPECTED.members[0], mask: PERMISSION_ALL },
              { key: EXPECTED.members[1], mask: 3 },
              { key: EXPECTED.members[2], mask: PERMISSION_ALL },
            ],
          }),
        }),
        { evidence: EVIDENCE, expected: EXPECT },
      ),
      /permission mask 3/,
    ),
  );
});

test("a second shared signer with Core/Commerce governance stops the run", async () => {
  // Two of the three live members also govern the non-custodial programs. One
  // shared key cannot reach a 2-of-3 alone; two can, which ends the separation.
  await quiet(() =>
    assert.rejects(
      preflight(
        fixture({
          multisig: multisigData({
            members: [
              { key: EXPECTED.members[0], mask: PERMISSION_ALL },
              { key: "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV", mask: PERMISSION_ALL },
              { key: "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ", mask: PERMISSION_ALL },
            ],
          }),
        }),
        {
          evidence: EVIDENCE,
          expected: {
            ...EXPECT,
            members: [
              EXPECTED.members[0],
              "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
              "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
            ],
          },
        },
      ),
      /2 live custody signer\(s\) also govern the non-custodial programs/,
    ),
  );
});

test("a multisig account owned by another program stops the run", async () => {
  await quiet(() =>
    assert.rejects(
      preflight(fixture({ multisigOwner: "11111111111111111111111111111111" }), {
        evidence: EVIDENCE,
        expected: EXPECT,
      }),
      /not the Squads V4 program/,
    ),
  );
});

/* ------------------------------------------------- the balance arithmetic */

const snap = (entries) => new BalanceSnapshot(entries);

test("a payout of exactly the right amount, to the right account, passes", () => {
  const before = snap({ vault: 25, seller: 0, buyer: 100, outsider: 7 });
  const after = snap({ vault: 0, seller: 25, buyer: 100, outsider: 7 });
  assert.deepEqual(
    assertPayout(before, after, { vault: "vault", recipient: "seller", amount: 25, label: "s" }),
    { vault: "-25", seller: "25", buyer: "0", outsider: "0" },
  );
});

test("a payout of the wrong amount is refused", () => {
  const before = snap({ vault: 25, seller: 0 });
  const after = snap({ vault: 1, seller: 24 });
  assert.throws(
    () => assertPayout(before, after, { vault: "vault", recipient: "seller", amount: 25, label: "s" }),
    InvariantViolation,
  );
});

test("a payout to an account nobody named is caught, not ignored", () => {
  // The whole reason the delta map must be complete: the two accounts the
  // assertion is "about" can both look right while a third one moved.
  const before = snap({ vault: 25, seller: 0, outsider: 0 });
  const after = snap({ vault: 0, seller: 20, outsider: 5 });
  assert.throws(
    () =>
      assertPayout(before, after, { vault: "vault", recipient: "seller", amount: 25, label: "s" }),
    /outsider: expected \+0, observed \+5/,
  );
});

test("funding by the wrong amount is refused", () => {
  const before = snap({ buyer: 100, vault: 0 });
  assert.throws(
    () =>
      assertFunding(before, snap({ buyer: 90, vault: 10 }), {
        buyer: "buyer",
        vault: "vault",
        amount: 25,
        label: "f",
      }),
    InvariantViolation,
  );
  assert.ok(
    assertFunding(before, snap({ buyer: 75, vault: 25 }), {
      buyer: "buyer",
      vault: "vault",
      amount: 25,
      label: "f",
    }),
  );
});

test("tokens appearing from nowhere are caught by the conservation check", () => {
  const before = snap({ vault: 25, seller: 0 });
  const after = snap({ vault: 25, seller: 25 });
  assert.throws(
    () => assertDeltas(before, after, { seller: 25 }, { label: "mint from air" }),
    /changed by a net 25; tokens were created or destroyed/,
  );
});

test("a state-only step that moved tokens is refused", () => {
  assert.throws(
    () => assertNoMovement(snap({ vault: 10 }), snap({ vault: 9 }), { label: "mark_completed" }),
    InvariantViolation,
  );
});

test("an unwatched account cannot be asserted about", () => {
  assert.throws(
    () => assertPayout(snap({ vault: 5 }), snap({ vault: 0 }), {
      vault: "vault",
      recipient: "nowhere",
      amount: 5,
      label: "s",
    }),
    /is not a watched account/,
  );
});

/* -------------------------------------------- the state/accounting agreement */

test("a funded agreement's vault must equal amount minus settled_total", () => {
  assert.deepEqual(
    assertAccountingConsistent({ amount: 100n, settledTotal: 40n, fundedAt: 1 }, 60n, { label: "m" }),
    { funded: true, owed: "60", balance: "60" },
  );
  assert.throws(
    () => assertAccountingConsistent({ amount: 100n, settledTotal: 40n, fundedAt: 1 }, 59n, { label: "m" }),
    /the agreement says 60 is still owed .* but the vault holds 59/,
  );
});

test("an unfunded agreement is not expected to hold its amount", () => {
  assert.deepEqual(
    assertAccountingConsistent({ amount: 11n, settledTotal: 0n, fundedAt: 0 }, 0n, { label: "c" }),
    { funded: false, owed: "0", balance: "0" },
  );
  assert.throws(
    () => assertAccountingConsistent({ amount: 11n, settledTotal: 0n, fundedAt: 0 }, 1n, { label: "c" }),
    /never funded but its vault holds 1/,
  );
});

test("settled_total above the agreement amount is an overpayment", () => {
  assert.throws(
    () => assertAccountingConsistent({ amount: 10n, settledTotal: 11n, fundedAt: 1 }, 0n, { label: "o" }),
    /PPV-P2/,
  );
});

test("only Settled, Cancelled and Refunded are terminal", () => {
  for (const state of ["Settled", "Cancelled", "Refunded"]) {
    assert.equal(assertTerminal(state, { label: "t" }), state);
  }
  for (const state of ["Open", "Funded", "Completed", "Disputed"]) {
    assert.throws(() => assertTerminal(state, { label: "t" }), /is not terminal/);
  }
});

/* ---------------------------------------- refusals that changed something */

test("an expected-failure transaction that moved tokens fails the harness", () => {
  assert.throws(
    () =>
      assertRefusalChangedNothing({
        label: "settle twice",
        before: snap({ vault: 0, seller: 25 }),
        after: snap({ vault: 0, seller: 26 }),
        stateBefore: "Settled",
        stateAfter: "Settled",
        settledTotalBefore: 25n,
        settledTotalAfter: 25n,
      }),
    InvariantViolation,
  );
});

test("an expected-failure transaction that moved the state fails the harness", () => {
  assert.throws(
    () =>
      assertRefusalChangedNothing({
        label: "fund after cancel",
        before: snap({ vault: 0 }),
        after: snap({ vault: 0 }),
        stateBefore: "Cancelled",
        stateAfter: "Funded",
        settledTotalBefore: 0n,
        settledTotalAfter: 0n,
      }),
    /the transaction failed but the agreement state moved Cancelled → Funded/,
  );
});

test("an expected-failure transaction that moved settled_total fails the harness", () => {
  assert.throws(
    () =>
      assertRefusalChangedNothing({
        label: "double settle",
        before: snap({ vault: 0 }),
        after: snap({ vault: 0 }),
        stateBefore: "Settled",
        stateAfter: "Settled",
        settledTotalBefore: 25n,
        settledTotalAfter: 50n,
      }),
    /settled_total moved 25 → 50/,
  );
});

test("a refusal that really changed nothing passes", () => {
  assert.equal(
    assertRefusalChangedNothing({
      label: "outsider settles",
      before: snap({ vault: 25, seller: 0 }),
      after: snap({ vault: 25, seller: 0 }),
      stateBefore: "Completed",
      stateAfter: "Completed",
      settledTotalBefore: 0n,
      settledTotalAfter: 0n,
    }),
    true,
  );
});

/* ------------------------------------------------------ the secret scrubber */

test("the evidence generator refuses a secret key by any of its names", () => {
  for (const field of [
    "secretKey",
    "secret_key",
    "privateKey",
    "keypair",
    "mnemonic",
    "seedPhrase",
    "apiKey",
    "credentials",
    "password",
  ]) {
    assert.throws(
      () => assertNoSecrets({ wallets: { buyer: { [field]: "anything" } } }),
      new RegExp(`${field} names secret material`),
      `${field} must be refused`,
    );
  }
});

test("the evidence generator refuses key-shaped byte arrays whatever they are called", () => {
  const keypair = Array.from(Keypair.generate().secretKey);
  assert.equal(keypair.length, 64);
  assert.throws(() => assertNoSecrets({ innocuous: keypair }), /64-byte array/);
  assert.throws(() => assertNoSecrets({ notes: [keypair] }), /64-byte array/);
  assert.throws(() => assertNoSecrets({ seedish: new Array(32).fill(3) }), /32-byte array/);
});

test("the evidence generator refuses raw bytes and stringified keypairs", () => {
  assert.throws(() => assertNoSecrets({ blob: Buffer.from("abc") }), /raw bytes/);
  assert.throws(
    () => assertNoSecrets({ text: JSON.stringify(Array.from(Keypair.generate().secretKey)) }),
    /serialized byte array/,
  );
});

test("public material passes the scrubber unchanged", () => {
  const record = {
    programId: ESCROW_ID,
    signatures: ["5xDmBitgkrQ1R9zVhvU3714VFE7arNeMJnhkimMWvP16cFmZVPytGad9j3XMa9CPMvTeoiRzAMJHPb3wmyazEzuA"],
    balances: { vault: "0", seller: "25" },
    members: [...EXPECTED.members],
  };
  assert.deepEqual(assertNoSecrets(record), record);
});

test("a built evidence record holds public facts only and is JSON-serializable", async () => {
  const facts = await quiet(() => preflight(fixture(), { evidence: EVIDENCE, expected: EXPECT }));
  const buyer = Keypair.generate();
  const ctx = {
    endpoint: "stub://devnet",
    runId: "abc123",
    mint: Keypair.generate().publicKey,
    otherMint: Keypair.generate().publicKey,
    supply: 10_000n,
    buyer,
    seller: Keypair.generate(),
    outsider: Keypair.generate(),
    ata: { buyer: Keypair.generate().publicKey },
    scenarios: {
      ordinaryEscrow: { agreement: "A", vault: "V", amount: "25", settledTotal: "25" },
    },
    negatives: [{ label: "x", result: "refused", stateBefore: "Settled", stateAfter: "Settled" }],
    finalVaultTotal: "0",
  };
  const record = buildEvidence(ctx, {
    preflightFacts: facts,
    reconstruction: {},
    commit: "0".repeat(40),
  });
  const round = JSON.parse(JSON.stringify(record));
  assert.equal(round.cluster, "devnet");
  assert.equal(round.testMaterial.tokenProgramName, "CLASSIC_SPL_TOKEN");
  assert.equal(round.testMaterial.mintDecimals, 0);
  assert.equal(round.gates.custodyGate, "CLOSED");
  assert.equal(round.gates.mainnetAuthorized, "NO");
  assert.equal(round.gates.independentSecurityReview, "OPEN (RR-13)");
  assert.equal(round.custodyGovernance.decodedFrom, "live-chain-state");
  assert.ok(!JSON.stringify(round).includes("secretKey"));
});

test("a run that tried to put a wallet in evidence fails instead of redacting it", () => {
  const ctx = {
    endpoint: "stub://devnet",
    runId: "abc",
    scenarios: {},
    negatives: [],
    // The mistake this guards: a future edit recording the whole Keypair.
    ata: {},
    leaked: Keypair.generate(),
  };
  assert.throws(
    () =>
      buildEvidence(
        { ...ctx, scenarios: { s: { wallet: { secretKey: [1, 2, 3] } } } },
        { preflightFacts: { squads: {} }, reconstruction: {}, commit: "x" },
      ),
    /names secret material/,
  );
});

/* ----------------------------------------------------------- misc plumbing */

test("bigint amounts survive the JSON conversion as decimal strings", () => {
  assert.deepEqual(jsonSafe({ a: 10n, b: [1n, { c: 2n }] }), {
    a: "10",
    b: ["1", { c: "2" }],
  });
});

test("a token account's amount is read at the classic SPL offset", () => {
  const account = Buffer.alloc(165);
  account.writeBigUInt64LE(4_242n, 64);
  assert.equal(decodeTokenAmount(account.toString("base64")), 4_242n);
});

test("a missing account reads as a zero balance, a missing read does not", async () => {
  const serving = {
    endpoint: "stub://x",
    call: async (_method, [addresses]) => ({
      value: addresses.map((address) =>
        address === "present"
          ? { data: [(() => { const b = Buffer.alloc(165); b.writeBigUInt64LE(7n, 64); return b; })().toString("base64"), "base64"] }
          : null,
      ),
    }),
  };
  const snapshot = await snapshotBalances(serving, ["present", "absent"]);
  assert.equal(snapshot.get("present"), 7n);
  assert.equal(snapshot.get("absent"), 0n);

  const truncating = { endpoint: "stub://x", call: async () => ({ value: [] }) };
  await assert.rejects(
    snapshotBalances(truncating, ["a", "b"]),
    /a missing read must not be recorded as a zero balance/,
  );
});

test("a custody defect is a different type from a harness failure", () => {
  assert.ok(new CustodyDefect("x") instanceof Error);
  assert.ok(!(new CustodyDefect("x") instanceof CustodyHarnessFailure));
});

/* -------------------------- the harness against the coverage table it feeds */

import { LIFECYCLE_COVERAGE, coverageLabel } from "../devnet-smoke.mjs";
import { SCENARIO_COVERAGE } from "../devnet-escrow-custody.mjs";

test("every coverage row the harness claims to establish exists in the table", () => {
  const rows = new Set(LIFECYCLE_COVERAGE.map((entry) => entry.step));
  for (const [scenario, steps] of Object.entries(SCENARIO_COVERAGE)) {
    for (const stepName of steps) {
      assert.ok(
        rows.has(stepName),
        `${scenario} claims to establish "${stepName}", which is not a coverage row`,
      );
    }
  }
});

test("every custody row in the table is claimed by some scenario", () => {
  // Otherwise a row could only ever read LIVE PROGRAM VERIFIED — CUSTODY
  // LIFECYCLE NOT RUN, with nothing in the repository able to change that,
  // which is a coverage table describing a test nobody wrote.
  const claimed = new Set(Object.values(SCENARIO_COVERAGE).flat());
  const custodyRows = LIFECYCLE_COVERAGE.filter((entry) => entry.executes === "custody");
  for (const entry of custodyRows) {
    assert.ok(
      claimed.has(entry.step),
      `no scenario establishes "${entry.step}"; the row can never go green`,
    );
  }
});

test("a completed scenario would promote exactly the rows it names", () => {
  const released = new Set(["ppv_core", "ppv_commerce", "ppv_escrow"]);
  const executed = new Set(SCENARIO_COVERAGE.milestones);
  for (const entry of LIFECYCLE_COVERAGE.filter((e) => e.executes === "custody")) {
    const label = coverageLabel(entry, released, executed);
    if (SCENARIO_COVERAGE.milestones.includes(entry.step)) {
      assert.equal(label, "LIVE VERIFIED", entry.step);
    } else {
      assert.equal(label, "LIVE PROGRAM VERIFIED — CUSTODY LIFECYCLE NOT RUN", entry.step);
    }
  }
});

test("the harness is preflight-only unless --execute is passed", () => {
  const source = readFileSync(join(REPO, "scripts", "devnet-escrow-custody.mjs"), "utf8");
  assert.match(
    source,
    /if \(!argv\.includes\("--execute"\)\) \{/,
    "the value-moving mode must be opt-in",
  );
  // Against code, not prose: the usage block at the top of the file documents
  // the funder variable, which is not the same as reading it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const guard = code.indexOf('argv.includes("--execute")');
  const funder = code.indexOf("process.env.PPV_CUSTODY_FUNDER");
  assert.ok(guard > -1, "the --execute guard is missing");
  assert.ok(funder > guard, "no funder keypair is read before the --execute guard");
});

test("the harness names no mainnet endpoint anywhere", () => {
  const sources = [
    join(REPO, "scripts", "devnet-escrow-custody.mjs"),
    join(REPO, "scripts", "lib", "custody-runner.mjs"),
    join(REPO, "scripts", "lib", "escrow-instructions.mjs"),
  ];
  for (const path of sources) {
    const code = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/api\.mainnet-beta\.solana\.com/.test(code),
      `${path} names a mainnet endpoint in code`,
    );
  }
});
