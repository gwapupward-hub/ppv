/**
 * PPV canonicalization — spec version 1. FROZEN.
 *
 * Rules:
 * - Object keys sorted by UTF-16 code unit.
 * - No insignificant whitespace.
 * - Strings normalized to NFC.
 * - Numbers and bigint are rejected. Money/timestamps use decimal strings.
 * - null/undefined are rejected; omit the key instead.
 * - Every document carries specVersion.
 *
 * Changing these rules requires a new spec version. Previously signed content
 * must remain byte-for-byte verifiable forever.
 */

export const PPV_SPEC_VERSION = 1;

export type CanonicalValue =
  | string
  | boolean
  | CanonicalValue[]
  | { [k: string]: CanonicalValue };

export class CanonicalizationError extends Error {}

function escapeString(s: string): string {
  const normalized = s.normalize("NFC");
  let out = '"';
  for (const ch of normalized) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '"': out += '\\"'; break;
      case "\\": out += "\\\\"; break;
      case "\b": out += "\\b"; break;
      case "\f": out += "\\f"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      default:
        out += code < 0x20 ? "\\u" + code.toString(16).padStart(4, "0") : ch;
    }
  }
  return out + '"';
}

function serialize(value: unknown, path: string): string {
  if (typeof value === "string") return escapeString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint") {
    throw new CanonicalizationError(`Numeric value at ${path}. Use a decimal string instead.`);
  }
  if (value === null || value === undefined) {
    throw new CanonicalizationError(`null/undefined at ${path}. Omit the key instead.`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => serialize(v, `${path}[${i}]`)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => escapeString(k) + ":" + serialize(obj[k], `${path}.${k}`)).join(",") + "}";
  }
  throw new CanonicalizationError(`Unsupported type ${typeof value} at ${path}`);
}

export function canonicalize(doc: CanonicalValue): Uint8Array {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new CanonicalizationError("Top-level document must be an object");
  }
  return new TextEncoder().encode(serialize({ ...doc, specVersion: String(PPV_SPEC_VERSION) }, "$"));
}

export function canonicalString(doc: CanonicalValue): string {
  return new TextDecoder().decode(canonicalize(doc));
}

export async function contentHash(doc: CanonicalValue): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalize(doc)));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
}
