# GWAP MASTER integration

Canonical cross-system authority:
https://github.com/gwapupward-hub/gwapspot-web/blob/main/docs/master/README.md

PPV remains the authoritative source for PPV-local protocol invariants, custody boundaries, deployment gates, threat model, and release evidence.

## Resolution order for PPV work

1. Explicit Founder decision.
2. PPV repo-local protocol/security/release documents and current deployed reality.
3. GWAP MASTER for cross-system architecture, source routing, payment boundaries, and shared decision status.
4. Current official Solana protocol/specification evidence.
5. Pinned upstream tooling/repositories.
6. examples/templates/community sources.

GWAP MASTER cannot authorize PPV escrow/custody deployment, mainnet deployment, upgrade-authority changes, or a release that fails PPV's local gates.

## Cross-system changes that must consult MASTER

- GwapOS integration contract changes;
- GNS identity/reference changes;
- GwapScore event/reputation contract changes;
- Kora/paymaster or signer changes;
- MPP/x402/Pay Kit integration;
- transaction-version migrations;
- shared IDL/release evidence conventions;
- digital-asset or marketplace coupling.

## Release evidence

PPV's existing deployment manifests and `deployments/evidence/` remain canonical for PPV releases. MASTER may index or summarize them; it does not replace them.
