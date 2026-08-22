const enc = new TextEncoder();

export interface WrappedKey { wrapped: string; iv: string }
export interface EncryptedEnvelope {
  ciphertext: string;
  iv: string;
  wrappedKeys: Record<string, WrappedKey>;
  contentHash: string;
  algorithm: "AES-256-GCM";
  kdf: "PPV-SIGMSG-HKDF-SHA256-v1";
}
export type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

export function kekMessage(id: string): Uint8Array {
  return enc.encode(`PPV-KEY-DERIVATION-v1:${id}`);
}

const b64 = {
  enc: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function deriveKek(signMessage: SignMessageFn, id: string): Promise<CryptoKey> {
  const signature = await signMessage(kekMessage(id));
  if (signature.length !== 64) throw new Error(`Expected 64-byte ed25519 signature, got ${signature.length}`);
  return hkdf(signature, enc.encode(`ppv-kek:${id}`), "ppv-key-encryption-key-v1");
}

export async function seal(
  plaintext: Uint8Array,
  contentHash: string,
  recipients: { wallet: string; kek: CryptoKey }[],
): Promise<EncryptedEnvelope> {
  if (!recipients.length) throw new Error("At least one recipient required");
  const dkRaw = crypto.getRandomValues(new Uint8Array(32));
  const dk = await crypto.subtle.importKey("raw", dkRaw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dk, plaintext));
  const wrappedKeys: Record<string, WrappedKey> = {};
  for (const recipient of recipients) {
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, recipient.kek, dkRaw));
    wrappedKeys[recipient.wallet] = { wrapped: b64.enc(wrapped), iv: b64.enc(wrapIv) };
  }
  dkRaw.fill(0);
  return { ciphertext: b64.enc(ciphertext), iv: b64.enc(iv), wrappedKeys, contentHash, algorithm: "AES-256-GCM", kdf: "PPV-SIGMSG-HKDF-SHA256-v1" };
}

export async function open(envelope: EncryptedEnvelope, wallet: string, kek: CryptoKey): Promise<Uint8Array> {
  const wrappedKey = envelope.wrappedKeys[wallet];
  if (!wrappedKey) throw new Error(`No wrapped key for ${wallet}`);
  const dkRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(wrappedKey.iv) }, kek, b64.dec(wrappedKey.wrapped)));
  const dk = await crypto.subtle.importKey("raw", dkRaw, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(envelope.iv) }, dk, b64.dec(envelope.ciphertext)));
  dkRaw.fill(0);
  return plaintext;
}

export function verifyAgainstChain(a: string, b: string): boolean {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function passphraseKek(passphrase: string, id: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(`ppv-recovery:${id}`), iterations: 600_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
