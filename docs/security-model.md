# PPV Escrow Security Model

Every value-moving instruction is treated as hostile territory. This document
records the questions asked of each one and the attacks the suite actually runs.

## Questions asked of every instruction

| Question | Answer for `ppv_escrow` |
| --- | --- |
| Can a wrong signer execute this? | No. Each instruction pins its signer to a key stored on the agreement. |
| Can a valid signer execute it in the wrong state? | No. Each instruction pins the state it is legal from. |
| Can an attacker substitute another agreement? | No. The agreement PDA is re-derived from its own stored creator and id. |
| Can an attacker substitute another vault? | No. Vault seeds contain the agreement address, and the bump is the stored one. |
| Can an attacker substitute another mint? | No. `has_one = mint`, plus `transfer_checked` re-validating inside the token program. |
| Can settlement be redirected? | No. The destination must be owned by the stored counterparty. |
| Can funding be sourced from someone else? | No. The source must be owned by the signing buyer. |
| Can an instruction execute twice? | No. Each transition leaves a state its own precondition rejects. |
| Can a terminal state reopen? | No. No instruction accepts `Settled`. |
| Can event history disagree with state? | No. Events are emitted after the state write, in the same transaction. |
| Can an indexer be tricked into a fake receipt? | No. Receipts derive only from committed events and chain coordinates. |
| Can a caller choose which program `submit_proof` calls? | No. `Program<'info, PpvCore>` is an address check on `ppv_core::ID`, so the CPI target is not an account the client supplies. |
| Can a caller choose where the commitment is written? | No. The `proof_id` is derived from the agreement and index, and the address is re-derived and asserted before the CPI. |
| Can `ppv_escrow` sign for evidence it did not submit? | No. It signs for no PDA in the CPI. The submitter's own signature crosses the boundary, so `ppv_core` records the wallet that committed. |
| Can escrow state outlive a failed `ppv_core` call? | No. The proof account and the incremented counter are written before the CPI, and unwind with it. |

## Ordering rule

Protocol state is never written on the strength of a transfer that has not
happened. Every custody instruction runs:

```text
1. authorize  (who)      require_*()
2. gate       (state)    require_*()
3. move       (custody)  token CPI
4. verify     (custody)  reload, assert the balance delta equals `amount`
5. record     (state)    record_*()
6. emit       (event)    emit_cpi!
```

Steps 4 and 5 are what separate custody state from protocol state. A vault
holding 100 USDC does not mean an agreement is funded — anyone can transfer
tokens to a token account. Only an authorized `fund()` that actually moved
exactly `amount` sets `Funded`.

## Core revocation and settlement

PPV has exactly one proof primitive, `ppv_core::ProofRecord`, and exactly one
way to withdraw a commitment: `ppv_core::revoke_proof`, callable only by the
wallet that made it. An escrow `Proof` account is not a second commitment. It
records which agreement the evidence was offered under, who offered it, and
what the counterparty decided about it.

Two readings of that arrangement are possible, and they disagree about one
moment: a settlement citing evidence whose core commitment has since been
revoked.

**Live core validity** (the rule this protocol enforces). A proof-backed payout
is allowed only while the linked `ppv_core::ProofRecord` is `Active`. Approval
is a decision *about* a commitment, not a replacement for it, so a revoked
commitment is not evidence, however genuine the approval was.

**Escrow approval snapshot** (rejected). Approval would be an irreversible
acceptance, and a later revocation would not reach a decision already made.

The repository settles this, and it settles it for live validity. The escrow
`Proof` account is built around *not* being a second source of truth: it stores
no content hash, and `state/proof.rs` says why — "one proof primitive, one
place to revoke". A snapshot model would give the protocol the second source of
truth it deliberately refused: `ppv_core` would say revoked, the chain's
settlement record would say proof-backed, and an indexer would have to pick one.
Nothing in the design treats an escrow decision as an independent artifact; the
decision names a core record precisely because the core record is the evidence.

