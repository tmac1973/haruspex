//! Research by email's record (`email_requests`): one row per request a job
//! has seen, ignored ones included. It stops a second answer, recognises
//! Haruspex's own replies, holds a thread's history for follow-ups, and feeds
//! Home's Email requests card.

use super::*;
use crate::integrations::email::auth_results::AuthResults;
use rusqlite::{params, OptionalExtension};

/// The states a request moves through. Open ones are the first three.
const STATES: [&str; 6] = [
    "waiting_sent",
    "researching",
    "sending",
    "answered",
    "failed",
    "ignored",
];
const REASONS: [&str; 4] = [
    "no_sent_copy",
    "daily_limit",
    "research_failed",
    "send_failed",
];
const REPLY_KINDS: [&str; 2] = ["answer", "failure"];

/// Ignored rows are kept this long.
const IGNORED_KEEP_MS: i64 = 30 * DAY_MS;
/// Answered and failed rows are kept this long.
const FINISHED_KEEP_MS: i64 = 180 * DAY_MS;
/// No row younger than this is pruned, so a reply's id stays known well past
/// the scan window.
const MIN_KEEP_MS: i64 = 7 * DAY_MS;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EmailRequestRow {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub job_id: i64,
    pub message_id: String,
    /// The root request's Message-ID.
    pub thread_id: String,
    pub references: Vec<String>,
    pub subject: String,
    /// The body with quoted text and signatures stripped.
    pub question: Option<String>,
    /// The answer's Markdown, or the failure note.
    pub answer: Option<String>,
    /// `answer` or `failure`.
    pub reply_kind: Option<String>,
    pub state: String,
    pub reason: Option<String>,
    pub auth: Option<AuthResults>,
    pub reply_message_id: Option<String>,
    #[ts(type = "number")]
    pub attempts: i64,
    #[ts(type = "number")]
    pub send_attempts: i64,
    #[ts(type = "number")]
    pub first_seen_at: i64,
    #[ts(type = "number | null")]
    pub claimed_at: Option<i64>,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number | null")]
    pub run_id: Option<i64>,
}

/// A request seen for the first time.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NewEmailRequest {
    #[ts(type = "number")]
    pub job_id: i64,
    pub message_id: String,
    pub thread_id: String,
    #[serde(default)]
    pub references: Vec<String>,
    pub subject: String,
    pub state: String,
    #[serde(default)]
    #[ts(optional)]
    pub reason: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub auth: Option<AuthResults>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub run_id: Option<i64>,
}

/// A change to a row. A field left out stays as it is; `reason: ""` clears
/// the reason. `updated_at` is always set to now.
#[derive(Clone, Debug, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EmailRequestPatch {
    #[serde(default)]
    #[ts(optional)]
    pub thread_id: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub question: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub answer: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub reply_kind: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub state: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub reason: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub reply_message_id: Option<String>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub attempts: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub send_attempts: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub claimed_at: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub run_id: Option<i64>,
}

const COLS: &str = "id, job_id, message_id, thread_id, references_json, subject, question,
     answer, reply_kind, state, reason, auth_json, reply_message_id, attempts, send_attempts,
     first_seen_at, claimed_at, updated_at, run_id";

fn row_of(row: &rusqlite::Row) -> rusqlite::Result<EmailRequestRow> {
    let references: String = row.get(4)?;
    let auth: Option<String> = row.get(11)?;
    Ok(EmailRequestRow {
        id: row.get(0)?,
        job_id: row.get(1)?,
        message_id: row.get(2)?,
        thread_id: row.get(3)?,
        references: serde_json::from_str(&references).unwrap_or_default(),
        subject: row.get(5)?,
        question: row.get(6)?,
        answer: row.get(7)?,
        reply_kind: row.get(8)?,
        state: row.get(9)?,
        reason: row.get(10)?,
        auth: auth.and_then(|a| serde_json::from_str(&a).ok()),
        reply_message_id: row.get(12)?,
        attempts: row.get(13)?,
        send_attempts: row.get(14)?,
        first_seen_at: row.get(15)?,
        claimed_at: row.get(16)?,
        updated_at: row.get(17)?,
        run_id: row.get(18)?,
    })
}

fn check_one(value: &str, allowed: &[&str], what: &str) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("{value:?} is not an email request {what}"))
    }
}

impl Database {
    /// The job's row for one request, if it has seen it.
    pub fn email_request_get(
        &self,
        job_id: i64,
        message_id: &str,
    ) -> Result<Option<EmailRequestRow>, String> {
        self.conn()
            .query_row(
                &format!("SELECT {COLS} FROM email_requests WHERE job_id = ?1 AND message_id = ?2"),
                params![job_id, message_id],
                row_of,
            )
            .optional()
            .map_err(|e| format!("Email request read failed: {e}"))
    }

