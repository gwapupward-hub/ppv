import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NON_CUSTODY_MEMBERS,
  NON_CUSTODY_VAULT,
  checkChain,
  checkPolicy,
  verify,
} from "../verify-custody-governance.mjs";
import { rpc, DEVNET_GENESIS, MAINNET_GENESIS } from "../lib/rpc.mjs";
import { isAddress } from "../lib/pubkey.mjs";
import { deriveVault } from "../lib/squads.mjs";
import { makeRpcTransport, MEMBERS, VAULT_PDA } from "./helpers.mjs";

/**
 * The custody governance policy, asserted rule by rule.
 *
 * `ppv_escrow` is the one PPV program that will hold value, and the custody
 * gate requires its upgrade authority to be a multisig separate from the one
 * governing the non-custodial programs. Every way that claim can be false while
 * looking true has a test here: a threshold of one, a member list that repeats,
 * a "vault" that is really a wallet, a vault that signs for itself, and the
 * arrangement that passes every structural check and is not separate at all —
 * the same vault, or the same people.
 *
 * Nothing here needs a keypair. Curve membership, uniqueness and equality are
 * public facts about public addresses, which is what makes this runnable before
 * the ceremony as well as after it.
 */

/**
 * A multisig and *its own* vault.
 *
 * These used to be two unrelated off-curve addresses, which was enough while
 * the policy only asked whether the vault was program-derived. It now asks
 * whether the vault is program-derived **from this multisig**, so an arbitrary
 * pair is exactly the misconfiguration the check exists to catch and cannot
 * stand in for a valid one. `HtQ44K…` is index 0 of `3cFRkT…` under the Squads
 * V4 program, asserted below rather than pasted and hoped for.
 */
const CUSTODY_MULTISIG = "3cFRkTFrpmNXetfLJka5q1owRffk1tjWVo8SDLPyWB7w";
const CUSTODY_VAULT = "HtQ44K1pxtvsXQFs2T5H4raTJd1GpCTGESBQJjSvoXwD";

test("the fixture vault really is the fixture multisig's vault at index 0", () => {
  assert.equal(deriveVault(CUSTODY_MULTISIG, 0).address, CUSTODY_VAULT);
});

test("a vault that is not this multisig's is refused", () => {
  // The check that replaced "does an account exist at the vault address",
  // which could not answer the question and answered it wrongly: a Squads
  // vault is a pure signer PDA and holds no account until somebody funds it.
  const failures = checkPolicy(valid({ vault: "FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA" }));
  assert.ok(
    failures.some((failure) => /derives to .*, not the declared vault/.test(failure)),
    `expected a derivation failure, got ${JSON.stringify(failures)}`,
  );
});

test("the right vault at the wrong index is refused", () => {
  const failures = checkPolicy(valid({ vaultIndex: 1 }));
  assert.ok(failures.some((failure) => /vault index 1 of multisig/.test(failure)));
});

/** A valid dedicated custody configuration, which every test perturbs. */
function valid(overrides = {}) {
  return {
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: [MEMBERS[0], MEMBERS[1], MEMBERS[2]],
    nonCustodyMembers: [],
    ...overrides,
  };
}

test("a dedicated 2-of-3 with a program-derived vault satisfies policy", () => {
  assert.deepEqual(checkPolicy(valid()), []);
});

test("a threshold of one is refused however many members there are", () => {
  for (const threshold of [1, 0, -1]) {
    const failures = checkPolicy(valid({ threshold }));
    assert.ok(
      failures.some((failure) => /policy requires at least 2/.test(failure)),
      `threshold ${threshold} was accepted`,
    );
  }
});

test("a threshold no member set can satisfy is refused", () => {
  const failures = checkPolicy(valid({ threshold: 4 }));
  assert.ok(failures.some((failure) => /cannot satisfy a threshold of 4/.test(failure)));
});

test("duplicate members are refused, because a threshold counts distinct keys", () => {
  // Two copies of one member in a "2-of-3" is a 1-of-2 that reads like a
  // 2-of-3 forever after, because this configuration is what later readers
  // compare against.
  const failures = checkPolicy(valid({ members: [MEMBERS[0], MEMBERS[0], MEMBERS[1]] }));
  assert.ok(failures.some((failure) => /contain duplicates/.test(failure)));
});

test("a vault on the ed25519 curve is refused", () => {
  // An on-curve "vault" is a wallet somebody holds the key to.
  const failures = checkPolicy(valid({ vault: MEMBERS[0] }));
  assert.ok(failures.some((failure) => /on the ed25519 curve/.test(failure)));
});

test("a vault or multisig listed among its own members is refused", () => {
  const asVaultMember = checkPolicy(
    valid({ members: [CUSTODY_VAULT, MEMBERS[0], MEMBERS[1]] }),
  );
  assert.ok(asVaultMember.some((failure) => /one of its own members/.test(failure)));

  const asMultisigMember = checkPolicy(
    valid({ members: [CUSTODY_MULTISIG, MEMBERS[0], MEMBERS[1]] }),
  );
  assert.ok(asMultisigMember.some((failure) => /one of its own members/.test(failure)));
});