**Why it costs no liveness.** Citing evidence is optional in both settlement
paths, by design — a plain escrow settles on the parties' own signatures, and
requiring a proof would fold approval into custody. So a revocation removes a
*justification*, never a payment:

| Path | If the cited commitment is revoked |
| --- | --- |
| `settle` (escrow, bounty) | Refused while cited. The same signer settles with no citation, or cites other approved evidence, and is paid `remaining()` in full. |
| `settle_milestone` | Refused while cited. The tranche is released uncited; the milestone's own submit/approve lifecycle is independent of proofs. |
| Repeated tranche payouts | Each tranche is a separate citation. One revoked commitment blocks the citations naming it, not the schedule. |
| `resolve_dispute`, `refund` | Unaffected — neither cites evidence. |

This is what makes the rule safe to state absolutely. Only the submitter can
revoke, so the worst either party can do is withdraw its *own* evidence; and
because the payout does not depend on the citation, withdrawing it cannot hold
the vault hostage. There is no unilateral griefing path, and no custody
deadlock is introduced in exchange for the integrity guarantee.

**What is given up.** A settlement made after a revocation records
`settlement_proof = Pubkey::default()` rather than a citation. That is the
intended outcome: the chain declines to record a payment as proof-backed when
the proof no longer stands, and the loss is to the record's richness, never to
custody.

Enforced at the custody boundary, not by clients: `settle` and
`settle_milestone` both take the cited evidence's `ppv_core::ProofRecord`,
require it both-or-neither with the citation, check its owner, discriminator,
recorded address, derived address and authority, and refuse the settlement
unless its status is `Active`. See `instructions/settlement_proof.rs`,
`Proof::require_live_core_commitment`, and invariant 12l.

## Attack matrix

Run by `tests/escrow.ts` against a local validator, plus the pure state-machine
cases in `programs/ppv_escrow/src/state/agreement.rs`.

