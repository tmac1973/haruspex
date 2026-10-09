//! Editor windows: read, save and watch the files open in them.
//!
//! Every file open in an editor window is watched, so a change made by
//! anything else (the agent, a formatter, `git checkout`) reaches the window.
//! The watch is on the file's directory, not the file: editors and our own
//! `write_atomic` replace a file by renaming over it, which an inode watch on
//! the old file would miss.
//!
//! Each (file, window) pair remembers the content hash that window last read
//! or saved. After a burst of events settles (`DEBOUNCE`), the file is hashed
//! once and only windows whose hash differs hear about it — so a window's own
//! save, which records the new hash before writing, never comes back to it as
//! a change, while another window showing the same file does get told.
//!
//! Paths are resolved through `resolve_in_workdir`, so a window can't read,
//! write or watch anything outside its folder.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::path::{
    resolve_in_workdir, workdir_path, workdir_path_for_write, write_bytes_to_workdir,
    MAX_READ_LOAD_BYTES, MAX_WRITE_BYTES,
};

/// The event a window hears when a file it has open changes on disk.
pub const FILE_CHANGED_EVENT: &str = "editor://file-changed";

/// Quiet time before a burst of events counts as one change. A save is
/// several events (create the temp file, write, rename); a `git checkout`
/// is many more.
const DEBOUNCE: Duration = Duration::from_millis(150);
/// A file written to non-stop is still checked this often.
const MAX_WAIT: Duration = Duration::from_secs(1);

/// The content hash a window last saw: `None` when the file didn't exist.
type Known = Option<String>;

/// What `editor_read_file` returns.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditorFile {
    /// The resolved absolute path: the file's identity in change events.
    pub path: String,
    /// `None` when the file doesn't exist (yet, or any more).
    pub content: Option<String>,
    /// Content hash, `None` when the file doesn't exist.
    pub hash: Option<String>,
}

/// What `editor_save_file` returns.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(tag = "status", rename_all = "snake_case")]
#[ts(export)]
pub enum EditorSave {
    /// Written; `hash` is the new content's.
    Saved { hash: String },
    /// Not written: the file on disk is no longer what the window loaded.
    /// `hash` is what is there now (`None`: deleted).
    Conflict { hash: Option<String> },
}

/// The payload of `editor://file-changed`.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditorFileChanged {
    pub path: String,
    /// `None`: the file was deleted.
    pub hash: Option<String>,
}

/// Hash file content. Only compared within one run, so std's hasher (fixed
/// keys) is enough; the length rules out the cheap collisions.
pub fn content_hash(bytes: &[u8]) -> String {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    format!("{:016x}-{:x}", h.finish(), bytes.len())
}

/// The file's hash on disk now, `None` if it isn't there or isn't readable.
fn disk_hash(path: &Path) -> Known {
    std::fs::read(path).ok().map(|b| content_hash(&b))
}

type EmitFn = dyn Fn(&str, EditorFileChanged) + Send + Sync;

#[derive(Default)]
struct State {
    /// file → window label → the hash that window last saw.
    files: HashMap<PathBuf, HashMap<String, Known>>,
    /// directory → how many watched files are in it.
    dirs: HashMap<PathBuf, usize>,
    watcher: Option<RecommendedWatcher>,
    /// Feeds the debounce thread; dropping it ends the thread.
    events: Option<Sender<PathBuf>>,
}

/// The watches for every editor window. Managed state; cheap to clone.
#[derive(Clone)]
pub struct EditorWatches {
    state: Arc<Mutex<State>>,
    emit: Arc<EmitFn>,
    debounce: Duration,
}

impl EditorWatches {
    /// Watches that report to `emit(window_label, change)`.
    pub fn new(emit: impl Fn(&str, EditorFileChanged) + Send + Sync + 'static) -> Self {
        Self::with_debounce(emit, DEBOUNCE)
    }

