export const PPV_CANONICALIZATION_VERSION = "1" as const;

export type CanonicalScalar = string | boolean;
export type CanonicalValue =
  | CanonicalScalar
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };
export type CanonicalDocument = Readonly<Record<string, CanonicalValue>>;

/**
 * Raised when a value cannot be represented by the frozen PPV v1 document
 * model. The path is diagnostic only and never becomes part of canonical data.
 */
export class CanonicalizationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

type PlainRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function quote(value: string): string {
  // JSON.stringify always returns a string for a string input.
  return JSON.stringify(value.normalize("NFC"));
}

function childPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new CanonicalizationError(path, "accessor properties are not supported");
  }
  if (!descriptor.enumerable) {
    throw new CanonicalizationError(path, "non-enumerable properties are not supported");
  }
}

function serializeArray(
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>,
): string {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new CanonicalizationError(path, "symbol properties are not supported");
  }

  const ownNames = Object.getOwnPropertyNames(value);
  const enumerableKeys = Object.keys(value);
  if (
    ownNames.length !== value.length + 1 ||
    !ownNames.includes("length") ||
    enumerableKeys.length !== value.length
  ) {
    throw new CanonicalizationError(
      path,
      "arrays must be dense and contain no named properties",
    );
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    if (enumerableKeys[index] !== key) {
      throw new CanonicalizationError(
        path,
        "arrays must be dense and contain no named properties",
      );
    }
    const itemPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assertDataProperty(descriptor, itemPath);
    items.push(serializeValue(descriptor.value, itemPath, ancestors));
  }

  return `[${items.join(",")}]`;
}

function recordEntries(
  value: PlainRecord,
  path: string,
): Array<readonly [normalizedKey: string, rawValue: unknown]> {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new CanonicalizationError(path, "symbol properties are not supported");
  }

  const normalized = new Map<string, readonly [string, unknown]>();
  for (const rawKey of Object.getOwnPropertyNames(value)) {
    const propertyPath = childPath(path, rawKey);
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    assertDataProperty(descriptor, propertyPath);

    const normalizedKey = rawKey.normalize("NFC");
    const prior = normalized.get(normalizedKey);
    if (prior !== undefined) {
      throw new CanonicalizationError(
        path,
        `keys ${JSON.stringify(prior[0])} and ${JSON.stringify(rawKey)} collide after NFC normalization`,
      );
    }
    normalized.set(normalizedKey, [rawKey, descriptor.value]);
  }

  return [...normalized.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([normalizedKey, entry]) => [normalizedKey, entry[1]] as const);
}

function serializeRecord(
  value: PlainRecord,
  path: string,
  ancestors: Set<object>,
  injectVersion: boolean,
): string {
  const entries = recordEntries(value, path);
  const versionIndex = entries.findIndex(([key]) => key === "specVersion");

  if (injectVersion) {
    if (versionIndex === -1) {
      entries.push(["specVersion", PPV_CANONICALIZATION_VERSION]);
      entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    } else if (entries[versionIndex]?.[1] !== PPV_CANONICALIZATION_VERSION) {
      throw new CanonicalizationError(
        `${path}.specVersion`,
        `expected ${JSON.stringify(PPV_CANONICALIZATION_VERSION)}`,
      );
    }
  }

  const properties = entries.map(([key, entryValue]) => {
    const valuePath = childPath(path, key);
    return `${quote(key)}:${serializeValue(entryValue, valuePath, ancestors)}`;
  });
  return `{${properties.join(",")}}`;
}

function serializeValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (typeof value === "string") {
    return quote(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value !== "object" || value === null) {
    const kind = value === null ? "null" : typeof value;
    throw new CanonicalizationError(path, `${kind} values are not supported`);
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new CanonicalizationError(path, "only arrays and plain objects are supported");
  }
  if (ancestors.has(value)) {
    throw new CanonicalizationError(path, "cyclic values are not supported");
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, path, ancestors)
      : serializeRecord(value, path, ancestors, false);
  } finally {
    ancestors.delete(value);
  }
}

/** Canonicalize a PPV document without mutating the input. */
export function canonicalizeV1(document: unknown): string {
  if (!isPlainRecord(document)) {
    throw new CanonicalizationError("$", "the top-level value must be a plain object");
  }

  const ancestors = new Set<object>([document]);
  return serializeRecord(document, "$", ancestors, true);
}

/** Return the exact UTF-8 bytes committed to by PPV v1. */
export function canonicalizeBytesV1(document: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalizeV1(document));
}

/** Browser-safe SHA-256. This module intentionally has no Node Buffer dependency. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

export async function hashDocumentV1(document: unknown): Promise<Uint8Array> {
  return sha256(canonicalizeBytesV1(document));
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}

export async function hashDocumentHexV1(document: unknown): Promise<string> {
  return bytesToHex(await hashDocumentV1(document));
}
