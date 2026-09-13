/**
 * Address checks the readiness verifier needs, with no dependencies so the
 * script runs before `npm ci` and outside a workspace install.
 *
 * The one that matters is `isOnCurve`. A Squads vault is a program-derived
 * address, and a PDA is by construction *off* the ed25519 curve; an ordinary
 * signer wallet is a public key and therefore *on* it. So "is this configured
 * upgrade authority a real multisig vault or somebody's hot wallet" is a
 * question about curve membership, and it can be answered locally, offline,
 * before any deployment reaches a cluster.
 *
 * `scripts/test/pubkey.test.mjs` cross-checks this against @solana/web3.js.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decodeBase58(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;

  const bytes = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = ALPHABET_MAP.get(text[i]);
    if (value === undefined) throw new TypeError(`invalid base58 character: ${text[i]}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** A syntactically valid Solana address: 32 bytes, base58. */
export function isAddress(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function mod(value) {
  const result = value % P;
  return result < 0n ? result + P : result;
}

function modPow(base, exponent) {
  let result = 1n;
  let acc = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * acc) % P;
    acc = (acc * acc) % P;
    e >>= 1n;
  }
  return result;
}

/**
 * Mirrors `curve25519-dalek`'s `CompressedEdwardsY::decompress`, which is what
 * the Solana runtime calls — including its quirks: a non-canonical `y` is
 * reduced rather than rejected, and `x == 0` with the sign bit set fails.
 */
export function isOnCurve(address) {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) return false;

  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i]);
  const signBit = (y >> 255n) & 1n;
  y = mod(y & ((1n << 255n) - 1n));

  const ySquared = (y * y) % P;
  const u = mod(ySquared - 1n);
  const v = mod(D * ySquared + 1n);
  if (v === 0n) return false;

  const w = (u * modPow(v, P - 2n)) % P;
  if (w !== 0n && modPow(w, (P - 1n) / 2n) !== 1n) return false;
  if (w === 0n && signBit === 1n) return false;
  return true;
}

/** A program-derived address is off the curve; a wallet public key is on it. */
export function isProgramDerived(address) {
  return isAddress(address) && !isOnCurve(address);
}

/**
 * base58 for the one direction the chain readers need: raw account bytes back
 * into an address. `decodeBase58` above is its inverse and the two are checked
 * against each other, and against @solana/web3.js, in pubkey.test.mjs.
 */
export function encodeBase58(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  const digits = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]];
  return out;
}
