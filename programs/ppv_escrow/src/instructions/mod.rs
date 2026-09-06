pub mod fund;
pub mod initialize_agreement;
pub mod mark_completed;
pub mod settle;

// Anchor's `#[program]` macro resolves the generated `__client_accounts_*`
// modules through these globs, so each handler carries its own name rather than
// four ambiguous `handler`s.
pub use fund::*;
pub use initialize_agreement::*;
pub use mark_completed::*;
pub use settle::*;
