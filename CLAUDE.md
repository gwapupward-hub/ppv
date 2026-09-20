# PPV build policy

Anchor/SBF builds are expensive and MUST NOT be run by default.

Before invoking `anchor build`, inspect the changed files and pick the
narrowest tier below that covers them.

The workspace programs are `ppv_core`, `ppv_escrow`, and `ppv_commerce`.

## No build

Do not invoke Anchor when changes are limited to:

- documentation
- Markdown
- frontend/UI
- scripts unrelated to programs
- non-program SDK changes
- comments
- formatting
- GitHub workflow/docs configuration

## Targeted fast build

If implementation code for exactly one Solana program changed:

```
anchor build -p <program> --no-idl
```

Never build unrelated PPV programs.

## IDL build

If instructions, account structs, instruction arguments, events, errors, or
public program types changed:

```
anchor build -p <program>
```

## Full workspace build

Only perform a full workspace build when:

- shared Rust dependencies change
- workspace `Cargo.toml` changes
- `Cargo.lock` changes materially
- Anchor/toolchain configuration changes
- multiple programs have coupled changes
- preparing a devnet/release candidate

## Verifiable build

`anchor build --verifiable` is release/deployment-only. Never run it during
ordinary implementation.

## Clean builds

Never run `anchor clean` or `cargo clean` unless diagnosing a confirmed
stale or corrupt build artifact problem. Preserve Cargo/target caches
whenever possible.

## Scope

This policy governs builds invoked locally during development. It does not
change what CI runs on its own; do not alter workflow behavior to suppress
CI builds without an explicit request.
