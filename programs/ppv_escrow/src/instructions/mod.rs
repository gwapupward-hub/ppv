pub mod cancel;
pub mod custody;
pub mod decide_proof;
pub mod fund;
pub mod initialize_agreement;
pub mod mark_completed;
pub mod milestone;
pub mod open_dispute;
pub mod refund;
pub mod resolve_dispute;
pub mod settle;
pub mod submit_proof;

// Anchor's `#[program]` macro resolves the generated `__client_accounts_*`
// modules through these globs, so each handler carries its own name rather than
// four ambiguous `handler`s.
pub use cancel::*;
pub use decide_proof::*;
pub use fund::*;
pub use initialize_agreement::*;
pub use mark_completed::*;
pub use milestone::*;
pub use open_dispute::*;
pub use refund::*;
pub use resolve_dispute::*;
pub use settle::*;
pub use submit_proof::*;
