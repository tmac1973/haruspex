//! One event stream per trusted computer, kept open while Settings → Remote
//! control → Show my other computers here is on, and reconnected when it
//! drops. Each event goes to every window as `peer://event`, and each change
//! of connection as `peer://status`: one stream per computer however many
//! windows are open. Operations don't come through here; they use the same
//! clients directly (`commands.rs`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::client::{PeerClient, PeerClients, SseFrames};
use super::{PeerConfig, CERTIFICATE_CHANGED, NOT_LET_IN};
use crate::sync_util::LockExt;
use crate::time_util::now_ms;

/// The first wait before reconnecting, doubled after each failure.
const FIRST_RETRY: Duration = Duration::from_secs(1);
const LAST_RETRY: Duration = Duration::from_secs(30);
/// The server sends a keep-alive every 15 s; this long without a byte means
/// the connection died without saying so (a computer asleep, a network gone).
const SILENCE: Duration = Duration::from_secs(45);

/// Settings' list of trusted computers, and whether to use them at all.
#[derive(Clone, Debug, Default, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeersConfig {
    pub enabled: bool,
    pub peers: Vec<PeerConfig>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PeerConnection {
    Connecting,
    Open,
    Offline,
    /// It showed another certificate: nothing is sent until the owner
    /// confirms the new one.
    CertificateChanged,
    /// Its Who can connect refuses this computer, or the token was wrong.
    NotLetIn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeerStatus {
    pub peer_id: String,
    pub connection: PeerConnection,
    /// When its stream last delivered anything (ms), if ever.
    #[ts(type = "number | null")]
    pub last_seen: Option<i64>,
}

/// Where events and statuses go: every window in the app, a recorder in tests.
pub trait Emit: Send + Sync + 'static {
    fn event(&self, peer_id: &str, event: Value);
    fn status(&self, status: &PeerStatus);
}

pub struct AppEmit(pub tauri::AppHandle);

impl Emit for AppEmit {
    fn event(&self, peer_id: &str, event: Value) {
        use tauri::Emitter;
        let payload = serde_json::json!({ "peerId": peer_id, "event": event });
        let _ = self.0.emit("peer://event", payload);
    }
    fn status(&self, status: &PeerStatus) {
        use tauri::Emitter;
        let _ = self.0.emit("peer://status", status);
    }
}

struct Stream {
    config: PeerConfig,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct PeerManager {
    clients: PeerClients,
    streams: Mutex<HashMap<String, Stream>>,
    statuses: Arc<Mutex<HashMap<String, PeerStatus>>>,
}

impl PeerManager {
    pub fn client(&self, instance_id: &str) -> Result<Arc<PeerClient>, String> {
        self.clients.get(instance_id)
    }

    /// Every peer's connection as it stands, for a window opened late.
    pub fn statuses(&self) -> Vec<PeerStatus> {
        self.statuses.lock_or_recover().values().cloned().collect()
    }