test("the multisig and its vault may not be the same address", () => {
  const failures = checkPolicy(valid({ multisig: CUSTODY_VAULT }));
  assert.ok(failures.some((failure) => /the same address/.test(failure)));
});

test("reusing the non-custodial programs' vault is refused", () => {
  // The whole point of RR-11: compromising the governance of Core and Commerce
  // must not reach the escrow vault. A configuration that reuses that vault is
  // structurally perfect and not separate at all.
  const failures = checkPolicy(valid({ vault: NON_CUSTODY_VAULT }));
  assert.ok(
    failures.some((failure) => /already governs the non-custodial programs/.test(failure)),
    `reusing ${NON_CUSTODY_VAULT} was accepted`,
  );
});

test("signers shared with the non-custodial multisig are refused by default", () => {
  // Two multisigs at different addresses held by the same people fall to one
  // compromise of those people. The escape exists, and has to be taken
  // deliberately.
  const shared = { nonCustodyMembers: [MEMBERS[1]] };
  const refused = checkPolicy(valid(shared));
  assert.ok(
    refused.some((failure) => /also govern the non-custodial programs/.test(failure)),
    "shared signers were accepted silently",
  );

  const accepted = checkPolicy(valid({ ...shared, allowSharedSigners: true }));
  assert.deepEqual(accepted, [], "the deliberate override did not work");
});

test("every failure is reported at once, not one per run", () => {
  // An operator fixing a configuration should see all of it, rather than one
  // round trip per mistake.
  const failures = checkPolicy(
    valid({ threshold: 1, members: [MEMBERS[0], MEMBERS[0]], vault: MEMBERS[1] }),
  );
  assert.ok(failures.length >= 3, `expected several failures, got ${failures.length}`);
});

test("mainnet is refused outright rather than reported as one failed check", async () => {
  const client = rpc("https://stub.invalid", {
    fetchImpl: makeRpcTransport({ genesis: MAINNET_GENESIS, accounts: {} }),
  });
  await assert.rejects(
    checkChain(client, { vault: CUSTODY_VAULT }),
    /mainnet-beta, which is not an authorized PPV cluster/,
  );
});

test("a vault with no account on chain is reported, not refused", async () => {
  // This assertion is inverted from what it used to be, and the inversion is
  // the point. It used to require an account at the vault address, on the
  // reasoning that "a vault that has never been created cannot hold
  // authority". Running the verifier against the live custody vault for the
  // first time showed the premise is false: a Squads V4 vault is a pure signer
  // PDA with no account of its own, and
  // `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` demonstrably holds the
  // upgrade authority of the deployed ppv_escrow program while having none.
  //
  // So the check was a false negative about the most important fact this file
  // is concerned with. Presence would have proved nothing either — anyone can
  // send a lamport to any address. The real question, "is this the multisig's
  // vault", is answered offline by derivation in `checkPolicy`.
  const client = rpc("https://stub.invalid", {
    fetchImpl: makeRpcTransport({ genesis: DEVNET_GENESIS, accounts: {} }),
  });
  const { failures, vaultAccountExists } = await checkChain(client, { vault: CUSTODY_VAULT });
  assert.equal(vaultAccountExists, false);
  assert.deepEqual(
    failures,
    [],
    "an unfunded Squads vault is normal and must not fail the governance verdict",
  );
});

test("the verifier exits non-zero and says so when policy is not satisfied", async () => {
  const chunks = [];
  const out = { write: (text) => chunks.push(text) };
  const result = await verify({
    argv: [
      "--multisig", CUSTODY_MULTISIG,
      "--vault", NON_CUSTODY_VAULT,
      "--threshold", "2",
      "--members", MEMBERS.slice(0, 3).join(","),
    ],
    out,
  });
  assert.equal(result.ok, false);
  const text = chunks.join("");
  assert.match(text, /GOVERNANCE POLICY NOT SATISFIED/);
  assert.match(text, /Do not give this configuration authority over ppv_escrow/);
  assert.doesNotMatch(text, /PPV_CUSTODY_GOVERNANCE_VALID/);
});

test("a valid configuration prints the marker later tooling greps for", async () => {
  const chunks = [];
  const out = { write: (text) => chunks.push(text) };
  const result = await verify({
    argv: [
      "--multisig", CUSTODY_MULTISIG,
      "--vault", CUSTODY_VAULT,
      "--threshold", "2",
      "--members", MEMBERS.slice(0, 3).join(","),
    ],
    out,
  });
  assert.equal(result.ok, true);
  const text = chunks.join("");
  assert.match(text, /PPV_CUSTODY_GOVERNANCE_VALID/);
  assert.match(text, new RegExp(`custody_vault=${CUSTODY_VAULT}`));
  assert.match(text, /result=valid/);
});

