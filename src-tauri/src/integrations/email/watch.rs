//! Research by email: the inbox watcher.
//!
//! One task per Research by email job that picks up requests on arrival. It
//! keeps its own IMAP connection (never the kept session: IDLE ties a
//! session up) with INBOX selected, and waits in IDLE (RFC 2177). When the
//! server reports new mail, it checks the new messages the way a scan does
//! ([`requests::arrivals`]) and emits `email://watch-hit` for a request
//! candidate. The frontend then runs the job, which decides everything
//! again; a hit is only a hint, and a missed one is caught by the job's
//! schedule.
//!
//! - **IDLE is sent again every [`RENEW`]**: servers drop it after 30
//!   minutes, and home routers often drop a quiet connection sooner. The
//!   DONE that ends it is also the check that the connection still works.
//! - **A server without IDLE is polled** every [`POLL`] on the same
//!   connection.
//! - **Sleep is noticed by the wall clock.** Tokio's timers stop while the
//!   computer sleeps, and a connection that sat in IDLE through a suspend
//!   looks alive. A wait that took far longer on the wall clock than on the
//!   timer means the computer slept, so the task reconnects at once.
//! - **A reconnect looks from where the last connection stopped**, so mail
//!   that came in during the gap is still checked. The first connection
//!   looks for a request candidate still in the Inbox from the last
//!   [`LOOK_BACK_MS`] instead, which catches one that came while the app was
//!   closed: a handled request is moved out of the Inbox.
//! - **Errors back off** from [`BACKOFF_MIN`] to [`BACKOFF_MAX`].
//!
//! The watchers run only while the app is open.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_imap::extensions::idle::IdleResponse;
use serde::{Deserialize, Serialize};

use super::auth::{self, EmailAccount};
use super::imap_client::{connect_and_login, within, ImapSession, Timeouts, TIMEOUTS};
use super::requests;

/// How long one IDLE lasts before it is ended and sent again.
const RENEW: Duration = Duration::from_secs(10 * 60);
/// How often the wall clock is compared with the timer during IDLE.
const CHECK: Duration = Duration::from_secs(30);
/// How often a server without IDLE is asked for new mail.
const POLL: Duration = Duration::from_secs(2 * 60);
/// After new mail, how long the watcher waits for more before it looks, so a
/// burst is checked once.
const SETTLE: Duration = Duration::from_secs(2);
/// A wait this much longer on the wall clock than on the timer means the
/// computer slept.
const SLEPT_SLACK: Duration = Duration::from_secs(60);
/// The first wait before a failed connection is tried again, and the longest.
const BACKOFF_MIN: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);
/// How far back the first look goes, as far as a job's scan does.
const LOOK_BACK_MS: i64 = 48 * 60 * 60 * 1000;
/// A connection this old was healthy, so the next failure waits the least.
const HEALTHY: Duration = Duration::from_secs(60);

/// One job to watch for: its account and trigger phrase.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EmailWatchEntry {
    #[ts(type = "number")]
    pub job_id: i64,
    pub account: EmailAccount,
    pub phrase: String,
}

/// What one watcher is doing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EmailWatchState {
    /// Logging in.
    Connecting,
    /// Waiting in IDLE: new mail is seen within seconds.
    Idle,
    /// The server has no IDLE, so it is asked every two minutes.
    Polling,
    /// The last connection failed; the next try is after a wait.
    Retrying { reason: String },
}

/// One watcher's state, in `email_watch_status` and `email://watch-status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EmailWatchStatus {
    #[ts(type = "number")]
    pub job_id: i64,
    pub state: EmailWatchState,
}

/// The payload of `email://watch-hit`: a request candidate arrived.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EmailWatchHit {
    #[ts(type = "number")]
    pub job_id: i64,
}

/// Doubles from [`BACKOFF_MIN`] up to [`BACKOFF_MAX`].
#[derive(Debug)]
struct Backoff(Duration);

impl Backoff {
    fn new() -> Self {
        Backoff(BACKOFF_MIN)
    }

    /// The wait before the next try; each call doubles the one after.
    fn next(&mut self) -> Duration {
        let wait = self.0;
        self.0 = (self.0 * 2).min(BACKOFF_MAX);
        wait
    }

    fn reset(&mut self) {
        self.0 = BACKOFF_MIN;
    }
}

