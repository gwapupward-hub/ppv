import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CanonicalizationError,
  canonicalizeV1,
  hashDocumentHexV1,
} from "../src/index.js";

describe("PPV canonicalization v1", () => {
  it("injects the version and sorts keys by normalized UTF-16 order", () => {
    assert.equal(
      canonicalizeV1({ z: true, 10: "ten", 2: "two", a: "first" }),
      '{"10":"ten","2":"two","a":"first","specVersion":"1","z":true}',
    );
  });

  it("normalizes keys and values to NFC without mutating the input", () => {
    const decomposed = "e\u0301";
    const document = { [decomposed]: decomposed };
    assert.equal(canonicalizeV1(document), '{"specVersion":"1","é":"é"}');
    assert.deepEqual(Object.keys(document), [decomposed]);
    assert.equal(document[decomposed], decomposed);
  });

  it("preserves array order and sorts nested records", () => {
    assert.equal(
      canonicalizeV1({ list: [{ b: "2", a: "1" }, false] }),
      '{"list":[{"a":"1","b":"2"},false],"specVersion":"1"}',
    );
  });

  it("produces the same hash for reordered semantically identical input", async () => {
    const first = { memo: "café", active: true };
    const second = { active: true, memo: "cafe\u0301", specVersion: "1" };
    assert.equal(await hashDocumentHexV1(first), await hashDocumentHexV1(second));
  });

  it("matches a frozen SHA-256 vector", async () => {
    assert.equal(
      await hashDocumentHexV1({ a: "é", z: true }),
      "ca543a6bde6173836cfc55b9762469cdf958b50f235dcc86b0aff8556a6f9dec",
    );
  });

  it("rejects a conflicting spec version", () => {
    assert.throws(
      () => canonicalizeV1({ specVersion: "2" }),
      (error: unknown) =>
        error instanceof CanonicalizationError && error.path === "$.specVersion",
    );
  });

  it("rejects normalized key collisions", () => {
    assert.throws(
      () => canonicalizeV1({ é: "first", "e\u0301": "second" }),
      /collide after NFC normalization/,
    );
  });

  it("rejects values outside the frozen document model", () => {
    const invalidValues: unknown[] = [
      null,
      undefined,
      1,
      1n,
      Symbol("value"),
      () => undefined,
      new Date(0),
      new Map(),
      new Set(),
      new Uint8Array([1]),
    ];

    for (const value of invalidValues) {
      assert.throws(() => canonicalizeV1({ value }));
    }
  });

  it("rejects class instances, cycles, sparse arrays, accessors, and symbols", () => {
    class Example {
      value = "x";
    }
    assert.throws(() => canonicalizeV1({ value: new Example() }));

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalizeV1(cyclic), /cyclic/);

    const sparse = new Array(2);
    sparse[1] = "x";
    assert.throws(() => canonicalizeV1({ sparse }), /dense/);

    const decoratedArray = ["x"];
    Object.defineProperty(decoratedArray, "hidden", { value: "y" });
    assert.throws(() => canonicalizeV1({ decoratedArray }), /dense/);

    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => "x",
    });
    assert.throws(() => canonicalizeV1(accessor), /accessor/);

    const symbolProperty = { value: "x", [Symbol("hidden")]: "y" };
    assert.throws(() => canonicalizeV1(symbolProperty), /symbol/);
  });

  it("allows repeated non-cyclic object references", () => {
    const shared = { value: "same" };
    assert.equal(
      canonicalizeV1({ left: shared, right: shared }),
      '{"left":{"value":"same"},"right":{"value":"same"},"specVersion":"1"}',
    );
  });
});
