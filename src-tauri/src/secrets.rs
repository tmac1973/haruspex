//! Secrets in the operating system's own store: Secret Service on Linux
//! (GNOME Keyring, KWallet), Keychain on macOS, Credential Manager on
//! Windows. Where none works — a headless session, a Secret Service with no
//! unlocked collection — they go to an encrypted file in the app's data
//! directory instead ([`EncryptedFile`]). Where that can't be written either,
//! they are kept in memory for the session ([`session`]) and asked for again
//! after a restart. They are never put in the settings blob, which lives in
//! webview storage.
//!
//! Values only leave the store inside Rust, with one narrow exception. The
//! frontend can ask whether a store exists, put a value in and delete one;
//! it can read one back only for the two kinds of secret the webview itself
//! uses ([`READABLE`]): inference API keys, sent by the webview's own chat
//! requests, and the remote-access token, shown as a link and QR code. Every
//! other stored password never reaches the webview again.
//!
//! **Every call runs on a thread of its own, with a time limit.** The Secret
//! Service store drives zbus on tokio, and called from a tokio thread it can
//! deadlock (keyring-rs issue #132). A locked KWallet may also put up an
//! unlock prompt and wait on the user; past the limit the call fails rather
//! than holding up a mail fetch forever.
//!
//! Entries are named as keyring 3 named them: a Secret Service item with
//! `service` = [`SERVICE`] and `username` = the key, a Keychain generic
//! password with that service and account, a Credential Manager generic
//! credential with the target `{key}.{SERVICE}`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};

use crate::sync_util::LockExt;

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

/// A fresh handle on this platform's store. For Secret Service that is a new
/// D-Bus connection per call, as keyring 3 made one per call: a shared one
/// would stay locked behind an unlock prompt the caller gave up on, and
/// would not survive the keyring daemon restarting.
#[cfg(all(unix, not(target_os = "macos")))]
fn platform_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Ok(zbus_secret_service_keyring_store::Store::new()?)
}

#[cfg(target_os = "macos")]
fn platform_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

#[cfg(windows)]
fn platform_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Ok(windows_native_keyring_store::Store::new()?)
}

#[cfg(not(any(unix, windows)))]
fn platform_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    Err(keyring_core::Error::NotSupportedByStore(
        "no system keychain on this platform".to_string(),
    ))
}

/// The entry for `key`. keyring 3 named entries the same way on every
/// platform, so what an older build saved is still found.
fn entry(key: &str) -> Result<keyring_core::Entry, String> {
    platform_store()
        .and_then(|store| store.build(SERVICE, key, None))
        .map_err(|e| format!("{} refused the key: {e}", store_name()))
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
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("{} refused the read: {e}", store_name())),
        })
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let key = key.to_string();
        on_own_thread("delete", move || match entry(&key)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("{} refused the delete: {e}", store_name())),
        })
    }
}

/// Whether a store works here: write a probe, read it back, delete it. A
/// Secret Service with no unlocked collection, or a headless session with
/// none at all, fails one of the three.
///
/// Each probe writes an entry of its own. macOS only lets the app that made
/// a Keychain entry touch it without asking, and to the Keychain every
/// rebuilt dev binary is a new app: a fixed key left behind by one run that
/// never reached the delete had every later build prompting for the login
/// password, several times, before anything was saved.
pub fn probe(store: &dyn Store) -> bool {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let key = format!(
        "haruspex:probe:{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let ok =
        store.set(&key, "probe").is_ok() && matches!(store.get(&key), Ok(Some(v)) if v == "probe");
    let _ = store.delete(&key);
    ok
}

/// [`probe`] of the system keychain, once per process.
pub fn keychain_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let ok = probe(&Keychain);
        if !ok {
            log::warn!(
                "No usable {}; secrets go to an encrypted file instead",
                store_name()
            );
        }
        ok
    })
}

/// Secrets in a file of their own, encrypted with AES-256-GCM under a random
/// key kept in a second file beside it: owner-only on Unix, and on Windows
/// wrapped with DPAPI, which ties it to the user's Windows login.
///
/// What this protects against, honestly: anything that can read the
/// webview's storage — a cross-site-scripting bug, an extension of the
/// webview, a copy of the browser profile — and a casual look at the data
/// directory; on Windows also a copy of the disk read without the user's
/// login. On Linux and macOS it does not protect against someone who can read
/// the user's files, since the key sits next to the data: nothing tied to the
/// OS is available to protect it with when there is no keychain. That is the
/// keychain's job, and it is always preferred when it works.
pub struct EncryptedFile {
    dir: PathBuf,
    /// One writer at a time: every write rewrites the whole file.
    lock: Mutex<()>,
}

