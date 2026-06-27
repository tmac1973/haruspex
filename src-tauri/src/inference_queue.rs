//! Process-wide admission control for inference turns.
//!
//! Every chat / shell / job turn POSTs to the single local `llama-server`
//! (one slot). The frontend used to gate this with a per-webview JS
//! semaphore, but that can't coordinate once shells are detached into
//! their own windows — each webview has its own JS context. So the gate
//! lives here, in Rust, shared across every window.
//!
//! Design (matches the old JS queue's observable behaviour):
//!   - FIFO. Capacity is 1 for local mode, unbounded when the frontend
//!     opts into remote parallel inference (`parallel = true`). The flag is
//!     re-sent on every acquire, mirroring the old "re-read setting at every
//!     acquire" semantics.
//!   - Each waiter holds a client-supplied `req_id` (unique per window) so
//!     it can be cancelled while still queued (abort-before-grant) and
//!     heartbeated while held.
//!   - State changes broadcast a full `inference://queue` snapshot to every
//!     window so each can render who is waiting / running.
//!
//! Orphan cleanup is belt-and-suspenders:
//!   - Primary: a window-destroyed listener (in `lib.rs`) calls
//!     `release_window`, dropping every ticket that window owned.
//!   - Backstop: a lease. A ticket whose holder neither releases nor
//!     heartbeats within `LEASE_TTL_MS` is reclaimed by the sweeper. The
//!     frontend heartbeats from acquire until release (covering the waiting
//!     period too), so a legitimately long multi-tool turn is never falsely
//!     reclaimed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// Backstop lease window. Generous: a long turn can sit minutes between
/// the frontend's heartbeats, and we'd rather leak a slot briefly than
/// yank one out from under a running turn.
const LEASE_TTL_MS: u64 = 5 * 60 * 1000;
/// How often the sweeper scans for expired leases.
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
/// Event name carrying the full queue snapshot to all windows.
const QUEUE_EVENT: &str = "inference://queue";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TicketState {
    Waiting,
    Running,
}

impl TicketState {
    fn as_str(self) -> &'static str {
        match self {
            TicketState::Waiting => "waiting",
            TicketState::Running => "running",
        }
    }
}

struct Ticket {
    id: String,
    /// Opaque consumer descriptor from the frontend (`"chat"`, `"shell"`,
    /// or `{kind:"job", jobName}`). Rust never interprets it — just echoes
    /// it back in the snapshot.
    consumer: Value,
    state: TicketState,
    owner_window: String,
    enqueued_at: u64,
    lease_expires_at: u64,
}

/// One entry in the broadcast snapshot. `id`/`enqueuedAt` aren't rendered
/// today but round-trip for completeness and future cross-window UI.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketDto {
    pub id: String,
    pub consumer: Value,
    pub state: &'static str,
    pub enqueued_at: u64,
}

#[derive(Default)]
struct Inner {
    /// FIFO order is the vec order. Holds both waiting and running tickets.
    tickets: Vec<Ticket>,
    /// Wakeups for waiting tickets, keyed by req_id. Removed on admit /
    /// cancel / release. Dropping a sender (without sending) resolves the
    /// waiter's receiver with an error → acquire reports "cancelled".
    senders: HashMap<String, oneshot::Sender<()>>,
    running: usize,
    /// Last-writer-wins, mirroring the old per-acquire settings read.
    parallel: bool,
}

impl Inner {
    fn capacity(&self) -> usize {
        if self.parallel {
            usize::MAX
        } else {
            1
        }
    }

    /// Admit waiting tickets in FIFO order while capacity allows, waking
    /// each via its oneshot sender.
    fn pump(&mut self) {
        let cap = self.capacity();
        for t in self.tickets.iter_mut() {
            if self.running >= cap {
                break;
            }
            if t.state == TicketState::Waiting {
                t.state = TicketState::Running;
                self.running += 1;
                if let Some(tx) = self.senders.remove(&t.id) {
                    let _ = tx.send(());
                }
            }
        }
    }

