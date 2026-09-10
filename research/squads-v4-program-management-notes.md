# Squads v4 Program Management — PPV Devnet Notes

**Source:** [Squads Docs — Programs](https://docs.squads.so/main/navigating-your-squad/developers-assets/programs), accessed 2026-09-07.

## Official workflow extracted

Squads supports assigning a Squad multisig as the upgrade authority for Solana programs. The documentation describes a **Safe Authority Transfer (SAT)** workflow: add the CLI tool to the Squad, create a SAT, approve the transaction until the confirmation threshold is reached, execute it with the added CLI tool, and confirm the authority transfer.

For later upgrades, the documented sequence is to create an upgrade buffer with `solana program write-buffer <PROGRAM_FILEPATH>`, add the upgrade in the Squads program interface with the buffer address, spill/refund address, and commit link, set the buffer authority to the address Squads provides and verify it, then approve and execute the Squads upgrade transaction.

Squads also documents a change-authority flow, initiated from a program entry, to withdraw or transfer program upgrade authority.

## PPV relevance

PPV's release-readiness policy requires a program-derived Squads vault, a threshold of at least two, and the permanent `ppv_core` and `ppv_commerce` program IDs. The official SAT process is the applicable handoff once both permanent program binaries have been deployed and independently verified on devnet.

## Sources

1. [Squads Docs — Programs](https://docs.squads.so/main/navigating-your-squad/developers-assets/programs)
2. [Squads Protocol v4 GitHub repository](https://github.com/Squads-Protocol/v4)

> These notes capture public documentation only. They do not create a Squad, transfer authority, or deploy any program.

## Squad membership and threshold configuration

**Source:** [Squads Docs — Create a Squad](https://docs.squads.so/main/getting-started/create-a-squad), accessed 2026-09-07.

Squads instructs operators to add members by public key and select a confirmation threshold. The threshold is the number of member approvals required before a transaction can execute; for example, a 2-of-3 configuration requires approvals from two of three member wallets. Squads cautions against 1-of-1 configurations because they create a single point of failure and against requiring the maximum number of members because loss of a single wallet can block operations. Up to ten members can be added at initial creation; later membership changes require approval under the configured threshold.

For PPV, this supports a minimum 2-of-N policy with independent member wallets and documented recovery/availability procedures. The exact vault public key, member public keys, and threshold are inputs required by PPV's deployment-grade readiness checker.
