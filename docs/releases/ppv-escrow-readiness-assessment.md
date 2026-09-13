# PPV Escrow — next-sprint readiness assessment

Written at the close of Sprint 2's non-deployment work. **This authorises
nothing.** It answers one question: should the next sprint be an Escrow
*security and readiness* sprint? It does not approve a deployment, does not move
the custody gate in [`deployment-gates.md`](../deployment-gates.md), and does not
change `ppv_escrow`'s absence from `[programs.devnet]` or from the deploy
workflow.

> **Superseded in part.** This document answered one question at the close of
> Sprint 2 — *should the next sprint be an Escrow security and readiness
> sprint?* — and its GO was acted on: that sprint ran. It is **not** a
> deployment-readiness verdict and never was. The deployment-readiness verdict
> is [PPV ESCROW DEVNET DEPLOYMENT READINESS:
> NO-GO](../security/ppv-escrow-readiness-verdict.md), issued at the close of
> Sprint 3. Where the two appear to disagree, they are answering different
> questions and the Sprint 3 verdict is the one about deployment.

## Verdict

**PPV ESCROW NEXT SPRINT: GO FOR SECURITY/READINESS**

Not because Escrow is close to deployable — it is not, and several answers below
are a flat no. The reason is that every remaining obstacle is *known, named and
bounded*, and the repository already carries the plan for closing them. A
security-and-readiness sprint has exactly that shape: a backlog of specific
gates, none of which requires a design decision nobody has made yet. What would
make this a NO-GO is an unanswered architectural question, and there isn't one.

Nothing in this verdict permits a deployment. The custody gate closes on an
independent security review, and no sprint plan substitutes for it.

## The eight questions, answered

**Are Escrow security invariants sufficient?** No — and the gap is measured, not
guessed. PPV-P1…P10 are asserted after every attempted action by the release-tier
property suite, but that suite attacks four of Escrow's seventeen instructions:
`fund`, `mark_completed`, `settle`, `cancel`. Disputes, refunds, milestones,
bounties, proofs and proof decisions, `select_counterparty`, and cross-program
composition are unfuzzed. [`property-testing.md`](../property-testing.md) already
states this and lays out phases B–H that close it, each arriving with its own
generators and model rules — because an invariant listed before its generator
exists documents a check nothing performs.

**Is the custody architecture frozen?** No. `ppv_escrow` carries a build-only
placeholder program id (`7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR`) present
only in `[programs.localnet]`. Freezing the architecture and generating a
permanent identity is a deliberate ceremony, not a build step.

**Are token-account constraints complete?** Substantially, with two accepted
limitations that must be resolved or explicitly signed off before custody:
donated surplus is stranded (sweeping it at settlement would let one lamport of a
donation block settlement permanently), and classic SPL Token only — a
Token-2022 mint with a transfer fee would break "the vault received exactly the
amount agreed". Both are recorded in
[`security-model.md`](../security-model.md) as deliberate trades rather than
oversights, which is the right starting position for a readiness sprint.

**Are refund and dispute terminal states proven?** Not to the standard custody
needs. They exist in the program and in the deterministic suite; they are not
covered by the randomized state-machine attack. That is phase B, and it is the
first thing the next sprint should land. Disputes additionally end only by
concession — there is no arbiter, deliberately, because the protocol has not
decided who may be one. A dispute where neither party concedes stays open with
the money in the vault.

**Are authority controls production-safe?** Not yet, and this one is structural.
The custody gate requires Escrow's upgrade authority to be held by a multisig
**separate** from the non-custodial programs, so that compromising one cannot
reach the other. Today there is one Squads 2-of-3 vault
(`B6tcsTrMCKTZV5vi3rRCnA3FMPeeWACSHuuTSz5XQgnX`), holding Core and — once Sprint
2's deployment runs — Commerce. A second, independent multisig does not exist. It
is a prerequisite, not a detail, and it has a lead time: new keys, new holders,
new threshold policy.

**Are property tests expanded beyond ordinary escrow?** No. This is the same
answer as the first question and the largest single piece of work: thirteen
instructions and the whole cross-program surface.

**Is the permanent Escrow identity safe?** There isn't one yet, which is the
safest state it could be in. No permanent keypair exists, so none can leak, and
no address can be occupied by accident. Generating it is a readiness-sprint task
and must happen in the same kind of ceremony that produced Core's and Commerce's.

**Is deployment governance ready?** No. `ppv_escrow` is deliberately absent from
`[programs.devnet]`, from `deploy-devnet.yml`'s program choices, and from
`record-deployment.sh`, so no existing path can deploy it by accident. That
absence is a security boundary and should be the *last* thing a readiness sprint
touches — after the separate multisig exists, the identity ceremony has happened,
and the security review has cleared.

## What a readiness sprint should contain

In dependency order, because most of these block the next:

1. **Property phases B and C** — disputes, refunds, the terminal `Refunded`
   state, concession semantics, then proofs and the settlement/evidence
   relationship. Phase B first; nothing downstream means much while refund is
   unfuzzed.
2. **Phases D and E** — the milestone child state machine with partial payouts
   and `settled_total <= amount`, then one-time bounty counterparty selection
   and the PPV-P6 exception it needs.
3. **Phase F** — cross-program Core/Commerce/Escrow relationships. Sprint 2 built
   the Core↔Commerce half of this; Escrow is the part that holds value and
   therefore the part that matters most.
4. **A second multisig**, independent of the vault holding Core and Commerce,
   with its own members and threshold. Long lead time — start it first even
   though it lands late.
5. **Deliberate vulnerability testing** per
   [`security-model.md`](../security-model.md): each guard removed in turn, the
   corresponding negative test confirmed to fail, then restored.
6. **Resolve or sign off** the accepted limitations: stranded surplus, expiry,
   Token-2022.
7. **Independent Solana security review** of the custody path, with all critical
   and high findings remediated and re-reviewed. This is the gate; everything
   above is preparation for it.
8. **Legal review** of the settlement and dispute paths.

Only after all of that does an identity ceremony and a governance change make
sense. A readiness sprint that reached step 8 would have earned the right to ask
the deployment question — and not before.

## Current state, for the record

| | |
| --- | --- |
| Program id | `7BECot7zFqH2oCxTu9uLmmwvzQSBtxWro47jMa2MqUdR` — build-only placeholder, localnet only |
| Permanent identity | none, deliberately |
| Deployed | nowhere; local validator only |
| In `[programs.devnet]` | no |
| In the deploy workflow | no |
| Custody gate | **CLOSED** |
| Instructions | 17 |
| Instructions under randomized attack | 4 |
| Upgrade authority for a future deployment | must be a multisig separate from the Core/Commerce vault; does not exist |

**PPV ESCROW CUSTODY GATE: CLOSED.**
