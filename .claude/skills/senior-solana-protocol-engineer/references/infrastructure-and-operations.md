# Infrastructure and operations

Use this reference for production RPC design, transaction landing, indexers, webhooks, CI/CD, custody, observability, and incident response around a Solana protocol.

## Architecture goals

Production infrastructure must preserve:

- **correctness:** reads and writes target the intended cluster/program and respect finality;
- **availability:** provider or region failure does not silently halt critical paths;
- **idempotency:** retries do not duplicate economic actions or corrupt derived state;
- **traceability:** a user action can be followed from request through signature, slot, logs, event, indexer, and database state;
- **custody:** no application service gains more signing authority than it needs;
- **recoverability:** backfill, reconciliation, rollback/forward-fix, and incident procedures are exercised.

## RPC and WebSocket layer

- Do not use shared public RPC endpoints as the production plan.
- Use explicit Mainnet and Devnet configurations with no silent fallback.
- Maintain at least one independent read/failover path for critical systems when the risk justifies it.
- Define provider, region, rate, archival/history, WebSocket, transaction-send, and enhanced/indexing requirements.
- Monitor HTTP and WebSocket latency, error rate, 403/429 responses, slot lag, skipped subscriptions, disconnects, and transaction-send success.
- Use bounded exponential backoff with jitter for transient reads; never turn a deterministic transaction error into an infinite retry loop.
- Compare slot and block context before accepting conflicting provider responses.
- Redact RPC credentials from logs, process lists, CI output, and CLI diagnostic output.

## Commitment and finality policy

Choose commitment per workflow:

- `processed` for low-latency previews that may roll back;
- `confirmed` for responsive user status where rollback handling exists;
- `finalized` for irreversible off-chain fulfillment, accounting, or governance evidence unless the product explicitly accepts lower finality.

Persist slot/block context with indexed data. A UI label must not present `processed` as final. Reconcile confirmed data to finalized state and handle fork rollback.

## Transaction landing service

Design the sender as a state machine, not a single RPC call:

1. create an application action/idempotency record;
2. resolve program/cluster and fetch a fresh lifetime value;
3. build the intended message version and explicit resource configuration;
4. simulate/estimate where appropriate;
5. obtain required signatures without leaking key material;
6. broadcast through the approved path;
7. persist the signature before waiting for confirmation;
8. poll/subscribe until the product's commitment threshold;
9. classify expired, dropped, failed, and confirmed outcomes;
10. reconcile canonical program state before retrying an ambiguous action.

For transaction v1, ensure builders and readers understand message configuration, absolute priority fees, and required compute/account-data limits. Do not insert legacy ComputeBudget instructions and assume they configure v1.

Record:

- action ID, user/request ID, cluster, program ID;
- message version, blockhash/nonce context, fee payer;
- simulation result and resource estimates;
- serialized message hash before signing;
- signature, send attempts, RPC path, status, slot, error/logs;
- canonical resulting state/event.

## Indexers, events, and webhooks

- Treat program accounts/transactions as canonical and the database as a rebuildable projection.
- Make ingestion idempotent using signature plus instruction/event index or another stable unique key.
- Persist slot, block time, program ID, event/version, and raw evidence needed to re-decode.
- Handle duplicate, delayed, out-of-order, missing, and rolled-back notifications.
- Build bounded backfill from a recorded cursor/slot and test it before incidents.
- Version event schemas and retain decoders for old deployed versions.
- Verify webhook authenticity where the provider supports it; enforce replay windows and deduplication.
- Reconcile balances, state totals, and terminal actions periodically against chain data.
- Alert on parser failures rather than silently dropping new event versions.

## Key management and authorities

Separate at minimum:

- permanent program-ID keypair;
- program upgrade authority;
- protocol admin/pause/fee authorities;
- deployer/fee payer;
- backend operational signers;
- mint/freeze authorities where applicable.

Controls:

