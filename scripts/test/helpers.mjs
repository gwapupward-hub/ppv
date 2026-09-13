import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { UPGRADEABLE_LOADER_ID } from "../lib/identity.mjs";
import { decodeBase58 } from "../lib/pubkey.mjs";
import { DEVNET_GENESIS } from "../lib/rpc.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const READINESS = join(REPO, "scripts", "verify-devnet-readiness.sh");

export const CORE_ID = "9cWE41ZDNQChvFrRoVuPQDeoVLg46ACTiZRCZaBZzfwU";
export const COMMERCE_ID = "GmRDoFuPrBrsxnvTX751WK5rLu14JXe4sgjh6vNwHzr3";

/**
 * A real off-curve address, derived under the Squads V4 program id — the shape
 * a vault PDA actually has. Fixture only; it is not the deployment vault.
 */
export const VAULT_PDA = "3cFRkTFrpmNXetfLJka5q1owRffk1tjWVo8SDLPyWB7w";
/** The real ProgramData address of the deployed devnet PPV Core. */
export const CORE_PROGRAM_DATA = "FfEQrpiQSzxUErCBkXCukbt26JivKiExA6HswMpQkiSA";
/** Real on-curve public keys — the shape an ordinary signer wallet has. */
export const MEMBERS = [
  "55y7B46ZUAyeYaMFUPxHAg9UUcwrfZ2eZDFDabxinhjp",
  "DyqdftdT3vo2SMvHaKVU2Pmb1zBfJ8wCpYYJQ7idnoAR",
  "E9sQrkYk4evsQLgY1jFCaRHgGCDjWKjaNLUKtS7kVueH",
];

const FIXTURE_FILES = [
  "Anchor.toml",
  "Cargo.lock",
  ".gitignore",
  "programs/ppv_core/src/lib.rs",
  "programs/ppv_commerce/src/lib.rs",
];

/**
 * A real git repository containing the files the verifier inspects. Real git
 * rather than a stub directory, because "is the tree clean" and "is the
 * lockfile unchanged" are git questions and a fake would not answer them.
 *
 * `mutate` runs after the clean commit, so whatever it changes is uncommitted
 * unless it commits itself.
 */
export function makeFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), "ppv-readiness-"));
  for (const file of FIXTURE_FILES) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    copyFileSync(join(REPO, file), join(root, file));
  }
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "fixture");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");

  const helpers = {
    root,
    git,
    write: (file, contents) => {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), contents);
    },
    read: (file) => readFileSync(join(root, file), "utf8"),
    edit: (file, from, to) => {
      const current = readFileSync(join(root, file), "utf8");
      if (!current.includes(from)) throw new Error(`fixture: '${from}' not found in ${file}`);
      writeFileSync(join(root, file), current.replace(from, to));
    },
    commitAll: () => {
      git("add", "-A");
      git("commit", "-q", "-m", "mutation");
    },
  };
  mutate?.(helpers);
  return helpers;
}

/**
 * Stub CLIs on PATH so the network- and toolchain-dependent checks can be
 * exercised without a validator or a release machine. Each stub answers only
 * the questions the verifier asks, and fails loudly on anything else.
 */
