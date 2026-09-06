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
| Observe an event from a failed settlement | FAIL | ✓ |
| Take a donated surplus along with settlement | FAIL | ✓ |

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
- **No cancellation or refund.** An `Open` agreement can be abandoned but not
  closed, and a `Funded` agreement cannot be refunded. Both are Phase 5, and
  both need the dispute machine to be meaningful. Until then, the buyer's own
  signature is required for funds to leave their wallet at all.
- **No expiry.** Nothing forces an agreement forward. A seller who never marks
  work complete leaves tokens in the vault indefinitely. Time-based release is a
  design decision with its own attack surface and is deferred, not forgotten.

## Deployment posture

`ppv_escrow` is the only PPV program that holds value. It ships no further than
a local validator until the custody gate in [deployment-gates.md](deployment-gates.md)
is met: independent security review, remediation, legal review, and an upgrade
authority held by a multisig separate from the non-custodial programs. It is
deliberately absent from `[programs.devnet]` and from the devnet deploy workflow.
