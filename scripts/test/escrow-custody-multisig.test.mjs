import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

import {
  CUSTODY_MEMBERS,
  CUSTODY_THRESHOLD,
  CUSTODY_TIME_LOCK,
  CUSTODY_VAULT_INDEX,
  CeremonyError,
  DEVNET_ENDPOINT,
  SQUADS_V4_PROGRAM_ID,
  assertDevnet,
  assertSquadsProgram,
  buildMembers,
  checkSafety,
  custodyPermissions,
  deriveAddresses,
  formatSummary,
  loadKeypairFromEnv,
  main,
  mayBroadcast,
  parseMode,
  resolveCreateKey,
} from "../create-escrow-custody-multisig.mjs";
import { DEVNET_GENESIS, MAINNET_GENESIS } from "../lib/rpc.mjs";

/**
 * The custody creation ceremony.
 *
 * Its output is permanent: a multisig created at the wrong address, or with a
 * threshold of one, is not corrected afterwards. So the properties asserted here
 * are the ones that cannot be re-checked later — the configuration itself, the
 * cluster proof, and above all the execution boundary, which is the only thing
 * standing between an accidental invocation and an irreversible transaction.
 *
 * Nothing here needs a private key or a live cluster. The signers are throwaway
 * keypairs generated in-process and the cluster is a stub, so the suite runs in
 * CI without any key material existing anywhere near it.
 */

/** A stub cluster. Every test that touches the network states its own answers. */
function stubConnection({
  genesisHash = DEVNET_GENESIS,
  squadsAccount = { executable: true, owner: PublicKey.default, data: Buffer.alloc(0) },
  rpcEndpoint = DEVNET_ENDPOINT,
} = {}) {
  return {
    rpcEndpoint,
    getGenesisHash: async () => genesisHash,
    getAccountInfo: async () => squadsAccount,
    getLatestBlockhash: async () => {
      throw new Error("the test cluster must never be asked to build a transaction");
    },
    sendTransaction: async () => {
      throw new Error("BROADCAST ATTEMPTED");
    },
  };
}

const scratchDir = () => mkdtempSync(join(tmpdir(), "ppv-custody-"));

/* ------------------------------------------------------- configuration */

test("the configuration is a 2-of-3 over three distinct, valid members", () => {
  assert.equal(CUSTODY_THRESHOLD, 2);
  assert.equal(CUSTODY_MEMBERS.length, 3);
  assert.equal(new Set(CUSTODY_MEMBERS).size, 3, "members must be distinct keys");
  for (const member of CUSTODY_MEMBERS) {
    assert.doesNotThrow(() => new PublicKey(member), `${member} is not a valid public key`);
    // A member is a person's signing key, so it is on the curve. An off-curve
    // "member" is a PDA nobody can sign for, and the threshold becomes
    // unsatisfiable at exactly the moment it is needed.
    assert.ok(PublicKey.isOnCurve(new PublicKey(member)), `${member} is not a signer key`);
  }
  // 2-of-3 is the point at which no single compromised key can move anything
  // and no single lost key can lock everyone out.
  assert.ok(CUSTODY_THRESHOLD > 1 && CUSTODY_THRESHOLD < CUSTODY_MEMBERS.length + 1);
});

test("the members are exactly the three addresses the ceremony was authorized for", () => {
  assert.deepEqual([...CUSTODY_MEMBERS], [
    "HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx",
    "5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo",
    "BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ",
  ]);
});

test("every member receives initiate, vote and execute", () => {
  const { Permission, Permissions } = multisig.types;
  const members = buildMembers();
  assert.equal(members.length, 3);
  for (const member of members) {
    for (const [name, permission] of Object.entries(Permission)) {
      assert.ok(
        Permissions.has(member.permissions, permission),
        `a member is missing the ${name} permission`,
      );
    }
  }
  // Built from the SDK's constants, not a literal: the mask is whatever the
  // installed program means by these three permissions.
  assert.equal(custodyPermissions().mask, Permissions.all().mask);
});

test("the time lock is zero and the vault index is zero", () => {
  assert.equal(CUSTODY_TIME_LOCK, 0);
  assert.equal(CUSTODY_VAULT_INDEX, 0);
});

