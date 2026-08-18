//! Process-wide admission control for inference turns.
//!
//! Every chat / shell / job turn POSTs to an inference provider — the single
//! local `llama-server` (one slot) or a remote OpenAI-compatible server. The
//! frontend used to gate this with a per-webview JS semaphore, but that can't
//! coordinate once shells are detached into their own windows — each webview
//! has its own JS context. So the gate lives here, in Rust, shared across every
//! window.
//!
//! Design:
//!   - FIFO, but admission is scoped per *lane* — an opaque provider key the
//!     frontend supplies (e.g. `"local"` for the single llama-server slot, or
//!     `"remote:<baseUrl>"` for a remote server). Lanes are independent: a turn
//!     in one lane never blocks a turn in another, so local chat/shell keep
//!     running while a job streams against a remote provider.
//!   - Each lane carries a capacity the frontend supplies on every acquire
//!     (last-writer-wins per lane), mirroring the old "re-read setting at
//!     every acquire" semantics. 1 serializes — the local llama-server lane is
//!     always 1. A parallel-capable remote lane uses the slot count the server
//!     advertises, falling back to unbounded only when that count is unknown
//!     (OpenRouter, whose concurrency is not ours to model). Unbounded against
//!     a server with N slots would let request N+1 queue *inside* the server,
//!     where nothing here can see or report it — losing the "waiting" signal
//!     exactly when contention starts.
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
    /// Opaque admission lane from the frontend (e.g. `"local"` or
    /// `"remote:<baseUrl>"`). Tickets only contend for capacity within their
    /// own lane. Rust never parses it beyond equality.
    lane: String,
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
    /// FIFO order is the vec order. Holds both waiting and running tickets
    /// across every lane.
    tickets: Vec<Ticket>,
    /// Wakeups for waiting tickets, keyed by req_id. Removed on admit /
    /// cancel / release. Dropping a sender (without sending) resolves the
    /// waiter's receiver with an error → acquire reports "cancelled".
    senders: HashMap<String, oneshot::Sender<()>>,
    /// How many turns each lane admits at once. Updated on every acquire
    /// (last-writer-wins per lane), mirroring the old per-acquire settings
    /// read. A lane absent from the map defaults to serialized (capacity 1).
    /// `usize::MAX` means "unbounded" — the backend's concurrency is not
    /// something this app models.
    lane_capacity: HashMap<String, usize>,
}

impl Inner {
    /// Capacity for a single lane, as last supplied by the frontend. Defaults
    /// to 1 so an unknown lane serializes rather than admitting everyone.
    fn capacity(&self, lane: &str) -> usize {
        self.lane_capacity.get(lane).copied().unwrap_or(1)
    }

    /// Count currently-running tickets per lane.
    fn running_by_lane(&self) -> HashMap<String, usize> {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for t in &self.tickets {
            if t.state == TicketState::Running {
                *counts.entry(t.lane.clone()).or_insert(0) += 1;
            }
        }
        counts
    }

