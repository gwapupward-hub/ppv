import type { ActionResult, GeneratedAction, ResolvedAccounts } from "./actions";
import { describeAction, isCanonicallyAddressed } from "./actions";
import type { EscrowModel, EscrowModelState, Prediction } from "./model";
import { describeModel, isLegalEdge, TERMINAL_STATES } from "./model";
import type { ProtocolSnapshot } from "./snapshots";
import { describeSnapshot, economicFingerprint } from "./snapshots";

/**
 * Every protocol invariant, asserted after every attempted action — successful
 * or refused.
 *
 * The invariant identifiers are the ones in docs/invariants.md. A violation
 * raises `InvariantViolation`, which carries the complete forensic record:
 * seed, sequence, the index where the divergence first occurred, the model's
 * expectation, what the chain actually shows, and the balances behind both. A
 * failure nobody can reproduce is not a finding, so nothing here throws a bare
 * assertion.
 */

export type InvariantId =
  | "PPV-MODEL"
  | "PPV-P1"
  | "PPV-P2"
  | "PPV-P3"
  | "PPV-P4"
  | "PPV-P5"
  | "PPV-P6"
  | "PPV-P7"
  | "PPV-P8"
  | "PPV-P9"
  | "PPV-P10"
  // Dispute and refund invariants, added when those paths joined the model.
  // Named separately from the PPV-P* family because they are claims about
  // custody leaving by a path an ordinary escrow never takes, and a report
  // that named them all "PPV-P1" would say less than the failure knows.
  | "PPV-D2"
  | "PPV-D3"
  | "PPV-D4"
  | "PPV-D5";

export type CheckContext = {
  seed: number;
  sequence: GeneratedAction[];
  actionIndex: number;
  action: GeneratedAction;
  resolved: ResolvedAccounts;
  prediction: Prediction;
  result: ActionResult;
  pre: ProtocolSnapshot;
  post: ProtocolSnapshot;
  /** The model as it stood *before* the action. */
  model: EscrowModel;
  /** The model as it stands after the model's own transition. */
  expected: EscrowModel;
  /** Successful settlements this harness has executed for this agreement. */
  settlementCount: number;
  /** Token units stranded in the vaults of already-finished sequences. */
  retiredInVaults: bigint;
  /** The controlled supply, measured once setup minting finished. */
  baseline: bigint;
  /** The agreement's buyer, seller and mint as initialized, base58. */
  initial: { buyer: string; seller: string; mint: string };
};

export class InvariantViolation extends Error {
  readonly invariant: InvariantId;
  readonly report: Record<string, unknown>;

  constructor(invariant: InvariantId, detail: string, ctx: CheckContext) {
    super(buildReport(invariant, detail, ctx));
    this.name = "InvariantViolation";
    this.invariant = invariant;
    this.report = {
      invariant,
      detail,
      seed: ctx.seed,
      actionIndex: ctx.actionIndex,
      sequence: ctx.sequence.map(describeAction),
      expectedModel: describeModel(ctx.expected),
      observedChain: describeSnapshot(ctx.post),
      preChain: describeSnapshot(ctx.pre),
    };
  }
}

