# Phase 03 — The email_requests table

**Depends on:** 01 (it stores `AuthResults` from the scan) · **Enables:** 04
(dedupe, daily cap, follow-ups, recovery), 05 (the card lists rows)

## Goal

A SQLite table with one row per request a Research by email job has seen,
including ignored ones, plus the commands to read and write it. It is the
record that stops a second answer, recognises Haruspex's own replies, holds a
thread's history for follow-ups, and feeds the Home card. The PR is labelled
`no-docs`.

## Files touched

- `src-tauri/src/db/mod.rs`: `CREATE TABLE IF NOT EXISTS email_requests` in
  the schema block (after `camera_events`, :787), with indexes.
- `src-tauri/src/db/email_requests.rs` (new): row and patch structs, queries.
- `src-tauri/src/db/commands.rs`: the `db_email_requests_*` commands.
- `src-tauri/src/db/tests.rs`: tests for the queries.
- `src-tauri/src/lib.rs`: register the commands.
- `src/lib/stores/emailRequests.ts` (new) and `emailRequests.test.ts`: typed
  wrappers over `invoke`.
- `src/lib/ipc/gen/*`: regenerated.

## Steps

1. Columns: `id INTEGER PRIMARY KEY`, `job_id TEXT NOT NULL` (references
   `jobs`, `ON DELETE CASCADE`), `message_id TEXT NOT NULL`, `thread_id TEXT
   NOT NULL` (the root request's Message-ID), `references_json TEXT NOT NULL`
   (the request's References, so a reply can be sent after the request has
   moved), `subject TEXT NOT NULL`, `question TEXT` (quote-stripped body),
   `answer TEXT` (Markdown, or the failure note), `reply_kind TEXT` (`answer`
   or `failure`), `state TEXT NOT NULL`, `reason TEXT`, `auth_json TEXT`,
   `reply_message_id TEXT`, `attempts INTEGER NOT NULL DEFAULT 0`,
   `send_attempts INTEGER NOT NULL DEFAULT 0`, `first_seen_at INTEGER NOT
   NULL`, `claimed_at INTEGER` (set when the request is claimed for
   research), `updated_at INTEGER NOT NULL`, `run_id TEXT`. `UNIQUE(job_id,
   message_id)`; indexes on `(job_id, updated_at)` and `reply_message_id`.
2. `state` is one of `waiting_sent`, `researching`, `sending`, `answered`,
   `failed`, `ignored`. `reason` is set for `ignored` and `failed`
   (`no_sent_copy`, `daily_limit`, `research_failed`, `send_failed`).
3. `EmailRequestRow` (`#[ts(export)]`) mirrors the columns, with `auth` as the
   `AuthResults` struct from Phase 01 and `references` as `Vec<String>`.
4. `EmailRequestPatch` (`#[ts(export)]`): every field `Option`, covering
   `thread_id`, `question`, `answer`, `reply_kind`, `state`, `reason`,
   `reply_message_id`, `attempts`, `send_attempts`, `claimed_at`, `run_id`. A field left out
   (`None`) leaves the column as it is; `reason` is cleared with an empty
   string, stored as NULL. `updated_at` is always set to now.
5. Commands: `db_email_requests_get(job_id, message_id)`,
   `db_email_requests_insert(row)` (insert-or-ignore on the unique key; returns
   whether it inserted), `db_email_requests_update(id, patch)`,
   `db_email_requests_list(job_id, limit)` (newest first),
   `db_email_requests_open(job_id)` (rows in `waiting_sent`, `researching` or
   `sending`, oldest first),
   `db_email_requests_thread(job_id, thread_id)` (oldest first),
   `db_email_requests_by_reply_id(reply_message_id)` (across every job, so
   no job ever mistakes any Haruspex reply for a request),
   `db_email_requests_count_since(job_id, since_ms)` (rows whose `claimed_at`
   is at or after a time; ignored and waiting rows have none), and
   `db_email_requests_prune(job_id)`.
6. `prune` deletes `ignored` rows older than 30 days and other finished rows
   (`answered`, `failed`) older than 180 days. It never deletes a row younger
   than 7 days, so a reply id stays known for well past the 48-hour scan
   window, and never deletes an open row.
7. `src/lib/stores/emailRequests.ts` wraps each with a literal `invoke`.
8. Run `./scripts/export-ipc-types.sh`.

## Build gate

`cargo fmt -- --check`, `cargo clippy`, `cargo test`; `npm run check`,
`npm run lint`, `npm run test`; IPC drift clean.

## Test plan

- Rust: insert twice with the same `(job_id, message_id)` inserts once;
  `thread` returns rows oldest first; `open` returns only open states;
  `count_since` counts by `claimed_at` and ignores rows without one;
  `by_reply_id` finds a row of another job; a patch leaves omitted
  fields alone and clears `reason` with `""`; deleting the job deletes its
  rows; `prune` keeps open rows and anything under 7 days old.
- TS: each wrapper calls the right command with the right argument names
  (mocked `invoke`).

## Commit

`feat(db): store research-by-email requests`

## Rollback

Revert the commit. The table is created with `IF NOT EXISTS` and nothing else
reads it; a leftover empty table after a revert is harmless.