    fn snapshot(&self) -> Vec<TicketDto> {
        self.tickets
            .iter()
            .map(|t| TicketDto {
                id: t.id.clone(),
                consumer: t.consumer.clone(),
                state: t.state.as_str(),
                enqueued_at: t.enqueued_at,
            })
            .collect()
    }
}

#[derive(Default)]
pub struct InferenceQueue {
    inner: Mutex<Inner>,
}

impl InferenceQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a waiting ticket and return its wakeup receiver. The caller
    /// awaits the receiver; `pump` may have admitted it before this returns
    /// (oneshot buffers the value, so the await still resolves immediately).
    fn enqueue(
        &self,
        req_id: String,
        consumer: Value,
        parallel: bool,
        window_label: String,
    ) -> Result<oneshot::Receiver<()>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.tickets.iter().any(|t| t.id == req_id) {
            return Err("duplicate inference request id".into());
        }
        let now = now_ms();
        inner.parallel = parallel;
        let (tx, rx) = oneshot::channel();
        inner.senders.insert(req_id.clone(), tx);
        inner.tickets.push(Ticket {
            id: req_id,
            consumer,
            state: TicketState::Waiting,
            owner_window: window_label,
            enqueued_at: now,
            lease_expires_at: now + LEASE_TTL_MS,
        });
        inner.pump();
        Ok(rx)
    }

    /// Cancel a still-waiting ticket (abort-before-grant). No-op once the
    /// ticket is running — that path goes through `release`.
    fn cancel(&self, req_id: &str) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return false,
        };
        let pos = inner
            .tickets
            .iter()
            .position(|t| t.id == req_id && t.state == TicketState::Waiting);
        match pos {
            Some(pos) => {
                inner.tickets.remove(pos);
                inner.senders.remove(req_id); // drop -> receiver errors -> "cancelled"
                inner.pump();
                true
            }
            None => false,
        }
    }

    /// Release a held (or still-waiting) slot and admit the next waiter.
    fn release(&self, req_id: &str) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return false,
        };
        let pos = inner.tickets.iter().position(|t| t.id == req_id);
        match pos {
            Some(pos) => {
                let was_running = inner.tickets[pos].state == TicketState::Running;
                inner.tickets.remove(pos);
                inner.senders.remove(req_id);
                if was_running {
                    inner.running = inner.running.saturating_sub(1);
                }
                inner.pump();
                true
            }
            None => false,
        }
    }

    /// Refresh a ticket's lease. Cheap, no snapshot/emit (lease isn't part
    /// of the broadcast).
    fn heartbeat(&self, req_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            let now = now_ms();
            if let Some(t) = inner.tickets.iter_mut().find(|t| t.id == req_id) {
                t.lease_expires_at = now + LEASE_TTL_MS;
            }
        }
    }

    /// Drop every ticket owned by a window (primary orphan cleanup, called
    /// from the window-destroyed listener). Returns whether anything changed.
    fn release_window(&self, label: &str) -> bool {
        self.reclaim(|t| t.owner_window == label)
    }

    /// Reclaim tickets whose lease has expired as of `now` (backstop).
    fn sweep_expired_at(&self, now: u64) -> bool {
        self.reclaim(|t| t.lease_expires_at < now)
    }

    /// Shared removal core: drop every ticket matching `pred`, fixing the
    /// running count and pumping the next waiter. Dropping the senders of
    /// waiting victims resolves their receivers with an error.
    fn reclaim(&self, pred: impl Fn(&Ticket) -> bool) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return false,
        };
        let victims: Vec<String> = inner
            .tickets
            .iter()
            .filter(|t| pred(t))
            .map(|t| t.id.clone())
            .collect();
        if victims.is_empty() {
            return false;
        }
        let freed_running = inner
            .tickets
            .iter()
            .filter(|t| pred(t) && t.state == TicketState::Running)
            .count();
        inner.tickets.retain(|t| !pred(t));
        for id in &victims {
            inner.senders.remove(id);
        }
        inner.running = inner.running.saturating_sub(freed_running);
        inner.pump();
        true
    }

    fn snapshot(&self) -> Vec<TicketDto> {
        self.inner
            .lock()
            .map(|inner| inner.snapshot())
            .unwrap_or_default()
    }

    /// DTO for a single (presumably just-admitted) ticket.
    fn ticket_dto(&self, req_id: &str) -> Option<TicketDto> {
        let inner = self.inner.lock().ok()?;
        inner
            .tickets
            .iter()
            .find(|t| t.id == req_id)
            .map(|t| TicketDto {
                id: t.id.clone(),
                consumer: t.consumer.clone(),
                state: t.state.as_str(),
                enqueued_at: t.enqueued_at,
            })
    }

    fn emit_snapshot(&self, app: &AppHandle) {
        let _ = app.emit(QUEUE_EVENT, self.snapshot());
    }

    /// Called from the window-destroyed listener in `lib.rs`.
    pub fn on_window_destroyed(&self, app: &AppHandle, label: &str) {
        if self.release_window(label) {
            self.emit_snapshot(app);
        }
    }
}

