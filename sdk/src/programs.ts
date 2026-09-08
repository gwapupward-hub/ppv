import {
  decodePpvEventData,
  programForEvent,
  type PpvChainEvent,
} from "./reputation/chain-events.js";
import { decodeEscrowEventData, type PpvEscrowEvent } from "./escrow/events.js";

/**
 * Program-scoped event decoding.
 *
 * An Anchor event discriminator is derived from the event name alone, so the
 * same name in two programs produces the same eight bytes. `ppv_commerce`
 * announces an agreement was negotiated and `ppv_escrow` announces one was
 * opened with custody; both used to call it `AgreementCreated`, and the escrow
 * side was renamed to `AgreementOpened` so they no longer do.
 *
 * That rename does not make the discriminator sufficient. Event identity is the
 * pair (program id, discriminator) — the name is chosen by whoever writes the
 * program, the program id is not — so every integrator should decode through
 * this function rather than guessing from the bytes. What a collision-free
 * namespace buys is that a mistake here yields nothing rather than a
 * plausible-looking event of the wrong kind.
 *
 * The emitting program is not something an indexer has to infer: an Anchor
 * event CPI is an inner instruction whose program id *is* the emitter.
 */

export const PPV_PROGRAM_NAMES = ["ppv_core", "ppv_commerce", "ppv_escrow"] as const;
export type PpvProgramName = (typeof PPV_PROGRAM_NAMES)[number];

export type PpvProgramEvent =
  | { program: "ppv_core" | "ppv_commerce"; event: PpvChainEvent }
  | { program: "ppv_escrow"; event: PpvEscrowEvent };

/**
 * Decodes one inner instruction's data as an event of `program`. Returns null
 * when the data is not an event of that program, and throws when it claims to
 * be one but does not decode — including an event that belongs to a *different*
 * PPV program, which is the case the discriminator alone cannot catch.
 */
export function decodeEventForProgram(
  program: PpvProgramName,
  data: Uint8Array,
): PpvProgramEvent | null {
  if (program === "ppv_escrow") {
    const event = decodeEscrowEventData(data);
    return event ? { program, event } : null;
  }

  const event = decodePpvEventData(data);
  if (!event) return null;
  const owner = programForEvent(event.name);
  if (owner !== program) {
    throw new RangeError(`${event.name} belongs to ${owner}, decoded as ${program}`);
  }
  return { program: owner, event };
}
