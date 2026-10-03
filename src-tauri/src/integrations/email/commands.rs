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
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use tokio::task::AbortHandle;

fn running() -> &'static Mutex<HashMap<String, AbortHandle>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, AbortHandle>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Run a call as a task registered under `call_id`, so [`email_cancel`] can
/// stop it. The IMAP session it holds is dropped with it, never kept: see
/// `imap_client`'s checkout.
async fn cancellable<T: Send + 'static>(
    call_id: Option<String>,
    work: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    let task = tokio::spawn(work);
    let lock = || running().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(id) = &call_id {
        lock().insert(id.clone(), task.abort_handle());
    }
    let out = task.await;
    if let Some(id) = &call_id {
        lock().remove(id);
    }
    match out {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Err("Cancelled".to_string()),
        Err(e) => Err(format!("The email call failed: {e}")),
    }
}

/// Stop a call. An unknown id has already finished.
#[tauri::command]
pub fn email_cancel(call_id: String) {
    if let Some(h) = running()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&call_id)
    {
        h.abort();
    }
}

/// Log the account in afresh next time: it was edited in Settings.
#[tauri::command]
pub fn email_forget_session(account_id: String) {
    imap_client::forget(&account_id);
}

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
    call_id: Option<String>,
) -> Result<Vec<EmailListing>, String> {
    let filters = ListFilters {
        hours,
        since_date,
        from,
        subject_contains,
        // Enough headroom for a typical inbox-day, most of it noise the
        // model skips; it is told to summarise only 3–5.
        max_results: max_results.unwrap_or(imap_client::DEFAULT_MAX_RESULTS),
    };
    cancellable(call_id, async move {
        imap_client::list_recent(&account, &filters).await
    })
    .await
}

/// Return the full normalized message for one UID. Backs the
/// `email_read_full` tool (escape hatch for verbatim content).
#[tauri::command]
pub async fn email_read_full(
    account: EmailAccount,
    message_id: String,
    call_id: Option<String>,
) -> Result<NormalizedMessage, String> {
    cancellable(call_id, async move {
        imap_client::fetch_full(&account, &message_id).await
    })
    .await
}

/// Fetch a message and return the prepared `SummarizerInput` (body
/// stripped of quotes and truncated to the summarizer cap). The
/// actual LLM call lives in TypeScript so it reuses the existing
/// local-vs-remote inference routing.
#[tauri::command]
pub async fn email_prepare_summary(
    account: EmailAccount,
    message_id: String,
    call_id: Option<String>,
) -> Result<SummarizerInputJson, String> {
    let msg = cancellable(call_id, async move {
        imap_client::fetch_full(&account, &message_id).await
    })
    .await?;
    Ok(sub_agent::prepare(&msg).into())
}
