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
use super::provider::{saves_sent_copy, EmailProviderPreset, PRESETS};
use super::smtp_client::{self, OutgoingMessage, ReplyContext};
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

/// Log in to the account's SMTP server without sending: Settings' check
/// when Allow sending is on.
#[tauri::command]
pub async fn email_test_smtp(account: EmailAccount) -> Result<(), String> {
    smtp_client::test_smtp(&account).await
}

/// What a send did.
#[derive(Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SendOutcome {
    /// The new message's Message-ID, without angle brackets.
    pub message_id: String,
    /// Why no copy was saved to Sent, when one could not be. The message
    /// itself was sent.
    #[ts(optional)]
    pub sent_copy_error: Option<String>,
}

/// Send a message the user approved in the review dialog, then file a copy
/// in Sent unless the provider does that itself. Only the dialog's Send
/// button invokes this.
#[tauri::command]
pub async fn email_send(
    account: EmailAccount,
    message: OutgoingMessage,
) -> Result<SendOutcome, String> {
    let sent = smtp_client::send_message(&account, &message).await?;
    let sent_copy_error = if saves_sent_copy(account.provider) {
        None
    } else {
        imap_client::append_sent(&account, &sent.raw)
            .await
            .err()
            .map(|e| format!("Sent, but could not save a copy to Sent: {e}"))
    };
    Ok(SendOutcome {
        message_id: sent.message_id,
        sent_copy_error,
    })
}

/// The reply to a listed message: recipients, subject, threading headers
/// and the quoted original, read through the bounded full-read path.
#[tauri::command]
pub async fn email_reply_context(
    account: EmailAccount,
    message_id: String,
    call_id: Option<String>,
) -> Result<ReplyContext, String> {
    let own = account.email_address.clone();
    let msg = cancellable(call_id, async move {
        imap_client::fetch_full(&account, &message_id).await
    })
    .await?;
    Ok(smtp_client::reply_context(&msg, &own))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn is_registered(id: &str) -> bool {
        running().lock().unwrap().contains_key(id)
    }

    #[tokio::test]
    async fn a_finished_call_returns_its_result_and_unregisters() {
        let id = "email-test-finished".to_string();
        let out = cancellable(Some(id.clone()), async { Ok::<_, String>(7) }).await;
        assert_eq!(out, Ok(7));
        assert!(!is_registered(&id));
    }

    #[tokio::test]
    async fn a_failed_call_keeps_its_own_error() {
        let out = cancellable(None, async { Err::<(), _>("login refused".to_string()) }).await;
        assert_eq!(out, Err("login refused".to_string()));
    }

    #[tokio::test]
    async fn email_cancel_stops_a_running_call_and_reports_cancelled() {
        let id = "email-test-cancel".to_string();
        let call = tokio::spawn(cancellable(Some(id.clone()), async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok::<_, String>(())
        }));
        // Wait for the call to register itself before cancelling it.
        for _ in 0..200 {
            if is_registered(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(is_registered(&id));
        email_cancel(id.clone());
        let out = tokio::time::timeout(Duration::from_secs(5), call)
            .await
            .expect("the call stopped")
            .unwrap();
        assert_eq!(out, Err("Cancelled".to_string()));
        assert!(!is_registered(&id));
    }

    #[test]
    fn cancelling_an_unknown_call_is_a_no_op() {
        email_cancel("email-test-never-started".to_string());
        assert!(!is_registered("email-test-never-started"));
    }

    #[tokio::test]
    async fn a_panicking_call_becomes_an_error_and_unregisters() {
        let id = "email-test-panic".to_string();
        let out: Result<(), String> =
            cancellable(Some(id.clone()), async { panic!("parser blew up") }).await;
        assert!(out.unwrap_err().starts_with("The email call failed"));
        assert!(!is_registered(&id));
    }

    #[test]
    fn summarizer_input_json_uses_camel_case_field_names() {
        let v = serde_json::to_value(SummarizerInputJson {
            subject: "s".to_string(),
            from_name: "Ann".to_string(),
            from_email: "ann@example.com".to_string(),
            date: "d".to_string(),
            body: "b".to_string(),
        })
        .unwrap();
        assert_eq!(v["fromName"], "Ann");
        assert_eq!(v["fromEmail"], "ann@example.com");
        assert!(v.get("from_name").is_none());
    }
}
