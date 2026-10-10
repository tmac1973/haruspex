//! The owner's devices: who may use the owner API, and what each may do.
//!
//! A token is shown once, when its device is added, and only its SHA-256
//! hash is kept (`owner-clients.json` in the app data directory). A hash is
//! not a secret, so the file needs no keychain, and a lost token is replaced
//! rather than recovered.

#[cfg(test)]
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::remote::auth::token_matches;
use crate::sync_util::LockExt;

/// What a device may do. Checked on every operation, not only at connect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Scope {
    /// List and read sessions, follow their events, see prompts.
    Read,
    /// Open and start sessions, send, steer and stop turns.
    Drive,
    /// Answer command approvals and the agent's questions.
    Approve,
}

impl Scope {
    pub const ALL: [Scope; 3] = [Scope::Read, Scope::Drive, Scope::Approve];
}

/// The scope an engine operation needs, or `None` for an operation that
/// doesn't exist.
pub fn required_scope(op_type: &str) -> Option<Scope> {
    Some(match op_type {
        "sessions.list" | "session.get" | "session.resync" | "prompts.list" => Scope::Read,
        "session.open"
        | "session.new"
        | "session.send"
        | "session.stop"
        | "session.cancelShellWait" => Scope::Drive,
        "prompts.answer" => Scope::Approve,
        _ => return None,
    })
}

/// A device as Settings shows it. Never carries the token or its hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OwnerClient {
    pub id: String,
    pub name: String,
    pub scopes: Vec<Scope>,
    /// Unix seconds.
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub last_seen: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Stored {
    id: String,
    name: String,
    scopes: Vec<Scope>,
    created_at: i64,
    last_seen: Option<i64>,
    /// Hex SHA-256 of the token.
    token_hash: String,
}

