//! The broker between HTTP clients and the webview that can actually run a turn.
//!
//! Rust cannot run an agent turn — the whole loop (tools, streaming, backend
//! selection) lives in the TypeScript frontend. So a remote prompt takes a
//! detour: the HTTP handler registers a turn here and emits a Tauri event, the
//! frontend driver runs it and pushes text back through commands, and this
//! module fans that out to whoever is listening on the session's SSE stream.
//!
//! Two properties are deliberate:
//!
//! * **The buffer is authoritative here, not in the driver.** The driver sends
//!   the full answer-so-far on every update and this module derives the suffix.
//!   Sending suffixes from the frontend would be cheaper on an IPC hop that is
//!   already in-process, and would put a whole class of desync bugs on the
//!   wire.
//! * **A dropped connection is not a cancelled turn.** The target user is on a
//!   phone, and a phone locks its screen mid-answer. Subscribers can come and
//!   go; the buffer is replayed on reconnect and only a session left with no
//!   listener for [`ORPHAN_GRACE`] gives up its turn.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// Emitted to the webview when a remote client submits a prompt.
pub const EVENT_PROMPT: &str = "remote://prompt";
/// Emitted to the webview when an in-flight remote turn should stop.
pub const EVENT_CANCEL: &str = "remote://cancel";

/// Buffered SSE events per session. Generous, because a lagging subscriber
/// costs a resync rather than a dropped connection — but bounded, because a
/// browser that stops reading must not grow this without limit.
const CHANNEL_CAPACITY: usize = 256;

/// Concurrent sessions per host. Not a security boundary — the token is that.
/// This stops one guest opening tabs until the queue is unusable for everyone.
pub const MAX_SESSIONS: usize = 8;

/// Turns accepted per minute across all sessions. The threat here is not an
/// attacker, it is a friend holding down enter.
const MAX_TURNS_PER_MINUTE: usize = 20;

/// How long a session may sit with no SSE subscriber before its in-flight turn
/// is abandoned. Long enough to cover a screen lock and a walk to the kitchen,
/// short enough that a closed tab does not hold the GPU.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(90);

/// How long an idle session (no subscriber, no turn) is remembered before it is
/// forgotten entirely.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Session ids come from the client, so they are echoed into events and used as
/// map keys. Bound them and keep them boring.
const MAX_SESSION_ID_LEN: usize = 64;