/// Whether a wait the timer measured as `expected` took so much longer on
/// the wall clock that the computer must have slept. A clock set back is
/// not sleep.
fn slept(before: SystemTime, after: SystemTime, expected: Duration) -> bool {
    after
        .duration_since(before)
        .is_ok_and(|wall| wall > expected + SLEPT_SLACK)
}

/// Where the next look at the Inbox starts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Cursor {
    validity: u32,
    next: u32,
}

/// What to do after a (re)connect, given the cursor the last connection
/// left and what SELECT reports now.
#[derive(Debug, PartialEq, Eq)]
enum Resume {
    /// The first connection: look for a candidate still in the Inbox.
    Fresh,
    /// The same mailbox: look from where the last connection stopped.
    From(u32),
    /// UIDVALIDITY changed, so the old UIDs mean nothing: look as a first
    /// connection does.
    Reset,
}

fn resume(last: Option<Cursor>, validity: u32) -> Resume {
    match last {
        None => Resume::Fresh,
        Some(c) if c.validity == validity => Resume::From(c.next),
        Some(_) => Resume::Reset,
    }
}

/// Why a connection ended.
enum Stop {
    /// The computer slept: reconnect at once.
    Slept,
    Failed(String),
}

impl From<String> for Stop {
    fn from(e: String) -> Self {
        Stop::Failed(e)
    }
}

/// Which watchers to stop and which to start, to go from `running` to
/// `wanted` (job id → the entry's key). A changed entry is both.
fn plan(running: &HashMap<i64, String>, wanted: &HashMap<i64, String>) -> (Vec<i64>, Vec<i64>) {
    let mut stop: Vec<i64> = running
        .iter()
        .filter(|(id, key)| wanted.get(id) != Some(key))
        .map(|(id, _)| *id)
        .collect();
    let mut start: Vec<i64> = wanted
        .iter()
        .filter(|(id, key)| running.get(id) != Some(key))
        .map(|(id, _)| *id)
        .collect();
    stop.sort_unstable();
    start.sort_unstable();
    (stop, start)
}

/// What decides whether a watcher must restart: everything in its entry.
fn key_of(entry: &EmailWatchEntry) -> String {
    serde_json::to_string(entry).unwrap_or_default()
}

struct Running {
    key: String,
    /// Tells a task that was replaced not to report.
    generation: u64,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
struct State {
    running: HashMap<i64, Running>,
    states: HashMap<i64, EmailWatchState>,
    generation: u64,
}

/// The running inbox watchers, managed as app state.
#[derive(Clone, Default)]
pub struct EmailWatch {
    state: Arc<Mutex<State>>,
}

impl EmailWatch {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> Vec<EmailWatchStatus> {
        let s = self.lock();
        let mut out: Vec<EmailWatchStatus> = s
            .states
            .iter()
            .map(|(id, state)| EmailWatchStatus {
                job_id: *id,
                state: state.clone(),
            })
            .collect();
        out.sort_unstable_by_key(|s| s.job_id);
        out
    }

    fn emit(&self, app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("email://watch-status", self.status());
    }

    /// Watch exactly these jobs: start new ones, stop gone ones, and restart
    /// any whose account or phrase changed.
    pub fn set(&self, app: &tauri::AppHandle, entries: Vec<EmailWatchEntry>) {
        let wanted: HashMap<i64, EmailWatchEntry> =
            entries.into_iter().map(|e| (e.job_id, e)).collect();
        {
            let mut s = self.lock();
            let running: HashMap<i64, String> = s
                .running
                .iter()
                .map(|(id, r)| (*id, r.key.clone()))
                .collect();
            let keys: HashMap<i64, String> =
                wanted.iter().map(|(id, e)| (*id, key_of(e))).collect();
            let (stop, start) = plan(&running, &keys);
            for id in stop {
                if let Some(r) = s.running.remove(&id) {
                    r.task.abort();
                }
                s.states.remove(&id);
            }
            for id in start {
                let entry = wanted[&id].clone();
                s.generation += 1;
                let generation = s.generation;
                let (this, app) = (self.clone(), app.clone());
                let task = tauri::async_runtime::spawn(async move {
                    watch(this, app, generation, entry).await;
                });
                s.running.insert(
                    id,
                    Running {
                        key: keys[&id].clone(),
                        generation,
                        task,
                    },
                );
                s.states.insert(id, EmailWatchState::Connecting);
            }
        }
        self.emit(app);
    }

    /// Stop every watcher, on exit.
    pub fn stop_all(&self) {
        let mut s = self.lock();
        for (_, r) in s.running.drain() {
            r.task.abort();
        }
        s.states.clear();
    }

