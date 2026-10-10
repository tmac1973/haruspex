//! The engine hub: how something other than a window's own UI reaches a Code
//! session, whichever window it lives in.
//!
//! Every Code session runs in exactly one webview, the window that claimed
//! it (`code_tools::claims`), and that webview's engine (`src/lib/engine/`)
//! is the only thing that can act on it. So an operation is routed here to
//! the owning window as an event, and the window answers through
//! [`engine_reply`]. Each window also pushes what its sessions do through
//! [`engine_events`], and this module fans those out to subscribers: the
//! owner API's WebSocket in phase 3 of `plan/remote-api/`, the driver's
//! hooks before that.
//!
//! Operations and events are JSON this module does not look inside, beyond
//! `type` and `id` for routing. Their shapes belong to the webview
//! (`src/lib/engine/types.ts`), the only side that builds or reads them.
//!
//! Off unless enabled: the owner API turns it on while it runs
//! (`owner::commands`), and the e2e test build (its own identifier) keeps it
//! on, so a normal build with the API off answers nothing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, oneshot};

use crate::code_tools::claims::CodeSessionClaims;
use crate::sync_util::LockExt;

/// Sent to one window: `{ reqId, op, window }`, answered with [`engine_reply`].
/// Every window's listener hears it, so each answers only its own.
pub const EVENT_OP: &str = "engine://op";
/// Sent to the main window with every batch of events, while enabled, so the
/// driver's hooks can read all windows' events from one place.
pub const EVENT_MIRROR: &str = "engine://event";
/// Sent to every window when the engine is switched on or off, so a window
/// loaded while it was off can start its engine without a restart.
pub const EVENT_ENABLED: &str = "engine://enabled";

/// How long a window has to answer. Every operation answers at once: a
/// `session.send` answers when the turn has started, not when it ends.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// Buffered events per subscriber. A subscriber that falls further behind is
/// told it lagged and resyncs from a snapshot.
const EVENT_CAPACITY: usize = 256;

/// Operations every window answers, merged here.
const FANOUT_OPS: [&str; 2] = ["sessions.list", "prompts.list"];

pub const MAIN_WINDOW: &str = "main";

/// Where an operation goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    Window(String),
    Fanout,
}

/// Route by the operation's `type`, `promptId` or session `id`: every window
/// for the listings, the window a prompt showed in, the session's owner, and
/// the main window for a session open nowhere (it opens there).
pub fn route(op: &Value, owner_of: impl Fn(&str) -> Option<String>) -> Route {
    let kind = op.get("type").and_then(Value::as_str).unwrap_or_default();
    if FANOUT_OPS.contains(&kind) {
        return Route::Fanout;
    }
    // A prompt lives in the window that showed it, which its id names.
    if let Some((label, _)) = op
        .get("promptId")
        .and_then(Value::as_str)
        .and_then(|p| p.rsplit_once(':'))
    {
        return Route::Window(label.to_string());
    }
    let owner = op.get("id").and_then(Value::as_str).and_then(owner_of);
    Route::Window(owner.unwrap_or_else(|| MAIN_WINDOW.to_string()))
}

/// Windows that run an engine: the main one and detached Code windows.
pub fn is_engine_window(label: &str) -> bool {
    label == MAIN_WINDOW || label.starts_with("code-")
}

/// Merge the windows' answers to a fan-out operation. Each answers a list;
/// a session can appear twice (saved in the main window's listing, open in
/// another), and the entry from the window that has it open wins: it is the
/// one with a `status`.
pub fn merge(answers: Vec<Value>) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for item in answers.into_iter().flat_map(|a| match a {
        Value::Array(items) => items,
        _ => Vec::new(),
    }) {
        let Some(id) = item.get("id").and_then(Value::as_str).map(str::to_string) else {
            out.push(item);
            continue;
        };
        let has_status = |v: &Value| v.get("status").is_some_and(|s| !s.is_null());
        match by_id.get(&id) {
            Some(&i) => {
                if has_status(&item) && !has_status(&out[i]) {
                    out[i] = item;
                }
            }
            None => {
                by_id.insert(id, out.len());
                out.push(item);
            }
        }
    }
    Value::Array(out)
}

type Reply = Result<Value, String>;

/// Managed state: requests waiting on a window, and the event fan-out.
pub struct EngineHub {
    enabled: AtomicBool,
    /// The e2e build: on whatever the owner API does.
    always: bool,
    seq: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    events: broadcast::Sender<Value>,
}