export function makeStubs({
  anchorVersion = "anchor-cli 0.30.1",
  solanaVersion = "solana-cli 1.18.17 (src:00000000; feat:0)",
  genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  existingPrograms = {},
  toolchains = ["1.85.1-x86_64-unknown-linux-gnu (default)", "nightly-2024-06-15-x86_64-unknown-linux-gnu"],
  keypairs = {},
} = {}) {
  const bin = mkdtempSync(join(tmpdir(), "ppv-stub-bin-"));
  const script = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
  };

  script(
    "anchor",
    `[[ "\${1:-}" == "--version" ]] && { echo "${anchorVersion}"; exit 0; }\necho "stub anchor: unexpected args: $*" >&2; exit 90`,
  );

  const showCases = Object.entries(existingPrograms)
    .map(
      ([id, authority]) =>
        `    ${id}) echo '{"programId":"${id}","authority":"${authority}","programdataAddress":"${id}Data","lastDeploySlot":1}'; exit 0 ;;`,
    )
    .join("\n");

  script(
    "solana",
    `case "\${1:-}" in
  --version) echo "${solanaVersion}"; exit 0 ;;
  genesis-hash) echo "${genesis}"; exit 0 ;;
  program)
    if [[ "\${2:-}" == "show" ]]; then
      case "\${3:-}" in
${showCases || "    __none__) ;;"}
        *) echo "Unable to find the account" >&2; exit 1 ;;
      esac
    fi
    ;;
esac
echo "stub solana: unexpected args: $*" >&2; exit 91`,
  );

  const keypairCases = Object.entries(keypairs)
    .map(([path, pubkey]) => `    ${path}) echo "${pubkey}"; exit 0 ;;`)
    .join("\n");
  script(
    "solana-keygen",
    `if [[ "\${1:-}" == "pubkey" ]]; then
  case "\${2:-}" in
${keypairCases || "    __none__) ;;"}
    *) echo "stub solana-keygen: no stub for \${2:-}" >&2; exit 92 ;;
  esac
fi
echo "stub solana-keygen: unexpected args: $*" >&2; exit 92`,
  );

  script(
    "rustup",
    `if [[ "\${1:-}" == "toolchain" && "\${2:-}" == "list" ]]; then
${toolchains.map((t) => `  echo "${t}"`).join("\n") || "  true"}
  exit 0
fi
echo "stub rustup: unexpected args: $*" >&2; exit 93`,
  );

  return bin;
}

export function runReadiness({ repoRoot, args = [], env = {}, stubBin, rpcUrl } = {}) {
  const path = stubBin ? `${stubBin}:${process.env.PATH}` : process.env.PATH;
  const result = spawnSync("bash", [READINESS, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: path,
      PPV_REPO_ROOT: repoRoot,
      // Cleared so a developer's own shell cannot make a negative test pass.
      PPV_SQUADS_VAULT_PDA: "",
      PPV_SQUADS_MEMBER_PUBKEYS: "",
      PPV_SQUADS_THRESHOLD: "",
      PPV_DEVNET_GENESIS_HASH: "",
      PPV_CORE_PROGRAM_KEYPAIR_PATH: "",
      PPV_COMMERCE_PROGRAM_KEYPAIR_PATH: "",
      // Pointed at a stub endpoint by every chain-dependent test, so a test
      // that reaches the real devnet is a bug rather than a flake.
      PPV_READINESS_RPC_URL: rpcUrl ?? "http://127.0.0.1:1/unreachable-by-design",
      ...env,
    },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A deployment-grade run whose non-target checks are all satisfied. */
export function goodDeploymentEnv(overrides = {}) {
  return {
    PPV_SQUADS_VAULT_PDA: VAULT_PDA,
    PPV_SQUADS_MEMBER_PUBKEYS: MEMBERS.join(","),
    PPV_SQUADS_THRESHOLD: "2",
    PPV_DEVNET_GENESIS_HASH: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    ...overrides,
  };
}

/**
 * A deterministic Solana JSON-RPC transport.
 *
 * The verifier's network boundary is one injected `fetch`, so every chain case
 * these tests care about — a missing program, the wrong loader, an authority
 * that is not the vault, a binary that is not the release, the wrong cluster —
 * is expressed as fixture data rather than as a devnet that has to be online
 * and in the right state. No test here opens a socket to the internet, and a
 * test that cannot reach devnet is therefore a real failure rather than noise.
 *
 * `accounts` maps address to `{ owner, executable, data }` where `data` is a
 * Buffer. Anything not in the map is reported as a non-existent account, which
 * is what the chain does.
 */
export function makeRpcTransport({ genesis = DEVNET_GENESIS, accounts = {}, signatures = {}, programAccounts = {} } = {}) {
  const calls = [];
  const transport = async (_endpoint, init) => {
    const request = JSON.parse(init.body);
    calls.push(request.method);
    const respond = (result) => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: request.id, result }),
    });

    switch (request.method) {
      case "getGenesisHash":
        return respond(genesis);
      case "getAccountInfo": {
        const account = accounts[request.params[0]];
        if (!account) return respond({ context: { slot: 1 }, value: null });
        return respond({
          context: { slot: 1 },
          value: {
            lamports: account.lamports ?? 1,
            owner: account.owner,
            executable: account.executable ?? false,
            rentEpoch: 0,
            data: [Buffer.from(account.data).toString("base64"), "base64"],
          },
        });
      }
      case "getProgramAccounts":
        return respond(
          (programAccounts[request.params[0]] ?? []).map(({ pubkey, account }) => ({
            pubkey,
            account: {
              lamports: account.lamports ?? 1,
              owner: account.owner ?? request.params[0],
              executable: false,
              rentEpoch: 0,
              data: [Buffer.from(account.data).toString("base64"), "base64"],
            },
          })),
        );
      case "getSignatureStatuses":
        return respond({
          context: { slot: 1 },
          value: request.params[0].map((signature) => signatures[signature] ?? null),
        });
      default:
        return {
          ok: true,
          status: 200,
          json: async () => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: `stub rpc: unexpected method ${request.method}` },
          }),
        };
    }
  };
  transport.calls = calls;
  return transport;
}

