//! Secrets in the operating system's own store: Secret Service on Linux
//! (GNOME Keyring, KWallet), Keychain on macOS, Credential Manager on
//! Windows.
//!
//! Values only leave the store inside Rust. The frontend can ask whether a
//! store exists, put a value in and delete one — there is deliberately no
//! command that reads one back, so a stored password never reaches the
//! webview again.
//!
//! **Every call runs on a thread of its own, with a time limit.** keyring's
//! Secret Service backend drives zbus on tokio, and called from a tokio
//! thread it can deadlock (keyring-rs issue #132). A locked KWallet may also
//! put up an unlock prompt and wait on the user; past the limit the call
//! fails rather than holding up a mail fetch forever.

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

/// The service every entry is filed under.
const SERVICE: &str = "com.haruspex.app";

/// Long enough to answer an unlock prompt, short enough not to hang a turn.
const CALL_LIMIT: Duration = Duration::from_secs(30);

/// What the user calls the store on this platform, for error messages.
pub fn store_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "the macOS Keychain"
    } else if cfg!(windows) {
        "Windows Credential Manager"
    } else {
        "the system keychain (Secret Service)"
    }
}

/// A place secrets are kept. The system keychain in the app; memory in tests.
pub trait Store: Send + Sync {
    fn set(&self, key: &str, value: &str) -> Result<(), String>;
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// The operating system's store.
pub struct Keychain;

/// Run `f` on a fresh thread and wait at most [`CALL_LIMIT`] for it.
fn on_own_thread<T: Send + 'static>(
    what: &str,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(CALL_LIMIT).unwrap_or_else(|_| {
        Err(format!(
            "{} did not answer the {what} within {} s",
            store_name(),
            CALL_LIMIT.as_secs()
        ))
    })
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| format!("{} refused the key: {e}", store_name()))
}

impl Store for Keychain {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        let (key, value) = (key.to_string(), value.to_string());
        on_own_thread("write", move || {
            entry(&key)?
                .set_password(&value)
                .map_err(|e| format!("{} refused the write: {e}", store_name()))
        })
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let key = key.to_string();
        on_own_thread("read", move || match entry(&key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("{} refused the read: {e}", store_name())),
        })
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let key = key.to_string();
        on_own_thread("delete", move || match entry(&key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("{} refused the delete: {e}", store_name())),
        })
    }
}

/// Whether a store works here: write a probe, read it back, delete it. A
/// Secret Service with no unlocked collection, or a headless session with
/// none at all, fails one of the three.
pub fn probe(store: &dyn Store) -> bool {
    const KEY: &str = "haruspex:probe";
    let ok =
        store.set(KEY, "probe").is_ok() && matches!(store.get(KEY), Ok(Some(v)) if v == "probe");
    let _ = store.delete(KEY);
    ok
}

/// [`probe`] of the system keychain, once per process.
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let ok = probe(&Keychain);
        if !ok {
            log::warn!("No usable {}; secrets stay in settings", store_name());
        }
        ok
    })
}

/// Keys the frontend may write: one namespace per kind of secret, so a
/// webview bug cannot overwrite an entry it does not own.
fn check_key(key: &str) -> Result<(), String> {
    let ok = key.starts_with("email:")
        && key.len() <= 200
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_:.@".contains(c));
    if ok {
        Ok(())
    } else {
        Err(format!("Not a secret key Haruspex uses: {key:?}"))
    }
}

/// Whether the system keychain works on this machine.
#[tauri::command]
pub async fn secret_available() -> bool {
    tokio::task::spawn_blocking(available)
        .await
        .unwrap_or(false)
}

/// Store a secret.
#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    tokio::task::spawn_blocking(move || Keychain.set(&key, &value))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a secret. One that is not there is already deleted.
#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> {
    check_key(&key)?;
    tokio::task::spawn_blocking(move || Keychain.delete(&key))
        .await
        .map_err(|e| e.to_string())?
}

/// Secrets in memory, for tests; `refuse` makes every write fail, as a
/// keychain with no unlocked collection does.
#[cfg(test)]
#[derive(Default)]
pub struct Memory {
    pub refuse: bool,
    map: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl Store for Memory {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if self.refuse {
            return Err("refused".into());
        }
        self.map
            .lock()
            .unwrap()
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.map.lock().unwrap().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_round_trips() {
        let m = Memory::default();
        m.set("email:a", "pw").unwrap();
        assert_eq!(m.get("email:a").unwrap(), Some("pw".into()));
        m.delete("email:a").unwrap();
        assert_eq!(m.get("email:a").unwrap(), None);
    }

    #[test]
    fn a_store_that_refuses_writes_is_unavailable() {
        assert!(probe(&Memory::default()));
        assert!(!probe(&Memory {
            refuse: true,
            ..Default::default()
        }));
    }

    #[test]
    fn the_probe_leaves_nothing_behind() {
        let m = Memory::default();
        probe(&m);
        assert_eq!(m.get("haruspex:probe").unwrap(), None);
    }

    #[test]
    fn only_email_keys_are_writable_from_the_webview() {
        assert!(check_key("email:3f2a-77b1").is_ok());
        assert!(check_key("haruspex:probe").is_err());
        assert!(check_key("email:a\nb").is_err());
    }
}
