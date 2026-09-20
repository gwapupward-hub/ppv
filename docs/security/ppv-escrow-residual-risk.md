# PPV Escrow residual-risk register

**Readiness verdict: PPV ESCROW DEVNET DEPLOYMENT READINESS: GO** (Sprint 3.1).
**RR-11** and **RR-12** were closed in Sprint 4 by the custody ceremony and the
identity freeze. **RR-13** (no independent security review) is untouched and
still blocks the custody gate, and **RR-4** (Escrow has no binding to Commerce)
is unchanged — there is no on-chain Commerce↔Escrow binding today.

**RR-1** and **RR-8**, the two entries that blocked Sprint 3's verdict, are
CLOSED with the evidence recorded below. Nothing else changed severity. See
[ppv-escrow-readiness-verdict.md](ppv-escrow-readiness-verdict.md) for the full
verdict and its statements of record — including what a GO does and does not
authorise.

What Sprint 3 did not resolve, classified honestly. Every entry here is
referenced from the [attack matrix](ppv-escrow-attack-matrix.md), so a risk
cannot exist in one document and not the other.

## Current state — `ppv_escrow` on devnet

Read this before anything else on this page. Anything elsewhere in this
document that describes `ppv_escrow` as undeployed, or its custody vault as an
*intended future* authority, is **historical** — true when it was written,
false now, and kept only so the sequence of events stays legible.

| | |
| --- | --- |
| Escrow deployed | YES — devnet, 2026-09-15 |
| Program ID | `7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4` |
| ProgramData | `2bWfopyJ8LxJ6azd9ZhaGmfs9S2gGRQKx6TX88ddULAa` |
| Upgrade authority | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` (custody vault) |
| Authority transfer | FINALIZED |
| Deployment provenance | CLOSED — `deployments/evidence/ppv-escrow-devnet-231dceb.json` |
| Live devnet read-only preflight | PASS — https://github.com/gwapupward-hub/ppv/actions/runs/35053809296 |
| RR-6 event/history reconstruction | CLOSED — reconstructed live from chain, run 35465469908 via recovery 35481530878 |
| RR-7 live Squads decode | CLOSED for the custody multisig; OPEN for Core/Commerce |
| Live devnet custody validation | PASS — custody run 35465469908, reconstructed read-only by recovery run 35481530878; `deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json` |
| Independent security review (RR-13) | OPEN |
| Legal review | OPEN |
| **Custody gate** | **CLOSED** |
| Mainnet authorized | NO |

Deployed and provenance-closed is not custody-verified. The deployment proved
that the reviewed bytes are the bytes the loader holds and that the dedicated
custody vault holds the upgrade authority. It proved nothing about how the
program behaves with real tokens in it. The gate stays closed.

**Classification rule.** A risk is CRITICAL or HIGH if a path to it ends with
value moving to someone not entitled to it, value moving twice, or value that
cannot be recovered. It is MEDIUM or LOW if it ends with a weaker claim than
the repository makes — coverage that does not exist, evidence that is asserted
rather than read — without a known path to any of those outcomes. Severity is
about what an attacker can do, not about how much work the fix is.

## CRITICAL

**None.**

## HIGH affecting custody correctness

**None.**

Two custody findings were opened and closed inside this sprint. They are
recorded in the attack matrix as S-9/B-5 and C-3 rather than here, because they
are fixed, regression-tested and mutation-qualified:

- An unclaimed bounty could be disputed into a state with no exit, whose only
  reachable "resolution" sent custody to a token account owned by the default
  address. Only the sponsor could reach it, with its own money, and it was
  still a way for the vault to lose custody with no recovery.
- `record_payout` wrote its running total before validating it. Anchor unwinds
  the account on a returned error, so it was not exploitable as the program
  stood; it is recorded as the defect it was rather than the vulnerability it
  was not.

## MEDIUM

RR-1 and RR-8 are recorded here in place, marked CLOSED, rather than removed:
the identifiers are cited from the attack matrix and from two sprint verdicts,
and an entry that vanishes is indistinguishable from one nobody wrote down.

### RR-1 — Milestones and bounties are not randomly attacked — **CLOSED**

*Closed in Sprint 3.1.* Milestone contracts and bounties are now attacked by the
randomized model-based suite, not only by deterministic tests and the exhaustive
host model. A sequence carries an agreement flavour, and six action kinds joined
the model: `createMilestone`, `submitMilestone`, `approveMilestone`,
`rejectMilestone`, `settleMilestone`, `selectWinner`.

The release-tier run that closed it, 5 seeds × 200 sequences:

```json
{"attempted":17607,"succeeded":3532,"refused":14075,"refusedNonCanonical":4856,
 "escrowSequences":362,"milestoneSequences":315,"bountySequences":323,
 "milestoneActions":4998,"milestonesScheduled":576,"milestoneReleases":169,
 "milestoneDuplicateReleaseAttempts":348,"milestoneForeignAccountAttempts":362,
 "milestonePostTerminalAttempts":1185,
 "bountyActions":5577,"winnerSelections":306,"winnerReplacementAttempts":1081,
 "bountyPayouts":93,"bountyUnassignedPayoutAttempts":144}
