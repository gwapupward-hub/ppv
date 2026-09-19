#!/usr/bin/env node
/**
 * Read-only recovery of a completed live custody run.
 *
 * Run 35465469908 executed the entire value-moving custody matrix against the
 * deployed `ppv_escrow` — ordinary escrow, cancel, refund, dispute-to-seller,
 * dispute-to-buyer, milestones, bounty, proof submit/approve/reject, a live
 * CPI into `ppv_core`, the foreign-proof relationship negative and its
 * cleanup, and the proof-backed final settlement — and then failed in Phase
 * 12, the read-only history reconstruction, because the RPC provider answered
 * `getTransaction` with HTTP 429.
 *
 * The custody behaviour happened. Only the reading of it did not. Repeating a
 * matrix of value-moving transactions because a read was rate limited would
 * spend real devnet state to re-learn something the chain already records, so
 * this command reconstructs the run instead.
 *
 * WHAT MAKES THIS SAFE
 *
 * It cannot send a transaction. Not "does not": cannot. It imports no signer
 * type, no transaction builder and no send path; the only chain access it has
 * is `rpc()` — whose JSON-RPC client refuses `sendTransaction`,
 * `simulateTransaction` and `requestAirdrop` outright — and the indexer's
 * `httpChainSource`, whose public surface is two read methods.
 * `scripts/test/custody-recovery.test.mjs` asserts that structurally, so an
 * edit that introduced a send path would fail the suite rather than ship.
 *
 * It needs no private key. No funder, buyer, seller or outsider secret, no
 * deploy keypair and no custody signer: every claim below is read from public
 * chain state.
 *
 * WHAT IT TRUSTS
 *
 * The diagnostic record supplies coordinates — addresses and signatures — and
 * nothing else. Every claim is then checked against the chain: a state the
 * diagnostic asserts is compared with the state the live account reports, a
 * balance it implies is read from the vault, a signature it lists is looked up
 * and its own `err` decides whether it succeeded or was refused. A diagnostic
 * that lies about an outcome fails here; a diagnostic that lies about an
 * address verifies the wrong account and fails the accounting.
 *
 * USAGE
 *
 *   PPV_CUSTODY_RPC_URL=<dedicated devnet endpoint> \
 *   node scripts/recover-devnet-escrow-custody-evidence.mjs \
 *     --diagnostic <path to the run's public diagnostic JSON> \
 *     [--out deployments/validation/ppv-escrow-devnet-live-custody-<runId>.json]
 *
 * Without `--out` it verifies and reports, writing nothing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PublicKey } from "@solana/web3.js";

import { ESCROW_PROGRAM_ID, CORE_PROGRAM_ID, deriveVault } from "./lib/escrow-instructions.mjs";
import { registerSensitiveEndpoint, redact, looksLikeCredentialUrl } from "./lib/endpoint-safety.mjs";
import { rpc } from "./lib/rpc.mjs";
import {
  CustodyDefect,
  CustodyHarnessFailure,
  assertNoSecrets,
  requireDevnet,
  snapshotBalances,
} from "./lib/custody-runner.mjs";
import { EXPECTED, HARNESS_VERSION, preflight, readAgreement } from "./devnet-escrow-custody.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const log = (line = "") => process.stdout.write(`${line}\n`);
const step = (ok, name, detail = "") =>
  log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);

/** The eight primary scenarios a complete matrix produces. */
export const PRIMARY_SCENARIOS = Object.freeze([
  "ordinaryEscrow",
  "cancel",
  "refund",
  "disputeToSeller",
  "disputeToBuyer",
  "milestones",
  "bounty",
  "proofs",
]);

/**
 * The lifecycle families RR-6 requires, and the scenario that proves each.
 *
 * Written down so a run that reconstructs seven of eight cannot be reported as
 * closing RR-6: the criterion is the list, not the count.
 */
