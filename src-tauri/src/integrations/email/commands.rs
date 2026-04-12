//! Tauri command handlers for the email integration.
//!
//! These are the public entry points the frontend invokes. They are
//! kept deliberately thin — structural validation happens on the
//! `EmailAccount` struct itself, and the real work lives in
//! `imap_client` and `sub_agent`. This file just glues arguments
//! together, dispatches, and normalizes errors into `Result<_, String>`
//! so the TS side can surface them as tool results.
//!
//! Tauri command parameter names use camelCase via serde — to match
//! what `@tauri-apps/api`'s `invoke` sends from JS — and we prefix
//! every handler's fn name with `email_` to stay consistent with the
//! other integrations (`fs_*`, `proxy_*`).

use super::auth::EmailAccount;
use super::imap_client::{self, ListFilters};
use super::parser::{EmailListing, NormalizedMessage};
use super::provider::{EmailProviderPreset, PRESETS};
use super::sub_agent::{self, SummarizerInput};
use serde::Serialize;

/// Serialized shape of `SummarizerInput` returned to the frontend.
/// Using a distinct `#[derive(Serialize)]` struct (instead of
/// serializing `SummarizerInput` directly) lets Rust keep the
/// business-logic type private and independent from the wire format.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizerInputJson {
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub date: String,
    pub body: String,
}

impl From<SummarizerInput> for SummarizerInputJson {
    fn from(v: SummarizerInput) -> Self {
        Self {
            subject: v.subject,
            from_name: v.from_name,
            from_email: v.from_email,
            date: v.date,
            body: v.body,
        }
    }
}

/// Returns the full list of built-in provider presets so the
/// frontend can render the provider dropdown and auto-fill
/// hostnames/ports when the user picks one.
#[tauri::command]
pub fn email_list_providers() -> Vec<EmailProviderPreset> {
    PRESETS.to_vec()
}

/// Validates credentials by connecting, logging in, and SELECTing
/// INBOX — no FETCH. Fast round-trip, safe to call from the
/// "Test connection" button on the Settings form.
#[tauri::command]
pub async fn email_test_connection(account: EmailAccount) -> Result<(), String> {
    imap_client::test_connection(&account).await
}

/// Fetch a list of recent messages matching the supplied filters.
/// Returns an array of `EmailListing` (metadata only — no bodies).
#[tauri::command]
pub async fn email_list_recent(
    account: EmailAccount,
    hours: Option<u32>,
    since_date: Option<String>,
    from: Option<String>,
    subject_contains: Option<String>,
    max_results: Option<u32>,
) -> Result<Vec<EmailListing>, String> {
    let filters = ListFilters {
        hours,
        since_date,
        from,
        subject_contains,
        max_results: max_results.unwrap_or(20),
    };
    imap_client::list_recent(&account, &filters).await
}

/// Return the full normalized message for one UID. Backs the
/// `email_read_full` tool (escape hatch for verbatim content).
#[tauri::command]
pub async fn email_read_full(
    account: EmailAccount,
    message_id: String,
) -> Result<NormalizedMessage, String> {
    imap_client::fetch_full(&account, &message_id).await
}

/// Fetch a message and return the prepared `SummarizerInput` (body
/// stripped of quotes and truncated to the summarizer cap). The
/// actual LLM call lives in TypeScript so it reuses the existing
/// local-vs-remote inference routing.
#[tauri::command]
pub async fn email_prepare_summary(
    account: EmailAccount,
    message_id: String,
) -> Result<SummarizerInputJson, String> {
    let msg = imap_client::fetch_full(&account, &message_id).await?;
    Ok(sub_agent::prepare(&msg).into())
}