```

Zero invariant violations.

**It did not close on the first try, and the reasons are worth keeping.** The
first run failed its own coverage floor — tranches scheduled, none released —
because reaching a release needs six ordered actions and the expected sequence
length to get there was about 47 against a budget of 32. Reachable in principle,
unreachable in practice, which is the fictional coverage this entry was about.
Three generator defects were behind it: the agreement's own second tranche
shared the *foreign* account's one-in-twelve weight, tranches were always
released in the same order, and `fc.nat` biased prefix lengths toward "barely
started".

Coverage floors now make this a gate rather than a claim: an action kind that
exists in the generator and is never selected fails the run, in the suite and in
the cross-seed aggregator.
`tests/invariants/reachability.test.ts` asserts the same reachability against
the model alone in milliseconds, so a generator change that closes a window
fails locally rather than after forty minutes of CI.

*What remains:* the randomized suite attacks one agreement per sequence, so
interactions *between* two live agreements of different types are still covered
only by the cross-agreement isolation tests. No path to one is known — every
instruction re-derives its accounts from the agreement it names — and it is not
tracked as a separate risk because PPV-P9 covers the substitution directly.

### RR-2 — Milestone state does not mean what a reader assumes

Two things about milestone contracts are true, deliberate, and not what someone
reading tranche state would guess.

**Release order is unconstrained.** A buyer can approve and release tranche 2
before tranche 1. Each tranche has its own submission and its own approval, and
nothing sequences them.

**A settled contract may have every tranche unreleased.** `resolve_dispute`
pays the whole remaining balance and terminates the agreement whatever the
tranche bookkeeping says, so a contract conceded by its buyer ends `Settled`
with both tranches `Pending`. The same is true of `refund`, which returns the
tranches nobody earned.

*Why neither is a defect:* no invariant is broken. `PPV-M1` and `PPV-M2` bound
the totals, `PPV-M3` bounds each tranche to one release, every release needs the
buyer's approval, and a terminal agreement can never release another tranche
because `require_milestone_active` demands `Funded`. Custody conserves in every
case.

*Evidence, since Sprint 3.1:* the randomized suite now releases tranches in a
generated order rather than always smallest-last, and the concession path is
pinned as a deterministic regression in
`tests/invariants/regression/milestone-dispute-settlement.ts` alongside its
converse. Neither produced a violation.

*Why it is listed:* "milestone 2 was never released" does not mean the money is
still there, and "milestone 3 was paid" does not imply 1 and 2 were. Anyone
integrating against milestones needs both facts.

### RR-3 — Donated surplus is stranded

Anyone can transfer tokens into an agreement's vault address. Payout paths move
`remaining()`, which is derived from `amount` and `settled_total`, so a
donation is never paid out and never returned.

*Why it is not HIGH:* the surplus was never the protocol's, no party's escrowed
funds are affected, and the alternative is worse — sweeping the vault at
settlement would let one lamport of donation, timed between two instructions,
change what a settlement pays. This is recorded as a deliberate trade in
[security-model.md](../security-model.md) and predates this sprint.

*What would close it:* an explicit recovery instruction, which has to be
designed rather than added, because it is a second way for money to leave a
vault.

### RR-4 — Escrow has no binding to Commerce

`ppv_escrow` does not reference `ppv_commerce` anywhere. It carries its own
parties and its own `terms_hash`, and its only cross-program dependency is the
proof CPI into `ppv_core`.

The `PPV-X1`, `PPV-X2` and `PPV-X3` invariants — agreement binding, party
binding, terms binding — therefore describe a relationship that does not exist
in this implementation, and are marked NOT APPLICABLE rather than passing.

*Why it is not a vulnerability:* "Escrow cannot be tricked into moving assets
for a different logical agreement" holds trivially, because escrow has no
concept of an upstream agreement to confuse. A client that wants an escrow to
correspond to a Commerce agreement does that by putting the same `terms_hash`
in both, which is checkable off chain and enforced by neither program.

*Why it matters:* it is a design gap, not a bug, and it should be a deliberate
decision rather than something discovered during a deployment sprint. If
on-chain binding is wanted, it is a protocol change with its own review.

### RR-5 — True concurrency is not simulated

Adversarial orderings are tested by executing both serialisations. Two
transactions landing in the same slot are not simulated.

*Why it is not HIGH:* Solana serialises writes to the same account, and every
value-moving instruction here takes the agreement account as writable. Two
racing payouts cannot both execute against the same pre-state.

*What would close it:* nothing available in a local-validator harness; this is
a property of the runtime rather than of the program.

### RR-6 — Reconstruction proven for every lifecycle family (CLOSED)

`escrow.ts` reconstructs agreement and proof history from chain data.
Milestone, refund, dispute and bounty histories are emitted as events and
decoded by the SDK, but no test rebuilds a complete projection from them and
compares it to chain state.

*Why it is not HIGH:* this is an observability claim, not a custody one. A
reconstruction gap cannot move money; it can mislead whoever reads the index.

*Progress, not closure (this sprint).* `scripts/devnet-escrow-custody.mjs`
reconstructs each lifecycle family — ordinary escrow, cancellation, refund,
dispute to either party, milestone contract, bounty and proofs — from devnet
transactions through the indexer's `replayAgreement`, and compares the projected
state against the live account rather than against what the harness remembers
doing. It also asserts duplicate-delivery idempotence and reversed-delivery
convergence per family, and that the events' own accounting of what was paid out
equals the agreement's `settled_total`.

**RR-6 is CLOSED.** Run
[35465469908](https://github.com/gwapupward-hub/ppv/actions/runs/35465469908)
executed the live custody matrix; it stopped in the read-only reconstruction
phase on an RPC rate limit, and recovery run
[35481530878](https://github.com/gwapupward-hub/ppv/actions/runs/35481530878)
reconstructed that exact run from public chain state without sending a
transaction.

All nine lifecycle families reconstruct — funding, settlement, cancellation,
refund, dispute to either party, milestone release, bounty selection and proof
approval. Every projection was compared against the live account rather than
against what the harness remembered doing, duplicate-delivery idempotence and
reversed-delivery convergence hold per family, and the events' own accounting of
what was paid out equals each agreement's `settled_total`.

The standard that was set here was met, not lowered: decoding cleanly was
explicitly not sufficient, and what closed this entry is complete projection
agreeing with chain state. The evidence is
`deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json`
(`sha256:c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c`);
`deployments/validation/README.md` records its provenance and the earlier
attempts.

Closing RR-6 does not open the custody gate and does not substitute for RR-13 or
legal review, both of which remain OPEN.

### RR-7 — The Squads threshold is declared, not read from chain — **CLOSED for the Escrow custody multisig; NARROWED to Core/Commerce governance**

Verification proves the upgrade authority is the recorded vault address and is
off-curve (so it is a PDA rather than a wallet). It does not read the Squads
multisig account to confirm the threshold is 2, or who the members are. The
threshold and member list come from the deployment environment and are checked
against policy — at least 2, enough distinct members, no duplicates, and the
vault is not its own member, the last two added this sprint.

*Why it is not HIGH for Escrow specifically:* the custody vault
`FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` is now the live upgrade
authority of the deployed `ppv_escrow` program, so this applies to Escrow as
well as to Core and Commerce. It stays MEDIUM because the gap is epistemic
rather than exploitable: a wrong declared threshold does not let anyone move
custody, it lets the repository overstate how hard an upgrade is to push. No
value is escrowed on devnet outside disposable test material, and mainnet is
not authorized.

*Historical note.* This entry previously read "Escrow is not deployed and has
no upgrade authority yet." True until 2026-09-15; false now.

*What would close it:* deriving and decoding the Squads multisig account from
live chain state — the threshold, the exact member set, and each member's
permission mask — rather than accepting them as deployment-environment inputs.
Attempted in Sprint 1 against two candidate program ids without a match; not
guessed at since.

*Closed for Escrow, with evidence.* `scripts/lib/squads.mjs` decodes the Squads
V4 `Multisig` account, and `scripts/verify-custody-governance.mjs --live-squads`
compares the decoded account against the declared configuration. It has been
run against the live account. From chain state, not from a declaration:

| | read from `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46` |
| --- | --- |
| Squads program | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Threshold | 2 |
| Members | exactly 3: `HDkMBufpYfm1LN6apVkeV3aA2dhMk57PmBujwJ4j4Ecx`, `5y12g4GKbba3k6WDUyZT8eUfeBdboxxGrjkdjM4kX2Wo`, `BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ` |
| Permissions | mask 7 (Initiate + Vote + Execute) for each |
| Vault index 0 | derives to `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Time lock | 0 |
| Shared signers with Core/Commerce governance | exactly 1 (the approved devnet exception) |

