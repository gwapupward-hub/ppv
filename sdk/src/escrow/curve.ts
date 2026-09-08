/**
 * Ed25519 point decompression, used only to answer one question: is a candidate
 * 32-byte address on the curve?
 *
 * A program-derived address must be *off* the curve, because an on-curve
 * address could have a private key and therefore a signer who is not the
 * program. Deriving PDAs client-side without that check produces addresses the
 * runtime will refuse, so the check is part of the derivation, not a nicety.
 *
 * This mirrors `curve25519-dalek`'s `CompressedEdwardsY::decompress`, which is
 * what the Solana runtime calls, including its two quirks: a non-canonical `y`
 * is reduced rather than rejected, and `x == 0` with the sign bit set is
 * rejected. Dependency-free on purpose — the SDK ships no runtime dependencies.
 */

const P = (1n << 255n) - 19n;
// d = -121665 / 121666 (mod p)
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function mod(value: bigint): bigint {
  const result = value % P;
  return result < 0n ? result + P : result;
}

function modPow(base: bigint, exponent: bigint): bigint {
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

function inverse(value: bigint): bigint {
  return modPow(value, P - 2n);
}

/** Whether `w` is a quadratic residue mod p. Zero counts: sqrt(0) = 0. */
function isSquare(w: bigint): boolean {
  if (w === 0n) return true;
  return modPow(w, (P - 1n) / 2n) === 1n;
}

export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;

  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    y = (y << 8n) | BigInt(bytes[i] as number);
  }
  const signBit = (y >> 255n) & 1n;
  y = mod(y & ((1n << 255n) - 1n));

  const ySquared = (y * y) % P;
  const u = mod(ySquared - 1n);
  const v = mod(D * ySquared + 1n);
  if (v === 0n) return false;

  const w = (u * inverse(v)) % P;
  if (!isSquare(w)) return false;
  // x == 0 with the sign bit set is the one square that still fails to
  // decompress, because there is no negative zero to encode.
  if (w === 0n && signBit === 1n) return false;
  return true;
}