impl Stored {
    fn public(&self) -> OwnerClient {
        OwnerClient {
            id: self.id.clone(),
            name: self.name.clone(),
            scopes: self.scopes.clone(),
            created_at: self.created_at,
            last_seen: self.last_seen,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    version: u32,
    clients: Vec<Stored>,
}

/// How often a device's "last seen" reaches the disk. In memory it is exact.
const SEEN_SAVE_INTERVAL: Duration = Duration::from_secs(60);

/// Tokens start with this, so one pasted in a log or a chat is recognisable.
pub const TOKEN_PREFIX: &str = "hsx_";

pub struct Clients {
    /// None in tests that don't care about the disk.
    path: Option<PathBuf>,
    inner: Mutex<Inner>,
}

struct Inner {
    clients: Vec<Stored>,
    last_save: Instant,
    /// `last_seen` changed since the file was written.
    dirty: bool,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "the system random number generator failed".to_string())?;
    Ok(hex(&buf))
}

impl Clients {
    /// Load from `path`, or start empty if there is no file yet. A file that
    /// can't be read is an error rather than an empty list: starting over
    /// would silently drop every device.
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let clients = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice::<File>(&bytes)
                    .map_err(|e| format!("{}: {e}", path.display()))?
                    .clients
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        };
        Ok(Self::with(Some(path), clients))
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with(None, Vec::new())
    }

    fn with(path: Option<PathBuf>, clients: Vec<Stored>) -> Self {
        Clients {
            path,
            inner: Mutex::new(Inner {
                clients,
                last_save: Instant::now(),
                dirty: false,
            }),
        }
    }

    fn save(&self, inner: &mut Inner) -> Result<(), String> {
        inner.last_save = Instant::now();
        inner.dirty = false;
        let Some(path) = &self.path else {
            return Ok(());
        };
        let body = serde_json::to_vec_pretty(&File {
            version: 1,
            clients: inner.clients.clone(),
        })
        .map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn list(&self) -> Vec<OwnerClient> {
        let inner = self.inner.lock_or_recover();
        inner.clients.iter().map(Stored::public).collect()
    }

    /// Add a device. The token is returned here and nowhere else, ever.
    pub fn create(&self, name: &str, scopes: &[Scope]) -> Result<(OwnerClient, String), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("give the device a name".into());
        }
        if name.chars().count() > 60 {
            return Err("a device name is at most 60 characters".into());
        }
        if scopes.is_empty() {
            return Err("a device needs at least one permission".into());
        }
        let mut scopes: Vec<Scope> = Scope::ALL
            .into_iter()
            .filter(|s| scopes.contains(s))
            .collect();
        scopes.dedup();
        let token = format!("{TOKEN_PREFIX}{}", random_hex(32)?);
        let stored = Stored {
            id: random_hex(8)?,
            name: name.to_string(),
            scopes,
            created_at: now(),
            last_seen: None,
            token_hash: hash(&token),
        };
        let client = stored.public();
        let mut inner = self.inner.lock_or_recover();
        inner.clients.push(stored);
        self.save(&mut inner)?;
        Ok((client, token))
    }

    /// Remove a device; its token stops working at once.
    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut inner = self.inner.lock_or_recover();
        let before = inner.clients.len();
        inner.clients.retain(|c| c.id != id);
        let removed = inner.clients.len() != before;
        if removed {
            self.save(&mut inner)?;
        }
        Ok(removed)
    }

    /// The device a token belongs to, noting that it was seen. Every stored
    /// hash is compared, in constant time, so how far a guess matched never
    /// shows in the timing.
    pub fn authenticate(&self, token: &str) -> Option<OwnerClient> {
        let token = token.trim();
        if !token.starts_with(TOKEN_PREFIX) {
            return None;
        }
        let presented = hash(token);
        let mut inner = self.inner.lock_or_recover();
        let mut found = None;
        for (i, c) in inner.clients.iter().enumerate() {
            if token_matches(&c.token_hash, &presented) {
                found = Some(i);
            }
        }
        let i = found?;
        inner.clients[i].last_seen = Some(now());
        inner.dirty = true;
        if inner.last_save.elapsed() >= SEEN_SAVE_INTERVAL {
            let _ = self.save(&mut inner);
        }
        Some(inner.clients[i].public())
    }

    /// Write any `last_seen` not yet on disk (the server is stopping).
    pub fn flush(&self) {
        let mut inner = self.inner.lock_or_recover();
        if inner.dirty {
            let _ = self.save(&mut inner);
        }
    }

    #[cfg(test)]
    fn stored_hashes(&self) -> HashMap<String, String> {
        let inner = self.inner.lock_or_recover();
        inner
            .clients
            .iter()
            .map(|c| (c.id.clone(), c.token_hash.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_device_authenticates_with_its_token() {
        let clients = Clients::in_memory();
        let (client, token) = clients.create("Phone", &Scope::ALL).unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));
        let seen = clients.authenticate(&token).unwrap();
        assert_eq!(seen.id, client.id);
        assert!(seen.last_seen.is_some());
    }

    #[test]
    fn a_wrong_or_revoked_token_does_not() {
        let clients = Clients::in_memory();
        let (client, token) = clients.create("Phone", &[Scope::Read]).unwrap();
        assert!(clients.authenticate("hsx_00").is_none());
        assert!(clients.authenticate("").is_none());
        assert!(clients.revoke(&client.id).unwrap());
        assert!(clients.authenticate(&token).is_none());
        assert!(!clients.revoke(&client.id).unwrap());
    }

    #[test]
    fn two_devices_have_their_own_tokens() {
        let clients = Clients::in_memory();
        let (a, ta) = clients.create("Laptop", &[Scope::Read]).unwrap();
        let (b, tb) = clients.create("Phone", &[Scope::Drive]).unwrap();
        assert_ne!(ta, tb);
        assert_eq!(clients.authenticate(&ta).unwrap().id, a.id);
        assert_eq!(clients.authenticate(&tb).unwrap().id, b.id);
    }

    #[test]
    fn the_file_holds_hashes_not_tokens() {
        let dir = std::env::temp_dir().join(format!("owner-clients-{}", random_hex(4).unwrap()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("owner-clients.json");
        let clients = Clients::load(path.clone()).unwrap();
        let (client, token) = clients.create("Phone", &Scope::ALL).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&token));
        assert!(text.contains(&clients.stored_hashes()[&client.id]));
        // And a reload knows the device.
        let again = Clients::load(path).unwrap();
        assert_eq!(again.authenticate(&token).unwrap().id, client.id);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_device_needs_a_name_and_a_permission() {
        let clients = Clients::in_memory();
        assert!(clients.create("  ", &Scope::ALL).is_err());
        assert!(clients.create("Phone", &[]).is_err());
        let (c, _) = clients
            .create("Phone", &[Scope::Approve, Scope::Read, Scope::Read])
            .unwrap();
        assert_eq!(c.scopes, vec![Scope::Read, Scope::Approve]);
    }

    #[test]
    fn each_operation_needs_its_scope() {
        assert_eq!(required_scope("session.get"), Some(Scope::Read));
        assert_eq!(required_scope("session.send"), Some(Scope::Drive));
        assert_eq!(required_scope("prompts.answer"), Some(Scope::Approve));
        assert_eq!(required_scope("session.delete"), None);
    }
}
