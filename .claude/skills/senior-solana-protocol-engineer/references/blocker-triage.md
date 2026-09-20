# Blocker and failed-release triage

Use this reference when a build, deployment, upgrade, transaction, multisig proposal, or production execution is blocked or failing. The objective is a defensible causal diagnosis, not a bag of commands.

## Preserve the incident before changing it

Capture:

- exact timestamp and target cluster;
- repository commit, workflow run, job, and failing step;
- full sanitized command, stdout/stderr, and exit code;
- transaction signature, proposal ID, buffer address, program ID, and signer public keys when available;
- RPC endpoint class/provider/region with credentials redacted;
- installed and pinned tool versions;
- last known-good commit, artifact, run, and on-chain deployment slot;
- changes since last success;
- whether any retry, buffer write, authority change, or partial migration occurred.

Do not delete buffers, rerun with a new program keypair, rotate authorities, or change multiple versions while evidence is still being collected.

## First split: did a transaction reach the cluster?

### No signature was produced

Focus on pre-broadcast layers:

- compile/link failure or wrong binary path;
- CI permissions, protected environment, missing secret, or denied approval;
- signer loading, wallet format, hardware/KMS/custody integration;
- wrong cluster configuration or malformed/redacted RPC URL;
- insufficient local inputs, IDL/client mismatch, or proposal construction failure;
- incompatible CLI/SDK/Anchor/platform-tools versions;
- multisig proposal never created or not moved to executable state.

Do not search transaction logs for a transaction that never existed.

### A signature was produced

Focus on submission, landing, and runtime:

- fetch status and the transaction from the same cluster;
- tell the RPC reader the highest transaction version it supports; v1 transactions require v1-aware clients;
- inspect `err`, logs, inner instructions, compute consumed, loaded addresses/config, block/slot, and confirmation status;
- decode custom errors against the exact deployed program and IDL, not the source branch you hoped was live;
- distinguish expired/dropped/unlanded from landed-and-failed;
- correlate with program deployment slot and the one-slot visibility delay.

Fees can be charged on failed transactions. Do not blindly rebroadcast deterministic failures.

## Failure-layer matrix

| Layer | Typical evidence | Common root causes | Next discriminating check |
| --- | --- | --- | --- |
| Source/build | compiler/linker error, missing `.so`, different hash | dependency/toolchain drift, unsupported Rust feature, platform-tools mismatch, stack/ELF limit | reproduce from clean pinned environment and compare last-good lockfiles |
| Program identity | `DeclaredProgramIdMismatch`, wrong client target, deploy creates unexpected ID | `declare_id!`, `Anchor.toml`, keypair, IDL, env, or governance target disagree | build a program identity matrix and derive the keypair public key |
| Cluster/RPC | account missing, wrong balance/authority, 403/429, inconsistent reads | wrong URL, embedded credential problem, public RPC limits, region lag, wrong commitment | query genesis/slot/program through explicit primary and independent RPCs |
| Funding/rent | insufficient funds, allocation/extend error | payer balance too low, binary grew, fees/congestion underestimated | measure binary and existing allocation; calculate current rent plus margin |
| Signing/custody | signature verification or missing signer; job cannot load key | wrong signer, malformed secret, unavailable hardware/KMS, vault/PDA mismatch | derive public keys only and compare to required authority/account metas |
| Upgrade authority | incorrect authority, proposal cannot execute | authority transferred, wrong vault, threshold/permission mismatch, immutable program | inspect on-chain ProgramData authority and governance state |
| Buffer/upload | buffer error, partial progress, resume confusion | wrong buffer authority, dropped chunks, stale buffer, size mismatch | inspect buffer address/authority/size and artifact hash before retry |
| Transaction landing | blockhash expired, timeout, no status | underpriced transaction, RPC/TPU path, retry policy, congestion | check recent blockhash lifetime, prioritization, send path, and status across RPCs |
| Runtime accounts | custom error, signer/owner/seeds/constraint failure | account substitution, stale client/IDL, wrong PDA seeds/bump, duplicate role | compare actual account metas and decoded state to instruction contract |
| Compute/resources | computational budget, heap, account-data or size failure | path-dependent CPI cost, v1 config missing, account set grew | simulate/measure exact path; inspect message-version-specific limits |
| CPI/token | invoked program error, privilege escalation, token error | wrong program/mint/authority, extension/hook accounts, missing signer seeds | trace inner instructions and validate every CPI account/program |
| State machine | invalid state, already processed, deadline | replay, partial prior success, stale UI/indexer, non-idempotent retry | read canonical on-chain state and event/receipt sequence |
| Client/decoder | unsupported transaction version or parse failure | v1 not opted in, stale SDK, IDL/event format drift | use a current decoder and compare artifact/IDL hashes |
| Multisig/governance | approved but not executed; execution failed | proposal state, stale blockhash, wrong vault index, account list/payload mismatch | inspect proposal/transaction state and exact compiled message |
| Post-deploy | deploy says success but calls fail | next-slot visibility delay, wrong client ID, failed migration, stale RPC/cache | wait/check slot, inspect on-chain metadata, then run narrow smoke test |

