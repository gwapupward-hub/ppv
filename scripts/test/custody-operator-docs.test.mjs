import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * The operator documentation, held to what the workflow actually requires.
 *
 * This drifted once and cost a dispatch to discover. PR #36 made the custody
 * workflow require a second protected-environment secret and removed the public
 * endpoint from the execute path; `deployments/validation/README.md` went on
 * saying the environment held "one secret" and showing
 * `https://api.devnet.solana.com` in its examples. An operator following it
 * would have configured half of what the run needs.
 *
 * So the requirement is derived from the workflow, not restated by hand: the
 * secrets the YAML references are extracted and the README must document each
 * one. Adding a third secret to the workflow and forgetting the README fails
 * here rather than on a run nobody wants to repeat.
 */

const WORKFLOW = readFileSync(
  join(REPO, ".github", "workflows", "devnet-escrow-custody-validation.yml"),
  "utf8",
);
const VALIDATION_README = readFileSync(join(REPO, "deployments", "validation", "README.md"), "utf8");

/** Every `secrets.NAME` the custody workflow reads. */
const REQUIRED_SECRETS = [
  ...new Set([...WORKFLOW.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((match) => match[1])),
].sort();

test("the workflow's secrets are the ones the audit expects", () => {
  // A cross-check on the extraction itself: if this list changes the tests
  // below still hold, but a reviewer is told the surface moved.
  assert.deepEqual(REQUIRED_SECRETS, ["PPV_CUSTODY_FUNDER_KEYPAIR", "PPV_CUSTODY_RPC_URL"]);
});

test("the README documents every secret the workflow requires", () => {
  for (const secret of REQUIRED_SECRETS) {
    assert.ok(
      VALIDATION_README.includes(secret),
      `${secret} is required by the workflow and undocumented in deployments/validation/README.md`,
    );
  }
});

test("the README does not claim the environment holds a single secret", () => {
  // The exact wording that was wrong. Counted rather than matched loosely, so
  // prose about "one secret per purpose" elsewhere does not false-positive.
  assert.ok(
    !/holding one\s+secret/i.test(VALIDATION_README),
    "the README still says the environment holds one secret; the workflow requires two",
  );
  assert.match(VALIDATION_README, /\*\*two\*\* secrets/);
});

test("the README names the protected environment the workflow uses", () => {
  const environment = WORKFLOW.match(/^\s+environment:\s*(\S+)\s*$/m)?.[1];
  assert.equal(environment, "devnet-custody-validation");
  assert.ok(VALIDATION_README.includes(environment));
});

/**
 * The public endpoint is the thing that must not come back.
 *
 * Runs 35405785493 and 35414331967 both died on it after their disposable setup
 * had been created and paid for. A README that still shows it teaches an
 * operator to reproduce those runs by hand.
 */
test("no operator document offers the shared public devnet endpoint", () => {
  assert.ok(
    !VALIDATION_README.includes("api.devnet.solana.com"),
    "deployments/validation/README.md offers the shared public endpoint the custody path removed",
  );
  assert.ok(!WORKFLOW.includes("api.devnet.solana.com"));
});

test("the README places an RPC placeholder rather than a real endpoint", () => {
  assert.match(VALIDATION_README, /PPV_CUSTODY_RPC_URL="<DEDICATED DEVNET RPC FROM SECURE ENV>"/);
  // A provider URL or key in a committed file is the failure this placeholder
  // exists to prevent, so the file is checked for one directly.
  const urls = VALIDATION_README.match(/https?:\/\/[^\s)"`]+/g) ?? [];
  for (const url of urls) {
    const parsed = new URL(url.replace(/[.,]$/, ""));
    assert.ok(
      !parsed.search && !parsed.username,
      `${url} carries credentials and must not be committed`,
    );
    assert.ok(
      ["github.com", "explorer.solana.com", "solana.com", "docs.rs", "anchor-lang.com"].some(
        (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
      ),
      `${url} is not a documentation link; an RPC endpoint must not be committed`,
    );
  }
});

test("the README states both operator rules the failed runs established", () => {
  // No public fallback, and genesis hash is what binds. Both were learned the
  // expensive way.
  assert.match(VALIDATION_README, /no public-RPC fallback|Fallback \| \*\*none\*\*|there is deliberately no public-RPC fallback/i);
  assert.match(VALIDATION_README, /genesis hash/i);
  assert.match(VALIDATION_README, /DEDICATED_DEVNET_RPC=MISSING/);
  // The funder rules the run-35393227976 failure established.
  assert.match(VALIDATION_README, /JSON byte array/i);
  assert.match(VALIDATION_README, /1 devnet SOL/);
});

/* ------------------------------------------------- the validation directory */

test("the validation directory holds no record while none has been produced", () => {
  const entries = readdirSync(join(REPO, "deployments", "validation")).sort();
  const records = entries.filter((entry) => entry.endsWith(".json"));
  if (records.length === 0) {
    assert.match(
      VALIDATION_README,
      /CANONICAL_LIVE_CUSTODY_EVIDENCE=NONE/,
      "no validation record exists and the README does not say so",
    );
    return;
  }
  // Once a real record lands, the README must stop claiming there is none.
  assert.ok(
    !VALIDATION_README.includes("CANONICAL_LIVE_CUSTODY_EVIDENCE=NONE"),
    `${records.join(", ")} exists but the README still says there is no evidence`,
  );
});

/* ------------------------------------------------------- the status language */

const STATUS_DOCS = [
  join("docs", "deployment-gates.md"),
  join("docs", "security", "ppv-escrow-residual-risk.md"),
  join("docs", "security", "ppv-escrow-surface.md"),
];

/**
 * The status rows have to be precise in both directions.
 *
 * "NOT RUN" understated it — controlled executions were dispatched and did send
 * disposable setup transactions to devnet. "PASS" would wildly overstate it.
 * The accurate claim is that no complete custody matrix has run, and that is
 * what these documents must say while that remains true.
 */
for (const relative of STATUS_DOCS) {
  const source = readFileSync(join(REPO, relative), "utf8");

  test(`${relative} states the custody status precisely`, () => {
    assert.match(
      source,
      /\| Live devnet custody validation \| ATTEMPTED — NOT COMPLETED/,
      "the custody row is not the precise current status",
    );
    assert.ok(
      !/\| Live devnet custody validation \| NOT RUN \|/.test(source),
      "the custody row understates it: executions were dispatched and sent setup transactions",
    );
  });

  test(`${relative} claims no custody pass`, () => {
    assert.ok(!/\| Live devnet custody validation \| PASS/.test(source));
    assert.ok(!/custody gate \| \*\*OPEN\*\*/i.test(source));
    assert.match(source, /\| Mainnet authorized \| NO \|/);
  });

  test(`${relative} no longer claims the maintaining environment has no RPC route`, () => {
    // It now has a dedicated one. Repeating the old reason would send a reader
    // looking for a blocker that has been removed.
    assert.ok(
      !/no route to any Solana RPC host/i.test(source),
      "a dedicated devnet RPC endpoint is configured; this reason is stale",
    );
  });
}

test("the gates document keeps RR-13, legal review and the custody gate unchanged", () => {
  const gates = readFileSync(join(REPO, "docs", "deployment-gates.md"), "utf8");
  assert.match(gates, /\| Independent security review \(RR-13\) \| OPEN \|/);
  assert.match(gates, /\| Legal review \| OPEN \|/);
  assert.match(gates, /\| \*\*Custody gate\*\* \| \*\*CLOSED\*\* \|/);
});
