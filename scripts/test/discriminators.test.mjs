import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { REPO } from "./helpers.mjs";

/**
 * No two PPV programs may share an Anchor discriminator.
 *
 * Anchor derives a discriminator from a name alone — `sha256("event:<Name>")`
 * and `sha256("account:<Name>")`, truncated to eight bytes — with no program id
 * in the input. Two programs that pick the same name therefore emit
 * byte-identical prefixes over incompatible bodies, and a consumer keying on
 * the prefix does not merely misattribute the data, it mis-deserializes it.
 *
 * This is the guard, not a description of one program's choices: it reads every
 * program in the workspace and fails on any pair. It caught `AgreementCreated`
 * and `AgreementCancelled` (ppv_commerce and ppv_escrow) and `Agreement` as an
 * account name in the same two.
 *
 * Program-scoped decoding stays mandatory regardless — `decodeEventForProgram`
 * selects by the program id an inner instruction targeted. A collision-free
 * namespace is defence in depth: it means a bug in that selection produces
 * nothing rather than something plausible.
 */

function discriminator(namespace, name) {
  return createHash("sha256")
    .update(`${namespace}:${name}`)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

function rustSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rustSources(path));
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}

/**
 * Names declared under an Anchor attribute. Intervening attributes are allowed
 * (`#[event]` is routinely followed by `#[derive(...)]`), but nothing else is:
 * matching loosely here would silently stop finding declarations if the macro
 * shape ever changed, and a guard that finds nothing passes.
 */
function declaredNames(source, attribute) {
  const pattern = new RegExp(
    String.raw`#\[${attribute}\]\s*(?:#\[[^\]]*\]\s*)*pub struct (\w+)`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function workspacePrograms() {
  return readdirSync(join(REPO, "programs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** `{ [namespace]: { [name]: [program, ...] } }` across the whole workspace. */
function namesByNamespace() {
  const found = { event: new Map(), account: new Map() };
  for (const program of workspacePrograms()) {
    const source = rustSources(join(REPO, "programs", program, "src"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const namespace of ["event", "account"]) {
      for (const name of declaredNames(source, namespace)) {
        const owners = found[namespace].get(name) ?? [];
        owners.push(program);
        found[namespace].set(name, owners);
      }
    }
  }
  return found;
}

const NAMES = namesByNamespace();

test("the scan finds the declarations it claims to check", () => {
  // A guard that silently stops finding anything passes forever. These are
  // floors, not inventories: they only have to fail if the scan breaks.
  assert.ok(NAMES.event.size >= 20, `expected many events, found ${NAMES.event.size}`);
  assert.ok(NAMES.account.size >= 4, `expected several accounts, found ${NAMES.account.size}`);
  assert.ok(workspacePrograms().length >= 3);
  for (const expected of ["ProofCreated", "AgreementOpened", "SettlementExecuted"]) {
    assert.ok(NAMES.event.has(expected), `${expected} was not found by the scan`);
  }
  for (const expected of ["ProofRecord", "Milestone"]) {
    assert.ok(NAMES.account.has(expected), `${expected} was not found by the scan`);
  }
});

for (const namespace of ["event", "account"]) {
  test(`no ${namespace} name is declared by two programs`, () => {
    const collisions = [...NAMES[namespace]]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([name, owners]) => `${namespace} ${name} (${[...new Set(owners)].join(", ")})`);
    assert.deepEqual(
      collisions,
      [],
      `Anchor derives ${namespace} discriminators from the name alone, so these ` +
        `collide across programs. The program without a permanent identity is ` +
        `the one that renames.`,
    );
  });
}

test("distinct names really do produce distinct discriminators", () => {
  // The collision check above compares names, which is only equivalent to
  // comparing discriminators because the derivation is injective in practice.
  // This asserts that, so the cheaper check stays honest.
  const seen = new Map();
  for (const namespace of ["event", "account"]) {
    for (const name of NAMES[namespace].keys()) {
      const hex = discriminator(namespace, name);
      const previous = seen.get(hex);
      assert.equal(previous, undefined, `${namespace}:${name} and ${previous} share ${hex}`);
      seen.set(hex, `${namespace}:${name}`);
    }
  }
});

test("the names that used to collide are gone from ppv_escrow", () => {
  // Named explicitly so a revert reads as a deliberate act rather than a merge
  // accident. ppv_commerce holds a permanent identity and keeps both.
  for (const [name, namespace] of [
    ["AgreementCreated", "event"],
    ["AgreementCancelled", "event"],
  ]) {
    assert.deepEqual(
      NAMES[namespace].get(name),
      ["ppv_commerce"],
      `${name} must be emitted by ppv_commerce alone`,
    );
  }
});
