/// Namespace of the agreement account. The creator is part of the seed so the
/// same numeric `agreement_id` under a different creator is a different
/// account, and no wallet can front-run another wallet's id.
pub const AGREEMENT_SEED: &[u8] = b"agreement";

/// Namespace of the per-agreement vault authority. There is deliberately no
/// global vault authority: the only PDA that can move an agreement's tokens is
/// derived from that agreement's own address.
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault";

/// Namespace of the per-agreement token vault.
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