test("the SDK targets the Squads V4 program policy names", () => {
  assert.equal(multisig.PROGRAM_ID.toBase58(), SQUADS_V4_PROGRAM_ID);
});

/* -------------------------------------------------------------- safety */

test("a sound configuration passes every offline check", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const failures = checkSafety({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
    members: [...CUSTODY_MEMBERS],
  });
  assert.deepEqual(failures, []);
});

test("a threshold other than two is refused", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const base = {
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    members: [...CUSTODY_MEMBERS],
  };
  for (const threshold of [0, 1, 3, 4]) {
    const failures = checkSafety({ ...base, threshold });
    assert.ok(
      failures.some((failure) => failure.includes("threshold")),
      `threshold ${threshold} was accepted`,
    );
  }
});

test("a member list that is not exactly three is refused", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const base = {
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
  };
  for (const members of [[], CUSTODY_MEMBERS.slice(0, 2), [...CUSTODY_MEMBERS, Keypair.generate().publicKey.toBase58()]]) {
    const failures = checkSafety({ ...base, members: [...members] });
    assert.ok(failures.length > 0, `a list of ${members.length} members was accepted`);
  }
});

test("duplicate members are refused, because a 2-of-3 with a repeat is a 1-of-2", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const failures = checkSafety({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
    members: [CUSTODY_MEMBERS[0], CUSTODY_MEMBERS[0], CUSTODY_MEMBERS[1]],
  });
  assert.ok(failures.some((failure) => failure.includes("duplicates")));
});

test("an invalid public key in the member list is refused", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const failures = checkSafety({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
    members: [CUSTODY_MEMBERS[0], CUSTODY_MEMBERS[1], "not-an-address"],
  });
  assert.ok(failures.some((failure) => failure.includes("not a valid public key")));
});

test("the vault cannot be one of its own members", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const failures = checkSafety({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
    members: [CUSTODY_MEMBERS[0], CUSTODY_MEMBERS[1], vaultPda.toBase58()],
  });
  assert.ok(failures.some((failure) => failure.includes("one of its own members")));
});

test("the multisig cannot be one of its own members", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  const failures = checkSafety({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    threshold: CUSTODY_THRESHOLD,
    members: [CUSTODY_MEMBERS[0], CUSTODY_MEMBERS[1], multisigPda.toBase58()],
  });
  assert.ok(failures.some((failure) => failure.includes("one of its own members")));
});

test("the multisig and its vault are distinct addresses", () => {
  const { multisigPda, vaultPda } = deriveAddresses(Keypair.generate().publicKey);
  assert.notEqual(multisigPda.toBase58(), vaultPda.toBase58());
});

/* ----------------------------------------------------------- derivation */

test("addresses come from the SDK's canonical PDA helpers and are deterministic", () => {
  const createKey = Keypair.generate().publicKey;
  const first = deriveAddresses(createKey);
  const second = deriveAddresses(createKey);
  assert.equal(first.multisigPda.toBase58(), second.multisigPda.toBase58());
  assert.equal(first.vaultPda.toBase58(), second.vaultPda.toBase58());

  const [expectedMultisig] = multisig.getMultisigPda({ createKey });
  const [expectedVault] = multisig.getVaultPda({
    multisigPda: expectedMultisig,
    index: CUSTODY_VAULT_INDEX,
  });
  assert.equal(first.multisigPda.toBase58(), expectedMultisig.toBase58());
  assert.equal(first.vaultPda.toBase58(), expectedVault.toBase58());

  // Both are program-derived, so neither is a wallet anyone holds a key to.
  assert.ok(!PublicKey.isOnCurve(first.multisigPda));
  assert.ok(!PublicKey.isOnCurve(first.vaultPda));
});

test("a different createKey derives a different multisig", () => {
  const a = deriveAddresses(Keypair.generate().publicKey);
  const b = deriveAddresses(Keypair.generate().publicKey);
  assert.notEqual(a.multisigPda.toBase58(), b.multisigPda.toBase58());
});