/** The Program account the upgradeable loader writes: tag 2, then ProgramData. */
export function programAccount(programDataAddress, { owner = UPGRADEABLE_LOADER_ID, executable = true } = {}) {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  Buffer.from(decodeBase58(programDataAddress)).copy(data, 4);
  return { owner, executable, data };
}

/**
 * The ProgramData account: tag 3, the last-deploy slot, an Option<Pubkey>
 * authority, then the ELF followed by the loader's zero padding.
 */
export function programDataAccount({ authority, slot = 497437304, binary = Buffer.alloc(0), padding = 0 }) {
  const header = Buffer.alloc(45);
  header.writeUInt32LE(3, 0);
  header.writeBigUInt64LE(BigInt(slot), 4);
  if (authority) {
    header[12] = 1;
    Buffer.from(decodeBase58(authority)).copy(header, 13);
  }
  return {
    owner: UPGRADEABLE_LOADER_ID,
    executable: false,
    data: Buffer.concat([header, Buffer.from(binary), Buffer.alloc(padding)]),
  };
}

/** A live devnet PPV Core, as the fixtures want it: correct in every respect. */
export function deployedCoreFixture({
  programId = CORE_ID,
  programDataAddress = CORE_PROGRAM_DATA,
  authority = VAULT_PDA,
  binary = Buffer.from("ppv_core release artifact"),
  padding = 16,
  slot = 497437304,
} = {}) {
  return {
    binary,
    accounts: {
      [programId]: programAccount(programDataAddress),
      [programDataAddress]: programDataAccount({ authority, slot, binary, padding }),
    },
  };
}

/**
 * The same stub, in a child process, for tests that run a shell script.
 *
 * `spawnSync` blocks this process's event loop, so an in-process server would
 * never get to answer the script it is meant to be serving.
 */
export async function startRpcServerProcess(config) {
  const fixture = join(mkdtempSync(join(tmpdir(), "ppv-rpc-fixture-")), "fixture.json");
  const encode = (account) => ({ ...account, data: Buffer.from(account.data).toString("base64") });
  writeFileSync(
    fixture,
    JSON.stringify({
      ...config,
      accounts: Object.fromEntries(
        Object.entries(config.accounts ?? {}).map(([address, account]) => [address, encode(account)]),
      ),
      programAccounts: Object.fromEntries(
        Object.entries(config.programAccounts ?? {}).map(([program, entries]) => [
          program,
          entries.map((entry) => ({ ...entry, account: encode(entry.account) })),
        ]),
      ),
    }),
  );

  const child = spawn("node", [join(REPO, "scripts", "test", "rpc-server.mjs"), fixture], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline !== -1) resolve(out.slice(0, newline).trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`stub rpc server exited with ${code}`)));
  });
  return { url, close: () => child.kill("SIGKILL") };
}

/** A serving JSON-RPC endpoint on loopback, for in-process async callers. */
export async function startRpcServer(config) {
  const transport = makeRpcTransport(config);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      const stub = await transport("stub", { body: Buffer.concat(chunks).toString("utf8") });
      const body = JSON.stringify(await stub.json());
      response.writeHead(stub.status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
