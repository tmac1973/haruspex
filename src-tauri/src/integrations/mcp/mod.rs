//! MCP client: from "add an integration" through to a tool call.
//!
//! Split so each layer can be proven on its own:
//!
//! - [`process`] owns the lifetime of a server's child process — spawning,
//!   crash and hang handling, graceful stop — and [`orphans`] owns the children
//!   that outlive the app. Neither knows what an MCP message is, which is what
//!   let lifecycle be built and tested before there was a protocol to speak.
//! - [`client`] owns everything that is MCP: dual-era negotiation, discovery,
//!   tool calls, over either transport. [`http`] is the remote one; [`types`] is
//!   the narrow projection of rmcp's model the frontend consumes.
//! - [`catalog`] is the bundled list of vetted servers, [`install`] puts one on
//!   the machine, and [`server_config`] is what the user's settings remember
//!   about it afterwards.
//! - [`companion`] handles the servers that bridge to an application we neither
//!   bundle nor install, which are healthy as processes and useless until that
//!   application is running.
//! - [`commands`] is the only place any of this meets Tauri.

pub mod catalog;
pub mod client;
pub mod commands;
pub mod companion;
pub mod http;
pub mod install;
pub mod orphans;
pub mod process;
pub mod server_config;
pub mod types;

pub use install::McpInstaller;
pub use process::McpSupervisor;