test("no member secret is required, and none is printed", async () => {
  // The configuration is public by construction: addresses, curve membership
  // and equality. A tool that needed a key here would be a tool nobody could
  // safely run before the ceremony.
  const source = await import("node:fs").then(({ readFileSync }) =>
    readFileSync(new URL("../verify-custody-governance.mjs", import.meta.url), "utf8"),
  );
  // Comment lines are stripped first: the file explains that it needs no
  // keypair, and a scan that read its own prose would fail on the sentence
  // saying the thing is true.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  for (const forbidden of ["keypair", "secretKey", "privateKey", "signTransaction"]) {
    assert.ok(!code.includes(forbidden), `the governance verifier references ${forbidden}`);
  }
});

/**
 * The shared-signer check is only as good as the list it compares against. An
 * empty `NON_CUSTODY_MEMBERS` makes it pass for every configuration, including
 * one held entirely by the people who already govern Core and Commerce — the
 * exact arrangement the custody gate exists to refuse. So the list is asserted
 * to be populated, and to agree with the governance the Core and Commerce
 * releases were actually approved under.
 */
test("the non-custodial member list is populated, so the shared-signer check can fire", () => {
  assert.ok(
    NON_CUSTODY_MEMBERS.length > 0,
    "NON_CUSTODY_MEMBERS is empty, so the shared-signer check passes for every configuration",
  );
  for (const member of NON_CUSTODY_MEMBERS) {
    assert.ok(isAddress(member), `${member} is not a Solana address`);
  }
  assert.equal(new Set(NON_CUSTODY_MEMBERS).size, NON_CUSTODY_MEMBERS.length);
});

test("the non-custodial members match the governance Core and Commerce were released under", () => {
  const approval = readFileSync(
    new URL("../verify-devnet-release-approval.mjs", import.meta.url),
    "utf8",
  );
  const declared = approval
    .match(/const EXPECTED_SQUADS_MEMBERS = Object\.freeze\(\[([\s\S]*?)\]/)?.[1]
    ?.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
  assert.ok(declared, "could not read the approved Squads members");
  assert.deepEqual(
    [...NON_CUSTODY_MEMBERS].sort(),
    [...declared].sort(),
    "the custody verifier and the release-approval policy disagree about who governs Core and Commerce",
  );
});

/**
 * The devnet custody ceremony's real member set.
 *
 * One of its three signers, `BJmFM4k7…`, also governs Core and Commerce. That
 * overlap is deliberate and approved **for devnet only**, and the way it stays
 * an exception rather than becoming the rule is that the verifier keeps
 * refusing it by default: the approval is expressed at the call site, per run,
 * by `--allow-shared-signers`, and never by softening the policy itself.
 *
 * So the pair of tests below is the actual guarantee. If the first one ever
 * starts passing without the override, the exception has silently become the
 * default and a mainnet ceremony inherits it.
 */
const DEVNET_CUSTODY_MEMBERS = [
  "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
  "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
];

const SHARED_SIGNER = "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ";

test("the devnet custody set is refused by default, naming the one shared signer", () => {
  const failures = checkPolicy({
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: [...DEVNET_CUSTODY_MEMBERS],
  });

  const shared = failures.filter((failure) => failure.includes(SHARED_SIGNER));
  assert.equal(shared.length, 1, "the shared signer was not reported exactly once");
  assert.match(shared[0], /1 member\(s\) also govern the non-custodial programs/);
  assert.match(shared[0], /--allow-shared-signers/);

  // The overlap must be the *only* thing wrong. If this set failed for some
  // other reason too, granting the override would let that second problem
  // through unnoticed.
  assert.deepEqual(
    failures.filter((failure) => !failure.includes(SHARED_SIGNER)),
    [],
    "the devnet custody set fails policy for reasons beyond the approved overlap",
  );
});

test("the approved overlap passes only with the deliberate override", () => {
  const accepted = checkPolicy({
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: [...DEVNET_CUSTODY_MEMBERS],
    allowSharedSigners: true,
  });
  assert.deepEqual(accepted, []);
});

test("exactly one custody signer overlaps; the other two are independent", () => {
  const overlap = DEVNET_CUSTODY_MEMBERS.filter((member) =>
    NON_CUSTODY_MEMBERS.includes(member),
  );
  assert.deepEqual(overlap, [SHARED_SIGNER]);
  // Two independent signers is what keeps the custody multisig from falling to
  // a single compromise of the Core/Commerce signers: they cannot reach a
  // 2-of-3 threshold with one shared key alone.
  assert.equal(DEVNET_CUSTODY_MEMBERS.length - overlap.length, 2);
  assert.ok(overlap.length < 2, "shared signers alone must not satisfy the threshold");
});

test("the override is scoped to the run, not baked into the policy", () => {
  // A second, otherwise-identical configuration with two shared signers is
  // still refused with the override absent — the override is not a mode the
  // verifier can be left in.
  const twoShared = checkPolicy({
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: [NON_CUSTODY_MEMBERS[0], NON_CUSTODY_MEMBERS[1], DEVNET_CUSTODY_MEMBERS[0]],
  });
  assert.ok(twoShared.some((failure) => failure.includes("2 member(s) also govern")));
});