/// What a guest calls themselves, which ends up in the host's sidebar as a
/// conversation title. Untrusted text: bounded here, stripped of control
/// characters, and never allowed to be the only thing a title is made of.
const MAX_LABEL_LEN: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnStatus {
    /// Accepted, waiting on an inference slot — the state that makes contention
    /// legible to a remote user instead of looking like a hung spinner.
    Waiting,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RemoteEvent {
    /// Full state of the current turn. Sent on connect and after a lagged
    /// subscriber misses deltas, so a reconnecting client never has to
    /// reconstruct anything.
    Snapshot {
        turn_id: Option<String>,
        text: String,
        status: Option<TurnStatus>,
        message: Option<String>,
    },
    /// Newly generated text, appended to whatever the client already has.
    Delta {
        turn_id: String,
        text: String,
    },
    Done {
        turn_id: String,
        text: String,
    },
    Error {
        turn_id: String,
        message: String,
    },
    /// Waiting → running transitions, so the client can say what it is doing.
    State {
        turn_id: String,
        status: TurnStatus,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum RelayError {
    /// A prompt arrived for a session that already has a turn in flight.
    Busy,
    TooManySessions,
    RateLimited,
    /// The turn id is unknown — a late delta from a turn already finished or
    /// cancelled. Always a drop, never an error to the caller.
    UnknownTurn,
    BadSessionId,
}

impl RelayError {
    pub fn message(&self) -> &'static str {
        match self {
            RelayError::Busy => "a turn is already running in this session",
            RelayError::TooManySessions => "too many people are connected right now",
            RelayError::RateLimited => "too many messages — slow down a moment",
            RelayError::UnknownTurn => "unknown turn",
            RelayError::BadSessionId => "invalid session id",
        }
    }
}

struct Turn {
    id: String,
    text: String,
    status: TurnStatus,
    message: Option<String>,
}

struct Session {
    tx: broadcast::Sender<RemoteEvent>,
    /// The current turn, kept after it finishes so a client that reconnects
    /// late still sees the answer it missed.
    turn: Option<Turn>,
    subscribers: usize,
    /// Last time this session had a subscriber or sent a prompt.
    last_seen: Instant,
}

impl Session {
    fn new() -> Self {
        Session {
            tx: broadcast::channel(CHANNEL_CAPACITY).0,
            turn: None,
            subscribers: 0,
            last_seen: Instant::now(),
        }
    }

    fn in_flight(&self) -> bool {
        matches!(
            self.turn.as_ref().map(|t| t.status),
            Some(TurnStatus::Waiting) | Some(TurnStatus::Running)
        )
    }

    fn snapshot(&self) -> RemoteEvent {
        match &self.turn {
            Some(t) => RemoteEvent::Snapshot {
                turn_id: Some(t.id.clone()),
                text: t.text.clone(),
                status: Some(t.status),
                message: t.message.clone(),
            },
            None => RemoteEvent::Snapshot {
                turn_id: None,
                text: String::new(),
                status: None,
                message: None,
            },
        }
    }
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    /// turn id -> session id.
    turns: HashMap<String, String>,
    /// Accept times of recent turns, pruned to the last minute.
    recent_turns: Vec<Instant>,
}

pub struct Relay {
    inner: Mutex<Inner>,
    counter: AtomicU64,
}

/// A prompt the frontend should run, handed to the caller so it can emit the
/// Tauri event outside the lock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    pub session_id: String,
    pub turn_id: String,
    pub message: String,
    pub client_label: Option<String>,
}

impl Default for Relay {
    fn default() -> Self {
        Self::new()
    }
}

impl Relay {
    pub fn new() -> Self {
        Relay {
            inner: Mutex::new(Inner::default()),
            counter: AtomicU64::new(0),
        }
    }

    /// Client-supplied ids are untrusted input: length-bounded, and restricted
    /// to characters that cannot confuse a log line or an event payload.
    pub fn valid_session_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= MAX_SESSION_ID_LEN
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    }

    /// Subscribe to a session's events, creating the session if new. Returns the
    /// receiver plus the current snapshot, which the caller sends first so a
    /// reconnecting client is immediately in sync.
    pub fn subscribe(
        &self,
        session_id: &str,
    ) -> Result<(broadcast::Receiver<RemoteEvent>, RemoteEvent), RelayError> {
        if !Self::valid_session_id(session_id) {
            return Err(RelayError::BadSessionId);
        }
        let mut inner = self.inner.lock().unwrap();
        if !inner.sessions.contains_key(session_id) && inner.sessions.len() >= MAX_SESSIONS {
            return Err(RelayError::TooManySessions);
        }
        let session = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(Session::new);
        session.subscribers += 1;
        session.last_seen = Instant::now();
        Ok((session.tx.subscribe(), session.snapshot()))
    }

    pub fn unsubscribe(&self, session_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.subscribers = session.subscribers.saturating_sub(1);
            session.last_seen = Instant::now();
        }
    }

    /// Current snapshot without subscribing — used to resync a lagged stream.
    pub fn snapshot(&self, session_id: &str) -> Option<RemoteEvent> {
        let inner = self.inner.lock().unwrap();
        inner.sessions.get(session_id).map(|s| s.snapshot())
    }

    /// Accept a prompt and register the turn. The caller emits [`EVENT_PROMPT`]
    /// with the returned request; nothing runs until the frontend picks it up.
    pub fn begin_turn(
        &self,
        session_id: &str,
        message: String,
        client_label: Option<String>,
    ) -> Result<PromptRequest, RelayError> {
        if !Self::valid_session_id(session_id) {
            return Err(RelayError::BadSessionId);
        }
        let mut inner = self.inner.lock().unwrap();

        let now = Instant::now();
        inner
            .recent_turns
            .retain(|t| now.duration_since(*t) < Duration::from_secs(60));
        if inner.recent_turns.len() >= MAX_TURNS_PER_MINUTE {
            return Err(RelayError::RateLimited);
        }

        if !inner.sessions.contains_key(session_id) && inner.sessions.len() >= MAX_SESSIONS {
            return Err(RelayError::TooManySessions);
        }

        let turn_id = format!(
            "{}#{}",
            session_id,
            self.counter.fetch_add(1, Ordering::Relaxed)
        );

        {
            let session = inner
                .sessions
                .entry(session_id.to_string())
                .or_insert_with(Session::new);
            if session.in_flight() {
                return Err(RelayError::Busy);
            }
            session.last_seen = now;
            session.turn = Some(Turn {
                id: turn_id.clone(),
                text: String::new(),
                status: TurnStatus::Waiting,
                message: None,
            });
            let _ = session.tx.send(RemoteEvent::State {
                turn_id: turn_id.clone(),
                status: TurnStatus::Waiting,
            });
        }

        inner.recent_turns.push(now);
        inner.turns.insert(turn_id.clone(), session_id.to_string());

        Ok(PromptRequest {
            session_id: session_id.to_string(),
            turn_id,
            message,
            client_label: client_label.and_then(|label| sanitise_label(&label)),
        })
    }

    /// The driver reports the whole answer so far; the suffix is derived here.
    ///
    /// If the text ever diverges from what we hold — a retry, a rewritten
    /// buffer — the client gets a fresh snapshot instead of a delta that would
    /// corrupt what it has.
    pub fn push_text(&self, turn_id: &str, full_text: &str) -> Result<(), RelayError> {
        let mut inner = self.inner.lock().unwrap();
        let session_id = inner
            .turns
            .get(turn_id)
            .cloned()
            .ok_or(RelayError::UnknownTurn)?;
        let session = inner
            .sessions
            .get_mut(&session_id)
            .ok_or(RelayError::UnknownTurn)?;
        let turn = match session.turn.as_mut() {
            Some(t) if t.id == turn_id => t,
            _ => return Err(RelayError::UnknownTurn),
        };

        if full_text == turn.text {
            return Ok(());
        }
        if let Some(suffix) = full_text.strip_prefix(turn.text.as_str()) {
            let delta = suffix.to_string();
            turn.text = full_text.to_string();
            if turn.status == TurnStatus::Waiting {
                turn.status = TurnStatus::Running;
            }
            let _ = session.tx.send(RemoteEvent::Delta {
                turn_id: turn_id.to_string(),
                text: delta,
            });
        } else {
            turn.text = full_text.to_string();
            let _ = session.tx.send(session.snapshot());
        }
        Ok(())
    }

    pub fn set_status(&self, turn_id: &str, status: TurnStatus) -> Result<(), RelayError> {
        let mut inner = self.inner.lock().unwrap();
        let session_id = inner
            .turns
            .get(turn_id)
            .cloned()
            .ok_or(RelayError::UnknownTurn)?;
        let session = inner
            .sessions
            .get_mut(&session_id)
            .ok_or(RelayError::UnknownTurn)?;
        match session.turn.as_mut() {
            Some(t) if t.id == turn_id => t.status = status,
            _ => return Err(RelayError::UnknownTurn),
        }
        let _ = session.tx.send(RemoteEvent::State {
            turn_id: turn_id.to_string(),
            status,
        });
        Ok(())
    }

    /// Terminal states. The turn id is retired so late deltas from a driver that
    /// has not noticed yet are dropped rather than reopening a finished turn.
    pub fn finish(&self, turn_id: &str, text: String) -> Result<(), RelayError> {
        self.terminate(turn_id, TurnStatus::Done, text, None)
    }

    pub fn fail(&self, turn_id: &str, message: String) -> Result<(), RelayError> {
        self.terminate(turn_id, TurnStatus::Failed, String::new(), Some(message))
    }

    fn terminate(
        &self,
        turn_id: &str,
        status: TurnStatus,
        text: String,
        message: Option<String>,
    ) -> Result<(), RelayError> {
        let mut inner = self.inner.lock().unwrap();
        let session_id = inner.turns.remove(turn_id).ok_or(RelayError::UnknownTurn)?;
        let session = inner
            .sessions
            .get_mut(&session_id)
            .ok_or(RelayError::UnknownTurn)?;
        let turn = match session.turn.as_mut() {
            Some(t) if t.id == turn_id => t,
            _ => return Err(RelayError::UnknownTurn),
        };
        turn.status = status;
        turn.message = message.clone();
        if status == TurnStatus::Done {
            turn.text = text.clone();
        }
        session.last_seen = Instant::now();
        let event = match (status, message) {
            (TurnStatus::Done, _) => RemoteEvent::Done {
                turn_id: turn_id.to_string(),
                text,
            },
            (_, Some(msg)) => RemoteEvent::Error {
                turn_id: turn_id.to_string(),
                message: msg,
            },
            (_, None) => RemoteEvent::State {
                turn_id: turn_id.to_string(),
                status,
            },
        };
        let _ = session.tx.send(event);
        Ok(())
    }

    /// The turn to cancel for a session, if any. The caller emits
    /// [`EVENT_CANCEL`]; the driver's abort path does the actual stopping and
    /// reports back through [`Relay::fail`].
    pub fn in_flight_turn(&self, session_id: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .sessions
            .get(session_id)
            .filter(|s| s.in_flight())
            .and_then(|s| s.turn.as_ref())
            .map(|t| t.id.clone())
    }

    /// Sessions nobody is listening to. Returns turn ids to cancel, and forgets
    /// sessions idle past [`IDLE_TIMEOUT`].
    pub fn reap(&self) -> Vec<String> {
        let mut inner = self.inner.lock().unwrap();
        let now = Instant::now();
        let mut orphaned = Vec::new();

        for session in inner.sessions.values_mut() {
            if session.subscribers > 0 {
                session.last_seen = now;
                continue;
            }
            if session.in_flight() && now.duration_since(session.last_seen) > ORPHAN_GRACE {
                if let Some(turn) = session.turn.as_ref() {
                    orphaned.push(turn.id.clone());
                }
            }
        }

        inner
            .sessions
            .retain(|_, s| s.subscribers > 0 || now.duration_since(s.last_seen) <= IDLE_TIMEOUT);
        let live: std::collections::HashSet<String> = inner.sessions.keys().cloned().collect();
        inner.turns.retain(|_, sid| live.contains(sid));

        orphaned
    }

    /// Drop everything — used when the server stops, so a restart does not
    /// inherit sessions whose clients are long gone.
    pub fn clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.sessions.clear();
        inner.turns.clear();
    }

    pub fn session_count(&self) -> usize {
        self.inner.lock().unwrap().sessions.len()
    }
}

