//! Remote web chat: a limited chat client served over HTTP to browsers on the
//! host's network.
//!
//! The split is forced by where the agent lives. Every tool call, every model
//! call and the whole streaming loop are TypeScript running in the webview, so
//! Rust's job here is transport and admission control only: serve the page,
//! authenticate the caller, and broker prompts to the frontend that can
//! actually answer them ([`relay`]).
//!
//! What this is not: a mirror of the desktop UI. A guest gets their own
//! session, independent of whoever is sitting at the machine. Contention is
//! the inference queue's business — the local lane serialises, a
//! parallel-capable remote backend does not — and the driver simply asks for a
//! slot like any other consumer.

pub mod auth;
pub mod commands;
pub mod relay;
pub mod server;

use std::sync::{Arc, Mutex};

pub use commands::*;
pub use server::{RemoteConfig, RemoteStatus};

use relay::Relay;
use server::Running;

/// Managed state: the running server, if any, and the relay that outlives
/// individual server lifetimes only in the sense that it is cleared on stop.
pub struct RemoteServer {
    running: Mutex<Option<Running>>,
    relay: Arc<Relay>,
}

impl Default for RemoteServer {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteServer {
    pub fn new() -> Self {
        RemoteServer {
            running: Mutex::new(None),
            relay: Arc::new(Relay::new()),
        }
    }

    pub fn relay(&self) -> Arc<Relay> {
        self.relay.clone()
    }

    pub fn status(&self) -> RemoteStatus {
        let running = self.running.lock().unwrap();
        match running.as_ref() {
            Some(r) => RemoteStatus {
                running: true,
                port: Some(r.port),
                bind_all: r.bind_all,
                sessions: self.relay.session_count(),
            },
            None => RemoteStatus {
                running: false,
                port: None,
                bind_all: false,
                sessions: 0,
            },
        }
    }

    /// True when a server is already up on this exact configuration, so a
    /// settings write that changed nothing does not drop live sessions.
    pub fn matches(&self, config: &RemoteConfig) -> bool {
        let running = self.running.lock().unwrap();
        running.as_ref().is_some_and(|r| {
            r.port == config.port && r.bind_all == config.bind_all && r.token == config.token
        })
    }

    pub fn install(&self, server: Running) {
        let previous = {
            let mut running = self.running.lock().unwrap();
            running.replace(server)
        };
        if let Some(previous) = previous {
            previous.stop();
        }
    }

    /// Stop and forget every session. Sessions are not persisted by design:
    /// their clients are gone the moment the port closes.
    pub fn shutdown(&self) {
        let previous = {
            let mut running = self.running.lock().unwrap();
            running.take()
        };
        if let Some(previous) = previous {
            previous.stop();
            log::info!("[remote] stopped");
        }
        self.relay.clear();
    }
}
