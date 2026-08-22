import { canonicalString, contentHash, toHex, CanonicalizationError } from "../src/canonical.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => cond ? (pass++, console.log("PASS", name)) : (fail++, console.log("FAIL", name));
const throws = (name: string, fn: () => unknown) => { try { fn(); fail++; } catch (e) { e instanceof CanonicalizationError ? pass++ : fail++; } console.log(name); };

ok("key order stable", canonicalString({ zeta: "1", alpha: "2" }) === canonicalString({ alpha: "2", zeta: "1" }));
ok("spec version injected", canonicalString({ a: "1" }).includes('"specVersion":"1"'));
throws("numbers rejected", () => canonicalString({ amount: 1500 } as any));
throws("bigint rejected", () => canonicalString({ amount: 1500n } as any));
ok("NFC stable", canonicalString({ name: "caf\u00e9" }) === canonicalString({ name: "cafe\u0301" }));
const h1 = toHex(await contentHash({ type: "proof", amountMinorUnits: "1500000" }));
const h2 = toHex(await contentHash({ amountMinorUnits: "1500000", type: "proof" }));
ok("hash reproducible", h1 === h2 && h1.length === 64);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
