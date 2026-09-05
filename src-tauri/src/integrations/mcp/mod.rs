//! MCP client: process lifecycle and the protocol itself.
//!
//! Split deliberately. [`process`] owns the lifetime of a server's child
//! process — spawning, crash and hang handling, graceful stop — and [`orphans`]
//! owns the children that outlive the app. [`client`] owns everything that is
//! MCP: dual-era negotiation, discovery, tool calls. [`types`] is the narrow
//! projection of rmcp's model that the frontend consumes.
//!
//! Lifecycle was built first, and provably, before any of it knew what a
//! protocol message looked like.

pub mod client;
pub mod commands;
pub mod orphans;
pub mod process;
pub mod types;

pub use process::McpSupervisor;