const SECRETS_FILE: &str = "secrets.bin";
const KEY_FILE: &str = "secrets.key";

impl EncryptedFile {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            lock: Mutex::new(()),
        }
    }

    fn key(&self) -> Result<LessSafeKey, String> {
        let path = self.dir.join(KEY_FILE);
        let bytes = match std::fs::read(&path) {
            Ok(stored) => unwrap_key(&path, stored)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut b = vec![0u8; KEY_LEN];
                SystemRandom::new()
                    .fill(&mut b)
                    .map_err(|_| "no random source for a secrets key".to_string())?;
                write_private(&path, &wrap_key(&b)?)?;
                b
            }
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        let unbound =
            UnboundKey::new(&AES_256_GCM, &bytes).map_err(|_| "bad secrets key".to_string())?;
        Ok(LessSafeKey::new(unbound))
    }

    fn load(&self, key: &LessSafeKey) -> Result<HashMap<String, String>, String> {
        let path = self.dir.join(SECRETS_FILE);
        let mut data = match std::fs::read(&path) {
            Ok(d) => d,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        if data.len() < NONCE_LEN {
            return Err(format!("{} is damaged", path.display()));
        }
        let mut body = data.split_off(NONCE_LEN);
        let nonce = Nonce::try_assume_unique_for_key(&data).map_err(|_| "bad nonce".to_string())?;
        let plain = key
            .open_in_place(nonce, Aad::empty(), &mut body)
            .map_err(|_| format!("{} could not be decrypted", path.display()))?;
        serde_json::from_slice(plain).map_err(|e| format!("{} is damaged: {e}", path.display()))
    }

    fn save(&self, key: &LessSafeKey, map: &HashMap<String, String>) -> Result<(), String> {
        let mut nonce = [0u8; NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "no random source for a nonce".to_string())?;
        let mut body = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut body)
            .map_err(|_| "could not encrypt the secrets file".to_string())?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&body);
        write_private(&self.dir.join(SECRETS_FILE), &out)
    }

    fn update(&self, f: impl FnOnce(&mut HashMap<String, String>)) -> Result<(), String> {
        let _guard = self.lock.lock_or_recover();
        let key = self.key()?;
        let mut map = self.load(&key)?;
        f(&mut map);
        self.save(&key, &map)
    }
}

const KEY_LEN: usize = 32;

/// The key as it is written to disk: wrapped with DPAPI on Windows, as is
/// elsewhere (where the file's owner-only mode is what there is).
fn wrap_key(key: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        dpapi::protect(key)
    }
    #[cfg(not(windows))]
    {
        Ok(key.to_vec())
    }
}

/// The key from what is on disk. A bare 32-byte key on Windows was written
/// before DPAPI wrapping: it is used, and rewritten wrapped.
fn unwrap_key(path: &Path, stored: Vec<u8>) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        if stored.len() == KEY_LEN {
            if let Err(e) = write_private(path, &dpapi::protect(&stored)?) {
                log::warn!("could not rewrap the secrets key with DPAPI: {e}");
            }
            return Ok(stored);
        }
        let key = dpapi::unprotect(&stored)
            .map_err(|e| format!("{} could not be unlocked: {e}", path.display()))?;
        if key.len() != KEY_LEN {
            return Err(format!("{} is not a key", path.display()));
        }
        Ok(key)
    }
    #[cfg(not(windows))]
    {
        if stored.len() != KEY_LEN {
            return Err(format!("{} is not a key", path.display()));
        }
        Ok(stored)
    }
}