function buildReport(invariant: InvariantId, detail: string, ctx: CheckContext): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  violated invariant : ${invariant}`);
  lines.push(`  detail             : ${detail}`);
  lines.push(`  seed               : ${ctx.seed}`);
  lines.push(`  replay             : PPV_INVARIANT_SEED=${ctx.seed} npm run test:invariants:seed`);
  lines.push(`  divergence index   : ${ctx.actionIndex} of ${ctx.sequence.length}`);
  lines.push("  action sequence    :");
  ctx.sequence.forEach((action, index) => {
    const marker = index === ctx.actionIndex ? ">>" : "  ";
    lines.push(`    ${marker} [${index}] ${describeAction(action)}`);
  });
  lines.push(`  prediction         : ${ctx.prediction.succeeds ? "SUCCEED" : "FAIL"} — ${ctx.prediction.reason}`);
  lines.push(
    `  chain outcome      : ${ctx.result.succeeded ? "SUCCEEDED" : "FAILED"}` +
      (ctx.result.errorCode ? ` (${ctx.result.errorCode})` : "") +
      (ctx.result.signature ? ` sig=${ctx.result.signature}` : ""),
  );
  if (!ctx.result.succeeded && ctx.result.error) {
    lines.push(`  chain error        : ${ctx.result.error.replace(/\s+/g, " ")}`);
  }
  lines.push("  resolved accounts  :");
  for (const [name, key] of Object.entries(ctx.resolved)) {
    lines.push(`    ${name.padEnd(20)} ${key.toBase58()}`);
  }
  lines.push("  expected model     :");
  for (const [key, value] of Object.entries(describeModel(ctx.expected))) {
    lines.push(`    ${key.padEnd(20)} ${value}`);
  }
  lines.push("  observed chain     :");
  const observed = describeSnapshot(ctx.post);
  for (const [key, value] of Object.entries(observed)) {
    lines.push(`    ${key.padEnd(20)} ${value}`);
  }
  lines.push("  chain before action:");
  for (const [key, value] of Object.entries(describeSnapshot(ctx.pre))) {
    lines.push(`    ${key.padEnd(20)} ${value}`);
  }
  lines.push(`  conservation       : baseline=${ctx.baseline} retired=${ctx.retiredInVaults} live=${ctx.post.controlledLive}`);
  lines.push("");
  return lines.join("\n");
}

function fail(invariant: InvariantId, detail: string, ctx: CheckContext): never {
  throw new InvariantViolation(invariant, detail, ctx);
}

/** The chain's `AgreementState` variant name, as a model state. */
function chainState(snapshot: ProtocolSnapshot): EscrowModelState | string {
  return snapshot.agreement.state;
}

/**
 * Asserts every applicable invariant. Order matters only for legibility: the
 * model divergence is checked first because it is the finding that explains
 * most of the others.
 */
export function assertInvariants(ctx: CheckContext): void {
  const { pre, post, action, result, prediction } = ctx;
  const canonical = isCanonicallyAddressed(action);

  // The reference model and the chain must agree on whether the action was
  // legal. This is not one of the numbered protocol invariants; it is the
  // property that makes all of them meaningful.
  if (prediction.succeeds !== result.succeeded) {
    fail(
      "PPV-MODEL",
      prediction.succeeds
        ? "the model expected this action to succeed and the chain refused it"
        : "the chain accepted an action the model says is illegal",
      ctx,
    );
  }

  // PPV-P8 — a refused action must leave nothing behind.
  if (!result.succeeded && economicFingerprint(pre) !== economicFingerprint(post)) {
    fail("PPV-P8", "a failed action changed observable state", ctx);
  }

  // PPV-P1 — custody conservation across the controlled token population.
  if (post.controlledLive + ctx.retiredInVaults !== ctx.baseline) {
    fail(
      "PPV-P1",
      `controlled supply moved: live ${post.controlledLive} + retired ${ctx.retiredInVaults} != baseline ${ctx.baseline}`,
      ctx,
    );
  }

  // PPV-P9 — the unrelated agreement is never reachable from here, however its
  // accounts are presented.
  if (pre.unrelatedAgreementRaw !== post.unrelatedAgreementRaw) {
    fail("PPV-P9", "an action mutated an unrelated agreement account", ctx);
  }
  if (pre.unrelatedVault !== post.unrelatedVault) {
    fail("PPV-P9", "an action moved tokens in an unrelated agreement's vault", ctx);
  }
  if (!canonical && result.succeeded) {
    fail(
      "PPV-P9",
      "a correctly formed account in the wrong relationship was accepted",
      ctx,
    );
  }

  // PPV-P5 — escrow assets never leave through a substituted vault or
  // authority, and nothing ever lands in an account that is not a vault.
  if (post.fakeVault !== pre.fakeVault) {
    fail("PPV-P5", "tokens moved through an account substituted for the vault", ctx);
  }
  const substitutedCustody =
    action.accounts.vault !== "canonical" ||
    (action.kind === "settle" && action.accounts.vaultAuthority !== "canonical");
  if (
    (action.kind === "fund" || action.kind === "settle") &&
    substitutedCustody &&
    post.vault !== pre.vault
  ) {
    fail("PPV-P5", "the canonical vault moved under a substituted custody path", ctx);
  }

  if (!post.agreement.exists) {
    fail("PPV-P2", "the agreement account disappeared", ctx);
  }

  // PPV-P6 — for an ordinary escrow the parties are fixed at initialization.
  if (post.agreement.creator !== ctx.initial.buyer) {
    fail("PPV-P6", "the agreement's creator changed", ctx);
  }
  if (post.agreement.counterparty !== ctx.initial.seller) {
    fail("PPV-P6", "the agreement's counterparty changed", ctx);
  }

  // PPV-P7 — the mint is fixed forever.
  if (post.agreement.mint !== ctx.initial.mint) {
    fail("PPV-P7", "the agreement's mint changed", ctx);
  }

  // PPV-P10 — only the four legal edges may be taken, and only by an action
  // the chain accepted.
  const before = chainState(pre);
  const after = chainState(post);
  if (before !== after) {
    if (!result.succeeded) {
      fail("PPV-P10", `a refused action moved the lifecycle ${before} -> ${after}`, ctx);
    }
    if (!isLegalEdge(before as EscrowModelState, after as EscrowModelState)) {
      fail("PPV-P10", `illegal lifecycle transition ${before} -> ${after}`, ctx);
    }
  }

  // PPV-P2 — terminal finality. Once settled or cancelled, nothing moves.
  if (TERMINAL_STATES.has(before as EscrowModelState)) {
    if (before !== after) {
      fail("PPV-P2", `a terminal agreement transitioned ${before} -> ${after}`, ctx);
    }
    if (economicFingerprint(pre) !== economicFingerprint(post)) {
      fail("PPV-P2", "a terminal agreement's economic state changed", ctx);
    }
    if (result.succeeded) {
      fail("PPV-P2", "an action succeeded against a terminal agreement", ctx);
    }
  }

  // PPV-P3 — one agreement, at most one canonical settlement.
  if (ctx.settlementCount > 1) {
    fail("PPV-P3", `the agreement settled ${ctx.settlementCount} times`, ctx);
  }
  if (post.agreement.settledTotal > post.agreement.amount) {
    fail(
      "PPV-P3",
      `settled total ${post.agreement.settledTotal} exceeds the escrowed amount ${post.agreement.amount}`,
      ctx,
    );
  }
  // A refunded agreement paid out everything the vault still owed, by the same
  // rule and for the same reason as a settled one: the money is gone and the
  // record is closed, so the books must say where all of it went (PPV-D3).
  if (after === "refunded" && post.agreement.settledTotal !== post.agreement.amount) {
    fail(
      "PPV-D3",
      `a refunded agreement returned ${post.agreement.settledTotal} of ${post.agreement.amount}`,
      ctx,
    );
  }
  if (after === "settled" && post.agreement.settledTotal !== post.agreement.amount) {
    fail(
      "PPV-P3",
      `a settled agreement paid out ${post.agreement.settledTotal} of ${post.agreement.amount}`,
      ctx,
    );
  }

  // PPV-P4 — settlement credits the canonical seller and nobody else.
  if (action.kind === "settle" && result.succeeded) {
    if (action.accounts.destination !== "seller") {
      fail("PPV-P4", "settlement was redirected away from the seller", ctx);
    }
    if (post.seller - pre.seller !== post.agreement.amount) {
      fail(
        "PPV-P4",
        `settlement credited the seller ${post.seller - pre.seller}, expected ${post.agreement.amount}`,
        ctx,
      );
    }
    if (post.buyer !== pre.buyer || post.attacker !== pre.attacker || post.outsider !== pre.outsider) {
      fail("PPV-P4", "settlement moved tokens into a non-seller account", ctx);
    }
  }

  // Finally: the chain must be exactly where the model says it is. Balances
  // are compared as well as lifecycle, because a state machine that agrees on
  // its labels and disagrees on its money is the more dangerous of the two.
  if (after !== ctx.expected.state) {
    fail("PPV-MODEL", `model says ${ctx.expected.state}, chain says ${after}`, ctx);
  }
  if (post.vault !== ctx.expected.vaultBalance) {
    fail(
      "PPV-MODEL",
      `model vault ${ctx.expected.vaultBalance}, chain vault ${post.vault}`,
      ctx,
    );
  }
  if (post.buyer !== ctx.expected.buyerBalance) {
    fail(
      "PPV-MODEL",
      `model buyer balance ${ctx.expected.buyerBalance}, chain ${post.buyer}`,
      ctx,
    );
  }
  if (post.seller !== ctx.expected.sellerBalance) {
    fail(
      "PPV-MODEL",
      `model seller balance ${ctx.expected.sellerBalance}, chain ${post.seller}`,
      ctx,
    );
  }
  if (post.attacker !== ctx.expected.attackerBalance) {
    fail(
      "PPV-MODEL",
      `model attacker balance ${ctx.expected.attackerBalance}, chain ${post.attacker}`,
      ctx,
    );
  }
}