    /// Admit waiting tickets in FIFO order while their lane has capacity,
    /// waking each via its oneshot sender. Lanes are independent: a full local
    /// lane never blocks a waiting remote ticket and vice versa.
    fn pump(&mut self) {
        let mut running = self.running_by_lane();
        for i in 0..self.tickets.len() {
            if self.tickets[i].state != TicketState::Waiting {
                continue;
            }
            let lane = self.tickets[i].lane.clone();
            let cap = self.capacity(&lane);
            if running.get(&lane).copied().unwrap_or(0) >= cap {
                continue;
            }
            let id = self.tickets[i].id.clone();
            self.tickets[i].state = TicketState::Running;
            *running.entry(lane).or_insert(0) += 1;
            if let Some(tx) = self.senders.remove(&id) {
                let _ = tx.send(());
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
        lane: String,
        max_parallel: Option<u32>,
        window_label: String,
    ) -> Result<oneshot::Receiver<()>, String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if inner.tickets.iter().any(|t| t.id == req_id) {
            return Err("duplicate inference request id".into());
        }
        let now = now_ms();
        // None means unbounded; a supplied count is floored at 1 so a server
        // reporting 0 slots cannot deadlock the lane.
        inner.lane_capacity.insert(
            lane.clone(),
            max_parallel.map_or(usize::MAX, |n| (n as usize).max(1)),
        );
        let (tx, rx) = oneshot::channel();
        inner.senders.insert(req_id.clone(), tx);
        inner.tickets.push(Ticket {
            id: req_id,
            consumer,
            lane,
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
        self.remove_ticket_where(|t| t.id == req_id && t.state == TicketState::Waiting)
    }

    /// Release a held (or still-waiting) slot and admit the next waiter in the
    /// freed lane.
    fn release(&self, req_id: &str) -> bool {
        self.remove_ticket_where(|t| t.id == req_id)
    }

    /// Shared removal core for `cancel` / `release`: drop the first ticket
    /// matching `pred` (ids are unique, so there is at most one), drop its
    /// sender (if it was still waiting, its receiver errors → "cancelled"),
    /// and pump the freed lane. Returns whether a ticket was removed.
    fn remove_ticket_where(&self, pred: impl Fn(&Ticket) -> bool) -> bool {
        let mut inner = match self.inner.lock() {
            Ok(i) => i,
            Err(_) => return false,
        };
        let pos = inner.tickets.iter().position(pred);
        match pos {
            Some(pos) => {
                let removed = inner.tickets.remove(pos);
                inner.senders.remove(&removed.id);
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

    /// Shared removal core: drop every ticket matching `pred`, then pump each
    /// freed lane's next waiter. Dropping the senders of waiting victims
    /// resolves their receivers with an error.
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
        inner.tickets.retain(|t| !pred(t));
        for id in &victims {
            inner.senders.remove(id);
        }
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
    lane: String,
    max_parallel: Option<u32>,
    window_label: String,
) -> Result<TicketDto, String> {
    let rx = state.enqueue(req_id.clone(), consumer, lane, max_parallel, window_label)?;
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

    /// Enqueue a serialized ticket on the `"local"` lane — the common case in
    /// these tests. Lane-specific behaviour gets its own helpers inline.
    fn enqueue_local(q: &InferenceQueue, id: &str, consumer: Value) -> oneshot::Receiver<()> {
        q.enqueue(id.into(), consumer, "local".into(), Some(1), "main".into())
            .unwrap()
    }

    #[test]
    fn admits_first_caller_immediately() {
        let q = InferenceQueue::new();
        let mut rx = enqueue_local(&q, "w-1", json!("chat"));
        assert!(admitted(&mut rx));
        assert_eq!(q.snapshot().len(), 1);
        assert_eq!(q.snapshot()[0].state, "running");
    }

    #[test]
    fn serializes_second_caller_behind_first() {
        let q = InferenceQueue::new();
        let mut a = enqueue_local(&q, "a", json!("chat"));
        let mut b = enqueue_local(&q, "b", json!({"kind":"job","jobName":"Headlines"}));
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
        let mut a = enqueue_local(&q, "a", json!("chat"));
        let mut b = enqueue_local(&q, "b", json!("chat"));
        let mut c = enqueue_local(&q, "c", json!("chat"));
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
        let mut a = enqueue_local(&q, "a", json!("chat"));
        let mut b = enqueue_local(&q, "b", json!("chat"));
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
        let mut a = enqueue_local(&q, "a", json!("chat"));
        let mut b = enqueue_local(&q, "b", json!("chat"));
        let mut c = enqueue_local(&q, "c", json!("chat"));
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
            .enqueue(
                "a".into(),
                json!("shell"),
                "local".into(),
                Some(1),
                "win-2".into(),
            )
            .unwrap();
        let mut b = enqueue_local(&q, "b", json!("chat"));
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
        let mut a = enqueue_local(&q, "a", json!("chat"));
        let mut b = enqueue_local(&q, "b", json!("chat"));
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
        let mut a = enqueue_local(&q, "a", json!("chat"));
        assert!(admitted(&mut a));
        // Sweep at a time the original lease would cover (just after enqueue).
        // Heartbeat pushes the lease further out, so a sweep at "now" is a no-op.
        q.heartbeat("a");
        assert!(!q.sweep_expired_at(now_ms()));
        assert_eq!(q.snapshot().len(), 1);
    }

    /// A server that advertises N slots must admit exactly N. Unbounded here
    /// would let the extra request queue *inside* the server, where nothing in
    /// the app can see it — so the user loses the "waiting" signal at the exact
    /// moment contention starts.
    #[test]
    fn lane_admits_up_to_its_advertised_slots() {
        let q = InferenceQueue::new();
        let mut tickets: Vec<_> = ["a", "b", "c"]
            .iter()
            .map(|id| {
                q.enqueue(
                    (*id).into(),
                    json!("chat"),
                    "remote:x".into(),
                    Some(2),
                    "main".into(),
                )
                .unwrap()
            })
            .collect();

        assert!(admitted(&mut tickets[0]));
        assert!(admitted(&mut tickets[1]));
        assert!(
            !admitted(&mut tickets[2]),
            "third turn must wait on a two-slot server"
        );

        // Releasing one lets the queued turn through.
        q.release("a");
        assert!(admitted(&mut tickets[2]));
    }

    /// A server reporting zero slots must not deadlock its lane.
    #[test]
    fn zero_slots_is_floored_to_one() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue(
                "a".into(),
                json!("chat"),
                "remote:x".into(),
                Some(0),
                "main".into(),
            )
            .unwrap();
        assert!(admitted(&mut a));
    }

    /// No advertised count means unbounded, which is right for a hosted API.
    #[test]
    fn parallel_lane_admits_everyone() {
        let q = InferenceQueue::new();
        let mut a = q
            .enqueue(
                "a".into(),
                json!("chat"),
                "remote:x".into(),
                None,
                "main".into(),
            )
            .unwrap();
        let mut b = q
            .enqueue(
                "b".into(),
                json!("chat"),
                "remote:x".into(),
                None,
                "main".into(),
            )
            .unwrap();
        assert!(admitted(&mut a));
        assert!(admitted(&mut b));
        let states: Vec<_> = q.snapshot().iter().map(|t| t.state).collect();
        assert_eq!(states, vec!["running", "running"]);
    }

    #[test]
    fn duplicate_id_rejected() {
        let q = InferenceQueue::new();
        let _a = enqueue_local(&q, "dup", json!("chat"));
        assert!(q
            .enqueue(
                "dup".into(),
                json!("chat"),
                "local".into(),
                Some(1),
                "main".into()
            )
            .is_err());
    }

    /// The core fix: a turn on one lane never blocks a turn on another, even
    /// when both lanes are serialized (capacity 1). Local chat keeps running
    /// while a job streams against a remote provider.
    #[test]
    fn distinct_lanes_run_concurrently_even_when_serialized() {
        let q = InferenceQueue::new();
        let mut local = enqueue_local(&q, "chat", json!("chat"));
        let mut remote = q
            .enqueue(
                "job".into(),
                json!({"kind":"job","jobName":"Audit"}),
                "remote:https://api.example.com".into(),
                Some(1),
                "main".into(),
            )
            .unwrap();
        // Neither waits on the other despite both lanes being capacity 1.
        assert!(admitted(&mut local));
        assert!(admitted(&mut remote));
        let states: Vec<_> = q.snapshot().iter().map(|t| t.state).collect();
        assert_eq!(states, vec!["running", "running"]);
    }

    /// Capacity is enforced per lane: a second local turn waits behind the
    /// first (one llama-server slot) while an unrelated remote turn runs.
    #[test]
    fn local_lane_serializes_independently_of_remote() {
        let q = InferenceQueue::new();
        let mut local_a = enqueue_local(&q, "chat", json!("chat"));
        let mut local_b = enqueue_local(&q, "shell", json!("shell"));
        let mut remote = q
            .enqueue(
                "job".into(),
                json!("chat"),
                "remote:y".into(),
                Some(1),
                "main".into(),
            )
            .unwrap();
        assert!(admitted(&mut local_a));
        assert!(!admitted(&mut local_b)); // serialized behind local_a
        assert!(admitted(&mut remote)); // different lane — runs anyway
                                        // Freeing the local head admits the waiting local turn.
        q.release("chat");
        assert!(admitted(&mut local_b));
    }

    /// The parallel flag is scoped to its lane: turning it on for the remote
    /// lane lets remote turns share, while the local lane still serializes.
    #[test]
    fn parallel_flag_is_per_lane() {
        let q = InferenceQueue::new();
        let mut remote_a = q
            .enqueue(
                "ra".into(),
                json!("chat"),
                "remote:z".into(),
                None,
                "main".into(),
            )
            .unwrap();
        let mut remote_b = q
            .enqueue(
                "rb".into(),
                json!("chat"),
                "remote:z".into(),
                None,
                "main".into(),
            )
            .unwrap();
        let mut local_a = enqueue_local(&q, "la", json!("chat"));
        let mut local_b = enqueue_local(&q, "lb", json!("chat"));
        // Remote lane is parallel — both run.
        assert!(admitted(&mut remote_a));
        assert!(admitted(&mut remote_b));
        // Local lane is serialized — second waits.
        assert!(admitted(&mut local_a));
        assert!(!admitted(&mut local_b));
    }
}