/* -------------------------------------------------------- cluster proof */

test("devnet's genesis hash is accepted", async () => {
  assert.equal(await assertDevnet(stubConnection()), DEVNET_GENESIS);
});

test("a wrong genesis hash stops the ceremony", async () => {
  for (const genesisHash of [MAINNET_GENESIS, "11111111111111111111111111111111"]) {
    await assert.rejects(
      () => assertDevnet(stubConnection({ genesisHash })),
      (error) => {
        assert.ok(error instanceof CeremonyError);
        assert.match(error.message, /STOP — WRONG CLUSTER/);
        return true;
      },
      `genesis ${genesisHash} was accepted as devnet`,
    );
  }
});

test("a missing Squads program stops the ceremony", async () => {
  await assert.rejects(
    () => assertSquadsProgram(stubConnection({ squadsAccount: null })),
    (error) => {
      assert.ok(error instanceof CeremonyError);
      assert.match(error.message, /does not exist/);
      return true;
    },
  );
});

test("a non-executable account at the Squads address stops the ceremony", async () => {
  await assert.rejects(
    () => assertSquadsProgram(stubConnection({ squadsAccount: { executable: false } })),
    (error) => {
      assert.ok(error instanceof CeremonyError);
      assert.match(error.message, /not executable/);
      return true;
    },
  );
});

/* ------------------------------------------------- the execution boundary */

test("only --execute may broadcast", () => {
  assert.equal(parseMode(["--execute"]), "execute");
  assert.ok(mayBroadcast("execute"));

  for (const mode of ["preflight", "none", "unknown"]) {
    assert.ok(!mayBroadcast(mode), `${mode} was allowed to broadcast`);
  }
});

test("--preflight cannot broadcast", () => {
  assert.equal(parseMode(["--preflight"]), "preflight");
  assert.ok(!mayBroadcast(parseMode(["--preflight"])));
});

test("no argument cannot broadcast", () => {
  assert.equal(parseMode([]), "none");
  assert.ok(!mayBroadcast(parseMode([])));
});

test("unknown modes cannot broadcast", () => {
  for (const argv of [
    ["--force"],
    ["--yes"],
    ["--execute-now"],
    ["--preflight", "--execute"],
    ["--execute", "--force"],
    ["--EXECUTE"],
    ["--Execute"],
    ["--execute="],
  ]) {
    const mode = parseMode(argv);
    assert.ok(
      !mayBroadcast(mode),
      `${argv.join(" ")} resolved to ${mode}, which may broadcast`,
    );
  }
});

test("no argument prints usage and creates nothing", async () => {
  let output = "";
  const result = await main({
    argv: [],
    out: { write: (text) => (output += text) },
    connectionFactory: () => {
      throw new Error("the cluster must not be contacted without a mode");
    },
  });
  assert.equal(result.broadcast, false);
  assert.equal(result.ok, false);
  assert.match(output, /Nothing was created/);
});

test("an unknown argument prints usage and creates nothing", async () => {
  let output = "";
  const result = await main({
    argv: ["--send-it"],
    out: { write: (text) => (output += text) },
    connectionFactory: () => {
      throw new Error("the cluster must not be contacted for an unknown mode");
    },
  });
  assert.equal(result.broadcast, false);
  assert.match(output, /Unrecognized arguments/);
});

