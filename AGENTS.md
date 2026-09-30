# AGENTS.md

## PPV local authority

Before changing PPV behavior, read the relevant repo-local protocol, security, release, and deployment documentation. PPV's own invariants and release gates are authoritative for PPV-local behavior.

At minimum, security/release work should inspect:
- `README.md`
- `docs/deployment-gates.md`
- `docs/security-model.md`
- `docs/threat-model.md`
- applicable release/runbook documents
- `deployments/evidence/` when discussing deployed state

## GWAP MASTER

For cross-system architecture, external-source adoption, shared payment/signing policy, GNS/GwapScore/GwapOS boundaries, or shared release-evidence conventions, also read `docs/gwap-master.md`.

MASTER coordinates PPV with the wider GWAP ecosystem. It does not weaken PPV's stronger local custody/mainnet/security gates.

## Hard safety rules

- No mainnet deployment without explicit authorization.
- No custody activation because an external tool/repo makes it possible.
- No reuse of PPV program/custody authority as fee payer, automation signer, treasury signer, or unrelated application authority.
- No claim that a feature is live on a cluster without target-cluster evidence.
- Preserve exact release/build evidence when required by the PPV release workflow.
