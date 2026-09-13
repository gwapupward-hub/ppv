import {
  createProgramAddress,
  decodeBase58,
  decodeEscrowEventData,
  decodeEventForProgram,
  findProgramAddress,
  type EscrowEventEnvelope,
  type PpvChainEvent,
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

/** The chain coordinates that make one emitted Core or Commerce event unique. */
export type PpvEventEnvelope = {
  event: PpvChainEvent;
  /**
   * The program that emitted it. Event identity is the pair (program id,
   * discriminator), never the discriminator alone: an Anchor event
   * discriminator is derived from the event name, so the same name in two
   * programs produces the same eight bytes.
   */
  program: "ppv_core" | "ppv_commerce";
  programId: string;
  transactionSignature: string;
  slot: number;
  instructionIndex: number;
  innerInstructionIndex: number;
  blockTime: number | null;
};

/**
 * Extracts the escrow-free PPV events — `ppv_core` and `ppv_commerce` — from a
 * confirmed transaction.
 *
 * The same three rules as `extractEscrowEvents` decide what counts, for the
 * same reasons: a failed transaction is not history, a top-level instruction is
 * a request rather than a fact, and only the program's own
 * `__event_authority` PDA can sign an event CPI.
 *
 * The fourth rule is specific to reading two programs at once. `program` is
 * taken from the instruction's program id and the event is decoded *for that
 * program*, so an event emitted by Commerce can never be reported as a Core
 * event even though the two share discriminators for any name they have in
 * common. A transaction that touches both programs yields events attributed
 * correctly to each.
 */
export function extractPpvEvents(
  tx: RpcTransaction,
  options: { programs: Readonly<Record<"ppv_core" | "ppv_commerce", string>> },
): PpvEventEnvelope[] {
  if (tx.meta?.err != null) return [];

  const signature = tx.transaction.signatures[0];
  if (!signature) return [];

  const byProgramId = new Map<string, "ppv_core" | "ppv_commerce">();
  const authorities = new Map<string, string>();
  for (const [program, programId] of Object.entries(options.programs) as Array<
    ["ppv_core" | "ppv_commerce", string]
  >) {
    byProgramId.set(programId, program);
    authorities.set(programId, deriveEventAuthority(programId));
  }

  const keys = accountKeysOf(tx);
  const envelopes: PpvEventEnvelope[] = [];

  for (const group of tx.meta?.innerInstructions ?? []) {
    group.instructions.forEach((instruction, innerInstructionIndex) => {
      const programId = programOf(keys, instruction);
      if (programId === undefined) return;
      const program = byProgramId.get(programId);
      if (program === undefined) return;
      if (keys[instruction.accounts[0] ?? -1] !== authorities.get(programId)) return;

      // Decoded for the emitting program, not merely decoded. A discriminator
      // that belongs to the other PPV program throws rather than being
      // reported under this one.
      const decoded = decodeEventForProgram(program, decodeBase58(instruction.data));
      if (!decoded || decoded.program === "ppv_escrow") return;

      envelopes.push({
        event: decoded.event,
        program: decoded.program,
        programId,
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
