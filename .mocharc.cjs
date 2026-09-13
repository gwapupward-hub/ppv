"use strict";

/**
 * Mocha configuration for the local-validator suites.
 *
 * `anchor test` shells out to `npm run test:anchor`, which is one command with
 * two audiences. By default it runs the deterministic suites: the adversarial
 * escrow tests, the Core/Commerce integration suite under tests/integration/,
 * and the deterministic regression replays under tests/invariants/regression/. The property gate is budgeted separately and
 * is selected by scripts/verify-invariants.sh through PPV_ANCHOR_TEST_GLOB, so
 * a 2,000-operation property run never rides along with F1 unannounced.
 */

const override = (process.env.PPV_ANCHOR_TEST_GLOB ?? "").trim();

module.exports = {
  timeout: 1_000_000,
  spec: override
    ? override.split(",").map((entry) => entry.trim()).filter(Boolean)
    : ["tests/*.ts", "tests/integration/*.ts", "tests/invariants/regression/*.ts"],
};