/// DPAPI (`CryptProtectData`), scoped to the current user: only this user's
/// login can unwrap what it wraps, and a copy of the disk can't.
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        call(data, true)
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        call(data, false)
    }

    fn call(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(data.len()).map_err(|_| "too much data for DPAPI")?,
            // DPAPI only reads its input.
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` points at `data`, alive for the call; the optional
        // arguments are null; `output` is written by the call and freed below
        // with LocalFree, as the API requires.
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 {
            return Err(format!("DPAPI failed: {}", std::io::Error::last_os_error()));
        }
        // SAFETY: on success `output` holds `cbData` bytes DPAPI allocated.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe {
            LocalFree(output.pbData.cast());
        }
        Ok(bytes)
    }
}

/// Write `bytes` to `path` atomically, readable by the owner only on Unix.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

impl Store for EncryptedFile {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.update(|m| {
            m.insert(key.to_string(), value.to_string());
        })
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        let _guard = self.lock.lock_or_recover();
        if !self.dir.join(SECRETS_FILE).exists() {
            return Ok(None);
        }
        let k = self.key()?;
        Ok(self.load(&k)?.get(key).cloned())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        if !self.dir.join(SECRETS_FILE).exists() {
            return Ok(());
        }
        self.update(|m| {
            m.remove(key);
        })
    }
}

/// The keychain where it works, the encrypted file otherwise, and memory for
/// the session where neither can be written. Reads look in all three, so a
/// secret written while the keychain was locked is still found once it
/// opens; deletes clear all three.
pub struct Layered<K: Store, F: Store> {
    keychain: Option<K>,
    file: F,
    session: Option<&'static Memory>,
}

impl<K: Store, F: Store> Store for Layered<K, F> {
    fn set(&self, key: &str, value: &str) -> Result<(), String> {
        match &self.keychain {
            Some(k) => {
                k.set(key, value)?;
                // An older copy in the file would otherwise outlive this one
                // as soon as the keychain fails a read.
                let _ = self.file.delete(key);
                Ok(())
            }
            None => match (self.file.set(key, value), self.session) {
                (Ok(()), _) => Ok(()),
                // Nowhere that lasts: keep it for this session rather than
                // anywhere a setting would put it. `secret_store_kind` says
                // "none", and Settings says it will be asked for again.
                (Err(e), Some(session)) => {
                    log::warn!("secret {key} kept in memory only: {e}");
                    session.set(key, value)
                }
                (Err(e), None) => Err(e),
            },
        }
    }

    fn get(&self, key: &str) -> Result<Option<String>, String> {
        if let Some(k) = &self.keychain {
            if let Ok(Some(v)) = k.get(key) {
                return Ok(Some(v));
            }
        }
        let from_file = self.file.get(key);
        if let Ok(Some(v)) = &from_file {
            return Ok(Some(v.clone()));
        }
        if let Some(Some(v)) = self.session.map(|m| m.get(key).ok().flatten()) {
            return Ok(Some(v));
        }
        from_file
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        if let Some(session) = self.session {
            let _ = session.delete(key);
        }
        if let Some(k) = &self.keychain {
            k.delete(key)?;
        }
        self.file.delete(key)
    }
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Tell the store where the encrypted file goes. Called once at startup with
/// the app data directory; until then only the keychain is used.
pub fn init(app_data_dir: PathBuf) {
    let _ = DATA_DIR.set(app_data_dir);
}

/// Secrets kept for this run only, where nothing that lasts can be written.
fn session() -> &'static Memory {
    static SESSION: OnceLock<Memory> = OnceLock::new();
    SESSION.get_or_init(Memory::default)
}

/// The store every secret goes through.
pub fn store() -> Layered<Keychain, EncryptedFile> {
    Layered {
        session: Some(session()),
        ..lasting_store()
    }
}

/// [`store`] without the session tier: only what survives a restart. What
/// `secret_available` and `secret_store_kind` probe, so moving a secret out
/// of the settings never moves it somewhere a restart would lose it.
fn lasting_store() -> Layered<Keychain, EncryptedFile> {
    Layered {
        session: None,
        keychain: keychain_available().then_some(Keychain),
        file: EncryptedFile::new(
            DATA_DIR
                .get()
                .cloned()
                .unwrap_or_else(|| std::env::temp_dir().join("haruspex-secrets-uninitialised")),
        ),
    }
}

/// Values read this run, so a credential used on every request (a search
/// key, a proxy password) costs one keychain round trip, not one per request.
/// Every write and delete through the commands below clears its entry.
fn cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Every secret value read this session, so a report can blank out the exact
/// strings rather than only the shapes credentials usually take.
pub fn known_values() -> Vec<String> {
    cache().lock_or_recover().values().cloned().collect()
}

/// A secret's value, from the cache or the store, read off the async runtime.
/// `Ok(None)` when nothing is stored under `key`.
pub async fn get(key: &str) -> Result<Option<String>, String> {
    if let Some(v) = cache().lock_or_recover().get(key) {
        return Ok(Some(v.clone()));
    }
    let k = key.to_string();
    let found = tokio::task::spawn_blocking(move || store().get(&k))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(v) = &found {
        cache().lock_or_recover().insert(key.to_string(), v.clone());
    }
    Ok(found)
}

/// [`get`] for a caller that cannot await, such as building a proxied HTTP
/// client. Blocks on the store only on a cache miss.
pub fn get_blocking(key: &str) -> Result<Option<String>, String> {
    if let Some(v) = cache().lock_or_recover().get(key) {
        return Ok(Some(v.clone()));
    }
    let found = store().get(key)?;
    if let Some(v) = &found {
        cache().lock_or_recover().insert(key.to_string(), v.clone());
    }
    Ok(found)
}

/// Seed the cache, so a test can resolve a secret without a real store.
#[cfg(test)]
pub fn seed_for_test(key: &str, value: &str) {
    cache()
        .lock_or_recover()
        .insert(key.to_string(), value.to_string());
}

/// [`get`], for a secret a setting says exists: missing is an error naming
/// what to re-enter.
pub async fn require(key: &str, what: &str) -> Result<String, String> {
    get(key).await?.ok_or_else(|| {
        format!("The saved {what} is missing from Haruspex's secret store — enter it again.")
    })
}

/// The kinds of secret, by key prefix. One namespace per kind, so a webview
/// bug cannot overwrite an entry it does not own, and a fixed list, so a key
/// the app does not use cannot be written at all.
const NAMESPACES: &[&str] = &[
    "email:", "dav:", "mcp:", "apikey:", "proxy:", "brave:", "comfy:", "remote:",
];

/// The namespaces the webview may read back, because it is what uses them:
/// inference requests (streaming chat, the model list, the server probe) are
/// made from the webview with the key as `Authorization: Bearer`, and the
/// remote-access token is shown as the guest link and its QR code.
///
/// Keeping these in Rust would mean routing inference through a localhost
/// proxy that adds the key (Tauri's custom schemes can't stream). Weighed in
/// #495 and not done: script running in the main window could still *use* a
/// key through such a proxy, and getting script there is already hard. The
/// window's CSP allows `script-src 'self'` only, rendered markdown is
/// sanitized, and model-written HTML runs in a sandboxed, opaque-origin
/// iframe with no IPC (`artifact_frame.rs`). Every other secret never reaches
/// the webview.
const READABLE: &[&str] = &["apikey:", "remote:"];

/// Read a secret the webview itself needs. Refused for every other kind.
#[tauri::command]
pub async fn secret_get(key: String) -> Result<Option<String>, String> {
    check_key(&key)?;
    if !READABLE.iter().any(|ns| key.starts_with(ns)) {
        return Err(format!("{key:?} is not readable from the webview"));
    }
    get(&key).await
}

/// Keys the frontend may write.
fn check_key(key: &str) -> Result<(), String> {
    let ok = NAMESPACES
        .iter()
        .any(|ns| key.len() > ns.len() && key.starts_with(ns))
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

/// Whether secrets can be kept somewhere that lasts on this machine: the
/// keychain works, or the encrypted file can be written. (Where neither does,
/// `secret_set` still takes a secret, for the session only.)
#[tauri::command]
pub async fn secret_available() -> bool {
    tokio::task::spawn_blocking(|| probe(&lasting_store()))
        .await
        .unwrap_or(false)
}

/// Where secrets go on this machine, for the settings copy: `"keychain"`,
/// `"file"` (the encrypted fallback) or `"none"` when neither works, and they
/// are kept in memory until the app closes.
#[tauri::command]
pub async fn secret_store_kind() -> &'static str {
    tokio::task::spawn_blocking(|| {
        if keychain_available() {
            "keychain"
        } else if probe(&lasting_store()) {
            "file"
        } else {
            "none"
        }
    })
    .await
    .unwrap_or("none")
}

/// Store a secret.
#[tauri::command]
pub async fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;
    cache().lock_or_recover().remove(&key);
    tokio::task::spawn_blocking(move || store().set(&key, &value))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a secret. One that is not there is already deleted.
#[tauri::command]
pub async fn secret_delete(key: String) -> Result<(), String> {
    check_key(&key)?;
    cache().lock_or_recover().remove(&key);
    tokio::task::spawn_blocking(move || store().delete(&key))
        .await
        .map_err(|e| e.to_string())?
}

/// Secrets in memory: the session tier of [`store`], and a stand-in store in
/// tests, where `refuse` makes every write fail, as a keychain with no
/// unlocked collection does.
#[derive(Default)]
pub struct Memory {
    pub refuse: bool,
    map: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

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
        probe(&m);
        assert!(m.map.lock().unwrap().is_empty());
    }

    #[test]
    fn each_probe_writes_an_entry_of_its_own() {
        /// Remembers every key written, and never deletes.
        #[derive(Default)]
        struct Keeps(Mutex<Vec<String>>, Memory);
        impl Store for Keeps {
            fn set(&self, key: &str, value: &str) -> Result<(), String> {
                self.0.lock().unwrap().push(key.to_string());
                self.1.set(key, value)
            }
            fn get(&self, key: &str) -> Result<Option<String>, String> {
                self.1.get(key)
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Err("refused".into())
            }
        }
        let k = Keeps::default();
        probe(&k);
        probe(&k);
        let keys = k.0.lock().unwrap();
        assert_eq!(keys.len(), 2);
        assert_ne!(keys[0], keys[1]);
    }

    /// The real system keychain, which CI has none of. On macOS:
    /// `cargo test secrets::tests::the_system_keychain -- --ignored`.
    #[test]
    #[ignore]
    fn the_system_keychain_works_and_the_probe_leaves_nothing_behind() {
        assert!(probe(&Keychain));
        let key = "haruspex:probe:roundtrip";
        Keychain.set(key, "v").unwrap();
        assert_eq!(Keychain.get(key).unwrap(), Some("v".into()));
        Keychain.delete(key).unwrap();
        assert_eq!(Keychain.get(key).unwrap(), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_secrets_test_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn the_encrypted_file_round_trips_and_holds_no_plaintext() {
        let dir = temp_dir("roundtrip");
        let f = EncryptedFile::new(&dir);
        assert_eq!(f.get("dav:a").unwrap(), None);
        f.set("dav:a", "hunter2").unwrap();
        f.set("mcp:b", "ghp_token").unwrap();
        assert_eq!(f.get("dav:a").unwrap(), Some("hunter2".into()));

        let raw = std::fs::read(dir.join(SECRETS_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("hunter2"));
        assert!(!String::from_utf8_lossy(&raw).contains("dav:a"));

        // A fresh instance reads what the first wrote, with the same key.
        let again = EncryptedFile::new(&dir);
        assert_eq!(again.get("mcp:b").unwrap(), Some("ghp_token".into()));
        again.delete("dav:a").unwrap();
        assert_eq!(f.get("dav:a").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_key_and_the_secrets_are_readable_by_the_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perms");
        EncryptedFile::new(&dir).set("dav:a", "x").unwrap();
        for name in [KEY_FILE, SECRETS_FILE] {
            let mode = std::fs::metadata(dir.join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_encrypted_under_another_key_is_refused_not_misread() {
        let dir = temp_dir("wrongkey");
        EncryptedFile::new(&dir).set("dav:a", "x").unwrap();
        std::fs::write(dir.join(KEY_FILE), [7u8; 32]).unwrap();
        assert!(EncryptedFile::new(&dir).get("dav:a").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layered_prefers_the_keychain_and_still_finds_older_file_entries() {
        let dir = temp_dir("layered");
        let file = EncryptedFile::new(&dir);
        file.set("email:old", "from-file").unwrap();
        let s = Layered {
            keychain: Some(Memory::default()),
            file,
            session: None,
        };
        assert_eq!(s.get("email:old").unwrap(), Some("from-file".into()));
        s.set("email:old", "now-in-keychain").unwrap();
        assert_eq!(s.get("email:old").unwrap(), Some("now-in-keychain".into()));
        // The stale file copy went with the write.
        assert_eq!(s.file.get("email:old").unwrap(), None);
        s.delete("email:old").unwrap();
        assert_eq!(s.get("email:old").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn layered_without_a_keychain_uses_the_file() {
        let dir = temp_dir("nokeychain");
        let s: Layered<Memory, EncryptedFile> = Layered {
            keychain: None,
            file: EncryptedFile::new(&dir),
            session: None,
        };
        assert!(probe(&s));
        s.set("brave:key", "k").unwrap();
        assert_eq!(s.file.get("brave:key").unwrap(), Some("k".into()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_known_namespaces_are_writable_from_the_webview() {
        for ok in [
            "email:3f2a-77b1",
            "dav:1",
            "mcp:srv:token",
            "apikey:k1",
            "proxy:network",
            "proxy:search",
            "brave:key",
            "comfy:key",
            "remote:token",
        ] {
            assert!(check_key(ok).is_ok(), "{ok}");
        }
        for bad in ["haruspex:probe", "email:", "dav:", "other:x", "emailx:a"] {
            assert!(check_key(bad).is_err(), "{bad}");
        }
        for unreadable in ["email:a", "dav:a", "mcp:s:t", "proxy:network", "brave:key"] {
            let r = tauri::async_runtime::block_on(secret_get(unreadable.into()));
            assert!(r.is_err(), "{unreadable} was readable");
        }
        assert!(check_key("email:3f2a-77b1").is_ok());
        assert!(check_key("haruspex:probe").is_err());
        assert!(check_key("email:a\nb").is_err());
        assert!(check_key("email:../x").is_err());
        assert!(check_key("email:a/b").is_err());
        assert!(check_key("email:é").is_err());
        assert!(check_key(&format!("email:{}", "a".repeat(194))).is_ok());
        assert!(check_key(&format!("email:{}", "a".repeat(195))).is_err());
    }

    #[test]
    fn with_nowhere_to_write_a_secret_is_kept_for_the_session_only() {
        // A data folder that can't be written: a file where the folder
        // should be.
        let blocker = temp_dir("session-blocker");
        std::fs::create_dir_all(&blocker).unwrap();
        let dir = blocker.join("not-a-dir");
        std::fs::write(&dir, b"x").unwrap();
        static SESSION: OnceLock<Memory> = OnceLock::new();
        let session = SESSION.get_or_init(Memory::default);
        let s: Layered<Memory, EncryptedFile> = Layered {
            keychain: None,
            file: EncryptedFile::new(dir.join("secrets")),
            session: Some(session),
        };
        s.set("email:a", "pw").unwrap();
        assert_eq!(s.get("email:a").unwrap(), Some("pw".into()));
        assert_eq!(session.get("email:a").unwrap(), Some("pw".into()));
        s.delete("email:a").ok();
        assert_eq!(session.get("email:a").unwrap(), None);
        // Without the session tier the same write fails, which is what
        // `secret_available` probes.
        let lasting: Layered<Memory, EncryptedFile> = Layered {
            keychain: None,
            file: EncryptedFile::new(dir.join("secrets")),
            session: None,
        };
        assert!(!probe(&lasting));
        std::fs::remove_dir_all(&blocker).ok();
    }

    #[test]
    fn a_file_that_works_is_used_before_the_session() {
        let dir = temp_dir("session-not-needed");
        static SESSION: OnceLock<Memory> = OnceLock::new();
        let session = SESSION.get_or_init(Memory::default);
        let s: Layered<Memory, EncryptedFile> = Layered {
            keychain: None,
            file: EncryptedFile::new(&dir),
            session: Some(session),
        };
        s.set("dav:a", "x").unwrap();
        assert_eq!(session.get("dav:a").unwrap(), None);
        assert_eq!(
            EncryptedFile::new(&dir).get("dav:a").unwrap(),
            Some("x".into())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(not(windows))]
    #[test]
    fn the_key_is_stored_bare_outside_windows_and_checked() {
        let p = Path::new("secrets.key");
        assert_eq!(wrap_key(&[7u8; KEY_LEN]).unwrap(), vec![7u8; KEY_LEN]);
        assert_eq!(
            unwrap_key(p, vec![7u8; KEY_LEN]).unwrap(),
            vec![7u8; KEY_LEN]
        );
        assert!(unwrap_key(p, vec![7u8; 31]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_a_bare_key_still_reads() {
        let key = [9u8; KEY_LEN];
        let wrapped = wrap_key(&key).unwrap();
        assert_ne!(wrapped.len(), KEY_LEN);
        let dir = temp_dir("dpapi");
        let p = dir.join(KEY_FILE);
        assert_eq!(unwrap_key(&p, wrapped).unwrap(), key.to_vec());
        // A key written before DPAPI wrapping is used, and rewritten wrapped.
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unwrap_key(&p, key.to_vec()).unwrap(), key.to_vec());
        assert_ne!(std::fs::read(&p).unwrap().len(), KEY_LEN);
        std::fs::remove_dir_all(&dir).ok();
    }
}
