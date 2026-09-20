# Live devnet custody validation records

One record per live custody run of `ppv_escrow` against devnet, written by
`scripts/devnet-escrow-custody.mjs`.

These are **not** deployment evidence. `deployments/evidence/` holds the
canonical record of what was deployed and who holds its upgrade authority; this
directory holds records of how the deployed program *behaved* when real token
accounts were put through it. The two answer different questions and neither
substitutes for the other:

| | `deployments/evidence/` | `deployments/validation/` |
| --- | --- | --- |
| Question | is the deployed program the reviewed one, under the intended authority? | does it move custody the way the protocol says? |
| Method | public account reads | signed devnet transactions with disposable tokens |
| Produced by | the deployment and recovery workflows | `devnet-escrow-custody-validation.yml`, `workflow_dispatch` only |

A validation record never modifies, replaces, or licenses an edit to the
canonical deployment evidence.

## Current contents

```
CANONICAL_LIVE_CUSTODY_EVIDENCE=deployments/validation/ppv-escrow-devnet-live-custody-35465469908.json
LIVE_CUSTODY_MATRIX=PASS
HISTORY_RECONSTRUCTION=PASS
FINAL_LIVE_VAULT_BALANCE_TOTAL=0
RR_6=CLOSED
```

`sha256:c95943d6a658ee7723c18b5696f543fe98e0a49ad9b4a57269ca3a0b8411ad3c`

### How that record came to exist

It was not produced by a single run, and the distinction is the whole point of
this section.

