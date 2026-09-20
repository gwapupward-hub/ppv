# Solana protocol security review

Use this reference for security audits, high-risk implementation reviews, threat modeling, and Mainnet release readiness. A checklist helps coverage; it does not replace tracing actual value and authority paths.

## Review method

### 1. Define scope and value at risk

Identify exact commits, programs, IDs, clusters, SDKs, off-chain services, privileged keys, tokens, oracles, and governance components. Record what is excluded. Estimate the maximum value or authority a defect could affect.

### 2. Build a trust map

List:

- users, administrators, keepers, relayers, guardians, auditors, and multisig members;
- upgrade, pause, mint, freeze, close, withdraw, oracle, and fee authorities;
- external programs, token programs, hooks, oracles, RPCs, indexers, and webhooks;
- which data arrives from signers, accounts, instruction arguments, prior instructions, and off-chain systems;
- which failures can halt the protocol versus lose or redirect value.

### 3. Trace every privileged or value-moving path

For each instruction, follow authorization, account validation, state transition, arithmetic, CPI, token/SOL movement, emitted evidence, and retry behavior. Review failure and adversarial paths before declaring the happy path safe.

### 4. Prove invariants

Map every important invariant to the exact code check and at least one regression or property test. An invariant written only in documentation is a release gap.

## Account validation

Verify every account against all properties the instruction relies on:

- expected address or PDA seeds and canonical bump;
- owner program;
- signer and writable privileges;
- executable flag for program accounts;
- discriminator/type, layout version, and minimum/exact data length;
- initialized/uninitialized state and allowed lifecycle state;
- authority relationships such as `has_one` or equivalent explicit comparison;
- mint, token-account authority, token program, associated-token derivation, and extension state;
- sysvar identity rather than merely compatible data;
- uniqueness when two logical roles must not use the same mutable account.

Treat `UncheckedAccount`, raw `AccountInfo`, manual deserialization, `remaining_accounts`, and unchecked loader APIs as review hotspots. Require a documented reason and explicit checks.

### Duplicate-account and aliasing risk

An attacker may pass the same account into two roles. Determine whether aliasing breaks conservation, bypasses role separation, or causes double counting. Do not rely on account names to imply distinctness. Anchor's duplicate-mutable protections have type-specific limits; verify the actual account types and framework version.

## Authorization and confused-deputy risk

- A public key stored in state is not authorization unless the matching account signs when required.
- Validate both the caller and the state relationship granting permission.
- Distinguish payer, owner, authority, delegate, close authority, and upgrade authority.
- Ensure a PDA signer authorizes only the intended CPI and destination.
- Domain-separate admin, user, vault, receipt, and proposal PDAs.
- Prevent a caller from substituting an arbitrary program, mint, vault, recipient, oracle, or fee account.
- Require explicit thresholds, proposal identity, replay protection, and expiry for multisig/governance actions.
- Verify emergency roles cannot silently expand into unlimited withdrawal or upgrade power.

## Initialization, reinitialization, close, and realloc

- Prevent reinitialization from overwriting an existing authority or state.
- Review every `init_if_needed` path for takeover and partially initialized accounts.
- Ensure account creation uses the intended payer, owner, size, and seeds.
- On close, enforce terminal state, correct recipient, and no remaining claimable value.
- Prevent revival or reuse of closed logical state through stale receipts or nonces.
- Bound realloc size and growth frequency; validate payer and zeroing behavior.
- Do not shrink accounts that intentionally hold excess lamports without accounting for the refund behavior. Anchor's current subtractive realloc behavior can send excess lamports to the realloc payer.

## Serialization and type safety

- Validate discriminators and reject all-zero or ambiguous type markers.
- Check length before deserialization, especially zero-copy and manually parsed accounts.
- Treat account version changes as an ABI migration.
- Reject trailing or malformed data when canonical encoding matters.
- Review enum/tag handling and default values for invalid state acceptance.
- Ensure events and IDLs do not disagree with the deployed binary.

## Arithmetic and economic integrity

- Use checked add/subtract/multiply/divide and safe conversions.
- Check order of operations, precision loss, rounding beneficiary, and dust accumulation.
- Reject zero or nonsensical amounts where they create state or bypass fees.
- Bound fees, prices, leverage, slippage, timestamps, deadlines, and list lengths.
- Prove conservation across deposit, escrow, settlement, cancellation, refund, fee, and close paths.
- Test maximum values and repeated partial operations.
- Review economic attacks: sandwiching, stale pricing, oracle manipulation, griefing, cheap state growth, lock contention, liquidation races, and incentives to block liveness.

## PDA safety

- Use unambiguous domain-separated seeds.
- Bound or hash user strings and document normalization.
- Verify canonical bump use unless a noncanonical bump is deliberate and securely stored.
- Check for seed collisions across account types and versions.
- Never allow attacker-controlled seeds to make a privileged PDA overlap another logical role.
- Confirm signer seed order and program ID match the derived address used in CPI.

## CPI, return data, and reentrancy