test("--preflight derives, reports, and sends nothing", async () => {
  const path = join(scratchDir(), "createkey-keypair.json");
  let output = "";
  const result = await main({
    argv: ["--preflight"],
    out: { write: (text) => (output += text) },
    env: { PPV_CUSTODY_CREATE_KEY: path },
    // The stub throws from getLatestBlockhash and sendTransaction, so a
    // preflight that tried to build or send a transaction fails this test
    // rather than passing quietly.
    connectionFactory: () => stubConnection(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.broadcast, false);
  assert.match(output, /NETWORK=devnet/);
  assert.match(output, new RegExp(`GENESIS_HASH=${DEVNET_GENESIS}`));
  assert.match(output, /THRESHOLD=2/);
  assert.match(output, /THRESHOLD_VALID=yes/);
  assert.match(output, /MEMBERS_UNIQUE=yes/);
  assert.match(output, /VAULT_NOT_MEMBER=yes/);
  assert.match(output, /MULTISIG_NOT_MEMBER=yes/);
  assert.match(output, /PREFLIGHT ONLY/);
  for (const member of CUSTODY_MEMBERS) assert.ok(output.includes(member));

  // The reported addresses are the ones the SDK derives from the recorded
  // createKey, not something the script decided separately.
  const { multisigPda, vaultPda } = deriveAddresses(new PublicKey(result.createKeyPublic));
  assert.equal(result.multisig, multisigPda.toBase58());
  assert.equal(result.vault, vaultPda.toBase58());
});

test("a wrong cluster stops --preflight before any derivation", async () => {
  await assert.rejects(
    () =>
      main({
        argv: ["--preflight"],
        out: { write: () => {} },
        env: {},
        connectionFactory: () => stubConnection({ genesisHash: MAINNET_GENESIS }),
      }),
    /STOP — WRONG CLUSTER/,
  );
});

/* ---------------------------------------------------------- key material */

test("--execute without an operator signer refuses to broadcast", async () => {
  const path = join(scratchDir(), "createkey-keypair.json");
  // Fix the createKey first, the way a real preflight would.
  await main({
    argv: ["--preflight"],
    out: { write: () => {} },
    env: { PPV_CUSTODY_CREATE_KEY: path },
    connectionFactory: () => stubConnection(),
  });

  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env: { PPV_CUSTODY_CREATE_KEY: path },
        connectionFactory: () => stubConnection(),
      }),
    (error) => {
      assert.ok(error instanceof CeremonyError);
      assert.match(error.message, /PPV_OPERATOR_KEYPAIR is not set/);
      // It stopped before building anything; the stub would have thrown
      // "BROADCAST ATTEMPTED" otherwise.
      assert.doesNotMatch(error.message, /BROADCAST ATTEMPTED/);
      return true;
    },
  );
});

test("--execute refuses a createKey that no preflight fixed", async () => {
  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env: {},
        connectionFactory: () => stubConnection(),
      }),
    /PPV_CUSTODY_CREATE_KEY is not set/,
  );

  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env: { PPV_CUSTODY_CREATE_KEY: join(scratchDir(), "absent-keypair.json") },
        connectionFactory: () => stubConnection(),
      }),
    /which does not exist/,
  );
});

test("--preflight writes the createKey once and reuses it thereafter", () => {
  const path = join(scratchDir(), "createkey-keypair.json");
  const first = resolveCreateKey("preflight", { env: { PPV_CUSTODY_CREATE_KEY: path } });
  const second = resolveCreateKey("preflight", { env: { PPV_CUSTODY_CREATE_KEY: path } });
  assert.equal(
    first.keypair.publicKey.toBase58(),
    second.keypair.publicKey.toBase58(),
    "a second preflight derived a different address than the one reviewed",
  );
  // The createKey is not one of the three governance members: it signs the
  // creation and then governs nothing.
  assert.ok(!CUSTODY_MEMBERS.includes(first.keypair.publicKey.toBase58()));
});

test("a keypair path that is unset, unreadable or malformed is refused by name", () => {
  const dir = scratchDir();
  const bad = join(dir, "bad-keypair.json");
  writeFileSync(bad, "{ not json");
  const wrongShape = join(dir, "shape-keypair.json");
  writeFileSync(wrongShape, JSON.stringify({ secretKey: "nope" }));
  const wrongLength = join(dir, "short-keypair.json");
  writeFileSync(wrongLength, JSON.stringify([1, 2, 3]));

  assert.throws(() => loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: {} }), /is not set/);
  assert.throws(
    () => loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: { PPV_OPERATOR_KEYPAIR: join(dir, "absent.json") } }),
    /could not be read/,
  );
  assert.throws(
    () => loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: { PPV_OPERATOR_KEYPAIR: bad } }),
    /not a JSON keypair array/,
  );
  assert.throws(
    () => loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: { PPV_OPERATOR_KEYPAIR: wrongShape } }),
    /not a JSON keypair array/,
  );
  assert.throws(
    () => loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: { PPV_OPERATOR_KEYPAIR: wrongLength } }),
    /not a valid ed25519 keypair/,
  );
});