- put production upgrade/admin authority behind suitable multisig, hardware, or institutional custody;
- keep hot service keys narrowly funded and narrowly authorized;
- never store seed phrases or raw keypair JSON in source, ordinary CI variables, logs, or build artifacts;
- use protected deployment environments and short-lived identity/federation where supported;
- restrict who can create, approve, and execute release proposals;
- record public keys and authority transitions in an inventory reconciled to chain;
- rehearse lost signer, compromised signer, member replacement, and governance-deadlock procedures;
- rotate exposed operational keys, but understand a program-ID keypair cannot be “rotated” without changing identity.

## CI/CD release path

Recommended stages:

1. source and lockfile validation;
2. format, lint, unit, instruction, integration, invariant, and fuzz tests;
3. dependency, license, and secret scanning;
4. deterministic/verifiable build in a pinned image;
5. artifact, IDL, SDK, SBOM/provenance, and hash publication;
6. Devnet deployment and smoke/reconciliation tests;
7. security and release approval;
8. Mainnet proposal/build selection with exact hash;
9. protected execution;
10. post-deploy verify, smoke, monitor, and release record.

Untrusted pull requests must never receive production secrets. Deployment jobs must verify the commit and artifact rather than rebuilding an unreviewed workspace. Protect tags/branches and require review for workflow changes.

## Observability

### Protocol signals

- instruction successes/failures by stable error code;
- state-transition and value-flow events;
- invariant/reconciliation deltas;
- paused/emergency/admin operations;
- account growth and rent needs;
- compute usage and transaction size by path.

### Transaction signals

- build/simulate/send/land/confirm latency;
- expired, dropped, duplicate, and failed counts;
- priority fee and total fee;
- blockhash age and retry count;
- message-version decode failures;
- RPC/provider/region used.

### Infrastructure signals

- RPC latency/errors/rate limits/slot lag;
- WebSocket disconnect and subscription gaps;
- indexer cursor lag and backfill depth;
- webhook authenticity/dedup failures;
- queue depth, dead letters, worker retries;
- database errors and reconciliation age;
- CI release failures and authority mismatch alerts.

Logs must be structured and secret-safe. Include correlation IDs, program ID, cluster, signature, instruction/event index, and slot where relevant.

## SLOs and alerts

Define user-facing objectives for:

- transaction acceptance and final confirmation;
- read freshness;
- indexer lag;
- webhook processing;
- reconciliation age;
- incident acknowledgement and recovery.

Alert on impact or leading evidence, not every noisy RPC error. Each high-severity alert needs an owner, runbook, dashboard, containment action, and escalation path.

## Incident response

Prepare scenarios for:

- compromised or unavailable authority;
- malicious/buggy upgrade;
- protocol invariant break;
- stuck funds or liveness failure;
- oracle failure/manipulation;
- RPC/provider outage or inconsistent reads;
- indexer divergence;
- leaked signer/RPC secret;
- transaction-version incompatibility;
- partial migration;
- governance deadlock.

Incident flow:

1. establish incident command and preserve evidence;
2. identify cluster, programs, authorities, assets, and affected slots;
3. contain using pre-authorized pause/disable controls without blocking safe exits unnecessarily;
4. stop automated retries or migrations that can deepen impact;
5. reconcile canonical chain state;
6. choose rollback, forward fix, migration, or communication path;
7. execute through approved governance;
8. verify recovery and monitor recurrence;
9. document root cause, trigger, control gaps, and corrective actions.

Do not improvise a pause key or upgrade path during the incident; design and rehearse it beforehand.

## Capacity and cost

Model:

- program and account rent/allocation;
- transaction base and priority fees, including failures;
- RPC calls, WebSocket connections, history/archive reads, and egress;
- indexer/database growth and backfill time;
- peak account-lock contention and hot-account throughput;
- compute and loaded-account-data headroom;
- deployment binary growth and ProgramData extension;
- multisig/custody and audit operations.

Performance testing should use representative account sizes, CPI paths, token extensions, concurrency, and Mainnet-like latency—not empty local state alone.

## Production readiness verdict

Return `GO`, `GO WITH CONTROLS`, or `NO-GO` based on evidence across:

- identity and authority;
- build reproducibility;
- protocol security and tests;
- transaction/client compatibility;
- RPC/landing/indexing resilience;
- observability and reconciliation;
- incident response and rollback;
- approvals and residual risk.

List each missing control with owner, due condition, and whether it blocks deployment.