## Program-ID mismatch procedure

1. Enumerate source `declare_id!` values.
2. Enumerate `Anchor.toml` entries for the exact cluster.
3. Derive the public key from each intended deploy keypair without printing secrets.
4. Inspect IDL metadata and generated-client constants.
5. Inspect frontend/backend/indexer environment configuration.
6. Inspect the on-chain program and ProgramData account.
7. Inspect the multisig/custody payload target.
8. Decide which identity is authoritative from release records—not from whichever file is easiest to change.

If the permanent program keypair is missing, do not generate a replacement and pretend it is the same program. Locate the approved secret/custody source or authorize a new program ID and migration.

## Custom-error procedure

1. Confirm the failing program ID from logs and inner instructions.
2. Confirm which binary/deployment slot was live at the transaction's slot.
3. Decode the error using that binary's IDL/source and framework version.
4. Inspect the accounts and instruction data actually sent.
5. Reproduce locally with the same state shape.
6. Add a regression test that fails before the fix and passes after it.

Do not decode an error against an unshipped branch or a regenerated IDL without proving they match on-chain code.

## Deployment-specific procedure

### Build fails

- reproduce in a clean environment using pins;
- identify the first compiler/linker error;
- compare Rust, platform-tools, Anchor, Cargo lock, and feature flags;
- avoid “fixing” by updating every dependency;
- verify the resulting artifact hash and tests after the minimal change.

### Upload/deploy fails before upgrade

- determine whether the program changed on-chain;
- record and inspect any buffer;
- verify payer funding, artifact size, RPC stability, and buffer authority;
- decide whether resume, a new approved buffer, or no action is safest;
- never close material buffers until the release state is understood.

### Upgrade transaction fails

- inspect runtime logs and account metas;
- compare Program, ProgramData, buffer, spill/recipient, loader, and authority accounts;
- verify authority signer/PDA/multisig vault and threshold;
- verify the program was not already deployed in the same slot where another operation depends on it;
- confirm binary verification and allocation requirements.

### Command succeeds but verification fails

- treat as unresolved and potentially `NO-GO`;
- verify commit, controlled build, builder image, tool versions, features, and artifact copied to deploy step;
- dump the on-chain binary and compare through the approved verifier;
- investigate machine-specific or unpinned inputs;
- do not publish a verification claim until artifacts match.

## Hypothesis discipline

Maintain a small table:

| Rank | Hypothesis | Supporting evidence | Contradicting evidence | Next check | Status |
| --- | --- | --- | --- | --- | --- |

Prefer checks that split multiple hypotheses. Mark a hypothesis confirmed only when it explains the evidence and the corrective change produces the predicted result.

Separate:

- **root cause:** the condition that created the failure;
- **trigger:** why it appeared now;
- **contributing control gap:** why automation/review did not catch it;
- **symptom:** what the user or CI observed.

## Risk escalation

Escalate to `NO-GO` and stop mutation when:

- program ID or cluster is uncertain;
- on-chain authority differs from governance records;
- the running artifact cannot be tied to source;
- the proposed retry could overwrite a correct program or execute a stale proposal;
- migration partially applied and state compatibility is unknown;
- secrets appeared in logs or source control;
- rollback artifact or authority is unavailable for a high-risk release;
- a deterministic failure is being repeatedly retried without diagnosis.

## Blocker report template

```text
Verdict / current impact:
Requested outcome:
Environment / program / commit:
First observed symptom:
Timeline:
Evidence captured:
Transaction or proposal state:
Confirmed failure layer:
Root cause:
Trigger:
Contributing control gap:
Fix or containment:
Validation performed:
Residual risk:
Release decision:
Owner / next action / stop condition:
```

If the cause is not yet confirmed, replace the root-cause claim with ranked hypotheses and the exact next discriminating check.
