//! Companion-app servers: the ones that drive an application we neither bundle
//! nor install.
//!
//! Blender and Godot are bridges. Each needs its application present, carrying
//! an enabled addon, and **running right now**. The failure that creates is the
//! one worth designing against: the MCP process starts cleanly, negotiates, and
//! answers `tools/list` with its full toolset — so Phase 02 calls it `Ready` and
//! the settings row draws a green dot — and then every `tools/call` fails with a
//! socket timeout or a `BRIDGE_DISCONNECTED` error, mid-conversation, with
//! nothing in Settings suggesting anything is wrong.
//!
//! So a catalog entry declares the dependency and the app probes it.
//!
//! # Two probe kinds, because the two servers wire up in opposite directions
//!
//! Blender's addon **listens** on 9876, so a refused TCP connection is a
//! definitive "the addon is not serving". Godot inverts the topology: the MCP
//! server binds the bridge and the editor's addon dials *out* to it, so
//! something is always listening there and a port check would report connected
//! with no editor attached. That one has to ask the server instead, and
//! classify a declared error.
//!
//! # Status is a field, not a fifth process state
//!
//! [`CompanionStatus`] sits beside `SidecarStatus`. A fifth variant would ripple
//! through every match on that enum — in the lifecycle, in the UI, in the
//! sidecar code that shares the vocabulary — to describe something that is not a
//! process state at all. The process is genuinely fine.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// How long a probe may take before it counts as disconnected.
///
/// Short on purpose. Both probes are local, and the settings panel polls this
/// while it is open — a slow probe would make the row feel stuck rather than
/// informative.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Whether the third-party application a server bridges to is reachable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompanionStatus {
    /// The application answered.
    Connected,
    /// It did not. `hint` is the catalog entry's own instructions for fixing
    /// it, carried through rather than composed here — a third companion entry
    /// must be a JSON change, not a code change.
    #[serde(rename_all = "camelCase")]
    Disconnected { hint: String },
    /// Not probed yet, the server is not running, or the probe itself could not
    /// run. Deliberately distinct from `Disconnected`: "we do not know" and
    /// "we asked and it said no" are different things to show a user.
    Unknown,
}

/// Probe a TCP endpoint by connecting and immediately dropping the connection.
///
/// Cheap and side-effect free, which is what makes it safe to run on a poll.
pub async fn probe_tcp(host: &str, port: u16) -> bool {
    let addr = format!("{host}:{port}");
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(&addr)).await,
        Ok(Ok(_))
    )
}

/// Classify the result of a `tool`-kind probe.
///
/// Three outcomes, and they are not two: an error naming the declared
/// disconnected marker means the bridge is down, a clean result means it is up,
/// and any other failure means the probe itself did not work — which is
/// `Unknown`, because reporting "disconnected" for a server that is merely
/// mid-restart would send the user off to fix something that is not broken.
pub fn classify_tool_probe(
    result: Result<(), String>,
    disconnected_error: &str,
    hint: &str,
) -> CompanionStatus {
    match result {
        Ok(()) => CompanionStatus::Connected,
        Err(message) if message.contains(disconnected_error) => CompanionStatus::Disconnected {
            hint: hint.to_string(),
        },
        Err(_) => CompanionStatus::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_tool_result_means_the_app_is_attached() {
        assert_eq!(
            classify_tool_probe(Ok(()), "BRIDGE_DISCONNECTED", "open Godot"),
            CompanionStatus::Connected
        );
    }

    #[test]
    fn the_declared_marker_means_the_app_is_not() {
        let status = classify_tool_probe(
            Err("tools/call failed: BRIDGE_DISCONNECTED".into()),
            "BRIDGE_DISCONNECTED",
            "open Godot and enable the addon",
        );
        assert_eq!(
            status,
            CompanionStatus::Disconnected {
                hint: "open Godot and enable the addon".into()
            }
        );
    }

    #[test]
    fn any_other_failure_is_unknown_rather_than_disconnected() {
        // Reporting "disconnected" for a server that is merely mid-restart
        // would send the user off to fix something that is not broken.
        assert_eq!(
            classify_tool_probe(
                Err("server srv-1 is not connected".into()),
                "BRIDGE_DISCONNECTED",
                "open Godot"
            ),
            CompanionStatus::Unknown
        );
    }

    #[test]
    fn the_marker_must_actually_appear_rather_than_merely_resemble() {
        // The declared marker is matched, not guessed at: a server whose error
        // happens to mention "disconnected" in prose is not making the claim.
        assert_eq!(
            classify_tool_probe(
                Err("the peer disconnected unexpectedly".into()),
                "BRIDGE_DISCONNECTED",
                "open Godot"
            ),
            CompanionStatus::Unknown
        );
    }

    #[tokio::test]
    async fn a_refused_port_reads_as_not_serving() {
        // Port 1 on loopback is not going to be listening.
        assert!(!probe_tcp("127.0.0.1", 1).await);
    }

    #[tokio::test]
    async fn a_listening_port_reads_as_serving() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_tcp("127.0.0.1", port).await);
    }
}
