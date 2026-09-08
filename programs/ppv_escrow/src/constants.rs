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

/// Namespace of an agreement-bound proof *decision*. The agreement is in the
/// seeds, so a decision recorded against one agreement can never be presented
/// for another.
///
/// Note what this account is not: it is not where the evidence lives. The
/// commitment itself is a `ppv_core::ProofRecord`, and this account records
/// what one agreement decided about it.
pub const PROOF_SEED: &[u8] = b"proof";

/// Domain separator for the `proof_id` ppv_escrow asks ppv_core to mint.
///
/// `ppv_core` lets an authority choose its own 16-byte `proof_id`. Escrow does
/// not pass that choice to the caller: it derives one deterministically from
/// the agreement and the proof index, so the core record's address is a pure
/// function of facts already on chain, and any observer can recompute it
/// without trusting an index. The domain prefix keeps escrow-minted ids from
/// ever colliding with a future derivation scheme.
pub const CORE_PROOF_ID_DOMAIN: &[u8] = b"ppv:escrow:core-proof:v1";

/// Namespace of a milestone. As with proofs, the agreement is in the seeds, so
/// one agreement's milestones cannot affect another's.
pub const MILESTONE_SEED: &[u8] = b"milestone";