| Attempt | Expected | Covered |
| --- | --- | --- |
| Initialize a valid agreement | PASS | ✓ |
| Duplicate the same creator + agreement id | FAIL | ✓ |
| Same agreement id under a different creator | PASS | ✓ |
| Initialize with the creator as counterparty | FAIL | ✓ |
| Initialize with a zero counterparty, amount, or terms hash | FAIL | ✓ |
| Initialize an unimplemented agreement type | FAIL | ✓ |
| Fund a valid `Open` agreement | PASS | ✓ |
| Fund as the seller or an outsider | FAIL | ✓ |
| Fund twice | FAIL | ✓ |
| Fund with a substituted mint | FAIL | ✓ |
| Fund into another agreement's vault | FAIL | ✓ |
| Fund into an attacker-owned token account posing as the vault | FAIL | ✓ |
| Fund from a source the buyer does not own | FAIL | ✓ |
| Donate tokens directly to a vault and claim it is funded | FAIL | ✓ |
| Complete before funding | FAIL | ✓ |
| Complete as the buyer or an outsider | FAIL | ✓ |
| Complete twice | FAIL | ✓ |
| Settle an `Open` agreement | FAIL | ✓ |
| Settle a `Funded` agreement before completion | FAIL | ✓ |
| Settle a `Completed` agreement | PASS | ✓ |
| Settle twice | FAIL | ✓ |
| Redirect settlement to an attacker's token account | FAIL | ✓ |
| Redirect settlement to the buyer | FAIL | ✓ |
| Settle with a substituted mint, vault, or vault authority | FAIL | ✓ |
| Settle as an outsider | FAIL | ✓ |
| Settle as the buyer (destination still the seller's) | PASS | ✓ |
| Drain another agreement's vault through your own agreement | FAIL | ✓ |
| Cancel an unfunded agreement | PASS | ✓ |
| Cancel as the seller, or after funding | FAIL | ✓ |
| Open a dispute as either party over escrowed money | PASS | ✓ |
| Open a dispute as an outsider, or before funding | FAIL | ✓ |
| Settle while disputed | FAIL | ✓ |
| Resolve a dispute in your own favour | FAIL | ✓ |
| Resolve a dispute to a non-party | FAIL | ✓ |
| Resolve an agreement that is not disputed, or twice | FAIL | ✓ |
| Concede a dispute to the other party | PASS | ✓ |
| Refund as the seller | PASS | ✓ |
| Refund as the buyer, or redirected away from the buyer | FAIL | ✓ |
| Act on a settled, refunded, or cancelled agreement | FAIL | ✓ |
| Schedule a milestone as the seller, or after funding | FAIL | ✓ |
| Schedule more than the agreement amount | FAIL | ✓ |
| Fund a partly-scheduled milestone contract | FAIL | ✓ |
| Submit a tranche as the buyer, or approve your own | FAIL | ✓ |
| Settle a tranche that is not approved, or twice | FAIL | ✓ |
| Redirect a tranche away from the seller | FAIL | ✓ |
| Use another agreement's tranche | FAIL | ✓ |
| Work a tranche while disputed | FAIL | ✓ |
| Refund a milestone contract midway | PASS — returns only the unearned tranches | ✓ |
| Fund a bounty before its winner is known | PASS | ✓ |
| Complete, settle or refund a bounty with no winner named | FAIL | ✓ |
| Name a bounty's winner twice | FAIL | ✓ |
| Name a winner as anyone but the sponsor, or name the sponsor | FAIL | ✓ |
| Start a non-bounty agreement with no payee | FAIL | ✓ |
| Observe an event from a failed settlement | FAIL | ✓ |
| Take a donated surplus along with settlement | FAIL | ✓ |
| Anchor evidence to a funded agreement | PASS | ✓ |
| Point `submit_proof` at another agreement's core proof address | FAIL | ✓ |
| Point `submit_proof` at an attacker-controlled account as the core proof | FAIL | ✓ |
| Route the proof CPI to any program but `ppv_core` | FAIL | ✓ |
| Leave an escrow proof behind when `ppv_core` rejects the call | FAIL | ✓ |

## Deliberate vulnerability testing

A negative test that passes against correct code proves nothing on its own. For
each guard, the procedure is:

1. implement the guard and confirm the negative test passes,
2. remove or weaken the guard,
3. confirm the negative test now **fails**,
4. restore the guard.

A guard whose removal leaves the suite green is not covered, whatever the test
name says. Perform this on every new guard before the phase is considered done;
it is a review step, not a committed change.

## Known limitations, deliberately accepted

- **Donated surplus is stranded.** Anyone may transfer tokens directly to a
  vault. `settle` moves exactly the agreed `amount` and does not close the
  vault. Sweeping the surplus at settlement would let one lamport of a donation
  permanently block settlement; closing the vault would do the same. A surplus
  therefore stays put until a later phase adds an explicit sweep. Nothing about
  it can affect the agreed settlement.
- **Classic SPL Token only.** A Token-2022 mint with a transfer fee would break
  "the vault received exactly the amount agreed". Token-2022 arrives with
  accounting rules of its own, not by widening an account type.
- **Disputes end only by concession.** There is no arbiter, so a dispute where
  neither party will concede stays open, with the money in the vault. That is a
  deliberate trade: an arbiter is a trusted third party, and the protocol has
  not yet decided who may be one or under what policy. Phase 13, behind the
  arbiter policy gate, is where splits and third-party judgement arrive.
- **A bounty sponsor who never selects.** The money stays in the vault. This is
  the same liveness gap as the one below, reached a different way.
- **No expiry.** Nothing forces an agreement forward. A seller who never marks
  work complete leaves tokens in the vault indefinitely. Time-based release is a
  design decision with its own attack surface and is deferred, not forgotten.

## Deployment posture

`ppv_escrow` is the only PPV program that holds value. It ships no further than
a local validator until the custody gate in [deployment-gates.md](deployment-gates.md)
is met: independent security review, remediation, legal review, and an upgrade
authority held by a multisig separate from the non-custodial programs. It is
deliberately absent from `[programs.devnet]` and from the devnet deploy workflow.
