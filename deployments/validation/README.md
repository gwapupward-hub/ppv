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
CANONICAL_LIVE_CUSTODY_EVIDENCE=NONE
```

This directory holds this README and nothing else. **No live custody validation
record exists**, and none may be written by hand: only a complete, successful
run of `devnet-escrow-custody-validation.yml` creates one.

Several controlled executions have been attempted. Each reached an
infrastructure or setup stage and stopped there:

| Run | How far it got | Why it stopped |
| --- | --- | --- |
| [35182967665](https://github.com/gwapupward-hub/ppv/actions/runs/35182967665) | deterministic checks | shallow checkout; the release suite reads the repository's own past |
| [35393227976](https://github.com/gwapupward-hub/ppv/actions/runs/35393227976) | funder preflight | the funder secret was not keypair JSON |
| [35405785493](https://github.com/gwapupward-hub/ppv/actions/runs/35405785493) | disposable setup complete | public devnet RPC returned HTTP 429 before the first agreement |
| [35414331967](https://github.com/gwapupward-hub/ppv/actions/runs/35414331967) | disposable setup | heavy rate limiting through the same shared public endpoint |
| [35430583241](https://github.com/gwapupward-hub/ppv/actions/runs/35430583241) | **almost the entire matrix** | preflight reported `Blockhash not found` before the final proof settlement |

Each cause is fixed and separately tested. What they have in common is where
they stopped, and it is worth being exact about it:

* disposable wallet, mint and associated-token-account transactions **did**
  occur in the later attempts — it is not true that nothing has ever been sent
  to devnet;
* **no PPV agreement was created, no vault existed, and no token ever entered
  PPV custody**;
* therefore **no complete PPV custody matrix has run**.

An aborted attempt is neither a custody PASS nor a custody FAIL. It is evidence
about infrastructure and about nothing else. Nothing in this directory may be
backfilled from a failed run's logs, and none of the rows above should be read
as a finding about the deployed program.

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
