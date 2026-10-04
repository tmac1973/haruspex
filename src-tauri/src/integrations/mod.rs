//! Optional third-party service integrations.
//!
//! Each integration module exposes its own set of Tauri commands and is
//! opt-in from the frontend Settings UI. Integrations are disabled by
//! default — the tools they provide do not appear to the agent until the
//! user explicitly adds and enables credentials for them.
//!
//! Current integrations:
//!
//! - `email` — multi-provider IMAP reading, and SMTP sending of drafts the
//!   user reviews.
//! - `mcp` — the general MCP client for the long tail of third-party
//!   services. Built in phases; see `plan/integrations-expansion/`. Process
//!   lifecycle landed first, before any protocol work.
//! - `dav` — CalDAV calendars and (from Phase 11) CardDAV contacts, over
//!   basic auth against the user's own server.
//!
//! Calendar and contacts arrive as CalDAV/CardDAV rather than as hand-built
//! per-vendor modules; anything Google-shaped ships as a curated MCP config.

pub mod dav;
pub mod email;
pub mod mcp;
