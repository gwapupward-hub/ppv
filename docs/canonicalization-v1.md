# PPV Canonicalization v1

Status: **frozen**. Existing v1 behavior must never be edited. A semantic
change requires a new spec version and a new function.

## Accepted document model

- Top-level value: plain JSON object.
- Values: strings, booleans, arrays, and nested plain objects.
- Rejected: numbers, bigints, `null`, `undefined`, dates, maps, sets, typed
  arrays, class instances, functions, symbols, and cyclic structures.
- Monetary values: decimal strings containing integer minor units.
- Timestamps: decimal strings containing Unix seconds.
- Every document contains `specVersion: "1"`; the SDK injects it when absent
  and rejects a conflicting value.

## Byte rules

1. Normalize every string value and object key to Unicode NFC.
2. Reject object keys that collide after normalization.
3. Sort normalized object keys by UTF-16 code-unit order.
4. Preserve array order.
5. Serialize without insignificant whitespace.
6. Encode the result as UTF-8.
7. Compute SHA-256 over those canonical plaintext bytes.

Hashing ciphertext is forbidden because randomized encryption produces
different ciphertext for identical plaintext.

## Domain documents

An agreement document should include at least:

- document type;
- both wallet addresses;
- human-readable terms;
- creation and expiry timestamps as strings;
- a machine-readable settlement section or an explicit `"none"` value;
- the canonicalization spec version.

On-chain `content_hash` commits to the complete canonical agreement.
`terms_hash` separately commits to the canonical machine-readable terms. A
future escrow initializer must recompute and match the latter from every
fund-moving parameter before custody can be enabled.