impl EngineHub {
    /// `always`: on for good (the e2e build); otherwise off until
    /// [`set_enabled`](Self::set_enabled).
    pub fn new(always: bool) -> Self {
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        EngineHub {
            enabled: AtomicBool::new(always),
            always,
            seq: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            events,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Switch on or off (an e2e build stays on). True when that changed it.
    pub fn set_enabled(&self, on: bool) -> bool {
        let on = on || self.always;
        self.enabled.swap(on, Ordering::Relaxed) != on
    }

    /// A request id and the receiver its reply arrives on.
    fn register(&self) -> (String, oneshot::Receiver<Reply>) {
        let id = format!("op-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock_or_recover().insert(id.clone(), tx);
        (id, rx)
    }

    fn forget(&self, req_id: &str) {
        self.pending.lock_or_recover().remove(req_id);
    }

    /// Deliver a window's answer. False for an id nobody is waiting on: late,
    /// timed out, or made up.
    pub fn reply(&self, req_id: &str, reply: Reply) -> bool {
        match self.pending.lock_or_recover().remove(req_id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// Events from every window, each stamped with its `window`. The owner
    /// API's WebSocket (phase 3) is the first subscriber outside tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    fn publish(&self, label: &str, events: Vec<Value>) -> Vec<Value> {
        events
            .into_iter()
            .map(|mut e| {
                if let Value::Object(map) = &mut e {
                    map.insert("window".into(), Value::String(label.to_string()));
                }
                // No subscribers is not an error.
                let _ = self.events.send(e.clone());
                e
            })
            .collect()
    }

    /// Send `op` to one window and wait for its answer.
    async fn ask(&self, emit: impl FnOnce(&str) -> Result<(), String>, timeout: Duration) -> Reply {
        let (req_id, rx) = self.register();
        if let Err(e) = emit(&req_id) {
            self.forget(&req_id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("the window went away before answering".into()),
            Err(_) => {
                self.forget(&req_id);
                Err(format!(
                    "no answer from the window in {}s",
                    timeout.as_secs()
                ))
            }
        }
    }
}

fn alive(app: &AppHandle) -> impl Fn(&str) -> bool + '_ {
    |label| app.get_webview_window(label).is_some()
}

/// Run one operation wherever it belongs. For the owner API (phase 3) and the
/// [`engine_request`] command.
pub async fn request(app: &AppHandle, op: Value) -> Reply {
    let hub = app.state::<EngineHub>();
    if !hub.enabled() {
        return Err("the engine is off".into());
    }
    let claims = app.state::<CodeSessionClaims>();
    let routed = route(&op, |id| claims.owner_of(id, alive(app)));
    let fanout = routed == Route::Fanout;
    let labels: Vec<String> = match routed {
        Route::Window(label) => vec![label],
        Route::Fanout => app
            .webview_windows()
            .into_keys()
            .filter(|l| is_engine_window(l))
            .collect(),
    };
    let mut answers = Vec::new();
    for label in labels {
        if app.get_webview_window(&label).is_none() {
            if fanout {
                continue;
            }
            return Err(format!("no window {label} to run it"));
        }
        let emit = |req_id: &str| {
            app.emit_to(
                label.as_str(),
                EVENT_OP,
                // Named: a webview's `listen` hears events sent to any window.
                serde_json::json!({ "reqId": req_id, "op": op, "window": label }),
            )
            .map_err(|e| e.to_string())
        };
        let answer = hub.ask(emit, REPLY_TIMEOUT).await;
        if !fanout {
            return answer;
        }
        // One window failing a listing leaves the others' answers.
        if let Ok(v) = answer {
            answers.push(v);
        }
    }
    Ok(merge(answers))
}

#[tauri::command]
pub fn engine_enabled(hub: tauri::State<'_, EngineHub>) -> bool {
    hub.enabled()
}

/// Run an operation in whichever window has the session.
#[tauri::command]
pub async fn engine_request(app: AppHandle, op: Value) -> Result<Value, String> {
    request(&app, op).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineReply {
    req_id: String,
    value: Option<Value>,
    error: Option<String>,
}

/// A window's answer to an [`EVENT_OP`].
#[tauri::command]
pub fn engine_reply(hub: tauri::State<'_, EngineHub>, reply: EngineReply) {
    let result = match reply.error {
        Some(e) => Err(e),
        None => Ok(reply.value.unwrap_or(Value::Null)),
    };
    hub.reply(&reply.req_id, result);
}

/// A window's batch of events.
#[tauri::command]
pub fn engine_events(window: tauri::Window, hub: tauri::State<'_, EngineHub>, events: Vec<Value>) {
    if !hub.enabled() || events.is_empty() {
        return;
    }
    let stamped = hub.publish(window.label(), events);
    let _ = window
        .app_handle()
        .emit_to(MAIN_WINDOW, EVENT_MIRROR, stamped);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_operation_goes_to_the_window_that_has_the_session() {
        let op = json!({ "type": "session.send", "id": "s1", "text": "hi" });
        let owner = |id: &str| (id == "s1").then(|| "code-s1".to_string());
        assert_eq!(route(&op, owner), Route::Window("code-s1".into()));
    }

    #[test]
    fn a_session_open_nowhere_goes_to_the_main_window() {
        let op = json!({ "type": "session.open", "id": "s2" });
        assert_eq!(route(&op, |_| None), Route::Window("main".into()));
        let op = json!({ "type": "session.new", "root": "/p" });
        assert_eq!(route(&op, |_| None), Route::Window("main".into()));
    }

    #[test]
    fn an_answer_goes_to_the_window_that_showed_the_prompt() {
        let op = json!({ "type": "prompts.answer", "promptId": "code-s1:3", "answer": {} });
        assert_eq!(route(&op, |_| None), Route::Window("code-s1".into()));
    }

    #[test]
    fn listings_ask_every_window() {
        for kind in FANOUT_OPS {
            assert_eq!(route(&json!({ "type": kind }), |_| None), Route::Fanout);
        }
    }

    #[test]
    fn only_the_main_and_code_windows_run_an_engine() {
        assert!(is_engine_window("main"));
        assert!(is_engine_window("code-abc"));
        assert!(!is_engine_window("editor-123"));
    }

    #[test]
    fn merging_prefers_the_window_that_has_the_session_open() {
        let main = json!([
            { "id": "a", "status": "idle" },
            { "id": "b", "status": null, "owner": "code-b" }
        ]);
        let detached = json!([{ "id": "b", "status": "running" }]);
        let merged = merge(vec![main, detached]);
        assert_eq!(
            merged,
            json!([{ "id": "a", "status": "idle" }, { "id": "b", "status": "running" }])
        );
    }

    #[test]
    fn merging_keeps_items_without_an_id() {
        let merged = merge(vec![json!([{ "kind": "x" }]), json!([{ "kind": "y" }])]);
        assert_eq!(merged, json!([{ "kind": "x" }, { "kind": "y" }]));
    }

    #[tokio::test]
    async fn a_reply_reaches_the_request_waiting_on_it() {
        let hub = EngineHub::new(true);
        let (req_id, rx) = hub.register();
        assert!(hub.reply(&req_id, Ok(json!(42))));
        assert_eq!(rx.await.unwrap(), Ok(json!(42)));
    }

    #[test]
    fn the_owner_api_switches_it_but_an_e2e_build_stays_on() {
        let hub = EngineHub::new(false);
        assert!(!hub.enabled());
        assert!(hub.set_enabled(true));
        assert!(hub.enabled());
        assert!(!hub.set_enabled(true));
        assert!(hub.set_enabled(false));
        let e2e = EngineHub::new(true);
        assert!(!e2e.set_enabled(false));
        assert!(e2e.enabled());
    }

    #[test]
    fn a_reply_nobody_waits_on_is_dropped() {
        let hub = EngineHub::new(true);
        assert!(!hub.reply("op-99", Ok(Value::Null)));
    }

    #[tokio::test]
    async fn a_window_that_never_answers_times_out() {
        let hub = EngineHub::new(true);
        let res = hub.ask(|_| Ok(()), Duration::from_millis(20)).await;
        assert!(res.unwrap_err().contains("no answer"));
        // And its late answer goes nowhere.
        assert!(!hub.reply("op-0", Ok(Value::Null)));
    }

    #[tokio::test]
    async fn a_window_that_cannot_be_reached_fails_at_once() {
        let hub = EngineHub::new(true);
        let res = hub
            .ask(|_| Err("gone".into()), Duration::from_secs(5))
            .await;
        assert_eq!(res, Err("gone".into()));
        assert!(hub.pending.lock_or_recover().is_empty());
    }

    #[tokio::test]
    async fn events_are_stamped_with_their_window() {
        let hub = EngineHub::new(true);
        let mut rx = hub.subscribe();
        hub.publish("code-x", vec![json!({ "seq": 1, "type": "status" })]);
        let got = rx.recv().await.unwrap();
        assert_eq!(got["window"], "code-x");
    }

    #[tokio::test]
    async fn a_subscriber_that_falls_behind_is_told_so() {
        let hub = EngineHub::new(true);
        let mut rx = hub.subscribe();
        let flood: Vec<Value> = (0..EVENT_CAPACITY + 10)
            .map(|i| json!({ "seq": i }))
            .collect();
        hub.publish("main", flood);
        assert!(matches!(
            rx.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
    }
}