export const RR6_FAMILIES = Object.freeze({
  funding: "ordinaryEscrow",
  settlement: "ordinaryEscrow",
  cancellation: "cancel",
  refund: "refund",
  disputeToSeller: "disputeToSeller",
  disputeToBuyer: "disputeToBuyer",
  milestoneRelease: "milestones",
  bountySelection: "bounty",
  proofApproval: "proofs",
});

/** Terminal states a completed scenario may legitimately rest in. */
const TERMINAL_STATES = Object.freeze(["Settled", "Cancelled", "Refunded", "Resolved", "Closed"]);

/* ------------------------------------------------------------- the inputs */

export function parseArguments(argv) {
  const args = { diagnostic: null, out: null, commit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--diagnostic") args.diagnostic = argv[++i] ?? null;
    else if (flag === "--out") args.out = argv[++i] ?? null;
    else if (flag === "--expect-commit") args.commit = argv[++i] ?? null;
    else if (flag.startsWith("--")) throw new CustodyHarnessFailure(`unknown option ${flag}`);
  }
  if (!args.diagnostic) {
    throw new CustodyHarnessFailure("--diagnostic <path> is required; recovery reads a run's public record");
  }
  return args;
}

/**
 * The diagnostic, read and sanity-checked as *coordinates*, never as findings.
 *
 * A record that claims to be validation evidence is refused outright: this
 * command exists to produce that, and accepting one as input would let a run's
 * own failure debris be laundered into a PASS.
 */
export function readDiagnostic(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.artifact !== "ppv-escrow-devnet-custody-failure") {
    throw new CustodyHarnessFailure(
      `${path} is not a custody failure diagnostic (artifact=${record.artifact ?? "absent"})`,
    );
  }
  if (record.isValidationEvidence) {
    throw new CustodyHarnessFailure(`${path} claims to be validation evidence; it is the input, not the output`);
  }
  if (record.cluster !== "devnet") {
    throw new CustodyHarnessFailure(`${path} names cluster ${record.cluster}, not devnet`);
  }
  if (!record.workflowRunId) throw new CustodyHarnessFailure(`${path} names no workflow run`);
  if (!record.repositoryCommit) throw new CustodyHarnessFailure(`${path} names no repository commit`);
  // A diagnostic is a public artifact and must never have carried an endpoint.
  // If one is in there, nothing downstream may quote it.
  const serialized = JSON.stringify(record);
  if (looksLikeCredentialUrl(serialized)) {
    throw new CustodyHarnessFailure(`${path} contains a credential-bearing URL; refusing to read it`);
  }
  return record;
}

/* ---------------------------------------------------- transaction lookups */