test("a real keypair file loads, and the loader is given a path rather than a key", () => {
  const dir = scratchDir();
  const path = join(dir, "operator-keypair.json");
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  const loaded = loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", { env: { PPV_OPERATOR_KEYPAIR: path } });
  assert.equal(loaded.publicKey.toBase58(), keypair.publicKey.toBase58());

  // Handing the loader the key itself, rather than a path, must fail rather
  // than quietly work — that is the habit the rule exists to prevent.
  assert.throws(
    () =>
      loadKeypairFromEnv("PPV_OPERATOR_KEYPAIR", {
        env: { PPV_OPERATOR_KEYPAIR: JSON.stringify(Array.from(keypair.secretKey)) },
      }),
    /could not be read/,
  );
});

/* --------------------------------------------------------- no key leakage */

test("the summary contains public information only", () => {
  const createKey = Keypair.generate();
  const { multisigPda, vaultPda } = deriveAddresses(createKey.publicKey);
  const summary = formatSummary({
    genesisHash: DEVNET_GENESIS,
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    createKeyPublic: createKey.publicKey.toBase58(),
  });

  // The secret key must not appear in any encoding the script could reach for.
  const secretArray = JSON.stringify(Array.from(createKey.secretKey));
  assert.ok(!summary.includes(secretArray));
  assert.ok(!summary.includes(Buffer.from(createKey.secretKey).toString("base64")));
  assert.ok(!summary.includes(Buffer.from(createKey.secretKey).toString("hex")));
  // A 64-element numeric array in the output would be a secret key whatever it
  // was labelled.
  assert.doesNotMatch(summary, /(\d+,){60,}\d+/);
  assert.ok(summary.includes(createKey.publicKey.toBase58()), "the public key may be printed");
});

