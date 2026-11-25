//! Multi-provider email integration: reading over IMAP, and sending over
//! SMTP — only ever a draft the user reviewed and sent from the dialog
//! (`email_compose` opens it; nothing sends on the model's say-so).
//!
//! This module splits the work across several files:
//!
//! - `provider` — built-in provider presets (Gmail, Fastmail, iCloud, …)
//! - `auth` — `EmailAccount` credential struct + validation
//! - `parser` — `NormalizedMessage` + `EmailListing` types and the
//!   RFC 5322 → normalized conversion via `mail-parser`
//! - `imap_client` — async-imap + tokio-rustls wrapper; connect,
//!   SEARCH, FETCH, BODY.PEEK, the kept session, saving to Sent
//! - `structure` — BODYSTRUCTURE → the text part a preview reads
//! - `text` — HTML to text and quote stripping
//! - `smtp_client` — lettre sending, and the reply a draft starts from
//! - `requests` — Research by email: request scan, the Sent-copy check,
//!   reply lookup and the job's folders
//! - `request_reply` — Research by email: the threaded reply to a request
//! - `watch` — Research by email: the IDLE inbox watchers that start a job
//!   when a request arrives
//! - `auth_results` — Authentication-Results → DKIM, SPF, DMARC
//! - `sub_agent` — email_summarize_message implementation (focused
//!   chat completion that compresses one message body)
//! - `commands` — `#[tauri::command]` handlers wired into `lib.rs`

pub mod auth;
pub mod auth_results;
pub mod body;
pub mod commands;
pub mod imap_client;
pub mod parser;
pub mod parts;
pub mod provider;
pub mod request_reply;
pub mod requests;
pub mod smtp_client;
pub mod structure;
pub mod sub_agent;
pub mod text;
pub mod watch;
