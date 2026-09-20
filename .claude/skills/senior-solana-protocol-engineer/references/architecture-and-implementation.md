# Architecture and implementation

Use this reference when designing a new protocol, extending an existing program, planning a migration, or implementing program/client code.

## Start with the protocol, not the framework

Write a compact protocol specification before editing code:

### 1. Intent and trust

- What outcome does the protocol guarantee?
- Which actors can create, fund, mutate, settle, cancel, pause, migrate, or close state?
- Which actors or services are trusted, partially trusted, or adversarial?
- Which assets can be lost, frozen, diluted, redirected, or made unavailable?
- Which external programs, oracles, hooks, relayers, indexers, or signers are dependencies?

### 2. State model

For every account type, record:

| Field | Required detail |
| --- | --- |
| Address | PDA seeds or keypair authority; domain separators; uniqueness scope |
| Owner | Exact program ID expected to own the account |
| Authority | Who may mutate it and how that relationship is proven |
| Lifecycle | Uninitialized, active states, terminal states, close behavior |
| Version | Serialization/layout version and migration behavior |
| Size | Maximum bounded allocation, realloc policy, rent implications |
| Value | Lamports/tokens held and the invariant governing them |

Draw the state transition graph when there are three or more meaningful states. Reject transitions not explicitly permitted. Terminal states should not silently become active again.

### 3. Instruction contract

For every instruction, specify:

- required signers and writable accounts;
- address, owner, executable, discriminator, mint, token authority, and relationship checks;
- instruction arguments and bounded ranges;
- permitted source state and resulting state;
- SOL/token movements and fee behavior;
- CPI targets and signer seeds;
- replay/idempotency key, expiry, and retry behavior;
- emitted event/receipt and stable custom errors;
- compute, account-data, transaction-size, and account-lock expectations.

### 4. Invariants

Write invariants in testable language. Typical categories:

- conservation: escrowed in = claimable + refunded + fees, with explicit rounding;
- authorization: only the stored authority or approved governance path can perform a privileged transition;
- uniqueness: one active account/claim/order per intended key;
- monotonicity: sequence numbers, nonces, settlement states, and totals cannot move backward;
- boundedness: supply, allocation, fee, duration, and vector/string lengths stay within declared limits;
- asset binding: vault, mint, token program, recipient, and authority cannot be substituted;
- liveness: a malicious or unavailable counterparty cannot lock funds forever when the design promises a timeout path;
- terminality: completed, cancelled, or closed states cannot be replayed.

## Choose the implementation model

### Anchor

Default to Anchor when rapid, auditable development, IDLs, account constraints, and team familiarity matter more than shaving every compute unit. Do not assume macros remove the need to understand account validation, CPI behavior, serialization, realloc, and runtime limits.

### Pinocchio

Use Pinocchio when binary size or compute savings are demonstrated requirements and the team can own lower-level account parsing and validation. Require stronger review and test evidence for every check Anchor would otherwise generate.

### Native Rust

Use native Rust when direct control of the ABI/runtime boundary is necessary. Document parsing, discriminator/type checks, ownership, privilege checks, and error mapping explicitly. “Fewer dependencies” is not enough by itself.

Do not migrate frameworks inside an urgent release repair unless the existing framework is the confirmed blocker and the migration risk is lower than the defect risk.

## Account and PDA design

- Begin PDA seeds with a stable domain tag such as `b"vault"`, `b"position"`, or `b"receipt"`.
- Include every dimension required for uniqueness, and document whether user-controlled bytes are normalized, hashed, or length-bounded.
- Use canonical bumps and persist a bump only when it improves cost or migration stability.
- Avoid ambiguous concatenation and seed schemas that can collide across account types.
- Never use a PDA as proof of authorization unless the program also validates the intended state and signer relationship.
- Version the seed schema if future derivation must change. A PDA address cannot be “migrated” in place.
- Decide whether account closure is allowed and who receives rent. Do not let an attacker choose a close recipient where value can be redirected.

## State, serialization, and migrations

