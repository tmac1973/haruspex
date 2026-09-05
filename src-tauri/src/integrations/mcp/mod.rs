//! MCP client: process lifecycle, and (from Phase 03) the protocol itself.
//!
//! Split deliberately. [`process`] owns the lifetime of a server's child
//! process — spawning, crash and hang handling, graceful stop — and [`orphans`]
//! owns the children that outlive the app. Neither knows anything about MCP
//! messages, which is what makes lifecycle provable before there is a protocol
//! to speak.

pub mod orphans;
pub mod process;

pub use process::McpSupervisor;
