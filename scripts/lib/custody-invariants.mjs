/**
 * The custody invariants, as arithmetic over observed balances.
 *
 * A live custody test is worth very little if its assertion is "the transaction
 * succeeded". A transaction that pays the wrong party succeeds. A transaction
 * that pays twice succeeds. What distinguishes a passing custody test from a
 * passing transaction is that every account's balance moved by exactly the
 * amount the protocol says it should, and every other account's did not move at
 * all — including the accounts nobody thought to name.
 *
 * So the unit of assertion here is a *complete* delta map: the caller states
 * what should change, and anything else that changed is a failure by default.
 * That is the direction that catches an unexpected recipient; the opposite
 * direction (check the accounts we expect, ignore the rest) never can.
 *
 * Pure arithmetic. No network, no keys, no I/O.
 */

/**
 * The properties `PPV-P1` … `PPV-P10` name, so a live result can be attributed
 * to the same property the offline suites assert rather than to a prose
 * summary of one.
 */
export const PPV_INVARIANTS = Object.freeze({
  "PPV-P1": "custody conservation: what leaves a vault arrives somewhere, in full",
  "PPV-P2": "no overpayment: total paid out never exceeds the agreement amount",
  "PPV-P3": "no double settlement: a terminal agreement cannot pay again",
  "PPV-P4": "destination binding: payouts reach only the account the protocol names",
  "PPV-P5": "mint binding: every custody account holds the agreement's mint",
  "PPV-P6": "authorized signer: only the signer a guard names may act",
  "PPV-P7": "terminal-state finality: a terminal agreement never becomes active",
  "PPV-P8": "exact funding: funding moves exactly the agreement amount",
  "PPV-P9": "account relationship binding: an account acts only for its own agreement",
  "PPV-P10": "state and accounting consistency: recorded state matches moved value",
});

export class InvariantViolation extends Error {
  constructor(invariant, message, detail = {}) {
    super(`${invariant} violated: ${message}`);
    this.name = "InvariantViolation";
    this.invariant = invariant;
    this.detail = detail;
  }
}

