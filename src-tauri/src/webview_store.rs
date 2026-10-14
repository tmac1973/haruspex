//! The webview's saved keys (the settings blob, MCP always-allow, the active
//! tab, …), kept in a file in the app data directory so every build shares
//! them.
//!
//! `localStorage` alone is per origin, and each build loads the frontend from
//! a different one: `http://localhost:1420` under `tauri dev`,
//! `tauri://localhost` in a Linux or macOS package, `http://tauri.localhost`
//! on Windows. So a release started after a dev build (or the reverse) saw
//! default settings. `src/lib/persist.ts` copies this file into
//! `localStorage` before any store reads it, and writes every change back
//! here; `localStorage` is only a cache.
//!
//! The file is `webview-store.json`: `{"version": 1, "items": {key: value}}`,
//! values being exactly the strings the webview stored.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::sync_util::LockExt;

const FILE_NAME: &str = "webview-store.json";

/// Every key the webview saves starts with this; anything else is refused,
/// so the file can't become a general-purpose store by accident.
const KEY_PREFIX: &str = "haruspex";

type Items = BTreeMap<String, String>;

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    items: Items,
}

pub struct WebviewStore {
    path: Option<PathBuf>,
    /// `None` until the file is first read, and while it doesn't exist.
    items: Mutex<Option<Items>>,
}

impl WebviewStore {
    pub fn new(app: &AppHandle) -> Self {
        Self::at(app.path().app_data_dir().ok().map(|d| d.join(FILE_NAME)))
    }

    fn at(path: Option<PathBuf>) -> Self {
        Self {
            path,
            items: Mutex::new(None),
        }
    }

    /// What the file holds, or `None` when there is no file yet.
    fn load(&self) -> Option<Items> {
        let mut items = self.items.lock_or_recover();
        if items.is_none() {
            *items = self.path.as_deref().and_then(read);
        }
        items.clone()
    }

    /// Start the file from a window's `localStorage`, unless another window
    /// got there first. Returns what the file holds afterwards.
    fn seed(&self, seed: Items) -> Result<Items, String> {
        let mut items = self.items.lock_or_recover();
        if items.is_none() {
            *items = self.path.as_deref().and_then(read);
        }
        if let Some(existing) = items.as_ref() {
            return Ok(existing.clone());
        }
        let seed: Items = seed.into_iter().filter(|(k, _)| valid_key(k)).collect();
        self.write(&seed)?;
        *items = Some(seed.clone());
        Ok(seed)
    }

    /// Store `value` under `key`, or remove the key when `value` is `None`.
    fn set(&self, key: &str, value: Option<String>) -> Result<(), String> {
        if !valid_key(key) {
            return Err(format!("not a Haruspex key: {key}"));
        }
        let mut items = self.items.lock_or_recover();
        if items.is_none() {
            *items = self.path.as_deref().and_then(read);
        }
        let map = items.get_or_insert_with(Items::new);
        let changed = match value {
            Some(v) => map.insert(key.to_string(), v.clone()).as_ref() != Some(&v),
            None => map.remove(key).is_some(),
        };
        if changed {
            self.write(map)?;
        }
        Ok(())
    }

    fn write(&self, items: &Items) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let body = serde_json::to_vec(&File {
            version: 1,
            items: items.clone(),
        })
        .map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }
}

fn valid_key(key: &str) -> bool {
    key.starts_with(KEY_PREFIX)
}

/// The file's items, or `None` when it is missing. A file that won't parse is
/// set aside as `.bad` rather than overwritten, and treated as missing.
fn read(path: &Path) -> Option<Items> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<File>(&text) {
        Ok(file) => Some(file.items),
        Err(e) => {
            log::warn!("{} is unreadable ({e}); setting it aside", path.display());
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            None
        }
    }
}

// Async, with the file work on a blocking thread: a sync command runs on the
// main thread, and a slow disk would freeze the window.

#[tauri::command]
pub async fn webview_store_load(
    store: State<'_, Arc<WebviewStore>>,
) -> Result<Option<Items>, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.load())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn webview_store_seed(
    store: State<'_, Arc<WebviewStore>>,
    items: Items,
) -> Result<Items, String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.seed(items))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn webview_store_set(
    store: State<'_, Arc<WebviewStore>>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || store.set(&key, value))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items(pairs: &[(&str, &str)]) -> Items {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_missing_file_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = WebviewStore::at(Some(dir.path().join(FILE_NAME)));
        assert_eq!(store.load(), None);
    }

    #[test]
    fn the_first_seed_wins_and_later_seeds_get_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = WebviewStore::at(Some(path.clone()));
        let first = items(&[("haruspex-settings", "{\"a\":1}")]);
        assert_eq!(store.seed(first.clone()).unwrap(), first);
        let second = items(&[("haruspex-settings", "{}")]);
        assert_eq!(store.seed(second).unwrap(), first);
        // A second process (the other build) reads the same file.
        assert_eq!(WebviewStore::at(Some(path)).load(), Some(first));
    }

    #[test]
    fn seeding_drops_keys_that_are_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        let store = WebviewStore::at(Some(dir.path().join(FILE_NAME)));
        let seeded = store
            .seed(items(&[("haruspex.activeTab", "chat"), ("other", "x")]))
            .unwrap();
        assert_eq!(seeded, items(&[("haruspex.activeTab", "chat")]));
    }

    #[test]
    fn set_writes_through_and_none_removes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = WebviewStore::at(Some(path.clone()));
        store
            .set("haruspex.activeTab", Some("code".into()))
            .unwrap();
        store
            .set("haruspex-working-dir", Some("/tmp".into()))
            .unwrap();
        store.set("haruspex-working-dir", None).unwrap();
        assert_eq!(
            WebviewStore::at(Some(path)).load(),
            Some(items(&[("haruspex.activeTab", "code")]))
        );
        assert!(store.set("someone-else", Some("x".into())).is_err());
    }

    #[test]
    fn an_unreadable_file_is_set_aside_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        std::fs::write(&path, "not json").unwrap();
        let store = WebviewStore::at(Some(path.clone()));
        assert_eq!(store.load(), None);
        assert_eq!(
            std::fs::read_to_string(path.with_extension("json.bad")).unwrap(),
            "not json"
        );
    }
}
