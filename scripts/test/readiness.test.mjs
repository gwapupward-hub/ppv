import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  COMMERCE_ID,
  CORE_ID,
  CORE_PROGRAM_DATA,
  REPO,
  MEMBERS,
  VAULT_PDA,
  deployedCoreFixture,
  goodDeploymentEnv,
  makeFixture,
  makeStubs,
  runReadiness,
  startRpcServerProcess,
} from "./helpers.mjs";

/**
 * Negative tests for the deployment preflight.
 *
 * A deployment safety check is only worth having if violating the condition it
 * guards makes a test fail. Every case here breaks exactly one thing and
 * asserts the verifier refuses — and asserts *which* refusal, so a check cannot
 * pass by failing for an unrelated reason.
 */

const WRONG_ID = "11111111111111111111111111111112";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

/**
 * Runs the preflight against a deterministic cluster.
 *
 * The chain half of this preflight used to go through the Solana CLI, so these
 * tests stubbed a CLI on PATH. It now reads JSON-RPC — the same change that
 * stops it failing on a machine with no wallet — so the stub is an endpoint.
 * Nothing here reaches a real cluster: `runReadiness` points every other run at
 * an address that cannot connect, so a test that quietly depends on devnet
 * fails rather than passing when the network happens to be up.
 */
async function runAgainstChain({ chain = {}, ...options }) {
  const server = await startRpcServerProcess({ genesis: DEVNET_GENESIS, ...chain });
  try {
    return runReadiness({ ...options, rpcUrl: server.url });
  } finally {
    server.close();
  }
}

function expectFailure(result, pattern) {
  assert.notEqual(result.code, 0, `expected a non-zero exit\n${result.output}`);
  assert.match(result.output, pattern);
  assert.match(result.output, /NOT READY/);
}

test("a clean checkout passes the repository and identity checks", () => {
  const fixture = makeFixture();
  const result = runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /NOT deployment-grade/);
});

test("a wrong declare_id! is refused, for either program", () => {
  for (const [program, id] of [
    ["ppv_core", CORE_ID],
    ["ppv_commerce", COMMERCE_ID],
  ]) {
    const fixture = makeFixture((f) => {
      f.edit(`programs/${program}/src/lib.rs`, `declare_id!("${id}")`, `declare_id!("${WRONG_ID}")`);
      f.commitAll();
    });
    expectFailure(
      runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
      new RegExp(`${program}: declare_id! is ${WRONG_ID}`),
    );
  }
});

test("a wrong Anchor.toml id is refused", () => {
  const fixture = makeFixture((f) => {
    f.write("Anchor.toml", f.read("Anchor.toml").replaceAll(CORE_ID, WRONG_ID));
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /ppv_core: Anchor.toml id is 11111111111111111111111111111112/,
  );
});

test("localnet and devnet naming different ids is refused", () => {
  // The failure this prevents: a binary built against one id and deployed at
  // another, which fails every instruction with DeclaredProgramIdMismatch and
  // reads like a protocol bug.
  const fixture = makeFixture((f) => {
    const toml = f.read("Anchor.toml");
    const devnetSection = toml.slice(toml.indexOf("[programs.devnet]"));
    f.write(
      "Anchor.toml",
      toml.replace(devnetSection, devnetSection.replace(CORE_ID, WRONG_ID)),
    );
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /ppv_core: Anchor.toml cluster ids disagree/,
  );
});

test("an id named for only one cluster is refused", () => {
  const fixture = makeFixture((f) => {
    const toml = f.read("Anchor.toml");
    f.write("Anchor.toml", toml.replace(`\nppv_core = "${CORE_ID}"`, ""));
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /ppv_core: Anchor.toml must name the id under both localnet and devnet/,
  );
});

test("a built IDL naming a different id is refused at deployment grade", () => {
  const fixture = makeFixture((f) => {
    f.write("target/idl/ppv_core.json", JSON.stringify({ address: WRONG_ID }));
  });
  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv(),
    }),
    /ppv_core: built IDL address is 11111111111111111111111111111112/,
  );
});

