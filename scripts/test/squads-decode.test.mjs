import assert from "node:assert/strict";
import test from "node:test";

import * as sqds from "@sqds/multisig";
import { PublicKey } from "@solana/web3.js";

import {
  MULTISIG_DISCRIMINATOR,
  PERMISSION_ALL,
  PERMISSION_EXECUTE,
  PERMISSION_INITIATE,
  PERMISSION_VOTE,
  SQUADS_V4_PROGRAM_ID,
  SquadsDecodeError,
  compareToPolicy,
  decodeMultisig,
  deriveVault,
  permissionNames,
  readMultisig,
} from "../lib/squads.mjs";
import { ESCROW_CUSTODY_GOVERNANCE } from "../lib/identity.mjs";

/**
 * The Squads decoder, checked against the Squads client rather than against
 * itself.
 *
 * `scripts/lib/squads.mjs` hand-writes the `Multisig` layout so the read-only
 * verifiers stay dependency-free. A hand-written layout is worth exactly as
 * much as the thing it is checked against, so it is checked against the pinned
 * `@sqds/multisig` 2.1.4 serializer — the same code Squads' own clients use —
 * on accounts that serializer produced. If Squads changes the layout, or this
 * repository's copy of it drifts, these tests fail rather than the verifier
 * reporting a confident wrong threshold for the multisig that can replace the
 * custody program's code.
 *
 * Nothing here touches a network. Every account is built locally.
 */

const CUSTODY_MULTISIG = "GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46";
const CUSTODY_VAULT = "FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE";
const CUSTODY_MEMBERS = [
  "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
  "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
];

/** A `Multisig` account built by the pinned Squads serializer. */
function multisigAccount({
  threshold = 2,
  members = CUSTODY_MEMBERS.map((key) => ({ key, mask: PERMISSION_ALL })),
  rentCollector = null,
  timeLock = 0,
  bump = 255,
  createKey = CUSTODY_MEMBERS[0],
  configAuthority = PublicKey.default.toBase58(),
} = {}) {
  const [buffer] = sqds.accounts.multisigBeet.serialize({
    accountDiscriminator: Array.from(sqds.accounts.multisigDiscriminator),
    createKey: new PublicKey(createKey),
    configAuthority: new PublicKey(configAuthority),
    threshold,
    timeLock,
    transactionIndex: 0n,
    staleTransactionIndex: 0n,
    rentCollector: rentCollector ? new PublicKey(rentCollector) : null,
    bump,
    members: members.map((member) => ({
      key: new PublicKey(member.key),
      permissions: { mask: member.mask },
    })),
  });
  return buffer;
}

/** A read-only RPC stub serving exactly one account. */
function clientServing(address, { data, owner = SQUADS_V4_PROGRAM_ID, executable = false }) {
  return {
    endpoint: "stub://offline",
    accountInfo: async (requested) =>
      requested === address
        ? { data: [data.toString("base64"), "base64"], owner, executable, lamports: 4_000_000 }
        : null,
  };
}

/* ------------------------------------------- the layout, against the client */