test("the script source contains no embedded key material", () => {
  const source = readFileSync(
    new URL("../create-escrow-custody-multisig.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /(\d+,\s*){31,}\d+/, "a literal secret key array is in the source");
  assert.doesNotMatch(source, /secretKey\s*:\s*["'[]/);
  // The key-bearing variables must hold paths, and the script must say so.
  assert.match(source, /PPV_OPERATOR_KEYPAIR/);
  assert.match(source, /PPV_CUSTODY_CREATE_KEY/);
});

/* --------------------------------------------------------------- scope */

test("this ceremony creates governance and transfers no authority", () => {
  const source = readFileSync(
    new URL("../create-escrow-custody-multisig.mjs", import.meta.url),
    "utf8",
  );
  // The custody gate is opened by a separate, reviewed step. Nothing here may
  // set an upgrade authority, deploy a program, or touch the escrow id.
  assert.doesNotMatch(source, /setUpgradeAuthority|BpfLoaderUpgradeable|upgradeAuthority\s*:/);
  assert.doesNotMatch(source, /ESCROW_PERMANENT_ID/);
});

/* ------------------------------------- requirements added in the RR-11 pass */

test("the permission mask is derived from the SDK, not written into the output", () => {
  const createKey = Keypair.generate();
  const { multisigPda, vaultPda } = deriveAddresses(createKey.publicKey);
  const summary = formatSummary({
    genesisHash: DEVNET_GENESIS,
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    createKeyPublic: createKey.publicKey.toBase58(),
  });
  assert.match(summary, /^MEMBER_PERMISSIONS=Initiate\+Vote\+Execute$/m);
  assert.match(summary, new RegExp(`^PERMISSION_MASK=${multisig.types.Permissions.all().mask}$`, "m"));
  // The reported mask is whatever the installed SDK computes. It happens to be
  // 7 today; the assertion is that the two agree, not that it is 7.
  assert.equal(custodyPermissions().mask, 7);
  assert.match(summary, /^SQUADS_PROGRAM_ID=SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf$/m);
});

test("a missing createKey path is rejected in every mode, not just execute", async () => {
  // An ephemeral createKey derives a multisig address that can never be
  // created once the session is gone, so preflight must refuse it too rather
  // than print a PDA the operator might take as authoritative.
  assert.throws(
    () => resolveCreateKey("preflight", { env: {} }),
    (error) => {
      assert.ok(error instanceof CeremonyError);
      assert.match(error.message, /PPV_CUSTODY_CREATE_KEY is not set/);
      return true;
    },
  );
  assert.throws(() => resolveCreateKey("execute", { env: {} }), /PPV_CUSTODY_CREATE_KEY is not set/);

  await assert.rejects(
    () =>
      main({
        argv: ["--preflight"],
        out: { write: () => {} },
        env: {},
        connectionFactory: () => stubConnection(),
      }),
    /PPV_CUSTODY_CREATE_KEY is not set/,
  );
});

test("--execute reruns the cluster and program validation", async () => {
  const path = join(scratchDir(), "createkey-keypair.json");
  const dir = scratchDir();
  const operatorPath = join(dir, "operator-keypair.json");
  writeFileSync(operatorPath, JSON.stringify(Array.from(Keypair.generate().secretKey)));
  const env = { PPV_CUSTODY_CREATE_KEY: path, PPV_OPERATOR_KEYPAIR: operatorPath };

  // Fix the createKey the way a real preflight would, so the failures below
  // are the cluster checks rather than a missing key.
  await main({
    argv: ["--preflight"],
    out: { write: () => {} },
    env,
    connectionFactory: () => stubConnection(),
  });

  // A wrong cluster stops --execute exactly as it stops --preflight. Passing
  // preflight earlier buys nothing: the checks are re-run against whatever
  // cluster --execute actually reaches.
  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env,
        connectionFactory: () => stubConnection({ genesisHash: MAINNET_GENESIS }),
      }),
    /STOP — WRONG CLUSTER/,
  );

  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env,
        connectionFactory: () => stubConnection({ squadsAccount: null }),
      }),
    /does not exist/,
  );

  await assert.rejects(
    () =>
      main({
        argv: ["--execute"],
        out: { write: () => {} },
        env,
        connectionFactory: () => stubConnection({ squadsAccount: { executable: false } }),
      }),
    /not executable/,
  );
});

test("no secret material reaches stdout or stderr on a full preflight run", async () => {
  const path = join(scratchDir(), "createkey-keypair.json");
  let captured = "";
  const sink = { write: (text) => (captured += text) };

  await main({
    argv: ["--preflight"],
    out: sink,
    env: { PPV_CUSTODY_CREATE_KEY: path },
    connectionFactory: () => stubConnection(),
  });

  // The createKey the run actually persisted, read back from disk — so this
  // checks the real secret, not a stand-in.
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  const createKey = Keypair.fromSecretKey(secretKey);

  for (const [label, encoding] of [
    ["json array", JSON.stringify(Array.from(secretKey))],
    ["bare array", Array.from(secretKey).join(",")],
    ["base64", Buffer.from(secretKey).toString("base64")],
    ["hex", Buffer.from(secretKey).toString("hex")],
    ["first 32 bytes hex", Buffer.from(secretKey.slice(0, 32)).toString("hex")],
  ]) {
    assert.ok(!captured.includes(encoding), `the createKey leaked to output as ${label}`);
  }
  // Any long run of numbers in the output would be a key whatever it was called.
  assert.doesNotMatch(captured, /(\d+,){60,}\d+/);
  assert.ok(captured.includes(createKey.publicKey.toBase58()), "the public key must be reported");
  assert.match(captured, /^CREATE_KEY_PUBLIC=/m);
  assert.match(captured, /^EXPECTED_CUSTODY_MULTISIG=/m);
  assert.match(captured, /^EXPECTED_CUSTODY_VAULT=/m);
});

test("the error raised when a createKey path is missing names no key material", () => {
  try {
    resolveCreateKey("execute", { env: {} });
    assert.fail("a missing createKey path was accepted");
  } catch (error) {
    assert.doesNotMatch(error.message, /(\d+,){10,}\d+/);
    assert.match(error.message, /path/);
  }
});