/// Guest-supplied names reach a conversation title and the host's UI. Strip
/// anything that could disturb a log line or a layout, bound the length, and
/// return `None` rather than an empty string so the caller's default applies.
fn sanitise_label(label: &str) -> Option<String> {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return None;
    }
    Some(
        cleaned
            .chars()
            .take(MAX_LABEL_LEN)
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(rx: &mut broadcast::Receiver<RemoteEvent>) -> Vec<RemoteEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    #[test]
    fn a_turn_streams_suffixes_not_whole_buffers() {
        let relay = Relay::new();
        let (mut rx, _) = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();

        relay.push_text(&req.turn_id, "Hel").unwrap();
        relay.push_text(&req.turn_id, "Hello wor").unwrap();
        relay.push_text(&req.turn_id, "Hello world").unwrap();

        let deltas: Vec<String> = drain(&mut rx)
            .into_iter()
            .filter_map(|e| match e {
                RemoteEvent::Delta { text, .. } => Some(text),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec!["Hel", "lo wor", "ld"]);
    }

    #[test]
    fn a_rewritten_buffer_resyncs_instead_of_corrupting() {
        let relay = Relay::new();
        let (mut rx, _) = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        relay.push_text(&req.turn_id, "one two").unwrap();
        let _ = drain(&mut rx);

        // Not an extension of what we hold: the client must be resynced, not
        // handed a delta it would append to the wrong prefix.
        relay
            .push_text(&req.turn_id, "completely different")
            .unwrap();
        match drain(&mut rx).pop().unwrap() {
            RemoteEvent::Snapshot { text, .. } => assert_eq!(text, "completely different"),
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn reconnecting_replays_the_answer_so_far() {
        let relay = Relay::new();
        let (_rx, _) = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        relay.push_text(&req.turn_id, "half an ans").unwrap();

        // A phone that locked its screen comes back mid-answer.
        relay.unsubscribe("s1");
        let (_rx2, snapshot) = relay.subscribe("s1").unwrap();
        match snapshot {
            RemoteEvent::Snapshot { text, status, .. } => {
                assert_eq!(text, "half an ans");
                assert_eq!(status, Some(TurnStatus::Running));
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn a_finished_turn_is_still_readable_by_a_late_client() {
        let relay = Relay::new();
        let (_rx, _) = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        relay.finish(&req.turn_id, "the answer".into()).unwrap();
        relay.unsubscribe("s1");

        let (_rx2, snapshot) = relay.subscribe("s1").unwrap();
        match snapshot {
            RemoteEvent::Snapshot { text, status, .. } => {
                assert_eq!(text, "the answer");
                assert_eq!(status, Some(TurnStatus::Done));
            }
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[test]
    fn late_deltas_from_a_finished_turn_are_dropped_not_panics() {
        let relay = Relay::new();
        let (_rx, _) = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        relay.finish(&req.turn_id, "done".into()).unwrap();

        assert_eq!(
            relay.push_text(&req.turn_id, "done and more"),
            Err(RelayError::UnknownTurn)
        );
        assert_eq!(
            relay.finish(&req.turn_id, "again".into()),
            Err(RelayError::UnknownTurn)
        );
    }

    #[test]
    fn one_turn_at_a_time_per_session() {
        let relay = Relay::new();
        let _ = relay.subscribe("s1").unwrap();
        let first = relay.begin_turn("s1", "one".into(), None).unwrap();
        assert_eq!(
            relay.begin_turn("s1", "two".into(), None),
            Err(RelayError::Busy)
        );

        relay.finish(&first.turn_id, "answered".into()).unwrap();
        assert!(relay.begin_turn("s1", "two".into(), None).is_ok());
    }

    #[test]
    fn sessions_are_capped() {
        let relay = Relay::new();
        for i in 0..MAX_SESSIONS {
            relay.subscribe(&format!("s{i}")).unwrap();
        }
        assert!(matches!(
            relay.subscribe("one-too-many"),
            Err(RelayError::TooManySessions)
        ));
        // An existing session is still welcome back.
        assert!(relay.subscribe("s0").is_ok());
    }

    #[test]
    fn turns_are_rate_limited_across_sessions() {
        let relay = Relay::new();
        let mut accepted = 0;
        // Spread across sessions so the per-session busy rule is not what stops
        // it — this is the global cap.
        for i in 0..(MAX_TURNS_PER_MINUTE + 4) {
            let sid = format!("s{}", i % MAX_SESSIONS);
            if let Ok(req) = relay.begin_turn(&sid, "hi".into(), None) {
                accepted += 1;
                relay.finish(&req.turn_id, "ok".into()).unwrap();
            }
        }
        assert_eq!(accepted, MAX_TURNS_PER_MINUTE);
        assert_eq!(
            relay.begin_turn("s0", "hi".into(), None),
            Err(RelayError::RateLimited)
        );
    }

    #[test]
    fn a_guest_name_is_cleaned_before_it_reaches_a_title() {
        let relay = Relay::new();
        let named = relay
            .begin_turn("s1", "hi".into(), Some("  Dave\n\u{7}  ".into()))
            .unwrap();
        assert_eq!(named.client_label.as_deref(), Some("Dave"));

        // Nothing but whitespace is no name at all, so the caller's default
        // wins rather than a title made of spaces.
        relay.finish(&named.turn_id, "ok".into()).unwrap();
        let blank = relay
            .begin_turn("s1", "hi".into(), Some("   ".into()))
            .unwrap();
        assert_eq!(blank.client_label, None);

        relay.finish(&blank.turn_id, "ok".into()).unwrap();
        let long = relay
            .begin_turn("s1", "hi".into(), Some("x".repeat(200)))
            .unwrap();
        assert_eq!(long.client_label.unwrap().chars().count(), MAX_LABEL_LEN);
    }

    #[test]
    fn session_ids_are_validated() {
        assert!(Relay::valid_session_id("abc-123_XYZ"));
        assert!(!Relay::valid_session_id(""));
        assert!(!Relay::valid_session_id("../../etc/passwd"));
        assert!(!Relay::valid_session_id("has space"));
        assert!(!Relay::valid_session_id(
            &"x".repeat(MAX_SESSION_ID_LEN + 1)
        ));
        let relay = Relay::new();
        assert!(matches!(
            relay.subscribe("has space"),
            Err(RelayError::BadSessionId)
        ));
    }

    #[test]
    fn a_subscribed_session_is_never_reaped() {
        let relay = Relay::new();
        let (_rx, _) = relay.subscribe("s1").unwrap();
        let _req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        assert!(relay.reap().is_empty());
        assert_eq!(relay.session_count(), 1);
    }

    #[test]
    fn in_flight_turn_is_reported_only_while_running() {
        let relay = Relay::new();
        let _ = relay.subscribe("s1").unwrap();
        let req = relay.begin_turn("s1", "hi".into(), None).unwrap();
        assert_eq!(relay.in_flight_turn("s1"), Some(req.turn_id.clone()));
        relay.finish(&req.turn_id, "done".into()).unwrap();
        assert_eq!(relay.in_flight_turn("s1"), None);
    }
}