test("the pinned program id is the canonical Squads V4 program", () => {
  assert.equal(SQUADS_V4_PROGRAM_ID, sqds.PROGRAM_ID.toBase58());
  assert.equal(SQUADS_V4_PROGRAM_ID, "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
});

test("the account discriminator is the client's", () => {
  assert.deepEqual(
    Array.from(MULTISIG_DISCRIMINATOR),
    Array.from(sqds.accounts.multisigDiscriminator),
  );
});

test("the permission bits are the client's", () => {
  assert.equal(PERMISSION_INITIATE, sqds.types.Permission.Initiate);
  assert.equal(PERMISSION_VOTE, sqds.types.Permission.Vote);
  assert.equal(PERMISSION_EXECUTE, sqds.types.Permission.Execute);
  assert.equal(PERMISSION_ALL, 7);
  assert.deepEqual(permissionNames(PERMISSION_ALL), ["Initiate", "Vote", "Execute"]);
});

test("decoding agrees with the pinned Squads client, field for field", () => {
  for (const shape of [
    {},
    { threshold: 3, timeLock: 86_400, bump: 250 },
    { rentCollector: CUSTODY_MEMBERS[2] },
    { members: [] },
    {
      members: [
        { key: CUSTODY_MEMBERS[0], mask: PERMISSION_VOTE },
        { key: CUSTODY_MEMBERS[1], mask: PERMISSION_ALL },
      ],
      threshold: 1,
    },
  ]) {
    const data = multisigAccount(shape);
    const ours = decodeMultisig(data);
    const [theirs] = sqds.accounts.Multisig.fromAccountInfo({
      data,
      owner: sqds.PROGRAM_ID,
      lamports: 1,
      executable: false,
    });

    assert.equal(ours.threshold, theirs.threshold, "threshold");
    assert.equal(ours.timeLock, theirs.timeLock, "time lock");
    assert.equal(ours.bump, theirs.bump, "bump");
    assert.equal(ours.createKey, theirs.createKey.toBase58(), "create key");
    assert.equal(ours.configAuthority, theirs.configAuthority.toBase58(), "config authority");
    assert.equal(
      ours.rentCollector,
      theirs.rentCollector ? theirs.rentCollector.toBase58() : null,
      "rent collector",
    );
    assert.deepEqual(
      ours.members.map((member) => [member.key, member.mask]),
      theirs.members.map((member) => [member.key.toBase58(), member.permissions.mask]),
      "members",
    );
    assert.equal(ours.trailingBytes, 0, "no bytes left over");
  }
});

test("the vault derivation agrees with the pinned Squads client", () => {
  for (const index of [0, 1, 7, 255]) {
    const [expected, expectedBump] = sqds.getVaultPda({
      multisigPda: new PublicKey(CUSTODY_MULTISIG),
      index,
    });
    const derived = deriveVault(CUSTODY_MULTISIG, index);
    assert.equal(derived.address, expected.toBase58(), `vault index ${index}`);
    assert.equal(derived.bump, expectedBump);
  }
});

test("vault index 0 of the custody multisig is the recorded custody vault", () => {
  assert.equal(deriveVault(CUSTODY_MULTISIG, 0).address, CUSTODY_VAULT);
  assert.equal(ESCROW_CUSTODY_GOVERNANCE.vault, CUSTODY_VAULT);
  assert.equal(ESCROW_CUSTODY_GOVERNANCE.multisig, CUSTODY_MULTISIG);
});

test("a different vault index is a different account", () => {
  assert.notEqual(deriveVault(CUSTODY_MULTISIG, 1).address, CUSTODY_VAULT);
});

test("a vault index outside u8 is refused rather than wrapped", () => {
  for (const index of [-1, 256, 1.5, "0"]) {
    assert.throws(() => deriveVault(CUSTODY_MULTISIG, index), SquadsDecodeError);
  }
});

/* ------------------------------------------------ what decoding must refuse */

test("a non-Multisig discriminator is refused", () => {
  const data = multisigAccount();
  data[0] ^= 0xff;
  assert.throws(() => decodeMultisig(data), /not the Squads V4 Multisig discriminator/);
});

test("a truncated account is an error, not a shorter multisig", () => {
  const data = multisigAccount();
  for (const length of [7, 40, 93, 94, 99, data.length - 1]) {
    assert.throws(() => decodeMultisig(data.subarray(0, length)), SquadsDecodeError);
  }
});

test("an invalid rent-collector option tag is refused", () => {
  const data = multisigAccount();
  data[94] = 2;
  assert.throws(() => decodeMultisig(data), /invalid Option tag/);
});

test("an account owned by another program is not a multisig", async () => {
  const data = multisigAccount();
  const client = clientServing(CUSTODY_MULTISIG, {
    data,
    owner: "11111111111111111111111111111111",
  });
  await assert.rejects(
    readMultisig(client, CUSTODY_MULTISIG),
    /not the Squads V4 program/,
    "Squads-shaped bytes under another program's ownership must not decode as a multisig",
  );
});

test("an executable account is not a multisig", async () => {
  const client = clientServing(CUSTODY_MULTISIG, { data: multisigAccount(), executable: true });
  await assert.rejects(readMultisig(client, CUSTODY_MULTISIG), /is executable/);
});

test("a missing account is an error", async () => {
  const client = clientServing("SomeOtherAddress11111111111111111111111111", {
    data: multisigAccount(),
  });
  await assert.rejects(readMultisig(client, CUSTODY_MULTISIG), /no account exists/);
});

test("the live account is read through the RPC client and decoded", async () => {
  const client = clientServing(CUSTODY_MULTISIG, { data: multisigAccount() });
  const live = await readMultisig(client, CUSTODY_MULTISIG);
  assert.equal(live.threshold, 2);
  assert.equal(live.address, CUSTODY_MULTISIG);
  assert.deepEqual(live.members.map((m) => m.key), CUSTODY_MEMBERS);
});

/* ------------------------------------------ live state against declared policy */

const DECLARED = {
  multisig: CUSTODY_MULTISIG,
  threshold: 2,
  members: CUSTODY_MEMBERS,
  vault: CUSTODY_VAULT,
  vaultIndex: 0,
};

test("the recorded custody configuration matches a live account that holds it", () => {
  const decoded = decodeMultisig(multisigAccount());
  assert.deepEqual(compareToPolicy(decoded, DECLARED), []);
});

test("a wrong live threshold is refused", () => {
  const decoded = decodeMultisig(multisigAccount({ threshold: 1 }));
  const failures = compareToPolicy(decoded, DECLARED);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /live threshold is 1, the declared threshold is 2/);
});