test("--repo-only deliberately ignores the generated IDL", () => {
  // Not an oversight to be tidied up later. The F1 harness builds with
  // ephemeral keypairs on purpose, so an IDL left in the ignored target/ after
  // an F1 run carries a throwaway address by design. Checking it here would
  // make F1's own cleanup assertion fail on a file behaving correctly. The
  // permanent identities live in declare_id! and Anchor.toml, which are checked
  // in both modes.
  const fixture = makeFixture((f) => {
    f.write("target/idl/ppv_core.json", JSON.stringify({ address: WRONG_ID }));
  });
  const result = runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] });
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /IDL/);
});

test("a tracked keypair file is refused", () => {
  const fixture = makeFixture((f) => {
    // Force it past .gitignore, exactly as `git add -f` would.
    f.write("deployer-keypair.json", "[1,2,3]");
    f.git("add", "-f", "deployer-keypair.json");
    f.git("commit", "-q", "-m", "oops");
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /signing material is tracked in git/,
  );
});

test("a committed keypair byte array is refused even under an innocent name", () => {
  const fixture = makeFixture((f) => {
    const bytes = Array.from({ length: 64 }, (_, i) => i % 256).join(",");
    f.write("config/notes.txt", `key = [${bytes}]\n`);
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /possible keypair byte array in config\/notes\.txt/,
  );
});

test("a .gitignore that stops ignoring keypairs is refused", () => {
  const fixture = makeFixture((f) => {
    f.write(".gitignore", f.read(".gitignore").replace("*-keypair.json\n", ""));
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /\.gitignore does not ignore \*-keypair\.json/,
  );
});

test("a modified Cargo.lock is refused", () => {
  const fixture = makeFixture((f) => {
    f.write("Cargo.lock", `${f.read("Cargo.lock")}\n# hand-edited\n`);
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /Cargo\.lock differs from HEAD/,
  );
});

test("a dirty tree is refused for a deployment-grade run", () => {
  const fixture = makeFixture((f) => f.write("README.md", "uncommitted\n"));
  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv(),
    }),
    /working tree is dirty/,
  );
});

test("a fully configured deployment-grade run passes", async () => {
  const fixture = makeFixture();
  const result = await runAgainstChain({
    repoRoot: fixture.root,
    stubBin: makeStubs(),
    env: goodDeploymentEnv(),
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /READY — every deployment-readiness check passed/);
  assert.match(result.output, /is unoccupied and ready for initial deployment/);
});

test("a wrong toolchain version is refused", () => {
  const fixture = makeFixture();
  for (const [stub, pattern] of [
    [{ anchorVersion: "anchor-cli 0.31.0" }, /Anchor CLI: found 'anchor-cli 0\.31\.0'/],
    [{ solanaVersion: "solana-cli 1.18.26" }, /Solana CLI: found 'solana-cli 1\.18\.26'/],
    [{ toolchains: ["1.85.1-x86_64-unknown-linux-gnu (default)"] }, /nightly-2024-06-15 is not installed/],
    [{ toolchains: ["nightly-2024-06-15-x86_64-unknown-linux-gnu"] }, /1\.85\.1 is not installed/],
  ]) {
    expectFailure(
      runReadiness({
        repoRoot: fixture.root,
        stubBin: makeStubs(stub),
        env: goodDeploymentEnv(),
      }),
      pattern,
    );
  }
});

test("a missing toolchain is refused rather than skipped", () => {
  // Fail-closed: a check that cannot be performed is a failure. A preflight
  // that passes when it could not look produces confidence, not information.
  // The PATH here still has git and node, so the run gets far enough to reach
  // the toolchain section — it simply cannot find anchor, solana or rustup.
  const fixture = makeFixture();
  const minimalPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const result = runReadiness({
    repoRoot: fixture.root,
    env: { ...goodDeploymentEnv(), PATH: minimalPath },
  });
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /Anchor CLI: anchor is not installed/);
  assert.match(result.output, /Solana CLI: solana is not installed/);
  assert.match(result.output, /NOT READY/);
});

test("a signer wallet as the upgrade authority is refused", () => {
  // The whole point of the Squads requirement: an on-curve address has a
  // private key, so one compromised key could upgrade the program alone.
  const fixture = makeFixture();
  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv({ PPV_SQUADS_VAULT_PDA: MEMBERS[0] }),
    }),
    /on the ed25519 curve — that is a signer wallet, not a multisig vault/,
  );
});