    /// Record and announce a watcher's state, unless it was replaced.
    fn report(&self, app: &tauri::AppHandle, job_id: i64, generation: u64, state: EmailWatchState) {
        {
            let mut s = self.lock();
            if s.running.get(&job_id).map(|r| r.generation) != Some(generation) {
                return;
            }
            if s.states.get(&job_id) == Some(&state) {
                return;
            }
            s.states.insert(job_id, state);
        }
        self.emit(app);
    }

    /// Tell the frontend a request candidate arrived, unless replaced.
    fn hit(&self, app: &tauri::AppHandle, job_id: i64, generation: u64) {
        use tauri::Emitter;
        if self.lock().running.get(&job_id).map(|r| r.generation) != Some(generation) {
            return;
        }
        let _ = app.emit("email://watch-hit", EmailWatchHit { job_id });
    }
}

/// One watcher's task: connect, watch, and on failure wait and connect
/// again, for as long as it is not aborted.
async fn watch(
    registry: EmailWatch,
    app: tauri::AppHandle,
    generation: u64,
    entry: EmailWatchEntry,
) {
    let job_id = entry.job_id;
    let ctx = Ctx {
        registry: &registry,
        app: &app,
        generation,
        entry: &entry,
    };
    let mut backoff = Backoff::new();
    let mut cursor: Option<Cursor> = None;
    loop {
        let began = Instant::now();
        let stop = match connection(&ctx, &mut cursor).await {
            Ok(never) => match never {},
            Err(stop) => stop,
        };
        if began.elapsed() >= HEALTHY {
            backoff.reset();
        }
        match stop {
            Stop::Slept => {
                log::info!("email watch for job {job_id}: the computer slept, reconnecting");
                registry.report(&app, job_id, generation, EmailWatchState::Connecting);
            }
            Stop::Failed(reason) => {
                let wait = backoff.next();
                log::warn!(
                    "email watch for job {job_id} failed, trying again in {} s: {reason}",
                    wait.as_secs()
                );
                registry.report(
                    &app,
                    job_id,
                    generation,
                    EmailWatchState::Retrying { reason },
                );
                tokio::time::sleep(wait).await;
            }
        }
    }
}

struct Ctx<'a> {
    registry: &'a EmailWatch,
    app: &'a tauri::AppHandle,
    generation: u64,
    entry: &'a EmailWatchEntry,
}

impl Ctx<'_> {
    fn report(&self, state: EmailWatchState) {
        self.registry
            .report(self.app, self.entry.job_id, self.generation, state);
    }

    fn hit(&self) {
        self.registry
            .hit(self.app, self.entry.job_id, self.generation);
    }
}

/// One connection, from login until it fails or the computer sleeps.
async fn connection(ctx: &Ctx<'_>, cursor: &mut Option<Cursor>) -> Result<Infallible, Stop> {
    let t = TIMEOUTS;
    let account = auth::resolve(&ctx.entry.account).await?;
    let host = account.imap_host.clone();
    let mut session = connect_and_login(&account, &t).await?;
    let caps = within(t.command, &host, "CAPABILITY", session.capabilities()).await?;
    let has_idle = caps.has_str("IDLE");
    let mailbox = within(t.command, &host, "SELECT INBOX", session.select("INBOX")).await?;
    let validity = mailbox.uid_validity.unwrap_or(0);
    let now_next = mailbox.uid_next.unwrap_or(1);
    let resume = resume(*cursor, validity);
    let c = cursor.insert(Cursor {
        validity,
        next: now_next,
    });
    match resume {
        Resume::Fresh | Resume::Reset => {
            let since_ms = crate::time_util::now_ms() - LOOK_BACK_MS;
            if requests::any_candidate(&mut session, &account, &ctx.entry.phrase, since_ms, &t)
                .await?
            {
                ctx.hit();
            }
        }
        Resume::From(next) => {
            c.next = next;
            look(ctx, &mut session, &account, c, &t).await?;
        }
    }
    if has_idle {
        ctx.report(EmailWatchState::Idle);
        idle_loop(ctx, session, &account, c, &t).await
    } else {
        ctx.report(EmailWatchState::Polling);
        poll_loop(ctx, session, &account, c, &t).await
    }
}

