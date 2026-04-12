//! Multi-provider email integration (Phase 10.1 — read-only).
//!
//! See `plan/phase-10-email-integration.md` for the overall design.
//! This module splits the work across several files:
//!
//! - `provider` — built-in provider presets (Gmail, Fastmail, iCloud, …)
//! - `auth` — `EmailAccount` credential struct + validation
//! - `parser` — `NormalizedMessage` + `EmailListing` types and the
//!   RFC 5322 → normalized conversion via `mail-parser`
//! - `imap_client` — async-imap + tokio-rustls wrapper; connect,
//!   SEARCH, FETCH, BODY.PEEK
//! - `smtp_client` — lettre-based stub for Phase 10.2 sending
//! - `sub_agent` — email_summarize_message implementation (focused
//!   chat completion that compresses one message body)
//! - `commands` — `#[tauri::command]` handlers wired into `lib.rs`

pub mod auth;
pub mod commands;
pub mod imap_client;
pub mod parser;
pub mod provider;
pub mod smtp_client;
pub mod sub_agent;
