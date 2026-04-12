//! Optional third-party service integrations.
//!
//! Each integration module exposes its own set of Tauri commands and is
//! opt-in from the frontend Settings UI. Integrations are disabled by
//! default — the tools they provide do not appear to the agent until the
//! user explicitly adds and enables credentials for them.
//!
//! Current integrations:
//!
//! - `email` — multi-provider IMAP email access (read-only in Phase 10.1).
//!   See the phase 10 planning doc in `plan/phase-10-email-integration.md`.
//!
//! Future integrations that will live here: Google Calendar / Drive /
//! Docs, and eventually a general MCP client for the long tail.

pub mod email;
