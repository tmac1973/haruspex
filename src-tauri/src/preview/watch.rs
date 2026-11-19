//! Live reload for preview windows: each file the server hands a session's
//! window is watched, and a change to any of them sends `preview://changed`
//! to `preview-<sessionId>`. The window reloads the whole page.
//!
//! Only files the page actually loaded are watched, not the folder: a
//! project's `node_modules` or `target` never comes into it, and a file the
//! page starts linking is picked up when the reload fetches it. The watching
//! itself is a second `EditorWatches`, so the debounce and the content-hash
//! check (a save of the same bytes is not a change) are the editor's.

use crate::fs_tools::editor::{disk_hash, EditorFileChanged, EditorWatches};
use std::path::Path;
use tauri::Emitter;

/// The event a preview window reloads on. No payload.
pub const CHANGED_EVENT: &str = "preview://changed";

/// Managed state: the files each preview window has loaded.
#[derive(Clone)]
pub struct PreviewWatches(EditorWatches);

fn label(session_id: &str) -> String {
    format!("preview-{session_id}")
}

impl PreviewWatches {
    pub fn new(app: &tauri::AppHandle) -> Self {
        let app = app.clone();
        Self::with_emit(move |label, _| {
            if let Err(e) = app.emit_to(label, CHANGED_EVENT, ()) {
                log::warn!("preview: emit to {label} failed: {e}");
            }
        })
    }

    fn with_emit(emit: impl Fn(&str, EditorFileChanged) + Send + Sync + 'static) -> Self {
        Self(EditorWatches::new(emit))
    }

    /// Watch `file`, just served to `session_id`'s window as it is now.
    pub fn watch(&self, session_id: &str, file: &Path) {
        self.0.watch(&label(session_id), file, disk_hash(file));
    }

    /// Stop watching for `session_id`: its window closed.
    pub fn stop(&self, session_id: &str) {
        self.0.unwatch_label(&label(session_id));
    }

    /// Drop every watch: the app is exiting.
    pub fn stop_all(&self) {
        self.0.stop_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn capturing() -> (PreviewWatches, Arc<Mutex<Vec<String>>>) {
        let got = Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        let w = PreviewWatches(EditorWatches::with_debounce(
            move |label, _| sink.lock().unwrap().push(label.to_string()),
            Duration::from_millis(30),
        ));
        (w, got)
    }

    /// Wait for the watcher thread to settle.
    fn settle() {
        std::thread::sleep(Duration::from_millis(400));
    }

    #[test]
    fn a_change_to_a_served_file_reloads_its_window_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let css = root.join("style.css");
        let other = root.join("unrelated.txt");
        std::fs::write(&css, "a{}").unwrap();
        std::fs::write(&other, "x").unwrap();
        let (w, got) = capturing();
        w.watch("s1", &css);

        std::fs::write(&css, "a{color:red}").unwrap();
        settle();
        assert_eq!(*got.lock().unwrap(), vec!["preview-s1".to_string()]);

        // The same bytes again, and a file the page never loaded: nothing.
        std::fs::write(&css, "a{color:red}").unwrap();
        std::fs::write(&other, "y").unwrap();
        settle();
        assert_eq!(got.lock().unwrap().len(), 1);

        // Its window closed: nothing more.
        w.stop("s1");
        std::fs::write(&css, "a{color:blue}").unwrap();
        settle();
        assert_eq!(got.lock().unwrap().len(), 1);
    }
}