    fn with_debounce(
        emit: impl Fn(&str, EditorFileChanged) + Send + Sync + 'static,
        debounce: Duration,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            emit: Arc::new(emit),
            debounce,
        }
    }

    /// Watch `path` for `label`, which has just seen `known`.
    pub fn watch(&self, label: &str, path: &Path, known: Known) {
        let mut st = self.state.lock().unwrap();
        let new_file = !st.files.contains_key(path);
        st.files
            .entry(path.to_path_buf())
            .or_default()
            .insert(label.to_string(), known);
        if !new_file {
            return;
        }
        let Some(dir) = path.parent().map(Path::to_path_buf) else {
            return;
        };
        let count = st.dirs.entry(dir.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            return;
        }
        if st.watcher.is_none() {
            match self.start(&mut st) {
                Ok(w) => st.watcher = Some(w),
                Err(e) => {
                    log::warn!("editor file watcher unavailable: {e}");
                    return;
                }
            }
        }
        if let Some(w) = st.watcher.as_mut() {
            if let Err(e) = w.watch(&dir, RecursiveMode::NonRecursive) {
                // A file in a folder that doesn't exist yet: no reloads for it.
                log::warn!("editor: can't watch {}: {e}", dir.display());
            }
        }
    }

    /// Record what `label` just wrote, so the change doesn't come back to it.
    pub fn set_known(&self, label: &str, path: &Path, known: Known) {
        let mut st = self.state.lock().unwrap();
        if let Some(labels) = st.files.get_mut(path) {
            if let Some(k) = labels.get_mut(label) {
                *k = known;
            }
        }
    }

    /// What `label` last saw of `path`, if it watches it.
    pub fn known(&self, label: &str, path: &Path) -> Option<Known> {
        let st = self.state.lock().unwrap();
        st.files.get(path).and_then(|l| l.get(label)).cloned()
    }

    /// Stop watching `path` for `label`.
    pub fn unwatch(&self, label: &str, path: &Path) {
        let mut st = self.state.lock().unwrap();
        Self::unwatch_locked(&mut st, label, path);
    }

    /// Stop every watch `label` holds: its window closed.
    pub fn unwatch_label(&self, label: &str) {
        let mut st = self.state.lock().unwrap();
        let paths: Vec<PathBuf> = st
            .files
            .iter()
            .filter(|(_, labels)| labels.contains_key(label))
            .map(|(p, _)| p.clone())
            .collect();
        for p in paths {
            Self::unwatch_locked(&mut st, label, &p);
        }
    }

    /// Drop every watch and the watcher: the app is exiting.
    pub fn stop_all(&self) {
        let mut st = self.state.lock().unwrap();
        st.files.clear();
        st.dirs.clear();
        st.watcher = None;
        st.events = None;
    }

    /// The windows that have `path` open.
    pub fn labels_for(&self, path: &Path) -> Vec<String> {
        let st = self.state.lock().unwrap();
        let mut labels: Vec<String> = st
            .files
            .get(path)
            .map(|l| l.keys().cloned().collect())
            .unwrap_or_default();
        labels.sort();
        labels
    }

    /// Directories under watch (tests).
    #[cfg(test)]
    fn watched_dirs(&self) -> Vec<PathBuf> {
        let st = self.state.lock().unwrap();
        st.dirs.keys().cloned().collect()
    }

    fn unwatch_locked(st: &mut State, label: &str, path: &Path) {
        let Some(labels) = st.files.get_mut(path) else {
            return;
        };
        labels.remove(label);
        if !labels.is_empty() {
            return;
        }
        st.files.remove(path);
        let Some(dir) = path.parent().map(Path::to_path_buf) else {
            return;
        };
        let Some(count) = st.dirs.get_mut(&dir) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        st.dirs.remove(&dir);
        if let Some(w) = st.watcher.as_mut() {
            let _ = w.unwatch(&dir);
        }
        if st.files.is_empty() {
            // Nothing left open anywhere: let the OS watch and thread go.
            st.watcher = None;
            st.events = None;
        }
    }

    /// The OS watcher, feeding a debounce thread. Its callback only forwards
    /// paths and never takes the state lock: `watch()` is called with the
    /// lock held and waits on the watcher's own thread.
    fn start(&self, st: &mut State) -> notify::Result<RecommendedWatcher> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let forward = tx.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else { return };
            // Opening or reading a file is not a change, and our own read in
            // `flush` would otherwise trigger the next one. A close after
            // writing is.
            if let EventKind::Access(kind) = event.kind {
                if kind != notify::event::AccessKind::Close(notify::event::AccessMode::Write) {
                    return;
                }
            }
            for p in event.paths {
                let _ = forward.send(p);
            }
        })?;
        st.events = Some(tx);
        let this = self.clone();
        std::thread::Builder::new()
            .name("editor-watch".into())
            .spawn(move || this.debounce_loop(rx))
            .map_err(|e| notify::Error::generic(&e.to_string()))?;
        Ok(watcher)
    }

    fn debounce_loop(&self, rx: mpsc::Receiver<PathBuf>) {
        // Blocks until the first event of a burst, then collects until it
        // goes quiet. Ends when every sender is dropped.
        while let Ok(first) = rx.recv() {
            let started = Instant::now();
            let mut pending: HashSet<PathBuf> = HashSet::from([first]);
            loop {
                if started.elapsed() >= MAX_WAIT {
                    break;
                }
                match rx.recv_timeout(self.debounce) {
                    Ok(p) => {
                        pending.insert(p);
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            for p in pending {
                self.flush(&p);
            }
        }
    }

    /// Hash `path` and tell each window whose last-seen hash differs.
    fn flush(&self, path: &Path) {
        if !self.state.lock().unwrap().files.contains_key(path) {
            return;
        }
        let now = disk_hash(path);
        let mut tell = Vec::new();
        {
            let mut st = self.state.lock().unwrap();
            let Some(labels) = st.files.get_mut(path) else {
                return;
            };
            for (label, known) in labels.iter_mut() {
                if *known != now {
                    *known = now.clone();
                    tell.push(label.clone());
                }
            }
        }
        for label in tell {
            (self.emit)(
                &label,
                EditorFileChanged {
                    path: path.to_string_lossy().into_owned(),
                    hash: now.clone(),
                },
            );
        }
    }
}

/// Build the managed state, emitting to the window that watches the file.
pub fn editor_watches(app: &tauri::AppHandle) -> EditorWatches {
    let app = app.clone();
    EditorWatches::new(move |label, change| {
        if let Err(e) = app.emit_to(label, FILE_CHANGED_EVENT, change) {
            log::warn!("editor: emit to {label} failed: {e}");
        }
    })
}

/// The file's text and hash, `None` for both when it doesn't exist.
async fn read_file(path: &Path) -> Result<(Option<String>, Known), String> {
    let bytes = match tokio::fs::metadata(path).await {
        Ok(meta) if !meta.is_file() => return Err("Not a file".to_string()),
        Ok(meta) if meta.len() > MAX_READ_LOAD_BYTES => {
            return Err(format!(
                "File too large to open ({} bytes, max {} MB).",
                meta.len(),
                MAX_READ_LOAD_BYTES / 1_048_576
            ))
        }
        Ok(_) => tokio::fs::read(path)
            .await
            .map_err(|e| format!("Failed to read file: {e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((None, None)),
        Err(e) => return Err(format!("Failed to stat file: {e}")),
    };
    let hash = content_hash(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| "Not a text file.".to_string())?;
    Ok((Some(text), Some(hash)))
}

/// Read a file into an editor window and watch it from now on. A file that
/// doesn't exist reads as `content: None`; saving creates it.
#[tauri::command]
pub async fn editor_read_file(
    window: tauri::Window,
    workdir: String,
    rel_path: String,
) -> Result<EditorFile, String> {
    let root = workdir_path(&workdir)?;
    let path = resolve_in_workdir(&root, &rel_path)?;
    let (content, hash) = read_file(&path).await?;
    window
        .state::<EditorWatches>()
        .watch(window.label(), &path, hash.clone());
    Ok(EditorFile {
        path: path.to_string_lossy().into_owned(),
        content,
        hash,
    })
}

/// Save from an editor window. Unless `force`, refuses with `Conflict` when
/// the file on disk isn't the one the window loaded (`expected_hash`, `None`
/// for a file that didn't exist).
#[tauri::command]
pub async fn editor_save_file(
    window: tauri::Window,
    workdir: String,
    rel_path: String,
    content: String,
    expected_hash: Option<String>,
    force: bool,
) -> Result<EditorSave, String> {
    let root = workdir_path_for_write(&workdir)?;
    let path = resolve_in_workdir(&root, &rel_path)?;
    let watches = window.state::<EditorWatches>();
    save_file(
        &watches,
        window.label(),
        &path,
        &content,
        expected_hash,
        force,
    )
    .await
}

async fn save_file(
    watches: &EditorWatches,
    label: &str,
    path: &Path,
    content: &str,
    expected_hash: Option<String>,
    force: bool,
) -> Result<EditorSave, String> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!(
            "Content too large ({} bytes). Maximum write is {} bytes.",
            content.len(),
            MAX_WRITE_BYTES
        ));
    }
    if path.is_dir() {
        return Err("Not a file".to_string());
    }
    let on_disk = disk_hash(path);
    if !force && on_disk != expected_hash {
        return Ok(EditorSave::Conflict { hash: on_disk });
    }
    let hash = content_hash(content.as_bytes());
    // Recorded first, so the watcher sees our own write as nothing new.
    let before = watches.known(label, path);
    watches.watch(label, path, Some(hash.clone()));
    if let Err(e) = write_bytes_to_workdir(path, content.as_bytes()).await {
        watches.set_known(label, path, before.unwrap_or(on_disk));
        return Err(e);
    }
    Ok(EditorSave::Saved { hash })
}

/// Stop watching a file for this window: its tab closed. `path` is the one
/// `editor_read_file` returned; only this window's own watch is dropped.
#[tauri::command]
pub fn editor_unwatch_file(window: tauri::Window, path: String) {
    window
        .state::<EditorWatches>()
        .unwatch(window.label(), Path::new(&path));
}

/// For each of `rel_paths`, the label of an editor window that has it open,
/// if any, so opening it again focuses that window's tab.
#[tauri::command]
pub fn editor_find_open(
    app: tauri::AppHandle,
    workdir: String,
    rel_paths: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    let root = workdir_path(&workdir)?;
    let watches = app.state::<EditorWatches>();
    Ok(rel_paths
        .iter()
        .map(|rel| {
            resolve_in_workdir(&root, rel)
                .ok()
                .and_then(|p| watches.labels_for(&p).into_iter().next())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::Receiver;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "haruspex_editor_watch_{name}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn recorder(debounce: Duration) -> (EditorWatches, Receiver<(String, EditorFileChanged)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let w = EditorWatches::with_debounce(
            move |label, change| {
                let _ = tx.lock().unwrap().send((label.to_string(), change));
            },
            debounce,
        );
        (w, rx)
    }

    /// Everything emitted within `wait`.
    fn drain(
        rx: &Receiver<(String, EditorFileChanged)>,
        wait: Duration,
    ) -> Vec<(String, EditorFileChanged)> {
        let end = Instant::now() + wait;
        let mut out = Vec::new();
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(e) => out.push(e),
                Err(_) => break,
            }
        }
        out
    }

    const SETTLE: Duration = Duration::from_millis(1200);

    #[test]
    fn emits_when_something_else_changes_the_file() {
        let dir = temp_dir("change");
        let file = dir.join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let (w, rx) = recorder(Duration::from_millis(100));
        w.watch("editor-1", &file, disk_hash(&file));

        std::fs::write(&file, "two").unwrap();
        let got = drain(&rx, SETTLE);
        assert_eq!(
            got,
            vec![(
                "editor-1".to_string(),
                EditorFileChanged {
                    path: file.to_string_lossy().into_owned(),
                    hash: Some(content_hash(b"two")),
                }
            )]
        );

        std::fs::remove_file(&file).unwrap();
        let got = drain(&rx, SETTLE);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].1.hash, None, "a deletion reports no hash");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_windows_own_save_does_not_come_back_but_reaches_the_other_window() {
        let dir = temp_dir("own_save");
        let file = dir.join("b.txt");
        std::fs::write(&file, "start").unwrap();
        let (w, rx) = recorder(Duration::from_millis(100));
        w.watch("editor-a", &file, disk_hash(&file));
        w.watch("editor-b", &file, disk_hash(&file));

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let saved = rt
            .block_on(save_file(
                &w,
                "editor-a",
                &file,
                "mine",
                Some(content_hash(b"start")),
                false,
            ))
            .unwrap();
        assert!(matches!(saved, EditorSave::Saved { .. }));

        let got = drain(&rx, SETTLE);
        let labels: Vec<&str> = got.iter().map(|(l, _)| l.as_str()).collect();
        assert_eq!(labels, vec!["editor-b"], "only the other window hears it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_burst_of_writes_is_one_change() {
        let dir = temp_dir("burst");
        let file = dir.join("c.txt");
        std::fs::write(&file, "0").unwrap();
        let (w, rx) = recorder(Duration::from_millis(200));
        w.watch("editor-1", &file, disk_hash(&file));
        for i in 1..=5 {
            std::fs::write(&file, i.to_string()).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        let got = drain(&rx, SETTLE);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].1.hash, Some(content_hash(b"5")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unwatch_stops_events_and_releases_the_directory() {
        let dir = temp_dir("unwatch");
        let file = dir.join("d.txt");
        let other = dir.join("e.txt");
        std::fs::write(&file, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let (w, rx) = recorder(Duration::from_millis(100));
        w.watch("editor-1", &file, disk_hash(&file));
        w.watch("editor-2", &other, disk_hash(&other));
        assert_eq!(w.watched_dirs(), vec![dir.clone()]);

        w.unwatch("editor-1", &file);
        assert_eq!(w.watched_dirs(), vec![dir.clone()], "e.txt still needs it");
        std::fs::write(&file, "changed").unwrap();
        assert!(drain(&rx, SETTLE).is_empty());

        w.unwatch_label("editor-2");
        assert!(w.watched_dirs().is_empty());
        assert!(w.labels_for(&other).is_empty());
        std::fs::write(&other, "changed").unwrap();
        assert!(drain(&rx, SETTLE).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_refuses_when_the_file_changed_since_it_was_loaded() {
        let dir = temp_dir("conflict");
        let file = dir.join("f.txt");
        std::fs::write(&file, "theirs").unwrap();
        let (w, _rx) = recorder(Duration::from_millis(100));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        let res = rt
            .block_on(save_file(
                &w,
                "e",
                &file,
                "mine",
                Some(content_hash(b"old")),
                false,
            ))
            .unwrap();
        match res {
            EditorSave::Conflict { hash } => assert_eq!(hash, Some(content_hash(b"theirs"))),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "theirs");

        // Overwrite.
        rt.block_on(save_file(&w, "e", &file, "mine", None, true))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mine");

        // A deleted file, expected missing: saving recreates it.
        std::fs::remove_file(&file).unwrap();
        let res = rt
            .block_on(save_file(&w, "e", &file, "again", None, false))
            .unwrap();
        assert!(matches!(res, EditorSave::Saved { .. }));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "again");
        w.stop_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_reports_a_missing_file_as_none() {
        let dir = temp_dir("missing");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (content, hash) = rt.block_on(read_file(&dir.join("nope.md"))).unwrap();
        assert_eq!((content, hash), (None, None));
        std::fs::write(dir.join("bin"), [0xff, 0xfe, 0x00]).unwrap();
        assert!(rt.block_on(read_file(&dir.join("bin"))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
