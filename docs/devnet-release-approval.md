# PPV Devnet Release Approval

Because native GitHub environment required-reviewer protection is unavailable for this private repository on the current GitHub plan, PPV devnet deployments require cryptographic approval from two distinct configured Squads members before deployment.

## Required approval message

Each of the two approvers independently signs the exact same UTF-8 message:

```text
PPV_DEVNET_RELEASE_V1
program=<program>
program_id=<program_id>
commit=<commit_sha>
cluster=devnet
```

Where:

- `<program>` is exactly `ppv_core` or `ppv_commerce`.
- `<program_id>` is the committed permanent program ID for the selected program.
- `<commit_sha>` is the exact Git commit being deployed.
- `cluster` is exactly `devnet`.

No extra whitespace, blank lines, or fields are permitted. The message has no trailing newline.

Each detached Ed25519 signature must be supplied as **canonical standard padded Base64** (88 characters for a 64-byte signature).

## Workflow dispatch inputs

A manual workflow dispatch must provide `approver_1`, `signature_1`, `approver_2`, and `signature_2`, in addition to the selected program and typed program-name confirmation. The workflow takes `commit` from its own checked-out `github.sha` and resolves `program_id` from the committed `Anchor.toml`; neither is accepted as dispatcher-controlled input.

## Approval requirements

The workflow must fail unless all of the following are true:

1. Both supplied approval public keys are members of the configured `PPV_SQUADS_MEMBER_PUBKEYS` set.
2. The two approval public keys are distinct.
3. Both supplied signatures are valid for the exact same release message above.
4. The signed program matches the selected workflow program.
5. The signed program ID matches the permanent committed program identity.
6. The signed commit matches the checked-out Git commit.
7. The signed cluster is `devnet`.
8. At least two configured Squads members must therefore approve every deployment.

The approval keys are used only to approve the release message. No Squads transaction or program upgrade authority operation is performed by this approval step.

## Security intent

This approval is the compensating control for the unavailable native GitHub environment required-reviewer gate. It preserves the release-readiness requirement that each devnet deployment receive independent manual approval before deployment.