test("a missing Squads vault is refused", () => {
  const fixture = makeFixture();
  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv({ PPV_SQUADS_VAULT_PDA: "" }),
    }),
    /PPV_SQUADS_VAULT_PDA is not set/,
  );
});

test("a threshold below policy is refused", () => {
  const fixture = makeFixture();
  for (const [threshold, pattern] of [
    ["1", /PPV_SQUADS_THRESHOLD is 1; policy requires at least 2/],
    ["0", /policy requires at least 2/],
    ["", /PPV_SQUADS_THRESHOLD is not set/],
    ["two", /PPV_SQUADS_THRESHOLD is not an integer/],
  ]) {
    expectFailure(
      runReadiness({
        repoRoot: fixture.root,
        stubBin: makeStubs(),
        env: goodDeploymentEnv({ PPV_SQUADS_THRESHOLD: threshold }),
      }),
      pattern,
    );
  }
});

test("a member set that cannot meet its own threshold is refused", () => {
  const fixture = makeFixture();
  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv({
        PPV_SQUADS_MEMBER_PUBKEYS: MEMBERS[0],
        PPV_SQUADS_THRESHOLD: "2",
      }),
    }),
    /1 members but a threshold of 2, which can never be met/,
  );
});

test("duplicate members, an invalid member, or the vault as a member are refused", () => {
  const fixture = makeFixture();
  for (const [members, pattern] of [
    [`${MEMBERS[0]},${MEMBERS[0]},${MEMBERS[1]}`, /member list contains duplicates/],
    [`${MEMBERS[0]},not-an-address,${MEMBERS[1]}`, /is not a valid address/],
    [`${MEMBERS[0]},${VAULT_PDA},${MEMBERS[1]}`, /member list contains the vault PDA itself/],
    ["", /PPV_SQUADS_MEMBER_PUBKEYS is not set/],
  ]) {
    expectFailure(
      runReadiness({
        repoRoot: fixture.root,
        stubBin: makeStubs(),
        env: goodDeploymentEnv({ PPV_SQUADS_MEMBER_PUBKEYS: members }),
      }),
      pattern,
    );
  }
});

test("the wrong cluster is refused", async () => {
  const fixture = makeFixture();
  expectFailure(
    await runAgainstChain({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      // Mainnet-beta's genesis, served where devnet was expected.
      chain: { genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" },
      env: goodDeploymentEnv(),
    }),
    /is not the configured devnet genesis/,
  );

  expectFailure(
    await runAgainstChain({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv({ PPV_DEVNET_GENESIS_HASH: "" }),
    }),
    /PPV_DEVNET_GENESIS_HASH is not set/,
  );
});

test("an unreachable cluster fails rather than being reported as clear", async () => {
  // Fail-closed: "I could not look" must never read as "nothing is there".
  const fixture = makeFixture();
  expectFailure(
    runReadiness({ repoRoot: fixture.root, stubBin: makeStubs(), env: goodDeploymentEnv() }),
    /could not read a genesis hash/,
  );
});

test("an address that already holds a program is refused, and reported not overwritten", async () => {
  const fixture = makeFixture();
  const result = await runAgainstChain({
    repoRoot: fixture.root,
    stubBin: makeStubs(),
    chain: { accounts: deployedCoreFixture({ authority: VAULT_PDA }).accounts },
    env: goodDeploymentEnv(),
  });
  expectFailure(result, /ppv_core already exists at .* — initial deployment must not overwrite it/);
  assert.match(result.output, new RegExp(`authority ${VAULT_PDA}`), "the existing state is reported");
  assert.match(result.output, /ppv_commerce address .* is unoccupied/);
});

test("a supplied permanent keypair must derive the committed id", async () => {
  const fixture = makeFixture();
  // A placeholder file, never read for its contents: the verifier only ever
  // asks solana-keygen for the derived public key.
  const keyDir = mkdtempSync(join(tmpdir(), "ppv-keys-"));
  const rightPath = join(keyDir, "core.json");
  const wrongPath = join(keyDir, "wrong.json");
  writeFileSync(rightPath, "placeholder");
  writeFileSync(wrongPath, "placeholder");

  const good = await runAgainstChain({
    repoRoot: fixture.root,
    stubBin: makeStubs({ keypairs: { [rightPath]: CORE_ID } }),
    env: goodDeploymentEnv({ PPV_CORE_PROGRAM_KEYPAIR_PATH: rightPath }),
  });
  assert.equal(good.code, 0, good.output);
  assert.match(good.output, /ppv_core: supplied keypair derives the permanent id/);
  assert.doesNotMatch(good.output, /\[[0-9]+,/, "no keypair contents are ever printed");

  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs({ keypairs: { [wrongPath]: WRONG_ID } }),
      env: goodDeploymentEnv({ PPV_CORE_PROGRAM_KEYPAIR_PATH: wrongPath }),
    }),
    /ppv_core: supplied keypair is 11111111111111111111111111111112/,
  );

  expectFailure(
    runReadiness({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      env: goodDeploymentEnv({ PPV_COMMERCE_PROGRAM_KEYPAIR_PATH: "/keys/absent.json" }),
    }),
    /ppv_commerce: keypair path \/keys\/absent\.json does not exist/,
  );
});