Evidence: https://github.com/gwapupward-hub/ppv/actions/runs/35053809296 — the verifier printed `squads_live_decode=read-from-chain`, and
the same run read `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` out of
`ppv_escrow`'s ProgramData as its live upgrade authority. The two halves of the
claim therefore come from the same reading of the same chain: the account that
holds authority over the custody program **is** the 2-of-3 this repository
records. `verify-escrow-custody-preflight.yml` re-establishes it on every pull
request that touches the decoder, the verifier or the evidence records, so the
answer cannot go stale without a failing check.

The decoder is hand-written so the read-only verifiers stay dependency-free, and
`scripts/test/squads-decode.test.mjs` checks it field for field against the
pinned `@sqds/multisig` 2.1.4 serializer, and asserts refusal of a wrong
threshold, a wrong member set, a wrong permission mask, a vault that does not
derive, a vault at the wrong index, an account under another program's
ownership, and a truncated account.

*What this does not close.* RR-7 was never only about Escrow. The vault
governing the non-custodial programs, `B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`,
is still verified from declared facts: this repository does not record the
address of the multisig that owns it, so there is nothing to decode. That
remainder is **OPEN** and MEDIUM for the same reason the whole entry was —
a wrong declared threshold there does not let anyone move custody, it lets the
repository overstate how hard a Core or Commerce upgrade is to push.

