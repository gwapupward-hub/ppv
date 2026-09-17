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

One repository **environment** named `devnet-custody-validation`, holding one
secret:

| | |
| --- | --- |
| Secret name | `PPV_CUSTODY_FUNDER_KEYPAIR` |
| Contents | the JSON byte array of a **disposable devnet** keypair |
| Balance | at least **1 devnet SOL** (the workflow refuses less) |

The funder must be disposable, devnet-only, and economically meaningless. It
must not be the deployer, a program keypair, a custody multisig signer, or any
wallet with a mainnet role. Its only job is paying rent and fees for the
throwaway wallets each run creates.

Never paste that keypair into a chat, an issue, a pull request, or a log. The
workflow reads it from the secret, writes it to a file with mode 600, and
deletes that file in a step that runs `if: always()`. It prints the funder's
public address and balance, and nothing else about it.

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

```
PPV_CUSTODY_RPC_URL=https://api.devnet.solana.com \
  node scripts/devnet-escrow-custody.mjs            # read-only preflight, sends nothing

PPV_CUSTODY_RPC_URL=https://api.devnet.solana.com \
PPV_CUSTODY_FUNDER=/path/to/disposable-devnet-wallet.json \
  node scripts/devnet-escrow-custody.mjs --execute  # the full scenario matrix
```

The harness refuses any cluster that is not devnet, by genesis hash, before a
keypair is loaded or an instruction is built.
