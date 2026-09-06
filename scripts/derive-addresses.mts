/**
 * Prints every address one PPV escrow agreement occupies.
 *
 * Derivation needs nothing but the program id and public inputs, which is the
 * point: an integrator can compute where to look before anything exists on
 * chain, and can check that what a PPV product shows them lives at the address
 * the protocol says it must.
 *
 *   node --import tsx scripts/derive-addresses.mts \
 *     --program <PPV_ESCROW_PROGRAM_ID> --creator <WALLET> --id 42
 */

import { deriveAgreementAddresses } from "@gwap/ppv-sdk";

function required(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

const programId = required("program");
const creator = required("creator");
const agreementId = BigInt(required("id"));

const derived = deriveAgreementAddresses(programId, creator, agreementId);

console.log(`program         ${programId}`);
console.log(`creator         ${creator}`);
console.log(`agreement id    ${agreementId}`);
console.log("");
console.log(`agreement       ${derived.agreement} (bump ${derived.agreementBump})`);
console.log(`vault authority ${derived.vaultAuthority} (bump ${derived.vaultAuthorityBump})`);
console.log(`vault           ${derived.vault} (bump ${derived.vaultBump})`);
