import assert from "node:assert/strict";
import test from "node:test";

import {
  NON_CUSTODY_VAULT,
  checkChain,
  checkPolicy,
  verify,
} from "../verify-custody-governance.mjs";
import { rpc, DEVNET_GENESIS, MAINNET_GENESIS } from "../lib/rpc.mjs";
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

/** A second program-derived address, for "the custody vault is a different PDA". */
const CUSTODY_VAULT = "FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA";
const CUSTODY_MULTISIG = "3cFRkTFrpmNXetfLJka5q1owRffk1tjWVo8SDLPyWB7w";

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

test("a vault that does not exist on chain is reported", async () => {
  const client = rpc("https://stub.invalid", {
    fetchImpl: makeRpcTransport({ genesis: DEVNET_GENESIS, accounts: {} }),
  });
  const { failures } = await checkChain(client, { vault: CUSTODY_VAULT });
  assert.ok(failures.some((failure) => /no account exists at the vault/.test(failure)));
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