/// Check the new messages and announce a request candidate.
async fn look(
    ctx: &Ctx<'_>,
    session: &mut ImapSession,
    account: &EmailAccount,
    cursor: &mut Cursor,
    t: &Timeouts,
) -> Result<(), String> {
    let found = requests::arrivals(session, account, &ctx.entry.phrase, cursor.next, t).await?;
    cursor.next = found.next;
    if found.request {
        ctx.hit();
    }
    Ok(())
}

async fn idle_loop(
    ctx: &Ctx<'_>,
    mut session: ImapSession,
    account: &EmailAccount,
    cursor: &mut Cursor,
    t: &Timeouts,
) -> Result<Infallible, Stop> {
    let host = account.imap_host.as_str();
    let failed = |e: async_imap::error::Error| format!("IDLE on {host} failed: {e}");
    loop {
        let mut handle = session.idle();
        within(t.command, host, "IDLE", handle.init()).await?;
        let began = Instant::now();
        let mut wall = SystemTime::now();
        let mail = loop {
            let (wait, _interrupt) = handle.wait_with_timeout(CHECK);
            match wait.await.map_err(failed)? {
                IdleResponse::NewData(_) => break true,
                IdleResponse::ManualInterrupt => break false,
                IdleResponse::Timeout => {
                    let now = SystemTime::now();
                    if slept(wall, now, CHECK) {
                        return Err(Stop::Slept);
                    }
                    wall = now;
                    if began.elapsed() >= RENEW {
                        break false;
                    }
                }
            }
        };
        if mail {
            // More mail often follows (a burst, or the EXPUNGE of a move);
            // look once it has gone quiet.
            loop {
                let (wait, _interrupt) = handle.wait_with_timeout(SETTLE);
                match wait.await.map_err(failed)? {
                    IdleResponse::NewData(_) => continue,
                    _ => break,
                }
            }
        }
        session = within(t.command, host, "DONE", handle.done()).await?;
        if mail {
            look(ctx, &mut session, account, cursor, t).await?;
        }
    }
}

async fn poll_loop(
    ctx: &Ctx<'_>,
    mut session: ImapSession,
    account: &EmailAccount,
    cursor: &mut Cursor,
    t: &Timeouts,
) -> Result<Infallible, Stop> {
    loop {
        let wall = SystemTime::now();
        tokio::time::sleep(POLL).await;
        if slept(wall, SystemTime::now(), POLL) {
            return Err(Stop::Slept);
        }
        look(ctx, &mut session, account, cursor, t).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_its_limit_and_resets() {
        let mut b = Backoff::new();
        let waits: Vec<u64> = (0..10).map(|_| b.next().as_secs()).collect();
        assert_eq!(waits, vec![2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
        b.reset();
        assert_eq!(b.next(), BACKOFF_MIN);
    }

    #[test]
    fn a_wait_much_longer_on_the_wall_clock_means_the_computer_slept() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        assert!(!slept(t0, t0 + Duration::from_secs(31), CHECK));
        assert!(!slept(t0, t0 + Duration::from_secs(89), CHECK));
        assert!(slept(t0, t0 + Duration::from_secs(3600), CHECK));
        // A clock set back is not sleep.
        assert!(!slept(t0, t0 - Duration::from_secs(3600), CHECK));
    }

    #[test]
    fn a_reconnect_looks_from_where_the_last_connection_stopped() {
        assert_eq!(resume(None, 7), Resume::Fresh);
        let c = Cursor {
            validity: 7,
            next: 120,
        };
        assert_eq!(resume(Some(c), 7), Resume::From(120));
        assert_eq!(resume(Some(c), 8), Resume::Reset);
    }

    #[test]
    fn set_restarts_only_what_changed() {
        let map = |pairs: &[(i64, &str)]| -> HashMap<i64, String> {
            pairs.iter().map(|(id, k)| (*id, k.to_string())).collect()
        };
        let running = map(&[(1, "a"), (2, "b"), (3, "c")]);
        let wanted = map(&[(1, "a"), (2, "b2"), (4, "d")]);
        let (stop, start) = plan(&running, &wanted);
        assert_eq!(stop, vec![2, 3]);
        assert_eq!(start, vec![2, 4]);
        assert_eq!(plan(&running, &running), (vec![], vec![]));
    }

    #[test]
    fn the_status_serialises_with_a_state_tag() {
        let s = EmailWatchStatus {
            job_id: 5,
            state: EmailWatchState::Retrying {
                reason: "no route".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            serde_json::json!({ "jobId": 5, "state": { "state": "retrying", "reason": "no route" } })
        );
    }
}