/** One signature, as the chain reports it. Never sent, only read. */
export async function lookupTransaction(client, signature) {
  const result = await client.call("getTransaction", [
    signature,
    { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  if (!result) return { signature, found: false, err: null, slot: null };
  return { signature, found: true, err: result.meta?.err ?? null, slot: result.slot ?? null };
}

/**
 * Every signature the run recorded as a success, proved to have succeeded.
 *
 * "Recorded as a success" is the diagnostic's claim; "succeeded" is the
 * chain's. A signature that is absent, or present carrying an error, fails.
 */
export async function verifySuccesses(client, signatures) {
  const rows = [];
  for (const { step: label, signature } of signatures) {
    const outcome = await lookupTransaction(client, signature);
    if (!outcome.found) {
      throw new CustodyDefect(`${label}: signature ${signature} is not on chain`);
    }
    if (outcome.err !== null) {
      throw new CustodyDefect(
        `${label}: signature ${signature} landed carrying ${JSON.stringify(outcome.err)}, but the run ` +
          "recorded it as a success",
      );
    }
    rows.push({ step: label, signature, onChain: true, err: null, slot: outcome.slot });
  }
  return rows;
}

/**
 * Every expected refusal, proved to be a refusal the chain recorded.
 *
 * A refusal is only a refusal when its signature landed AND carries an error.
 * No signature is infrastructure, not evidence; a landed signature with no
 * error means the program accepted something it must have refused, which is a
 * custody defect and the most serious thing this command can find.
 */
export async function verifyRefusals(client, negatives) {
  const rows = [];
  for (const row of negatives) {
    if (!row.signature) {
      throw new CustodyHarnessFailure(
        `${row.label}: the run recorded no signature for this refusal, so it cannot be proved from chain ` +
          "state; this is an infrastructure gap, not a proven refusal",
      );
    }
    const outcome = await lookupTransaction(client, row.signature);
    if (!outcome.found) {
      throw new CustodyHarnessFailure(
        `${row.label}: signature ${row.signature} is not on chain; a refusal that did not land proves nothing`,
      );
    }
    if (outcome.err === null) {
      throw new CustodyDefect(
        `${row.label}: signature ${row.signature} landed with no error. The program accepted an ` +
          "instruction it must have refused.",
      );
    }
    rows.push({
      label: row.label,
      signature: row.signature,
      onChain: true,
      err: outcome.err,
      errorCode: row.errorCode ?? null,
      slot: outcome.slot,
    });
  }
  return rows;
}

/* --------------------------------------------------------- the accounting */

/** A vault's balance, read from chain. Zero for an account that never existed. */
export async function vaultBalance(client, vault) {
  const snapshot = await snapshotBalances(client, [vault]);
  return snapshot.get(vault);
}

/* ------------------------------------------------------ the verification */

/**
 * Everything, checked. Returns the recovered record; throws on any failure.
 *
 * `sources` is injected so the tests can drive the whole verification without
 * a chain — and so that nothing in this file ever constructs a client that
 * could do more than read.
 */
export async function recover({ diagnostic, client, chainSource, expectedCommit, indexer }) {
  const findings = [];
  const note = (ok, name, detail = "") => {
    step(ok, name, detail);
    findings.push({ check: name, pass: ok, detail: detail || null });
  };

  /* 1-6. The cluster, the program, and the governance that holds it. */
  log("\nPhase R1 — cluster, deployment and custody governance");
  // `preflight` is the harness's own read-only deployment proof, reused rather
  // than reimplemented: genesis hash, program identity, ProgramData, the
  // deployed binary hash, the upgrade authority, and RR-7's live Squads decode
  // against the recorded policy. A second implementation of these checks could
  // disagree with the one a live run uses, and then neither would be evidence.
  const facts = await preflight(client, {});
  note(true, "cluster genesis hash is devnet", facts.genesis);
  note(true, "ppv_escrow is deployed, executable and loader-owned", facts.programId);
  note(true, "ProgramData resolves to the recorded account", facts.programDataAddress);
  note(true, "deployed bytes are the reviewed binary", facts.binaryHash);
  note(true, "upgrade authority is the custody vault", facts.upgradeAuthority);
  if (facts.squads.threshold !== 2 || facts.squads.members.length !== 3) {
    throw new CustodyDefect(
      `live custody governance is ${facts.squads.threshold}-of-${facts.squads.members.length}, not 2-of-3`,
    );
  }
  note(
    true,
    `live Squads custody governance is ${facts.squads.threshold}-of-${facts.squads.members.length}`,
    facts.squads.vaultDerived,
  );

  /* 7. The commit the run actually executed. */
  if (expectedCommit && diagnostic.repositoryCommit !== expectedCommit) {
    throw new CustodyHarnessFailure(
      `the diagnostic names commit ${diagnostic.repositoryCommit}, recovery expected ${expectedCommit}`,
    );
  }
  note(true, "run commit matches the commit under recovery", diagnostic.repositoryCommit);

  /* 8-12. Signatures, states and balances, from chain. */
  log("\nPhase R2 — transactions, terminal states and vault balances");
  const missing = PRIMARY_SCENARIOS.filter((key) => !diagnostic.scenarios?.[key]);
  if (missing.length > 0) {
    throw new CustodyHarnessFailure(
      `the run did not complete every primary scenario; missing: ${missing.join(", ")}. RR-6 cannot close ` +
        "on a partial matrix.",
    );
  }

  const scenarios = {};
  let primaryVaultTotal = 0n;
  for (const key of PRIMARY_SCENARIOS) {
    const recorded = diagnostic.scenarios[key];
    const live = await readAgreement({ client }, new PublicKey(recorded.agreement));
    if (!live) throw new CustodyDefect(`${key}: agreement ${recorded.agreement} has no account on chain`);

    // The diagnostic's state is a claim; the account's is the fact.
    if (live.state !== recorded.finalState) {
      throw new CustodyDefect(
        `${key}: the run recorded final state ${recorded.finalState}, the live account is ${live.state}`,
      );
    }
    if (!TERMINAL_STATES.includes(live.state)) {
      throw new CustodyDefect(`${key}: the agreement rests in ${live.state}, which is not terminal`);
    }
    // The vault address is re-derived rather than taken from the record.
    const derived = deriveVault(new PublicKey(recorded.agreement))[0].toBase58();
    if (live.vault !== derived) {
      throw new CustodyDefect(`${key}: the program records vault ${live.vault}, the client derives ${derived}`);
    }
    const balance = await vaultBalance(client, derived);
    if (balance !== 0n) {
      throw new CustodyDefect(`${key}: vault ${derived} still holds ${balance} units after a terminal state`);
    }
    primaryVaultTotal += balance;

    const successes = await verifySuccesses(client, recorded.signatures ?? []);
    scenarios[key] = {
      agreement: recorded.agreement,
      vault: derived,
      liveState: live.state,
      amount: String(live.amount),
      settledTotal: String(live.settledTotal),
      finalVaultBalance: "0",
      signatures: successes,
    };
    note(true, `${key}: ${successes.length} signatures on chain, state ${live.state}, vault 0`);
  }

  const refusals = await verifyRefusals(client, diagnostic.negatives ?? []);
  note(true, `${refusals.length} expected refusals landed on chain carrying an error`);

  /* 12. The disposable fixtures, and what they are allowed to be. */
  log("\nPhase R3 — disposable fixtures");
  const fixtures = [];
  let fixtureTotal = 0n;
  for (const fixture of diagnostic.unfinishedFixtures ?? []) {
    const live = await readAgreement({ client }, new PublicKey(fixture.agreement));
    const derived = deriveVault(new PublicKey(fixture.agreement))[0].toBase58();
    const balance = await vaultBalance(client, derived);
    fixtureTotal += balance;
    if (balance !== 0n) {
      throw new CustodyDefect(
        `${fixture.label}: disposable fixture vault ${derived} holds ${balance} units; this is stranded value ` +
          "and recovery must not report a pass",
      );
    }
    fixtures.push({
      label: fixture.label,
      agreement: fixture.agreement,
      vault: derived,
      liveState: live?.state ?? null,
      vaultBalance: "0",
      funded: false,
      disposition:
        "Aborted disposable devnet fixture. Its vault balance is 0, so it holds no customer or economic " +
        "value. Its signer was generated in memory for the run and destroyed with the failed process, so " +
        "it may rest in a non-terminal state permanently. No signer was reconstructed and no recovery " +
        "transaction was attempted.",
    });
    note(true, `${fixture.label}: vault 0, state ${live?.state ?? "absent"}, aborted disposable fixture`);
  }

  /* 13-19. The histories, rebuilt through the published indexer. */
  log("\nPhase R4 — history reconstruction through @gwap/ppv-indexer");
  const { replayAgreement, ReceiptStore } = indexer;
  const reconstruction = {};
  const bindings = new Map();
  for (const key of PRIMARY_SCENARIOS) {
    const scenario = scenarios[key];
    const replay = await replayAgreement(chainSource, scenario.agreement, {
      programId: ESCROW_PROGRAM_ID.toBase58(),
    });

    for (const envelope of replay.events) {
      if (envelope.programId !== ESCROW_PROGRAM_ID.toBase58()) {
        throw new CustodyDefect(
          `${key}: an event was attributed to program id ${envelope.programId ?? "undefined"}`,
        );
      }
      if (typeof envelope.transactionSignature !== "string" || envelope.transactionSignature === "") {
        throw new CustodyDefect(`${key}: an event carries no transaction signature`);
      }
    }

    if (replay.lifecycle.state !== scenario.liveState) {
      throw new CustodyDefect(
        `${key}: the reconstruction projects ${replay.lifecycle.state}, the live account says ${scenario.liveState}`,
      );
    }

    const doubled = new ReceiptStore();
    doubled.addEvents(replay.events);
    if (doubled.addEvents(replay.events) !== 0) {
      throw new CustodyDefect(`${key}: re-delivering the same events added receipts; delivery must be idempotent`);
    }
    const reversed = new ReceiptStore();
    reversed.addEvents([...replay.events].reverse());
    if (reversed.projectAgreement(scenario.agreement).state !== replay.lifecycle.state) {
      throw new CustodyDefect(`${key}: reversed delivery reconstructs a different state`);
    }
    if (doubled.projectAgreement(scenario.agreement).state !== replay.lifecycle.state) {
      throw new CustodyDefect(`${key}: duplicate delivery changed the projected state`);
    }

    const settled = replay.lifecycle.settledAmount ?? 0n;
    const refunded = replay.lifecycle.refundedAmount ?? 0n;
    if ((settled + refunded).toString() !== scenario.settledTotal) {
      throw new CustodyDefect(
        `${key}: the events account for ${settled + refunded} paid out, the agreement records ${scenario.settledTotal}`,
      );
    }

    reconstruction[key] = {
      agreement: scenario.agreement,
      events: replay.events.length,
      eventNames: replay.events.map((event) => event.event.name),
      transactionsScanned: replay.transactionsScanned,
      failedTransactionsSkipped: replay.failedTransactionsSkipped,
      projectedState: replay.lifecycle.state,
      liveState: scenario.liveState,
      projectionAgreesWithChain: true,
      duplicateDeliveryIdempotent: true,
      reversedDeliveryConverges: true,
      settledAmount: settled.toString(),
      refundedAmount: refunded.toString(),
      milestones: replay.lifecycle.milestones.length,
      proofs: replay.lifecycle.proofs.length,
      // The escrow-side Proof PDAs, which is what `ProofRecord.proof` means.
      // Kept for the record; NOT the addresses Phase R5 asks ppv_core about.
      proofAddresses: replay.lifecycle.proofs.map((record) => record.proof),
    };
    collectProofBindings(bindings, key, replay.events);
    note(true, `${key}: ${replay.events.length} events reconstruct ${replay.lifecycle.state}`);
  }

  if (reconstruction.milestones.milestones === 0) {
    throw new CustodyDefect("milestones: the reconstruction recovered no milestone history");
  }
  if (reconstruction.proofs.proofs === 0) {
    throw new CustodyDefect("proofs: the reconstruction recovered no proof history");
  }
  note(true, "milestone history reconstructs", `${reconstruction.milestones.milestones} milestones`);
  note(true, "proof history reconstructs", `${reconstruction.proofs.proofs} proofs`);

  /* 20. The escrow proof, the ppv_core record it minted, and the link. */
  log("\nPhase R5 — proof bindings, and the records under the permanent ppv_core");
  const proofBindings = await verifyProofBindings(client, bindings);
  note(
    true,
    `${proofBindings.length} escrow proofs bind to ppv_core records`,
    `${ESCROW_PROGRAM_ID.toBase58()} -> ${CORE_PROGRAM_ID.toBase58()}`,
  );

  /* The accounting, stated as totals. */
  const totals = {
    PRIMARY_SCENARIO_VAULT_TOTAL: primaryVaultTotal.toString(),
    FIXTURE_VAULT_TOTAL: fixtureTotal.toString(),
    TOTAL_RUN_PPV_VAULT_BALANCE: (primaryVaultTotal + fixtureTotal).toString(),
  };
  if (primaryVaultTotal !== 0n || fixtureTotal !== 0n) {
    throw new CustodyDefect(`recovery found a nonzero vault total: ${JSON.stringify(totals)}`);
  }

  const families = Object.fromEntries(
    Object.entries(RR6_FAMILIES).map(([family, key]) => [family, Boolean(reconstruction[key])]),
  );
  const rr6 = Object.values(families).every(Boolean);

  return {
    findings,
    facts,
    scenarios,
    refusals,
    fixtures,
    reconstruction,
    proofBindings,
    totals,
    families,
    rr6,
    multisig: { threshold: facts.squads.threshold, members: facts.squads.members.length },
  };
}

/* -------------------------------------------------- the proof bindings */

/** The escrow events that name both sides of the relationship. */
const PROOF_EVENTS = Object.freeze(["ProofSubmitted", "ProofApproved", "ProofRejected"]);

/**
 * The escrow proof -> ppv_core record mapping, taken from the events themselves.
 *
 * Recovery run 35474019085 passed R1-R4 and then failed here with
 *
 *     proof record CkQ2svTDYnKftVG36Ds12zfBwngakmAooLKro9QPKnLo
 *     is owned by ppv_escrow instead of ppv_core
 *
 * which was the verifier asking the right question of the wrong account.
 * `AgreementLifecycle.proofs[].proof` is the ESCROW-side Proof PDA, and it is
 * supposed to be owned by `ppv_escrow`; the record under `ppv_core` is a
 * different address, and the escrow events publish it directly as `coreProof`
 * — "the ppv_core ProofRecord minted by the same instruction", in
 * `sdk/src/escrow/events.ts`'s own words.
 *
 * So the relationship is read off the envelopes rather than guessed from one
 * half of it. `ProofSubmitted` establishes a binding; a later `ProofApproved`
 * or `ProofRejected` for the same proof must agree with it, and a disagreement
 * is a finding rather than a last-writer-wins overwrite. Duplicate deliveries
 * of the same event are harmless because they carry the same pair.
 */
export function collectProofBindings(bindings, scenario, envelopes) {
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (!PROOF_EVENTS.includes(event.name)) continue;

    if (!event.proof) {
      throw new CustodyDefect(`${scenario}: a ${event.name} event names no escrow proof account`);
    }
    if (!event.coreProof) {
      throw new CustodyDefect(`${scenario}: ${event.name} for proof ${event.proof} names no coreProof`);
    }

    const existing = bindings.get(event.proof);
    if (!existing) {
      if (event.name !== "ProofSubmitted") {
        // A decision without the submission that created the binding: the
        // history is incomplete, and guessing the pair from one event would
        // be inventing the relationship this check exists to prove.
        bindings.set(event.proof, {
          scenario,
          proof: event.proof,
          coreProof: event.coreProof,
          proofIndex: event.proofIndex ?? null,
          submitted: false,
          decisions: [event.name],
        });
        continue;
      }
      bindings.set(event.proof, {
        scenario,
        proof: event.proof,
        coreProof: event.coreProof,
        proofIndex: event.proofIndex ?? null,
        submitted: true,
        decisions: [],
      });
      continue;
    }

    if (existing.coreProof !== event.coreProof) {
      throw new CustodyDefect(
        `${scenario}: escrow proof ${event.proof} is bound to ppv_core record ${existing.coreProof} by ` +
          `one event and to ${event.coreProof} by ${event.name}; one escrow proof mints exactly one ` +
          "ppv_core record",
      );
    }
    if (event.name === "ProofSubmitted") existing.submitted = true;
    else if (!existing.decisions.includes(event.name)) existing.decisions.push(event.name);
  }
  return bindings;
}

/**
 * Each binding, proved against chain state rather than taken from the events.
 *
 * Four independent facts per proof, plus the one that ties them together:
 *
 *   A. the escrow Proof account exists;
 *   B. it is owned by the permanent `ppv_escrow`;
 *   C. the `coreProof` account exists;
 *   D. it is owned by the permanent `ppv_core`;
 *   E. the escrow account's OWN stored `coreProof` field equals the one the
 *      event published.
 *
 * (E) is what makes this more than two ownership lookups. The event is a claim
 * about a relationship; the escrow account's `core_proof` field is the program's
 * own record of it. An event that named someone else's ppv_core record would
 * pass A-D and fail here.
 */
export async function verifyProofBindings(client, bindings) {
  const rows = [...bindings.values()];
  if (rows.length === 0) {
    throw new CustodyDefect(
      "no reconstructed history bound an escrow proof to a ppv_core record, so the ppv_escrow -> " +
        "ppv_core CPI cannot be verified; this check must not pass vacuously",
    );
  }

  const escrowOwner = ESCROW_PROGRAM_ID.toBase58();
  const coreOwner = CORE_PROGRAM_ID.toBase58();
  const verified = [];

  for (const row of rows) {
    if (row.proof === row.coreProof) {
      throw new CustodyDefect(
        `${row.scenario}: escrow proof ${row.proof} names itself as its ppv_core record; recovery must ` +
          "never substitute one for the other",
      );
    }
    if (!row.submitted) {
      throw new CustodyDefect(
        `${row.scenario}: escrow proof ${row.proof} was decided by ${row.decisions.join(", ")} but no ` +
          "ProofSubmitted event established its ppv_core binding",
      );
    }

    // A / B — the escrow side.
    const escrow = await client.accountInfo(row.proof);
    if (!escrow) {
      throw new CustodyDefect(`${row.scenario}: escrow proof account ${row.proof} does not exist on chain`);
    }
    if (escrow.owner !== escrowOwner) {
      throw new CustodyDefect(
        `${row.scenario}: escrow proof ${row.proof} is owned by ${escrow.owner}, not the permanent ` +
          `ppv_escrow ${escrowOwner}`,
      );
    }

    // E — the program's own record of the relationship.
    const { decodeProofAccount } = await import("@gwap/ppv-sdk");
    const decoded = decodeProofAccount(Buffer.from(escrow.data[0], "base64"));
    if (decoded.coreProof !== row.coreProof) {
      throw new CustodyDefect(
        `${row.scenario}: escrow proof ${row.proof} stores ppv_core record ${decoded.coreProof}, but its ` +
          `events published ${row.coreProof}`,
      );
    }

    // C / D — the ppv_core side.
    const core = await client.accountInfo(row.coreProof);
    if (!core) {
      throw new CustodyDefect(
        `${row.scenario}: ppv_core record ${row.coreProof}, minted for escrow proof ${row.proof}, does ` +
          "not exist on chain",
      );
    }
    if (core.owner !== coreOwner) {
      throw new CustodyDefect(
        `${row.scenario}: ppv_core record ${row.coreProof} is owned by ${core.owner}, not the permanent ` +
          `ppv_core ${coreOwner}`,
      );
    }

    verified.push({
      scenario: row.scenario,
      proof: row.proof,
      coreProof: row.coreProof,
      proofIndex: row.proofIndex,
      escrowOwner: escrow.owner,
      coreOwner: core.owner,
      storedCoreProofMatchesEvent: true,
      decisions: row.decisions,
    });
  }

  return verified;
}

/* ----------------------------------------------------- the public record */

export function buildRecoveredEvidence(result, { diagnostic, generatedAt = new Date().toISOString() }) {
  const record = {
    artifact: "ppv-escrow-devnet-live-custody-validation",
    schemaVersion: 1,
    note:
      "Custody behaviour was executed during the source workflow run. This record was produced later, " +
      "read-only, from public chain state. No transaction was sent during recovery.",
    sourceWorkflowRun: String(diagnostic.workflowRunId),
    sourceCommit: diagnostic.repositoryCommit,
    sourceHarnessRunId: diagnostic.harnessRunId ?? null,
    recoveryMode: "READ_ONLY",
    recoveryHarnessVersion: HARNESS_VERSION,
    originalFailureClassification: diagnostic.classification,
    originalFailure: diagnostic.failedAt,
    liveMatrixExecuted: true,
    liveMatrixRepeated: false,
    valueMovingTransactionsSentDuringRecovery: 0,
    historyReconstruction: "PASS",
    cluster: "devnet",
    genesisHash: result.facts.genesis,
    program: {
      name: "ppv_escrow",
      programId: result.facts.programId,
      programDataAddress: result.facts.programDataAddress,
      programOwner: result.facts.programOwner,
      upgradeAuthority: result.facts.upgradeAuthority,
      liveBinaryHash: result.facts.binaryHash,
      releaseCommit: result.facts.releaseCommit,
      canonicalEvidence: EXPECTED.evidencePath,
      canonicalEvidenceSha256: EXPECTED.evidenceSha256,
    },
    custodyGovernance: result.facts.squads,
    scenarios: result.scenarios,
    expectedFailures: result.refusals,
    abortedDisposableFixtures: result.fixtures,
    reconstruction: result.reconstruction,
    proofBindings: result.proofBindings,
    accounting: { ...result.totals, finalVaultTotal: "0" },
    lifecycleFamilies: result.families,
    gates: {
      "RR-6": result.rr6 ? "CLOSED" : "OPEN",
      "RR-13": "OPEN",
      legalReview: "OPEN",
      custodyGate: "CLOSED",
      mainnetAuthorized: false,
    },
    generatedAt,
  };
  return assertNoSecrets(record);
}

/* ------------------------------------------------------------------ main */

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const endpoint = process.env.PPV_CUSTODY_RPC_URL;
  if (!endpoint) {
    log("::error::DEDICATED_DEVNET_RPC=MISSING");
    throw new CustodyHarnessFailure(
      "PPV_CUSTODY_RPC_URL is required. Recovery reads a great many transactions and there is " +
        "deliberately no public-endpoint fallback.",
    );
  }
  registerSensitiveEndpoint(endpoint);

  const diagnostic = readDiagnostic(args.diagnostic);
  log(`Recovering workflow run ${diagnostic.workflowRunId} at commit ${diagnostic.repositoryCommit}`);
  log(`Original failure: ${diagnostic.classification}`);
  log("Recovery is READ-ONLY. No transaction will be sent.\n");

  const client = rpc(endpoint);
  await requireDevnet(client);
  const indexer = await import("@gwap/ppv-indexer");
  const chainSource = indexer.httpChainSource(endpoint);

  const result = await recover({
    diagnostic,
    client,
    chainSource,
    indexer,
    expectedCommit: args.commit,
  });

  log("\nAccounting");
  for (const [name, value] of Object.entries(result.totals)) step(value === "0", `${name}=${value}`);

  if (!result.rr6) {
    const open = Object.entries(result.families)
      .filter(([, ok]) => !ok)
      .map(([family]) => family);
    throw new CustodyHarnessFailure(`RR-6 cannot close: these families were not reconstructed: ${open.join(", ")}`);
  }

  if (args.out) {
    const record = buildRecoveredEvidence(result, { diagnostic });
    const path = join(REPO, args.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    log(`\nRECOVERY=PASS  wrote ${args.out}`);
  } else {
    log("\nRECOVERY=PASS  (no --out given; nothing written)");
  }
  return result;
}

if (process.argv[1] && process.argv[1].endsWith("recover-devnet-escrow-custody-evidence.mjs")) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      process.stderr.write(`\nRECOVERY=FAIL  ${redact(error?.message ?? String(error))}\n`);
      process.exit(1);
    });
}
