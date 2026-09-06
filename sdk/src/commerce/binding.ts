import type { AgreementAccount } from "../escrow/accounts.js";
import type { CommerceAgreementAccount } from "./accounts.js";

/**
 * Binding a negotiated contract to the escrow that funds it.
 *
 * PPV keeps negotiation and custody in separate programs on purpose: one giant
 * state machine spanning "counter-offer sent" and "vault funded" is how an
 * illegal transition gets smuggled through a state that looks adjacent and is
 * not. The link between them is therefore not a pointer either program trusts —
 * it is a cryptographic commitment that anyone can re-check.
 *
 * `ppv_escrow` never reads a `ppv_commerce` account, and this function is not a
 * substitute for a check the program skipped. The program's own guarantee is
 * that an agreement's `terms_hash` is fixed at creation and never rewritten.
 * What this adds is the answer to a different question: *which* negotiated
 * document does that hash commit to, and did both of these parties actually
 * accept it?
 *
 * Every reason below is a way the two accounts can disagree. A caller that
 * ignores them has an escrow bound to nothing in particular.
 */

export type TermsBinding = {
  bound: boolean;
  /** Empty when bound; otherwise every way the two accounts disagree. */
  reasons: readonly string[];
};

export type TermsBindingInput = {
  escrow: Pick<AgreementAccount, "creator" | "counterparty" | "termsHash">;
  contract: CommerceAgreementAccount;
};

export function verifyTermsBinding({ escrow, contract }: TermsBindingInput): TermsBinding {
  const reasons: string[] = [];

  // The commitment itself. Everything else establishes that the document this
  // hash names was genuinely agreed by these two wallets.
  if (contract.termsHash !== escrow.termsHash) {
    reasons.push("the escrow's terms hash does not match the contract's");
  }

  if (contract.state !== "Executed") {
    reasons.push(`the contract is ${contract.state}, not Executed`);
  }

  const contractParties = new Set([contract.partyA, contract.partyB]);
  if (!contractParties.has(escrow.creator) || !contractParties.has(escrow.counterparty)) {
    reasons.push("the escrow's parties are not the contract's parties");
  }
  if (escrow.creator === escrow.counterparty) {
    reasons.push("the escrow names the same wallet twice");
  }

  // A revision clears both signatures, so a signature that survives is one for
  // the current version by construction. Checking anyway costs nothing and
  // makes this function independent of that property holding elsewhere.
  for (const [label, signature] of [
    ["party A", contract.signatureA],
    ["party B", contract.signatureB],
  ] as const) {
    if (!signature) {
      reasons.push(`${label} has not signed the current version`);
      continue;
    }
    if (signature.versionSigned !== contract.version) {
      reasons.push(`${label} signed version ${signature.versionSigned}, not ${contract.version}`);
    }
    if (signature.termsHashSigned !== contract.termsHash) {
      reasons.push(`${label} signed a different terms hash`);
    }
    if (signature.contentHashSigned !== contract.contentHash) {
      reasons.push(`${label} signed a different content hash`);
    }
  }

  if (contract.signatureA && contract.signatureB) {
    if (contract.signatureA.signer === contract.signatureB.signer) {
      reasons.push("both signatures are from the same wallet");
    }
    for (const [label, signature] of [
      ["party A", contract.signatureA],
      ["party B", contract.signatureB],
    ] as const) {
      if (!contractParties.has(signature.signer)) {
        reasons.push(`${label}'s signature is from a wallet that is not a party`);
      }
    }
  }

  return { bound: reasons.length === 0, reasons };
}