- Validate the invoked program ID and executable account.
- Validate every account passed through to the callee, not only accounts used before the CPI.
- Do not grant writable or signer privileges beyond need.
- Treat caller-controlled remaining accounts as untrusted.
- Validate the program ID associated with CPI return data before decoding it.
- Reload accounts after a CPI if their data, lamports, ownership, or token balance may have changed.
- Consider direct self-recursion and callback-style behavior even though indirect runtime reentrancy is restricted.
- Bound CPI depth, account count, instruction data, compute, and returned-data assumptions using the target feature set.

## Token and Token-2022 safety

- Validate exact token program, mint, vault, token-account authority, and destination.
- Verify the token account's base owner is the token program and its internal authority is correct.
- Do not assume transfer amount received equals amount sent when transfer-fee extensions apply.
- Evaluate transfer hooks and all extra accounts as a callback surface.
- Check permanent delegates, close authority, freeze/pause state, default account state, confidential features, interest-bearing behavior, metadata/group pointers, and any extension relevant to accepted mints.
- Allocate Token-2022 accounts using actual extension sizes.
- Maintain an explicit supported-extension policy; reject unknown or unsafe combinations.
- Test original Token Program and Token-2022 separately if both are accepted.

## Oracle and time safety

- Pin expected feed/product identity and program.
- Validate status, publish time/slot, confidence interval, exponent/decimals, and maximum age.
- Define behavior when the feed is stale, missing, halted, or extreme.
- Distinguish slots from wall-clock seconds.
- Do not assume cluster time is exact or strictly increasing at sub-slot granularity.
- Prevent a user from choosing the oracle account or fallback price unless the design explicitly authorizes it.

## Instruction introspection and signatures

- When inspecting prior instructions, validate the instructions sysvar address, index/order, invoked verification program, public key, message bytes, and signature result.
- Domain-separate signed messages with protocol name, cluster/genesis context, program ID, action, nonce, expiry, and all economically relevant fields.
- Prevent replay across users, actions, clusters, program upgrades, and environments.
- Mark nonces consumed atomically with the protected transition.
- Do not accept a frontend “verified” flag as on-chain proof.

## State machine and liveness

- Enumerate every legal transition; reject skipped, repeated, and backward transitions.
- Make settlement/cancellation mutually exclusive.
- Ensure timeouts cannot be bypassed or create permanent lockup.
- Design idempotent retries for relayers and off-chain workers.
- Prevent one party from indefinitely blocking funds if the product promises unilateral timeout recovery.
- Verify pause semantics: which actions stop, which exits remain available, and who can unpause.
- Test concurrent transactions against the same accounts and expected account-lock behavior.

## Upgrade and governance security

- Verify on-chain upgrade authority, not only configuration files.
- Prefer a production multisig/custody path with separation of proposer, reviewer, and executor.
- Protect the permanent program-ID keypair separately from upgrade authority material.
- Require immutable commit, reproducible artifact, artifact hash, proposal payload review, and an approval record.
- Model compromised signer, lost signer, governance deadlock, malicious upgrade, and emergency response.
- Making a program immutable is irreversible; require a mature audit, migration strategy, and explicit final authorization.
- A rollback is another upgrade. It works only if the prior artifact is retained, authority remains available, and state migrations are backward compatible.

## Dependency, build, and supply-chain security

- Pin Rust toolchain, platform tools, Anchor, Node, package manager, and dependencies.
- Review lockfile diffs and source/git dependencies.
- Run dependency advisory and license checks appropriate to the stack.
- Generate artifacts in a controlled environment; retain hashes and build logs.
- Use verifiable builds where supported and compare the on-chain binary.
- Prevent untrusted pull requests from accessing deployment secrets.
- Use protected environments, short-lived credentials where available, and human approval for production.
- Detect secret files and deploy keypairs in Git history, artifacts, caches, and logs.

## Tests required by risk

At minimum, add tests for every finding and every material invariant. For protocols that custody or authorize meaningful value, include:

- negative authorization/account-substitution tests;
- stateful property tests and invariant checks;
- fuzzing of instruction data and transition sequences;
- malformed/undersized/oversized account data;
- duplicate account roles;
- token extension combinations;
- CPI failures and post-CPI state changes;
- arithmetic and rounding boundaries;
- replay, expiry, and nonce reuse;
- paused/emergency and recovery behavior;
- migration from every supported version;
- compute and account-size ceilings.

## Severity model

Use impact plus exploitability, then state confidence:

- **Critical:** credible unauthorized loss/control, arbitrary upgrade, or systemic permanent lock with practical exploitation.
- **High:** major loss, privilege escalation, or widespread denial requiring limited conditions.
- **Medium:** bounded loss, griefing, correctness or availability failure with meaningful preconditions.
- **Low:** limited impact, hard-to-exploit weakness, or localized operational failure.
- **Informational:** hardening, clarity, or maintainability improvement without a demonstrated security failure.

Do not inflate severity to sound cautious. Do not lower severity because no exploit script was written.

## Finding format

```text
ID / title:
Severity / confidence:
Affected code and version:
Invariant violated:
Evidence:
Attack or failure path:
Impact:
Preconditions:
Remediation:
Regression test:
Residual risk:
```

End the review with:

- release verdict: `GO`, `GO WITH CONTROLS`, or `NO-GO`;
- unresolved Critical/High/Medium findings;
- missing evidence and scope exclusions;
- required fixes and owners;
- tests/audit/rehearsal gates;
- authority, monitoring, incident-response, and rollback readiness.