*A finding from running it.* The first live run failed, and the failure was in
the verifier rather than in the configuration. `checkChain` required an account
to exist at the vault address, reasoning that "a vault that has never been
created cannot hold authority". A Squads V4 vault is a pure signer PDA: the BPF
loader stores an authority as a bare pubkey and Squads signs with
`invoke_signed`, so a vault nobody has funded has no account and holds authority
perfectly well. In the same run that reported "no account exists at the vault
FD2spns…", the preflight read that address out of ProgramData as the live
upgrade authority. The check has been replaced by one that is strictly stronger
and needs no network: the vault must *derive* from the multisig at the declared
index. It had never fired before because the verifier is normally run without an
RPC endpoint.

### RR-8 — The property suite is not mutation-qualified — **CLOSED**

*Closed in Sprint 3.1.* `scripts/mutation-qualify-property.sh` breaks one
defence at a time and requires **the randomized property suite** to fail. The
run is pinned to `tests/invariants/**/*.invariant.ts`, so a deterministic test
cannot be what noticed; a mutation that does not compile is reported as a broken
mutation rather than a detection; a validator that never started is not a
result; and the clean suite must be green again afterwards.

| Mutation | Class | Detected | Seed | First violation |
| --- | --- | --- | --- | --- |
| an already-settled tranche may be released again | milestone lifecycle finality (PPV-M3) | yes | 20260912 | PPV-MODEL |
| a tranche may be paid to any account of the right mint | destination binding (PPV-M4 / PPV-P4) | yes | 20260912 | PPV-MODEL |
| a tranche pays out everything the vault still owes | custody conservation (PPV-P1 / PPV-M2) | yes | 20260912 | PPV-MODEL |
| a bounty sponsor may replace the winner after naming one | bounty lifecycle finality (PPV-B1) | yes | 20260912 | PPV-MODEL |

