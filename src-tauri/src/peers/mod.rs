//! Your other computers' Haruspex (plan/instance-sync): this side is a
//! client of their owner API (`owner/`), the same one the Remote control web
//! page uses. Nothing is copied; their sessions run on them.
//!
//! The webview can't pin a self-signed certificate, so every request goes
//! through Rust (`client.rs`), checked against the fingerprint the owner
//! confirmed (`tls.rs`).

pub mod client;
pub mod commands;
pub mod manager;
#[cfg(test)]
mod test_support;
pub mod tls;

use serde::{Deserialize, Serialize};

/// How this computer gets in on the other one.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PeerAuthKind {
    /// The other computer's Who can connect lets this one in without a token.
    #[default]
    Trusted,
    /// A script token from its Add a device…, kept in the secret store under
    /// [`token_key`].
    Token,
}

/// A computer the owner has trusted, as Settings keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeerConfig {
    /// Its install id (`owner/identity.rs`).
    pub instance_id: String,
    pub name: String,
    /// What the owner typed or mDNS found: a name or an IP address.
    pub address: String,
    pub port: u16,
    /// The pinned SHA-256 fingerprint, `AA:BB:…`.
    pub fingerprint: String,
    #[serde(default)]
    pub auth: PeerAuthKind,
}

/// What a probe learned about a computer before anyone trusts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeerProbe {
    pub instance_id: String,
    pub name: String,
    pub version: String,
    pub fingerprint: String,
    pub address: String,
    pub port: u16,
}

/// Errors the frontend acts on, by their exact text.
pub const OFFLINE: &str = "offline";
pub const NOT_LET_IN: &str = "not let in";
pub const CERTIFICATE_CHANGED: &str = "certificate changed";

/// Where a peer's token is kept in the secret store.
pub fn token_key(instance_id: &str) -> String {
    format!("peer:{instance_id}")
}