/** Token amounts are u64. They are handled as BigInt end to end, never Number. */
export function toAmount(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${value} is not a safe integer amount`);
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  throw new TypeError(`cannot read ${typeof value} as a token amount`);
}

/**
 * A snapshot of every account this run watches, taken before and after each
 * value-moving transaction.
 *
 * "Every account this run watches" is the important part: a snapshot that only
 * contains the two accounts a transfer is supposed to touch cannot notice a
 * third one changing. The harness registers each account once, at creation, and
 * every snapshot covers all of them.
 */
export class BalanceSnapshot {
  constructor(entries) {
    this.balances = new Map();
    for (const [address, amount] of Object.entries(entries)) {
      this.balances.set(address, toAmount(amount));
    }
  }

  get(address) {
    if (!this.balances.has(address)) {
      throw new InvariantViolation(
        "PPV-P1",
        `no balance was recorded for ${address}; an unwatched account cannot be asserted about`,
      );
    }
    return this.balances.get(address);
  }

  addresses() {
    return [...this.balances.keys()].sort();
  }

  toJSON() {
    return Object.fromEntries(
      [...this.balances.entries()].map(([address, amount]) => [address, amount.toString()]),
    );
  }
}

/**
 * Every account's movement between two snapshots, as a plain map of strings so
 * it can be written straight into an evidence record.
 */
export function deltas(before, after) {
  const out = new Map();
  const addresses = new Set([...before.balances.keys(), ...after.balances.keys()]);
  for (const address of addresses) {
    const from = before.balances.get(address) ?? 0n;
    const to = after.balances.get(address) ?? 0n;
    out.set(address, to - from);
  }
  return out;
}

/**
 * The complete-delta assertion.
 *
 * `expected` names every account that may move and by how much. Every watched
 * account absent from it must have moved by zero — that is not a courtesy
 * check, it is the one that catches a payout reaching an account nobody
 * thought to look at.
 *
 * Returns the observed deltas so the caller can record them as evidence; a
 * mismatch throws.
 */
export function assertDeltas(before, after, expected, { label, invariant = "PPV-P1" } = {}) {
  const observed = deltas(before, after);
  const wanted = new Map(
    Object.entries(expected).map(([address, amount]) => [address, toAmount(amount)]),
  );

  for (const [address, amount] of wanted) {
    if (!observed.has(address)) {
      throw new InvariantViolation(
        invariant,
        `${label}: ${address} was expected to move by ${amount} but is not a watched account`,
      );
    }
  }

  const wrong = [];
  for (const [address, moved] of observed) {
    const want = wanted.get(address) ?? 0n;
    if (moved !== want) {
      wrong.push(
        `${address}: expected ${want >= 0n ? "+" : ""}${want}, observed ${moved >= 0n ? "+" : ""}${moved}`,
      );
    }
  }
  if (wrong.length > 0) {
    // The offending accounts go in the message, not only in `detail`. A failure
    // a reader has to open a debugger to understand is a failure they will read
    // as "the harness is flaky" — and this is the assertion that catches a
    // payout reaching an account nobody named.
    throw new InvariantViolation(
      invariant,
      `${label}: balances did not move as the protocol says — ${wrong.join("; ")}`,
      {
        wrong,
        observed: Object.fromEntries([...observed].map(([a, v]) => [a, v.toString()])),
      },
    );
  }

  // Conservation: a transfer neither creates nor destroys units. Stated
  // separately from the per-account check because a pair of deltas can each be
  // individually "as expected" and still not sum to zero if the expectation was
  // written wrong, and an expectation that does not conserve is a bug in the
  // test rather than in the program.
  let sum = 0n;
  for (const moved of observed.values()) sum += moved;
  if (sum !== 0n) {
    throw new InvariantViolation(
      "PPV-P1",
      `${label}: watched balances changed by a net ${sum}; tokens were created or destroyed, ` +
        "or a participating account is not being watched",
      { net: sum.toString() },
    );
  }

  return Object.fromEntries([...observed].map(([a, v]) => [a, v.toString()]));
}

/** A payout of exactly `amount` from `vault` to `recipient`, and nothing else. */
export function assertPayout(before, after, { vault, recipient, amount, label, invariant }) {
  const value = toAmount(amount);
  return assertDeltas(
    before,
    after,
    { [vault]: -value, [recipient]: value },
    { label, invariant: invariant ?? "PPV-P4" },
  );
}

/** Funding: exactly `amount` from the buyer into the vault, and nothing else. */
export function assertFunding(before, after, { buyer, vault, amount, label }) {
  const value = toAmount(amount);
  return assertDeltas(
    before,
    after,
    { [buyer]: -value, [vault]: value },
    { label, invariant: "PPV-P8" },
  );
}

/** No value moved at all. Used for every state-only step and every refusal. */
export function assertNoMovement(before, after, { label, invariant = "PPV-P10" } = {}) {
  return assertDeltas(before, after, {}, { label, invariant });
}

/**
 * The state half of `PPV-P10`: what the agreement account says must agree with
 * what the tokens did.
 *
 * `settled_total` is the program's own record of how much has left the vault by
 * any path, so `amount - settled_total` must equal the vault's balance for as
 * long as the agreement exists. An agreement whose accounting says it has paid
 * out more than its vault has lost is the single most important thing a live
 * run could find, and it is invisible to any assertion that only looks at
 * balances.
 */
export function assertAccountingConsistent(agreement, vaultBalance, { label } = {}) {
  const amount = toAmount(agreement.amount);
  const settled = toAmount(agreement.settledTotal);
  const balance = toAmount(vaultBalance);

  if (settled > amount) {
    throw new InvariantViolation(
      "PPV-P2",
      `${label}: settled_total ${settled} exceeds the agreement amount ${amount}`,
    );
  }

  // `amount` is what the agreement is *for*, not what the vault holds. Until
  // `fund` runs, the vault holds nothing however large the agreement is, and an
  // agreement cancelled before funding stays that way forever. Conflating the
  // two would make every unfunded agreement look like a missing balance — and,
  // worse, would make a *funded* agreement whose money vanished look normal if
  // the harness ever stopped distinguishing them.
  const funded = Number(agreement.fundedAt ?? 0) !== 0;
  if (!funded) {
    if (settled !== 0n) {
      throw new InvariantViolation(
        "PPV-P10",
        `${label}: the agreement was never funded but records ${settled} paid out`,
      );
    }
    if (balance !== 0n) {
      throw new InvariantViolation(
        "PPV-P1",
        `${label}: the agreement was never funded but its vault holds ${balance}`,
      );
    }
    return { funded: false, owed: "0", balance: "0" };
  }

  if (amount - settled !== balance) {
    throw new InvariantViolation(
      "PPV-P10",
      `${label}: the agreement says ${amount - settled} is still owed (amount ${amount} − ` +
        `settled_total ${settled}) but the vault holds ${balance}`,
      { amount: amount.toString(), settled: settled.toString(), balance: balance.toString() },
    );
  }
  return { funded: true, owed: (amount - settled).toString(), balance: balance.toString() };
}

/** Terminal states, from `AgreementState::is_terminal`. */
export const TERMINAL_STATES = Object.freeze(["Settled", "Cancelled", "Refunded"]);

export function assertTerminal(state, { label } = {}) {
  if (!TERMINAL_STATES.includes(state)) {
    throw new InvariantViolation("PPV-P7", `${label}: state is ${state}, which is not terminal`);
  }
  return state;
}

/**
 * What an expected-to-fail transaction must leave behind.
 *
 * A negative test that only checks "the transaction failed" proves less than it
 * looks like it does: a transaction can fail *after* moving tokens if a program
 * writes before it validates, and it can fail while leaving an account
 * half-written. So a refusal is only a pass when the state and every watched
 * balance are byte-identical to what they were before the attempt.
 */
export function assertRefusalChangedNothing({
  label,
  before,
  after,
  stateBefore,
  stateAfter,
  settledTotalBefore,
  settledTotalAfter,
}) {
  assertNoMovement(before, after, { label: `${label} (refused)`, invariant: "PPV-P7" });
  if (stateBefore !== stateAfter) {
    throw new InvariantViolation(
      "PPV-P7",
      `${label}: the transaction failed but the agreement state moved ${stateBefore} → ${stateAfter}`,
    );
  }
  if (toAmount(settledTotalBefore) !== toAmount(settledTotalAfter)) {
    throw new InvariantViolation(
      "PPV-P3",
      `${label}: the transaction failed but settled_total moved ` +
        `${settledTotalBefore} → ${settledTotalAfter}`,
    );
  }
  return true;
}