Each records its minimized counterexample, so the evidence is a sequence rather
than an exit code.

**Two of the four survived the first run**, and the cause was the generator
rather than the assertions — the same three defects RR-1 records. Both were
then caught through the *second* tranche, which is what confirms the weight fix
was the enabler. The budget was also measured rather than guessed: at 90
sequences the generator produced a single wrong-destination window in the whole
run, so the harness runs 300.

No mutation was made easier and no assertion was weakened to close this.

*What remains:* four mutations across four classes is a sample, not a proof of
detection power in general. The classes chosen are the ones a custody defect
would fall into, and the host-model qualification covers seven more; neither is
a substitute for an independent review (RR-13).

## LOW

### RR-9 — `AgreementType::Invoice`, `Contract` and `ProofOnly` are unimplemented

`initialize_agreement` refuses them, so they cannot be created. They exist in
the enum to keep the wire format stable.

*Consequence:* none today. Listed so that adding one is understood to be a
lifecycle addition needing its own model rows, not a config change.

### RR-10 — Dispute resolution is concession-only

A dispute ends only when one party surrenders its claim. If neither concedes,
the agreement stays `Disputed` and the money stays in the vault indefinitely.
There is no arbiter, deliberately, because the protocol has not decided who may
be one.

*Consequence:* funds can be locked by mutual stubbornness. No party can take
them, and either can end it unilaterally in the other's favour at any time.

## DEFERRED

### RR-11 — A dedicated custody multisig does not exist — **CLOSED**

The custody gate requires Escrow's upgrade authority to be held by a multisig
**separate** from the non-custodial programs, so compromising one cannot reach
the other. There is one Squads 2-of-3 vault today
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), holding Core and Commerce.

*Unchanged in severity, now closeable.* Sprint 4 added
`scripts/verify-custody-governance.mjs`, which proves a proposed custody
multisig satisfies policy **before** it is given authority over anything, using
only public facts — no key material, so anyone can run it, before the ceremony
and after. It refuses a threshold of one, duplicate members, a vault on the
ed25519 curve, a vault or multisig among its own members, and the non-custodial
vault reused as the custody vault.

It also refuses **shared signers** by default. Two multisigs at different
addresses held by the same people fall to one compromise of those people, so
"separate" is a claim about people as well as addresses. The override exists and
has to be taken deliberately.

*Closed in Sprint 4.* The ceremony ran on devnet and produced a dedicated
Squads V4 2-of-3:

| | |
| --- | --- |
| Multisig | `GEE6nE9xN4GsHGo8QHvyqNLH7eM7yLBrtFtfsmH9ip46` |
| Vault (index 0) | `FD2spnsMVgsuddPSRWAe3ee4DMbgDx5ivpvVfvKcNrLE` |
| Threshold | 2-of-3 |
| Permissions | Initiate + Vote + Execute (mask 7) each |
| Creation tx | `PAr6UEy3Am4HDjZFLwWKCiG3jVMh2pE9vCfKxAq3SACyFs9wwheGCwLDRV57kE7GHZPyCJEqQBJByR1574spqR5` |