test("a wrong live member set is refused, in both directions", () => {
  const stranger = "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV";
  const decoded = decodeMultisig(
    multisigAccount({
      members: [
        { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
        { key: CUSTODY_MEMBERS[1], mask: PERMISSION_ALL },
        { key: stranger, mask: PERMISSION_ALL },
      ],
    }),
  );
  const failures = compareToPolicy(decoded, DECLARED);
  assert.ok(failures.some((f) => f.includes(`declared member ${CUSTODY_MEMBERS[2]} is not a live member`)));
  assert.ok(failures.some((f) => f.includes(`live member ${stranger} is not in the declared member set`)));
});

test("an extra live member is refused even when every declared member is present", () => {
  const decoded = decodeMultisig(
    multisigAccount({
      members: [
        ...CUSTODY_MEMBERS.map((key) => ({ key, mask: PERMISSION_ALL })),
        { key: "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV", mask: PERMISSION_ALL },
      ],
    }),
  );
  const failures = compareToPolicy(decoded, DECLARED);
  assert.ok(failures.some((f) => /has 4 member\(s\), 3 were declared/.test(f)));
});

test("a duplicated live member is refused", () => {
  const decoded = decodeMultisig(
    multisigAccount({
      members: [
        { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
        { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
        { key: CUSTODY_MEMBERS[2], mask: PERMISSION_ALL },
      ],
    }),
  );
  assert.ok(compareToPolicy(decoded, DECLARED).some((f) => /duplicate keys/.test(f)));
});

test("a member short of Initiate + Vote + Execute is refused", () => {
  const decoded = decodeMultisig(
    multisigAccount({
      members: [
        { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
        { key: CUSTODY_MEMBERS[1], mask: PERMISSION_VOTE | PERMISSION_EXECUTE },
        { key: CUSTODY_MEMBERS[2], mask: PERMISSION_ALL },
      ],
    }),
  );
  const failures = compareToPolicy(decoded, DECLARED);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /permission mask 6 \(Vote \+ Execute\), policy requires mask 7/);
});

test("a vault that does not derive from this multisig is refused", () => {
  const decoded = decodeMultisig(multisigAccount());
  const failures = compareToPolicy(decoded, { ...DECLARED, vault: CUSTODY_MEMBERS[0] });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /derives to FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE, not the declared/);
});

test("the right vault under the wrong index is refused", () => {
  const decoded = decodeMultisig(multisigAccount());
  const failures = compareToPolicy(decoded, { ...DECLARED, vaultIndex: 1 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /vault index 1 of the live multisig derives to/);
});

/* ------------------------------- the verifier, driven against a stub cluster */

import { DEVNET_GENESIS, MAINNET_GENESIS } from "../lib/rpc.mjs";
import {
  GovernanceFailure,
  MAX_APPROVED_SHARED_SIGNERS,
  checkPolicy,
  verify,
} from "../verify-custody-governance.mjs";

/** A read-only cluster stub: a genesis hash, the multisig, and the vault. */
function cluster({
  genesis = DEVNET_GENESIS,
  multisigData = multisigAccount(),
  multisigOwner = SQUADS_V4_PROGRAM_ID,
  vaultExists = true,
} = {}) {
  return {
    endpoint: "stub://offline",
    genesisHash: async () => genesis,
    accountInfo: async (address) => {
      if (address === CUSTODY_MULTISIG) {
        return {
          data: [multisigData.toString("base64"), "base64"],
          owner: multisigOwner,
          executable: false,
          lamports: 4_000_000,
        };
      }
      if (address === CUSTODY_VAULT && vaultExists) {
        return { data: ["", "base64"], owner: "11111111111111111111111111111111", lamports: 1 };
      }
      return null;
    },
  };
}

const ARGV = [
  "--multisig", CUSTODY_MULTISIG,
  "--vault", CUSTODY_VAULT,
  "--threshold", "2",
  "--members", CUSTODY_MEMBERS.join(","),
  "--allow-shared-signers",
];

/** Collects the verifier's report instead of printing it. */
function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

test("--live-squads reads the threshold and members off the chain", async () => {
  const out = sink();
  const result = await verify({ argv: [...ARGV, "--live-squads"], client: cluster(), out });
  assert.equal(result.ok, true, out.text());
  assert.match(out.text(), /squads_live_decode=read-from-chain/);
  assert.match(out.text(), /squads_live_threshold=2/);
  assert.match(out.text(), new RegExp(`squads_live_members=${CUSTODY_MEMBERS.join(",")}`));
  assert.match(out.text(), /squads_live_permissions=7,7,7/);
  assert.match(out.text(), new RegExp(`squads_vault_derived=${CUSTODY_VAULT}`));
  assert.equal(result.squads.threshold, 2);
});

test("without --live-squads the verifier says so rather than implying a live read", async () => {
  const out = sink();
  const result = await verify({ argv: ARGV, client: cluster(), out });
  assert.equal(result.ok, true);
  assert.match(out.text(), /squads_live_decode=declared-only/);
  assert.equal(result.squads, null);
});

test("a live threshold that disagrees with the declared one fails the verifier", async () => {
  const out = sink();
  const result = await verify({
    argv: [...ARGV, "--live-squads"],
    client: cluster({ multisigData: multisigAccount({ threshold: 3 }) }),
    out,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /live threshold is 3/.test(f)));
  assert.match(out.text(), /GOVERNANCE POLICY NOT SATISFIED/);
});

test("a live member set that disagrees with the declared one fails the verifier", async () => {
  const out = sink();
  const result = await verify({
    argv: [...ARGV, "--live-squads"],
    client: cluster({
      multisigData: multisigAccount({
        members: [
          { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
          { key: CUSTODY_MEMBERS[1], mask: PERMISSION_ALL },
          { key: "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV", mask: PERMISSION_ALL },
        ],
      }),
    }),
    out,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /is not a live member/.test(f)));
});

test("a live member missing a permission bit fails the verifier", async () => {
  const out = sink();
  const result = await verify({
    argv: [...ARGV, "--live-squads"],
    client: cluster({
      multisigData: multisigAccount({
        members: [
          { key: CUSTODY_MEMBERS[0], mask: PERMISSION_ALL },
          { key: CUSTODY_MEMBERS[1], mask: PERMISSION_INITIATE },
          { key: CUSTODY_MEMBERS[2], mask: PERMISSION_ALL },
        ],
      }),
    }),
    out,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /permission mask 1 \(Initiate\), policy requires mask 7/.test(f)));
});

test("a multisig account under the wrong program fails the verifier", async () => {
  const out = sink();
  const result = await verify({
    argv: [...ARGV, "--live-squads"],
    client: cluster({ multisigOwner: "11111111111111111111111111111111" }),
    out,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /not the Squads V4 program/.test(f)));
  assert.match(out.text(), /squads {4}NOT DECODED/);
});

test("--live-squads with no RPC endpoint is a failure, not a silent downgrade", async () => {
  const out = sink();
  const result = await verify({ argv: [...ARGV, "--live-squads"], client: null, out });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => /a live decode that did not happen is not a live decode/.test(f)),
  );
});

test("mainnet is refused before any multisig is read", async () => {
  await assert.rejects(
    verify({
      argv: [...ARGV, "--live-squads"],
      client: cluster({ genesis: MAINNET_GENESIS }),
      out: sink(),
    }),
    GovernanceFailure,
  );
});

test("an unknown cluster is refused and no live decode is claimed", async () => {
  const out = sink();
  const result = await verify({
    argv: [...ARGV, "--live-squads"],
    client: cluster({ genesis: "11111111111111111111111111111111" }),
    out,
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /expected devnet/.test(f)));
  assert.equal(result.squads, null);
});

/* ---------------------------------------- the shared-signer policy, unweakened */

const NON_CUSTODY = [
  "58kuGbxpvaamvYE44WYkyipBB6FVKt2qT9u3vAKtyKYV",
  "2FFVcm9xJmUHG6zfo15ktzuGQTXACPG42iquGHe6faTN",
  "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
];

test("the approved overlap is exactly one signer", () => {
  assert.equal(MAX_APPROVED_SHARED_SIGNERS, 1);
  const shared = CUSTODY_MEMBERS.filter((member) => NON_CUSTODY.includes(member));
  assert.deepEqual(shared, ["BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ"]);
});

test("one shared signer is refused by default and accepted only deliberately", () => {
  const config = {
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: CUSTODY_MEMBERS,
  };
  assert.ok(
    checkPolicy(config).some((f) => /Pass --allow-shared-signers/.test(f)),
    "the default must still refuse the overlap",
  );
  assert.deepEqual(checkPolicy({ ...config, allowSharedSigners: true }), []);
});

test("a second shared signer is refused even with --allow-shared-signers", () => {
  const failures = checkPolicy({
    multisig: CUSTODY_MULTISIG,
    vault: CUSTODY_VAULT,
    threshold: 2,
    members: [CUSTODY_MEMBERS[0], NON_CUSTODY[0], NON_CUSTODY[2]],
    allowSharedSigners: true,
  });
  assert.ok(
    failures.some((f) => /At most 1 shared signer is approved/.test(f)),
    `expected the cap to fire, got ${JSON.stringify(failures)}`,
  );
});