    /// Record a request; does nothing when the job already has it. Returns
    /// whether a row was added.
    pub fn email_request_insert(&self, new: &NewEmailRequest) -> Result<bool, String> {
        check_one(&new.state, &STATES, "state")?;
        let reason = new.reason.as_deref().filter(|r| !r.is_empty());
        if let Some(r) = reason {
            check_one(r, &REASONS, "reason")?;
        }
        let references = serde_json::to_string(&new.references).map_err(|e| e.to_string())?;
        let auth = new
            .auth
            .map(|a| serde_json::to_string(&a))
            .transpose()
            .map_err(|e| e.to_string())?;
        let now = chrono_now();
        let n = self
            .conn()
            .execute(
                "INSERT OR IGNORE INTO email_requests
                     (job_id, message_id, thread_id, references_json, subject, state, reason,
                      auth_json, first_seen_at, updated_at, run_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
                params![
                    new.job_id,
                    new.message_id,
                    new.thread_id,
                    references,
                    new.subject,
                    new.state,
                    reason,
                    auth,
                    now,
                    new.run_id
                ],
            )
            .map_err(|e| format!("Email request insert failed: {e}"))?;
        Ok(n > 0)
    }

    /// Change the fields the patch gives.
    pub fn email_request_update(&self, id: i64, patch: &EmailRequestPatch) -> Result<(), String> {
        if let Some(s) = &patch.state {
            check_one(s, &STATES, "state")?;
        }
        if let Some(r) = patch.reason.as_deref().filter(|r| !r.is_empty()) {
            check_one(r, &REASONS, "reason")?;
        }
        if let Some(k) = &patch.reply_kind {
            check_one(k, &REPLY_KINDS, "reply kind")?;
        }
        let clear_reason = patch.reason.as_deref() == Some("");
        let reason = patch.reason.as_deref().filter(|r| !r.is_empty());
        self.conn()
            .execute(
                "UPDATE email_requests SET
                     thread_id = COALESCE(?2, thread_id),
                     question = COALESCE(?3, question),
                     answer = COALESCE(?4, answer),
                     reply_kind = COALESCE(?5, reply_kind),
                     state = COALESCE(?6, state),
                     reason = CASE WHEN ?7 THEN NULL ELSE COALESCE(?8, reason) END,
                     reply_message_id = COALESCE(?9, reply_message_id),
                     attempts = COALESCE(?10, attempts),
                     send_attempts = COALESCE(?11, send_attempts),
                     claimed_at = COALESCE(?12, claimed_at),
                     run_id = COALESCE(?13, run_id),
                     updated_at = ?14
                 WHERE id = ?1",
                params![
                    id,
                    patch.thread_id,
                    patch.question,
                    patch.answer,
                    patch.reply_kind,
                    patch.state,
                    clear_reason,
                    reason,
                    patch.reply_message_id,
                    patch.attempts,
                    patch.send_attempts,
                    patch.claimed_at,
                    patch.run_id,
                    chrono_now()
                ],
            )
            .map_err(|e| format!("Email request update failed: {e}"))?;
        Ok(())
    }

    fn email_requests_where(
        &self,
        clause: &str,
        args: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<EmailRequestRow>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!("SELECT {COLS} FROM email_requests WHERE {clause}"))
            .map_err(|e| format!("Email requests query failed: {e}"))?;
        let rows = stmt
            .query_map(args, row_of)
            .map_err(|e| format!("Email requests query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Email request row read failed: {e}"))
    }

    /// The job's latest rows, newest first.
    pub fn email_requests_list(
        &self,
        job_id: i64,
        limit: i64,
    ) -> Result<Vec<EmailRequestRow>, String> {
        self.email_requests_where(
            "job_id = ?1 ORDER BY first_seen_at DESC, id DESC LIMIT ?2",
            &[&job_id, &limit.clamp(1, 500)],
        )
    }

    /// The job's unfinished rows, oldest first.
    pub fn email_requests_open(&self, job_id: i64) -> Result<Vec<EmailRequestRow>, String> {
        self.email_requests_where(
            "job_id = ?1 AND state IN ('waiting_sent', 'researching', 'sending')
             ORDER BY first_seen_at, id",
            &[&job_id],
        )
    }

    /// Every row of one thread, oldest first.
    pub fn email_requests_thread(
        &self,
        job_id: i64,
        thread_id: &str,
    ) -> Result<Vec<EmailRequestRow>, String> {
        self.email_requests_where(
            "job_id = ?1 AND thread_id = ?2 ORDER BY first_seen_at, id",
            &[&job_id, &thread_id],
        )
    }

    /// The row whose reply has this Message-ID, in any job.
    pub fn email_request_by_reply_id(
        &self,
        reply_message_id: &str,
    ) -> Result<Option<EmailRequestRow>, String> {
        Ok(self
            .email_requests_where(
                "reply_message_id = ?1 ORDER BY id LIMIT 1",
                &[&reply_message_id],
            )?
            .into_iter()
            .next())
    }

    /// How many of the job's requests were claimed for research at or after
    /// `since_ms`.
    pub fn email_requests_count_since(&self, job_id: i64, since_ms: i64) -> Result<i64, String> {
        self.conn()
            .query_row(
                "SELECT count(*) FROM email_requests WHERE job_id = ?1 AND claimed_at >= ?2",
                params![job_id, since_ms],
                |r| r.get(0),
            )
            .map_err(|e| format!("Email request count failed: {e}"))
    }

    /// Drop the job's old finished rows. Returns how many went.
    pub fn email_requests_prune(&self, job_id: i64) -> Result<usize, String> {
        self.email_requests_prune_at(job_id, chrono_now())
    }

    pub(super) fn email_requests_prune_at(&self, job_id: i64, now: i64) -> Result<usize, String> {
        let young = now - MIN_KEEP_MS;
        self.conn()
            .execute(
                "DELETE FROM email_requests
                 WHERE job_id = ?1 AND updated_at < ?2 AND (
                     (state = 'ignored' AND updated_at < ?3)
                     OR (state IN ('answered', 'failed') AND updated_at < ?4)
                 )",
                params![job_id, young, now - IGNORED_KEEP_MS, now - FINISHED_KEEP_MS],
            )
            .map_err(|e| format!("Email request prune failed: {e}"))
    }
}
