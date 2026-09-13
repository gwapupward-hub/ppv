# Release candidates

One file per program queued for its initial devnet release. A file here means
three things:

- **CI runs the release-tier invariant budget** on any pull request that touches
  this directory — 200 sequences of up to 32 actions across five seeds, floor
  12,000 operations, rather than the PR budget. The heavy gate runs on the change
  that declares a release, which is the only moment it is actually needed.
- **`scripts/prepare-release-candidate.mjs <program>`** will emit the exact
  approval message for the current commit, but only once every identity source
  agrees and the tree is clean.
- **The program is not yet released.** The moment its record lands in
  `deployments/evidence/`, the initial-deployment path refuses it forever and
  this file should be deleted.

## No commit sha lives here

Deliberately. A file naming its own commit cannot be written, and a file naming
a different commit is a second source of truth that will drift. The candidate
commit is the one the operator dispatches the deploy workflow against, and the
workflow binds it from its own checkout — never from dispatcher input. Approvals
are signed over that commit and are void for any other.
