# Build Status and What Is Blocked

## Where each phase stands

| Phase | Status | Where |
| --- | --- | --- |
| 0 — Protocol identity | Done | `Anchor.toml`, `deployments/`, [deployment-gates.md](deployment-gates.md) |
| 1 — Escrow kernel | Done | `programs/ppv_escrow`, [state-machines.md](state-machines.md) |
| 2 — Events + receipts | Done | `@gwap/ppv-indexer`, [indexing.md](indexing.md), [receipts.md](receipts.md) |
| 3 — Proof vault | Done | `submit_proof`, [pdas.md](pdas.md) |
| 4 — Approval | Done | `approve_proof` / `reject_proof`, settlement citing evidence |
| 5 — Disputes + refunds | Done | `open_dispute`, `resolve_dispute`, `refund`, `cancel` |
| 6 — Milestones | Done | `create_milestone` … `settle_milestone` |
| 7 — Contracts + terms | Done | `verifyTermsBinding`, [contracts.md](contracts.md) |
| 8 — Invoices | Done | `verifyInvoice`, [compositions.md](compositions.md) |
| 9 — Bounties | Done | `select_counterparty`, [compositions.md](compositions.md) |
| 10 — Ecosystem contract | Done | `normalizeEscrowEvent`, [ecosystem.md](ecosystem.md) |
| 11 — Credentials | Done | `escrowCredential`, [credentials.md](credentials.md) |
| 12 — Optional NFT | **Blocked** | needs a deployed program |
| 13 — Advanced arbitration | **Blocked** | needs the security review |

Everything marked Done is code, tests and documentation. **None of it is
deployed.** `ppv_escrow` has a build-only placeholder program id and is
deliberately absent from `[programs.devnet]` and from the devnet deploy
workflow.

## What is blocking the rest

These are decisions and operations, not code. Nothing further can be written
that would not be guesswork until they are made.

### 1. Program keypair custody and upgrade authority

`ppv_escrow` is the first PPV program that holds value. Before it reaches any
cluster:

- Generate a controlled program keypair offline and record the resulting id in a
  deployment manifest. It becomes permanent protocol identity: every agreement,
  vault, proof and milestone address derives from it, so changing it later is not
  a migration but a second, empty universe.
- Decide the upgrade authority, which must be a Squads multisig **separate from
  the non-custodial programs**, so a compromise of one authority cannot reach
  value held by the other.
- Add `PPV_ESCROW_PROGRAM_KEYPAIR` to the deploy workflow's secrets, and add
  `ppv_escrow` to `.github/workflows/deploy-devnet.yml` and
  `scripts/record-deployment.sh` — both deliberately reject it today.

### 2. Independent security review

The custody gate in [deployment-gates.md](deployment-gates.md) requires an
external Solana security review of the custody path, with critical and high
findings remediated and re-reviewed. Two things should happen alongside it:

- **Deliberate vulnerability testing** on every guard, per
  [security-model.md](security-model.md): remove each guard in turn, confirm the
  corresponding negative test fails, restore it. A guard whose removal leaves the
  suite green is not covered, whatever the test name says.
- **Fuzzing** of the state machine and the custody accounting.

### 3. Legal review

Of the settlement and dispute paths, and of what the "PPV Verified" wording
claims — see [credentials.md](credentials.md) for exactly what it is allowed to
mean today.

### 4. Sign-off on the accepted limitations

Each is deliberate and recorded in [security-model.md](security-model.md):
stranded token donations, no expiry, no arbiter (disputes end only by
concession), a bounty sponsor who never selects, classic SPL Token only.

## What unblocks after each

**Phase 12 (optional NFT)** needs (1). An NFT is a representation of a finalized
protocol record, and there is nothing worth pointing one at until a deployed
program with a permanent id exists. The eligibility gate is already written and
evaluates server-side from chain-derived facts.

**Phase 13 (advanced arbitration)** needs (2), and its own policy decision:
percentage splits, designated arbiters, multisig arbitration and appeals all
require first answering *who is allowed to judge, and under what policy* — see
[arbiter-policy.md](arbiter-policy.md). Concession-only resolution is what a
protocol can do safely before that question is answered, which is why Phase 5
stops there.

## Before any of it: run the gate

The on-chain suite has never executed in the environment these phases were
written in — there is no validator there. `npm run test:f1` is its first real
run: it builds twice, compares the IDLs, checks that every program id agrees
across keypair, `declare_id!`, `Anchor.toml` and IDL, then deploys to a local
validator and runs the full adversarial suite.

Run it before reading anything else here as verified.