    /// Match Settings. A peer whose config is unchanged and whose stream is
    /// still trying keeps it; one that changed, or whose stream gave up
    /// (refused, or another certificate), starts again. Off stops them all.
    pub fn apply(&self, config: PeersConfig, emit: Arc<dyn Emit>) -> Result<(), String> {
        let peers = if config.enabled {
            config.peers
        } else {
            Vec::new()
        };
        self.clients.set(peers.clone())?;
        let mut streams = self.streams.lock_or_recover();
        let mut next = HashMap::new();
        for peer in peers {
            let id = peer.instance_id.clone();
            let kept = match streams.remove(&id) {
                Some(s) if s.config == peer && !s.task.is_finished() => Some(s),
                Some(s) => {
                    s.task.abort();
                    None
                }
                None => None,
            };
            let stream = match kept {
                Some(s) => s,
                None => Stream {
                    task: tokio::spawn(follow(
                        self.clients.get(&id)?,
                        emit.clone(),
                        self.statuses.clone(),
                    )),
                    config: peer,
                },
            };
            next.insert(id, stream);
        }
        for (_, s) in streams.drain() {
            s.task.abort();
        }
        self.statuses
            .lock_or_recover()
            .retain(|id, _| next.contains_key(id));
        *streams = next;
        Ok(())
    }
}

impl Drop for PeerManager {
    fn drop(&mut self) {
        for (_, s) in self.streams.lock_or_recover().drain() {
            s.task.abort();
        }
    }
}

/// Keep one peer's stream open, forwarding its events, until aborted or
/// refused for good.
async fn follow(
    client: Arc<PeerClient>,
    emit: Arc<dyn Emit>,
    statuses: Arc<Mutex<HashMap<String, PeerStatus>>>,
) {
    let peer_id = client.instance_id().to_string();
    let set = |connection: PeerConnection, seen: bool| {
        let mut map = statuses.lock_or_recover();
        let last_seen = if seen {
            Some(now_ms())
        } else {
            map.get(&peer_id).and_then(|s| s.last_seen)
        };
        let status = PeerStatus {
            peer_id: peer_id.clone(),
            connection,
            last_seen,
        };
        let changed = map.get(&peer_id).map(|s| s.connection) != Some(connection);
        map.insert(peer_id.clone(), status.clone());
        drop(map);
        if changed {
            emit.status(&status);
        }
    };
    let mut retry = FIRST_RETRY;
    loop {
        set(PeerConnection::Connecting, false);
        match client.events().await {
            Ok(response) => {
                set(PeerConnection::Open, true);
                retry = FIRST_RETRY;
                let mut body = response.bytes_stream();
                let mut frames = SseFrames::default();
                while let Ok(Some(Ok(chunk))) = tokio::time::timeout(SILENCE, body.next()).await {
                    set(PeerConnection::Open, true);
                    for data in frames.feed(&chunk) {
                        if let Ok(event) = serde_json::from_str::<Value>(&data) {
                            emit.event(&peer_id, event);
                        }
                    }
                }
            }
            Err(e) if e == CERTIFICATE_CHANGED => {
                return set(PeerConnection::CertificateChanged, false);
            }
            Err(e) if e == NOT_LET_IN => return set(PeerConnection::NotLetIn, false),
            Err(_) => {}
        }
        set(PeerConnection::Offline, false);
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(LAST_RETRY);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::owner::trust::AccessMode;
    use crate::peers::test_support::{Other, ID};
    use crate::peers::PeerAuthKind;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<Value>>,
        statuses: Mutex<Vec<PeerConnection>>,
    }

    impl Emit for Recorder {
        fn event(&self, peer_id: &str, event: Value) {
            assert_eq!(peer_id, ID);
            self.events.lock_or_recover().push(event);
        }
        fn status(&self, status: &PeerStatus) {
            self.statuses.lock_or_recover().push(status.connection);
        }
    }

    impl Recorder {
        fn last(&self) -> Option<PeerConnection> {
            self.statuses.lock_or_recover().last().copied()
        }
        fn count(&self, c: PeerConnection) -> usize {
            self.statuses
                .lock_or_recover()
                .iter()
                .filter(|&&s| s == c)
                .count()
        }
    }

    /// Wait up to 5 s for `check`.
    async fn until(check: impl Fn() -> bool) {
        for _ in 0..100 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("timed out");
    }

    fn on(peers: Vec<PeerConfig>) -> PeersConfig {
        PeersConfig {
            enabled: true,
            peers,
        }
    }

    #[tokio::test]
    async fn a_trusted_peer_streams_its_events() {
        let o = Other::new(AccessMode::Lan).await;
        let m = PeerManager::default();
        let rec = Arc::new(Recorder::default());
        m.apply(
            on(vec![o.config("127.0.0.1", PeerAuthKind::Trusted)]),
            rec.clone(),
        )
        .unwrap();
        until(|| rec.last() == Some(PeerConnection::Open)).await;
        // The server's `ready` comes first.
        until(|| !rec.events.lock_or_recover().is_empty()).await;
        assert_eq!(rec.events.lock_or_recover()[0]["type"], "ready");
        o.stub
            .events
            .send(json!({ "seq": 1, "type": "status", "sessionId": "s" }))
            .unwrap();
        until(|| rec.events.lock_or_recover().len() == 2).await;
        assert_eq!(rec.events.lock_or_recover()[1]["type"], "status");
        assert_eq!(m.statuses()[0].connection, PeerConnection::Open);
        assert!(m.statuses()[0].last_seen.is_some());
    }

    #[tokio::test]
    async fn a_peer_that_goes_away_is_offline_then_back() {
        let mut o = Other::new(AccessMode::Lan).await;
        let m = PeerManager::default();
        let rec = Arc::new(Recorder::default());
        m.apply(
            on(vec![o.config("127.0.0.1", PeerAuthKind::Trusted)]),
            rec.clone(),
        )
        .unwrap();
        until(|| rec.last() == Some(PeerConnection::Open)).await;
        o.stop().await;
        until(|| rec.last() == Some(PeerConnection::Offline)).await;
        o.start().await;
        until(|| rec.last() == Some(PeerConnection::Open)).await;
        assert_eq!(rec.count(PeerConnection::Open), 2);
    }

    #[tokio::test]
    async fn another_certificate_stops_the_stream_until_applied_again() {
        let o = Other::new(AccessMode::Lan).await;
        let m = PeerManager::default();
        let rec = Arc::new(Recorder::default());
        let mut cfg = o.config("127.0.0.1", PeerAuthKind::Trusted);
        cfg.fingerprint = "00:".repeat(31) + "00";
        m.apply(on(vec![cfg.clone()]), rec.clone()).unwrap();
        until(|| rec.last() == Some(PeerConnection::CertificateChanged)).await;
        tokio::time::sleep(FIRST_RETRY + Duration::from_millis(300)).await;
        assert_eq!(rec.count(PeerConnection::Connecting), 1, "it retried");
        // The owner confirms the real one.
        m.apply(
            on(vec![o.config("127.0.0.1", PeerAuthKind::Trusted)]),
            rec.clone(),
        )
        .unwrap();
        until(|| rec.last() == Some(PeerConnection::Open)).await;
    }

    #[tokio::test]
    async fn a_refused_peer_is_not_let_in() {
        let o = Other::new(AccessMode::Tokens).await;
        let m = PeerManager::default();
        let rec = Arc::new(Recorder::default());
        m.apply(
            on(vec![o.config("127.0.0.1", PeerAuthKind::Trusted)]),
            rec.clone(),
        )
        .unwrap();
        until(|| rec.last() == Some(PeerConnection::NotLetIn)).await;
    }

    #[tokio::test]
    async fn the_same_config_keeps_its_stream_and_off_stops_all() {
        let o = Other::new(AccessMode::Lan).await;
        let m = PeerManager::default();
        let rec = Arc::new(Recorder::default());
        let config = on(vec![o.config("127.0.0.1", PeerAuthKind::Trusted)]);
        m.apply(config.clone(), rec.clone()).unwrap();
        until(|| rec.last() == Some(PeerConnection::Open)).await;
        m.apply(config, rec.clone()).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(rec.count(PeerConnection::Connecting), 1);

        m.apply(PeersConfig::default(), rec.clone()).unwrap();
        assert!(m.statuses().is_empty());
        assert!(m.client(ID).is_err());
    }
}