`verify-custody-governance.mjs` prints `PPV_CUSTODY_GOVERNANCE_VALID` against
it, and `ESCROW_CUSTODY_GOVERNANCE` in `scripts/lib/identity.mjs` records it as
the single source every gate reads.

**The approved exception.** One custody signer is intentionally shared with
Core/Commerce governance (`BJmFM4k7Q32CiCYSdoYkAhXdD5Sk3BegMh2cbEAsgSwJ`). The
other two custody signers are distinct. This exception is approved for **devnet
only**. The verifier still refuses this member set by default; the exception is
taken per run with `--allow-shared-signers`, never by changing the policy, and
`scripts/test/custody-governance.test.mjs` asserts both halves so it cannot
become the default. One shared key cannot reach a 2-of-3 threshold alone — that
arithmetic is what makes one overlap tolerable and a second one not.

*What this does not close:* RR-13 is untouched. The vault now holds the live
upgrade authority over the deployed `ppv_escrow` program — the transfer is
finalized and recorded in
`deployments/evidence/ppv-escrow-devnet-231dceb.json` — so this is governance
that exists, is verified, and is exercising something. It is still not a
security review, and the custody gate is closed on RR-13 and legal review, not
on governance.

*Historical note.* This paragraph previously read "the vault holds nothing.
Escrow is not deployed and no upgrade authority has been transferred to it."
True until 2026-09-15; false now.

### RR-12 — No permanent Escrow identity exists — **CLOSED**

`ppv_escrow` carries a build-only placeholder
(`7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR`), present only in
`[programs.localnet]`. All identity sources agree on this, and
`scripts/lib/identity.mjs` names escrow unreleased explicitly rather than
omitting it.

This is the safest state an unreleased identity can be in: no keypair exists, so
none can leak and no address can be occupied by accident.

*Unchanged in severity, now closeable.* `ESCROW_PERMANENT_ID` and
`ESCROW_CUSTODY_GOVERNANCE` are `null` in the identity table, and
`scripts/test/escrow-identity.test.mjs` enforces **both** states: while the id is
`null`, escrow must be unreleased everywhere and the placeholder must not appear
in any release record or deploy path; once it is set, `declare_id!`,
`Anchor.toml` (both sections), the permanent-identity table and the governance
record must all agree. A half-entered freeze cannot be committed — setting the
constant alone fails, changing `declare_id!` alone fails, and setting the
constant to the placeholder fails.

*Closed in Sprint 4.* The permanent identity is
`7U1bCHQcr8Jg6J8G69JGaAWCRtsrZB1RYx4zo1sNEVF4`. The keypair was generated
outside this repository and stored as the `PPV_ESCROW_PROGRAM_KEYPAIR`
repository secret through the approved workflow; no key material is committed,
printed or reachable from here, and only the public address appears anywhere.

The freeze is all-or-nothing and covers `ESCROW_PERMANENT_ID`, `declare_id!`,
both `Anchor.toml` sections, `PERMANENT_PROGRAM_IDS`, `UNRELEASED_PROGRAMS` and
`ESCROW_CUSTODY_GOVERNANCE`. `scripts/test/escrow-identity.test.mjs` and
`scripts/test/custody-gate.test.mjs` enforce that every source names exactly
this id, that the build-only placeholder is gone from every identity and deploy
path, and that governance exists alongside the identity — an id without
governance is a program that can be deployed and then cannot be safely governed.

*What this does not close:* having an identity is not having a deployment. The
custody gate stays closed on its remaining requirements, RR-13 among them.

### RR-13 — No independent security review

The custody gate requires an independent Solana security review of the custody
path, with all critical and high findings remediated and re-reviewed. This
sprint is a self-review. It found and fixed two custody defects, which is
evidence that the surface rewards attention, not a substitute for someone else
attacking it.