test("the secret scanner catches a real private key header", () => {
  // The detector's source representation is split so it cannot match itself.
  // This proves the split did not disable it: the pattern it applies is
  // unchanged, and a real header is still caught.
  const header = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
  const fixture = makeFixture((f) => {
    f.write("ops/backup.txt", `${header}\nMIIEow…\n`);
    f.commitAll();
  });
  expectFailure(
    runReadiness({ repoRoot: fixture.root, args: ["--repo-only"] }),
    /possible private key material in ops\/backup\.txt/,
  );
});

test("the scanner does not flag itself, or anything else in this repository", () => {
  // The regression test for the bug this suite missed: every fixture tree is a
  // handful of copied files, so the scanner never saw its own source until the
  // script was committed and became a tracked file. Running against the real
  // repository is what catches a detector that reports itself — and a scanner
  // that flags itself teaches everyone who runs it to ignore its one result.
  const result = runReadiness({ repoRoot: REPO, args: ["--repo-only"] });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /no committed private key material found/);
});

test("a released program does not block the release of another one", async () => {
  // The state after PPV Core shipped: Core's address is supposed to be
  // occupied. Treating that as a failure would hold the preflight red forever
  // and block Commerce's first deployment on a fact that is not a problem.
  const fixture = makeFixture((f) => {
    f.write(
      "deployments/evidence/ppv-core-devnet.json",
      JSON.stringify({ cluster: "devnet", program: "ppv_core", programId: CORE_ID }),
    );
    f.commitAll();
  });
  const result = await runAgainstChain({
    repoRoot: fixture.root,
    stubBin: makeStubs(),
    chain: { accounts: deployedCoreFixture({ authority: VAULT_PDA }).accounts },
    env: goodDeploymentEnv(),
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ppv_core is already released at .* — verify, never redeploy/);
  assert.match(result.output, /ppv_commerce address .* is unoccupied and ready for initial deployment/);
});

test("a release record with no program behind it is a failure, not a pass", async () => {
  const fixture = makeFixture((f) => {
    f.write(
      "deployments/evidence/ppv-core-devnet.json",
      JSON.stringify({ cluster: "devnet", program: "ppv_core", programId: CORE_ID }),
    );
    f.commitAll();
  });
  expectFailure(
    await runAgainstChain({
      repoRoot: fixture.root,
      stubBin: makeStubs(),
      chain: { accounts: {} },
      env: goodDeploymentEnv(),
    }),
    /ppv_core has a release record .* but no program at/,
  );
});