- Add an explicit version field for state expected to evolve.
- Bound every variable-length field and allocate from the encoded maximum, not typical input.
- Prefer additive compatible changes when possible. Treat field reordering and type changes as ABI migrations.
- Make migrations resumable and idempotent. Record migrated version and progress so partial batches can resume safely.
- Rehearse migrations using a representative snapshot, including the largest accounts and oldest supported version.
- Separate program deployment from large data migration when doing both atomically would exceed compute, locks, or rollback tolerance.
- Preserve a decoder for old account/event versions until all downstream consumers have migrated.

## Arithmetic and economics

- Use checked operations and explicit integer widths.
- Define units in names or types: lamports, token base units, basis points, slots, and Unix seconds are not interchangeable.
- Specify rounding direction and who benefits from dust.
- Compute fees from validated gross/net amounts and prevent fee-on-fee drift.
- Test zero, one, maximum, just-over-maximum, and rounding-boundary values.
- Model rent, account creation, account growth, priority fees, and failed-transaction fees in the user flow.
- If an oracle is involved, validate feed identity, status, confidence, age, exponent/decimals, and failure behavior.

## Token integration

- Choose the original Token Program, Token-2022, or an explicitly supported interface. Validate the exact program ID.
- Bind token accounts to expected mint and authority; distinguish the base account owner from a token account's authority field.
- Check decimals only when the business rule depends on human units; store and calculate in base units.
- For Token-2022, enumerate supported and rejected extensions. Account for transfer fees, transfer hooks and their extra accounts, permanent delegates, close authority, confidential behavior, pausing, metadata/group pointers, and altered account sizing as applicable.
- Do not accept arbitrary hook or callback programs. Verify program identity and every forwarded account.
- Keep vault authority as a PDA where appropriate; never store its nonexistent private key.

## CPI and transaction composition

- Allowlist CPI program IDs and validate executable accounts.
- Forward only the signer/writable privileges that are required.
- Derive signer seeds from validated state, not untrusted account data alone.
- Re-read or reload accounts whose state or ownership may have changed during CPI before using cached assumptions.
- Include downstream compute, CPI depth, instruction count, account locks, loaded-account data, and return-data limits in tests.
- Choose legacy, v0, or v1 transactions based on current cluster/tool support and the exact account/resource requirements. Do not assume v1 is a drop-in encoding change.
- For v1, configure resource limits in the message and validate every downstream reader can decode v1.

## Client and IDL design

- Keep instruction builders typed and deterministic.
- Use generated clients where practical; check generated output or IDL hashes in CI.
- Reject ambiguous cluster or program-ID defaults in production clients.
- Simulate transactions when useful, but never treat simulation as authorization or finality.
- Make send logic safe against expired blockhashes, duplicate user actions, RPC timeouts, and “submitted but response lost” ambiguity.
- Record an application-level idempotency key before broadcast when a retry could create a second economic action.
- Set an explicit commitment/finality policy for each read and user-visible status.

## Repository shape

Prefer a structure that keeps protocol boundaries visible:

- program entrypoint and instruction modules;
- account/state definitions and versioning;
- error and event definitions;
- reusable validation/math helpers;
- typed SDK/client generation;
- tests organized by invariant and failure class;
- deployment configuration and release workflows;
- operational runbooks and security contacts.

Avoid giant instruction handlers and generic utility modules that hide authority or value-flow rules.

## Implementation workflow

1. Inspect existing conventions and version pins.
2. Add or update the protocol specification and invariant list.
3. Write negative tests for the failure being prevented.
4. Implement the smallest coherent change.
5. Run format, lint, unit, instruction, integration, and adversarial tests appropriate to the change.
6. Measure compute, account sizes, and transaction size on representative paths.
7. Regenerate IDLs/clients and inspect the diff.
8. Rehearse migration/deployment if state or ABI changed.
9. Hand off exact commands, evidence, risks, and remaining gates.

## Completion criteria

Implementation is not complete until:

- invariants are encoded in tests;
- unauthorized and invalid transitions fail with stable errors;
- client/IDL artifacts match the program;
- resource use stays within measured headroom;
- migration and rollback behavior are documented and exercised;
- security-sensitive diffs have an independent review proportional to risk;
- the deployment and monitoring path can prove the intended artifact is live.
