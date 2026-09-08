import {
  createProgramAddress,
  decodeBase58,
  decodeEscrowEventData,
  findProgramAddress,
  type EscrowEventEnvelope,
} from "@gwap/ppv-sdk";

import type { RpcInstruction, RpcTransaction } from "./rpc.js";

/**
 * Extracts PPV escrow events from a confirmed transaction.
 *
 * Three rules decide what counts as an event, and each one is a security
 * property rather than a parsing convenience:
 *
 * 1. **A failed transaction is not history.** Nothing committed, so nothing
 *    happened, so no event and no receipt can come from it.
 * 2. **Only inner instructions.** An Anchor event CPI is the program invoking
 *    itself. A top-level instruction to the program is a request, not a fact,
 *    and its data must never be read as an event.
 * 3. **Only with the event authority.** The generated event handler requires
 *    the program's `__event_authority` PDA as a *signer*, which only the
 *    program itself can produce. Checking that account is what separates a
 *    genuine self-emitted event from an arbitrary instruction whose data
 *    happens to start with the same eight bytes.
 */

const EVENT_AUTHORITY_SEED = new TextEncoder().encode("__event_authority");

export function deriveEventAuthority(programId: string): string {
  return findProgramAddress([EVENT_AUTHORITY_SEED], programId).address;
}

export type ExtractOptions = {
  programId: string;
  /** Precomputed to avoid re-deriving per transaction; derived when absent. */
  eventAuthority?: string;
};

/**
 * The full account list of a transaction, in the order instruction indices
 * refer to: static keys first, then lookup-table writables, then readonlys.
 * Getting this order wrong on a versioned transaction silently reads the wrong
 * program id, so it is done once, here.
 */
export function accountKeysOf(tx: RpcTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  return [
    ...tx.transaction.message.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ];
}

function programOf(keys: string[], instruction: RpcInstruction): string | undefined {
  return keys[instruction.programIdIndex];
}

export function extractEscrowEvents(
  tx: RpcTransaction,
  options: ExtractOptions,
): EscrowEventEnvelope[] {
  if (tx.meta?.err != null) return [];

  const signature = tx.transaction.signatures[0];
  if (!signature) return [];

  const eventAuthority = options.eventAuthority ?? deriveEventAuthority(options.programId);
  const keys = accountKeysOf(tx);
  const envelopes: EscrowEventEnvelope[] = [];

  for (const group of tx.meta?.innerInstructions ?? []) {
    group.instructions.forEach((instruction, innerInstructionIndex) => {
      if (programOf(keys, instruction) !== options.programId) return;
      if (keys[instruction.accounts[0] ?? -1] !== eventAuthority) return;

      const event = decodeEscrowEventData(decodeBase58(instruction.data));
      if (!event) return;

      envelopes.push({
        event,
        programId: options.programId,
        transactionSignature: signature,
        slot: tx.slot,
        instructionIndex: group.index,
        innerInstructionIndex,
        blockTime: tx.blockTime,
      });
    });
  }

  return envelopes;
}

/** Whether an address could be a program id at all. Cheap input validation. */
export function isAddress(value: string): boolean {
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}

/** Exported for tests: an on-curve address can never be an event authority. */
export function isProgramDerivable(seeds: readonly Uint8Array[], programId: string): boolean {
  try {
    createProgramAddress(seeds, programId);
    return true;
  } catch {
    return false;
  }
}