**The custody behaviour happened in run
[35465469908](https://github.com/gwapupward-hub/ppv/actions/runs/35465469908).**
That run created agreements, funded vaults, moved tokens, and drove every
lifecycle family to a terminal state. It then stopped in Phase 12 — the
*read-only* history reconstruction — because the RPC provider answered
`getTransaction` with HTTP 429. Nothing about the chain or the program was
wrong; only the reading of it did not finish, so the run wrote a failure
diagnostic and no evidence.

**The evidence was produced later, read-only, by recovery run
[35481530878](https://github.com/gwapupward-hub/ppv/actions/runs/35481530878).**
It read that run's public diagnostic for coordinates — addresses and signatures
— and checked every claim against public chain state: each recorded success
exists carrying no error, each expected refusal landed carrying one, each
agreement holds the recorded terminal state, each vault reads zero, and each
history reconstructs through `@gwap/ppv-indexer` to the state the live account
reports.

**Recovery sent zero transactions**, and **no behaviour matrix was repeated**.
Re-running the matrix to recover from a rate-limited *read* would have sent ~70
fresh value-moving transactions to re-learn what the chain already records.

The recovered file is now the canonical validation evidence. It is a record of
run 35465469908's behaviour, reconstructed independently, and it says so in its
own `recoveryMode`, `liveMatrixExecuted`, `liveMatrixRepeated` and
`valueMovingTransactionsSentDuringRecovery` fields.

### What it establishes

| | |
| --- | --- |
| Primary scenarios | 8, all terminal, every vault `0` |
| | `ordinaryEscrow` Settled · `cancel` Cancelled · `refund` Refunded · `disputeToSeller` Settled · `disputeToBuyer` Refunded · `milestones` Settled (2 milestones) · `bounty` Settled · `proofs` Settled (2 proofs) |
| Expected refusals | 43, each a landed transaction with `err != null` |
| Proof bindings | 2 escrow Proof PDAs owned by `ppv_escrow`, 2 `coreProof` records owned by `ppv_core`, stored `core_proof` matching the emitted event binding |
| Disposable fixtures | `foreign-milestone-source` and `foreign-proof-source`, both vault `0` |
| `PRIMARY_SCENARIO_VAULT_TOTAL` | `0` |
| `FIXTURE_VAULT_TOTAL` | `0` |
| `TOTAL_RUN_PPV_VAULT_BALANCE` | `0` |
| Lifecycle families | all nine true — funding, settlement, cancellation, refund, disputeToSeller, disputeToBuyer, milestoneRelease, bountySelection, proofApproval |

**RR-6 is CLOSED** on that basis. It does not open the custody gate, and it is
not a substitute for RR-13 or legal review — see *What a record does not
authorize*, below.

A record is still never written by hand: it comes from a complete, successful
run of `devnet-escrow-custody-validation.yml`, or from a `RECOVERY=PASS` of
`devnet-escrow-custody-recovery.yml`.

Several controlled executions have been dispatched:

| Run | How far it got | Why it stopped |
| --- | --- | --- |
| [35182967665](https://github.com/gwapupward-hub/ppv/actions/runs/35182967665) | deterministic checks | shallow checkout; the release suite reads the repository's own past |
| [35393227976](https://github.com/gwapupward-hub/ppv/actions/runs/35393227976) | funder preflight | the funder secret was not keypair JSON |
| [35405785493](https://github.com/gwapupward-hub/ppv/actions/runs/35405785493) | disposable setup complete | public devnet RPC returned HTTP 429 before the first agreement |
| [35414331967](https://github.com/gwapupward-hub/ppv/actions/runs/35414331967) | disposable setup | heavy rate limiting through the same shared public endpoint |
| [35430583241](https://github.com/gwapupward-hub/ppv/actions/runs/35430583241) | **almost the entire matrix** | preflight reported `Blockhash not found` before the final proof settlement |
| [35439828941](https://github.com/gwapupward-hub/ppv/actions/runs/35439828941) | escrow, cancel, refund, both disputes | the first state-only step was sent without a read client (fixed in #39) |
| [35457793117](https://github.com/gwapupward-hub/ppv/actions/runs/35457793117) | **the whole matrix** | Phase 12 read `envelope.program`, which `EscrowEventEnvelope` does not have (fixed in #40) |
| [35465469908](https://github.com/gwapupward-hub/ppv/actions/runs/35465469908) | **the whole matrix** | Phase 12 `getTransaction` returned HTTP 429 |
| [35481530878](https://github.com/gwapupward-hub/ppv/actions/runs/35481530878) | **recovered run 35465469908 in full, read-only** | nothing — `RECOVERY=PASS`, and it produced the canonical evidence above |

Each cause is fixed and separately tested. The last three rows are a different
kind of stop from the first four, and the distinction is the point of this
section:

* the earlier attempts stopped before any PPV agreement existed. Disposable
  wallet, mint and associated-token-account transactions **did** occur, so it
  is not true that nothing was ever sent to devnet, but no vault existed and no
  token entered PPV custody;
* runs 35457793117 and **35465469908 executed the entire custody behaviour
  matrix**. Agreements were created, vaults were funded, tokens moved, and
  every completed funded scenario vault returned to zero. Both then stopped in
  **Phase 12, which is read-only** — one on a consumer bug, one on a provider's
  rate limiter. Neither is a finding about the deployed program.

An aborted attempt is neither a custody PASS nor a custody FAIL, and a run that
completed its behaviour matrix is not a PASS either until its history has been
independently reconstructed. Nothing in this directory may be backfilled from a
failed run's logs.

### Recovering a completed run instead of repeating it

Run 35465469908's failure was a *read*. Re-running the matrix to recover from
it would send ~70 fresh value-moving transactions to re-learn what the chain
already records, so the repository recovers the run instead:

```
gh workflow run devnet-escrow-custody-recovery.yml \
  -f run_id=35465469908 \
  -f expect_commit=6053b1ede324b03a5064da53c7ebae25b13f1ee6 \
  -f publish=true
```

`scripts/recover-devnet-escrow-custody-evidence.mjs` reads that run's public
diagnostic for **coordinates only** — addresses and signatures — and checks
every claim against chain state: each recorded success must exist and carry no
error, each expected refusal must have landed carrying one, each agreement must
currently hold the recorded terminal state, each vault must read zero, and each
history must reconstruct through `@gwap/ppv-indexer` to the state the live
account reports.

It needs no funder, buyer, seller, outsider, deployer or custody key, and it
**cannot** send a transaction: it imports no signer type, no transaction
builder and no send path, and every RPC method it names is a read.
`scripts/test/custody-recovery.test.mjs` asserts that structurally, so an edit
that broke it fails the suite.

### Run 35430583241 in particular

It got much further than the others, and the distinction matters. Ordinary
escrow, cancel, refund, both dispute outcomes, milestones, bounty, and the
proof path — submission through a live CPI into `ppv_core`, approval, and
rejection — all completed, and several funded vaults were emptied and checked
at zero.

It then stopped on `proofs: settle citing the approved proof` with

```
Transaction simulation failed: Blockhash not found
Logs: []
```

`Logs: []` is the part that settles the classification. The transaction was
rejected by **simulation, before broadcast**: no instruction executed, and
`ppv_escrow` never saw the settlement. That is
`PRE_SUBMISSION_BLOCKHASH_EXPIRED`, and it is not a custody defect, not a
program rejection, and not an invariant failure.

**Aborted test fixtures.** Two agreements were funded and not wound down:

| fixture | disposable units |
| --- | --- |
| the proofs agreement (reached `Completed`) | 9 |
| `foreign-proof-source` | 3 |

`ABORTED_TEST_FIXTURES_RUN_35430583241` = **12 economically meaningless Classic
SPL test units**. The disposable buyer and seller keys existed only inside that
process and are gone, so there is no safe recovery and none should be
attempted; no key is to be reconstructed and no cleanup instruction invented.
They are devnet test artifacts, not customer assets.

They must **not** count toward a future run's `FINAL_LIVE_VAULT_BALANCE_TOTAL`.
That metric is about the vaults a run creates, and a run that inherits someone
else's stranded fixture has not failed its own accounting.

The exposure that produced the 3-unit half is closed: `foreign-proof-source` is
now created, used and refunded entirely inside the proof scenario, before the
settlement that failed, instead of being opened at the start of the run and
torn down at the end.

### Run 35465469908's disposable fixtures

The run stopped in Phase 12, after the matrix, so the concern was whether its
two disposable fixtures had been left holding anything. Recovery answered that
from chain rather than from the run's own claims:

| fixture | live state | vault balance |
| --- | --- | --- |
| `foreign-milestone-source` | `Cancelled` | `0` |
| `foreign-proof-source` | `Refunded` | `0` |

Both are terminal and both are empty, so **no Run 16 custody value is
stranded**. The record carries them under `abortedDisposableFixtures` with the
standing disposition: no signer is to be reconstructed and no recovery
instruction invented, because the disposable signers existed only inside that
process. A fixture whose vault read anything other than zero would have failed
recovery outright — the check is on the balance, not on the label.

## What a record may contain

Public facts only: the repository commit, the cluster genesis, the program id,
ProgramData, the upgrade authority, the live binary hash, the custody multisig
with its live threshold, members and permission masks, the derived vault, the
disposable test mint, the disposable test wallets' **public** addresses,
agreement/milestone/proof PDAs, transaction signatures, pre- and post-transaction
token balances, terminal states, every expected-failure result, the event and
history-reconstruction results, a timestamp, and the harness version.

## What a record must never contain

Secret keys, keypair byte arrays, seed phrases, mnemonics, sensitive wallet file
paths, environment values, tokens, credentials, GitHub secrets, or RPC
credentials.

That is enforced rather than requested. `assertNoSecrets` in
`scripts/lib/custody-runner.mjs` walks the whole record before it is serialized
and **fails the run** on a secret-shaped field name, a 32- or 64-byte number
array, raw bytes, or a stringified keypair. It does not redact: a generator that
redacted would still have handled a secret, and a reader would have no way to
know it had. `scripts/test/escrow-custody-harness.test.mjs` asserts each of those
refusals, and the workflow greps the produced file a second time before it is
uploaded anywhere.

## What a record does not authorize

Nothing. A passing live custody run leaves **RR-13** (no independent Solana
security review) open, leaves legal review open, leaves the custody gate in
[`docs/deployment-gates.md`](../../docs/deployment-gates.md) **CLOSED**, and
leaves mainnet **NOT AUTHORIZED**. Every record states those four facts in its
own `gates` block so a reader who sees only the record cannot mistake it for a
clearance.

## Running one

The run is `workflow_dispatch` only — never on push, never on a pull request,
never on a schedule. It therefore needs a person, or a token with
`actions: write`, to start it; an agent whose GitHub App installation lacks that
scope cannot begin a custody run, which is the intended shape of the control.

### What the operator has to provide

One repository **environment** named `devnet-custody-validation`, holding
**two** secrets. The workflow requires both and refuses to start without either;
they serve completely different purposes and should be rotated independently.

#### 1. `PPV_CUSTODY_RPC_URL` — where the run reads and signs

| | |
| --- | --- |
| Secret name | `PPV_CUSTODY_RPC_URL` |
| Contents | a **dedicated Solana devnet** RPC endpoint with quota for the full matrix |
| Fallback | **none** |

There is deliberately no public-RPC fallback. Runs 35405785493 and 35414331967
both reached execute mode, created their disposable wallets, mints and token
accounts, and were then rate-limited by the shared public endpoint before the
custody matrix could complete. Falling back to that endpoint would spend devnet
SOL and then fail the same way, so the workflow stops instead — see
`DEDICATED_DEVNET_RPC=MISSING` below.

A dedicated endpoint usually authenticates with a key inside the URL, so it is
treated as a credential:

* **never print it.** The harness registers it as sensitive before a client
  exists; every message this repository writes says "the configured RPC
  endpoint" instead, and messages from `@solana/web3.js` or undici are scrubbed
  on the way out.
* **never commit it**, and never put it in an issue, a pull request or a log.
* **it is absent from the evidence record by construction.** `assertNoSecrets`
  refuses any URL carrying a query string, userinfo or a long opaque path
  segment, so a record that contains one fails the run rather than publishing.

**The URL is trusted for nothing.** Devnet is proved by **genesis hash** against
the live cluster, before a keypair is loaded or an instruction is built. The
endpoint's name is only a cheap early refusal for anything that says "mainnet"
on its face.

#### What the endpoint has to be able to do

Run 35430583241 drew repeated `429 Too Many Requests` and one
`ws error: Unexpected server response: 429` from a dedicated endpoint, so
"dedicated" is not by itself sufficient. The matrix needs, roughly:

| | |
| --- | --- |
| Transactions | ~70 submissions over ~15 minutes, in short bursts |
| Reads | a `getMultipleAccounts` over every watched account before and after each one, plus confirmation polling |
| Sustained request rate | comfortably above ~25 requests/second in burst |
| Websocket subscriptions | **none required** |

That last row is deliberate. Confirmation polls `getSignatureStatuses` over
HTTP and never subscribes, so a provider's websocket quota cannot decide
whether a custody run succeeds. A plan whose websocket tier is exhausted is
fine; a plan whose HTTP tier is exhausted is not.

Pacing between submissions is short and bounded on purpose. A long sleep would
make a low-capacity endpoint appear adequate, and the next failure would arrive
somewhere less legible.

#### 2. `PPV_CUSTODY_FUNDER_KEYPAIR` — who pays rent and fees

| | |
| --- | --- |
| Secret name | `PPV_CUSTODY_FUNDER_KEYPAIR` |
| Contents | the JSON byte array of a **disposable devnet** keypair |
| Balance | at least **1 devnet SOL**, immediately before execution |

The funder must be disposable, devnet-only, and economically meaningless. It
must not be the deployer, a program keypair, a custody multisig signer, or any
wallet with a mainnet role. Its only job is paying rent and fees for the
throwaway wallets each run creates.

It must be a **JSON byte array**, not a base58 string: run 35393227976 failed
because it was not, and the parser then quoted part of what it rejected into the
log. A malformed value is now refused with one constant message that says
nothing about the value.

Never paste that keypair into a chat, an issue, a pull request, or a log. The
workflow reads it from the secret, writes it to a file with mode 600, and
deletes that file in a step that runs `if: always()`. It prints the funder's
public address and balance, and nothing else about it.

**Check the balance before each execute run.** Previous attempts spent devnet
SOL creating their disposable setup before failing, so a funder that cleared the
floor last time may not clear it now. The preflight enforces it, but finding out
that way costs a dispatch.

**Why 1 SOL.** The buyer wallet creates every agreement, and a creator pays rent
for every account its instructions open: ten agreements, ten vault token
accounts and three milestone accounts, roughly 0.061 SOL, plus the funder's own
outlay on two mints and five associated token accounts. The harness gives each
of its three wallets 0.25 SOL and refuses to start below a 1 SOL funder balance.
The arithmetic is asserted in `scripts/test/escrow-custody-harness.test.mjs`, so
adding a scenario that changes it fails a test rather than a live run.

### Dispatching

*Actions → Live DEVNET custody validation (ppv_escrow) → Run workflow*, against
`main`:

| Input | Preflight | Live run |
| --- | --- | --- |
| `confirm` | `ppv_escrow` | `ppv_escrow` |
| `preflight_only` | `true` (default) | **`false`** |

Run it with the default first. That reads the chain, decodes the custody
multisig, sends nothing, and proves the wiring. Only then run it with
`preflight_only: false`.

If the live run fails, do not simply re-run it. Classify the first failure
before deciding: a harness bug and an RPC hiccup want opposite responses, and a
custody-invariant failure wants neither — it wants the run stopped and the
finding reported, with the deployed program left exactly as it is.

### Locally

`PPV_CUSTODY_RPC_URL` is required here too, with no default. Take the value
from your secret store; do not paste a provider URL or API key into this file,
a shell history you keep, or anything you commit.

```
PPV_CUSTODY_RPC_URL="<DEDICATED DEVNET RPC FROM SECURE ENV>" \
  node scripts/devnet-escrow-custody.mjs            # read-only preflight, sends nothing

PPV_CUSTODY_RPC_URL="<DEDICATED DEVNET RPC FROM SECURE ENV>" \
PPV_CUSTODY_FUNDER=/path/to/disposable-devnet-wallet.json \
  node scripts/devnet-escrow-custody.mjs --execute  # the full scenario matrix
```

Without it the harness stops before reading anything and prints
`DEDICATED_DEVNET_RPC=MISSING`.

The harness refuses any cluster that is not devnet, by genesis hash, before a
keypair is loaded or an instruction is built.