/// Background task: periodically reclaim expired leases. Spawned once at
/// startup.
pub fn spawn_lease_sweeper(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SWEEP_INTERVAL).await;
            let queue = app.state::<InferenceQueue>();
            if queue.sweep_expired_at(now_ms()) {
                queue.emit_snapshot(&app);
            }
        }
    });
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn inference_acquire(
    app: AppHandle,
    state: tauri::State<'_, InferenceQueue>,
    req_id: String,
    consumer: Value,
    parallel: bool,
    window_label: String,
) -> Result<TicketDto, String> {
    let rx = state.enqueue(req_id.clone(), consumer, parallel, window_label)?;
    state.emit_snapshot(&app);

    match rx.await {
        // Admitted.
        Ok(()) => state
            .ticket_dto(&req_id)
            .ok_or_else(|| "ticket vanished after admit".to_string()),
        // Sender dropped without sending → cancelled / reclaimed.
        Err(_) => Err("inference request cancelled".to_string()),
    }
}

#[tauri::command]
pub fn inference_cancel(app: AppHandle, state: tauri::State<'_, InferenceQueue>, req_id: String) {
    if state.cancel(&req_id) {
        state.emit_snapshot(&app);
    }
}

#[tauri::command]
pub fn inference_release(app: AppHandle, state: tauri::State<'_, InferenceQueue>, req_id: String) {
    if state.release(&req_id) {
        state.emit_snapshot(&app);
    }
}

/// Reclaim every ticket attributed to `window_label`. Called by the frontend
/// on startup so a renderer that crashed/reloaded (which destroys the JS
/// context WITHOUT firing the OS window-destroyed listener) doesn't leave a
/// phantom "running" ticket blocking the single slot until the lease expires.
/// A freshly loaded renderer owns no in-flight turns, so dropping all of its
/// window's tickets is always safe.
#[tauri::command]
pub fn inference_release_window(
    app: AppHandle,
    state: tauri::State<'_, InferenceQueue>,
    window_label: String,
) {
    if state.release_window(&window_label) {
        state.emit_snapshot(&app);
    }
}

#[tauri::command]
pub fn inference_heartbeat(state: tauri::State<'_, InferenceQueue>, req_id: String) {
    state.heartbeat(&req_id);
}

