import { deriveKek, seal, open, verifyAgainstChain } from "../src/crypto.js";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => cond ? (pass++, console.log("PASS", name)) : (fail++, console.log("FAIL", name));
const kp = generateKeyPairSync("ed25519");
const signer = async (msg: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(msg), kp.privateKey));
const kek1 = await deriveKek(signer, "proof-1");
const kek2 = await deriveKek(signer, "proof-1");
const plaintext = new TextEncoder().encode("private proof content");
const hash = "ab".repeat(32);
const envelope = await seal(plaintext, hash, [{ wallet: "owner", kek: kek1 }]);
const opened = await open(envelope, "owner", kek2);
ok("wallet-derived key is reproducible", Buffer.compare(Buffer.from(opened), Buffer.from(plaintext)) === 0);
ok("hash comparison matches", verifyAgainstChain(hash.toUpperCase(), hash));
let denied = false;
try { await open(envelope, "outsider", kek1); } catch { denied = true; }
ok("unknown recipient denied", denied);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