#[tauri::command]
pub fn inference_queue_snapshot(state: tauri::State<'_, InferenceQueue>) -> Vec<TicketDto> {
    state.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn admitted(rx: &mut oneshot::Receiver<()>) -> bool {
        matches!(rx.try_recv(), Ok(()))
    }

    fn cancelled(rx: &mut oneshot::Receiver<()>) -> bool {
        matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Closed))
    }

    #[test]
    fn admits_first_caller_immediately() {
        let q = InferenceQueue::new();
        let mut rx = q
            .enqueue("w-1".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut rx));
        assert_eq!(q.snapshot().len(), 1);
        assert_eq!(q.snapshot()[0].state, "running");
    }

    #[test]
    fn serializes_second_caller_behind_first() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut b = q
            .enqueue(
                "b".into(),
                json!({"kind":"job","jobName":"Headlines"}),
                false,
                "main".into(),
            )
            .unwrap();
        assert!(admitted(&mut a));
        assert!(!admitted(&mut b));
        let states: Vec<_> = q.snapshot().iter().map(|t| t.state).collect();
        assert_eq!(states, vec!["running", "waiting"]);

        // Releasing the head admits the next in FIFO order.
        assert!(q.release("a"));
        assert!(admitted(&mut b));
        assert_eq!(
            q.snapshot().iter().map(|t| t.state).collect::<Vec<_>>(),
            vec!["running"]
        );
    }

    #[test]
    fn fifo_admission_order() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut c = q
            .enqueue("c".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        assert!(!admitted(&mut b));
        q.release("a");
        assert!(admitted(&mut b));
        assert!(!admitted(&mut c));
        q.release("b");
        assert!(admitted(&mut c));
    }

    #[test]
    fn cancel_waiting_unblocks_nothing_but_clears_ticket() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        // Cancel the waiting one: its receiver closes, head keeps its slot.
        assert!(q.cancel("b"));
        assert!(cancelled(&mut b));
        assert_eq!(q.snapshot().len(), 1);
        // Cancelling a running ticket is a no-op (use release).
        assert!(!q.cancel("a"));
    }

    #[test]
    fn release_admits_waiter_after_cancelled_sibling() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut c = q
            .enqueue("c".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        q.cancel("b");
        assert!(cancelled(&mut b));
        q.release("a");
        // c was behind b; with b gone it's next.
        assert!(admitted(&mut c));
    }

    #[test]
    fn release_window_drops_all_owned_tickets() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("shell"), false, "win-2".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        assert!(!admitted(&mut b));
        // The window holding the running slot dies.
        assert!(q.release_window("win-2"));
        assert!(cancelled(&mut a));
        // Its slot is freed and the main-window waiter is admitted.
        assert!(admitted(&mut b));
        assert_eq!(q.snapshot().len(), 1);
        assert_eq!(q.snapshot()[0].id, "b");
    }

    #[test]
    fn lease_sweep_reclaims_expired_slot() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        // Far future: every lease is expired.
        let future = now_ms() + LEASE_TTL_MS + 1;
        assert!(q.sweep_expired_at(future));
        // Both reclaimed; receivers close.
        assert!(cancelled(&mut a));
        assert!(cancelled(&mut b));
        assert_eq!(q.snapshot().len(), 0);
    }

    #[test]
    fn heartbeat_prevents_reclaim() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        // Sweep at a time the original lease would cover (just after enqueue).
        // Heartbeat pushes the lease further out, so a sweep at "now" is a no-op.
        q.heartbeat("a");
        assert!(!q.sweep_expired_at(now_ms()));
        assert_eq!(q.snapshot().len(), 1);
    }

    #[test]
    fn parallel_mode_admits_everyone() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue("a".into(), json!("chat"), true, "main".into())
            .unwrap();
        let mut b = q
            .enqueue("b".into(), json!("chat"), true, "main".into())
            .unwrap();
        assert!(admitted(&mut a));
        assert!(admitted(&mut b));
        let states: Vec<_> = q.snapshot().iter().map(|t| t.state).collect();
        assert_eq!(states, vec!["running", "running"]);
    }

    #[test]
    fn duplicate_id_rejected() {
        let q = InferenceQueue::new();
        let _a = q
            .enqueue("dup".into(), json!("chat"), false, "main".into())
            .unwrap();
        assert!(q
            .enqueue("dup".into(), json!("chat"), false, "main".into())
            .is_err());
    }
}
