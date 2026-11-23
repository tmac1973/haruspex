//! The Code tab's web preview: a session's folder served on loopback HTTP,
//! for its preview window (`/preview`) and for the Playwright MCP server,
//! which can open an `http://127.0.0.1` page but not one of the app's own
//! schemes.
//!
//! One listener serves every session, on a port the OS picks, from the
//! first preview until the last closes. Each session gets a random token,
//! the first segment of every URL, mapped to its folder:
//! `http://127.0.0.1:<port>/<token>/mockup/index.html`. The page runs in
//! that origin, never the app's, so it can't reach IPC. See `paths` for
//! what a request may name and `http` for what a response carries.

mod http;
pub mod paths;
pub mod watch;

use crate::fs_tools::path::strip_verbatim;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::oneshot;

/// Called with a session id and a file the first time that file is served
/// to it: the reload watcher's way in (`watch`).
type OnServed = Box<dyn Fn(&str, &Path) + Send + Sync>;

/// What `preview_serve` hands back.
#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PreviewServe {
    /// The page's address, for the window and for `browser_navigate`.
    pub url: String,
}

struct Mapping {
    session_id: String,
    /// Canonical, without `\\?\`.
    root: PathBuf,
    /// Files served so far, so the watcher hears of each once.
    served: HashSet<PathBuf>,
}

struct Running {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

#[derive(Default)]
struct State {
    running: Option<Running>,
    /// By token.
    mappings: HashMap<String, Mapping>,
    /// Session id → token.
    tokens: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct Shared {
    state: Mutex<State>,
    on_served: OnceLock<OnServed>,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The folder `token` serves, if any.
    pub(crate) fn root_for(&self, token: &str) -> Option<PathBuf> {
        self.lock().mappings.get(token).map(|m| m.root.clone())
    }

    /// Note that `file` went to `token`'s session, telling the watcher the
    /// first time.
    pub(crate) fn served(&self, token: &str, file: &Path) {
        let session = {
            let mut st = self.lock();
            let Some(m) = st.mappings.get_mut(token) else {
                return;
            };
            if !m.served.insert(file.to_path_buf()) {
                return;
            }
            m.session_id.clone()
        };
        if let Some(hook) = self.on_served.get() {
            hook(&session, file);
        }
    }
}

/// Managed state: the listener and the sessions it serves.
#[derive(Clone, Default)]
pub struct PreviewServer(Arc<Shared>);

impl PreviewServer {
    /// Set the hook `served` calls; only the first call takes effect.
    pub fn on_served(&self, hook: impl Fn(&str, &Path) + Send + Sync + 'static) {
        let _ = self.0.on_served.set(Box::new(hook));
    }

    /// Serve `root` for `session_id` and return the address of `rel`.
    pub async fn serve(&self, session_id: &str, root: &str, rel: &str) -> Result<String, String> {
        let root = Path::new(root)
            .canonicalize()
            .map(|p| strip_verbatim(&p))
            .map_err(|_| format!("The session folder is missing: {root}"))?;
        if !root.is_dir() {
            return Err(format!("Not a folder: {}", root.display()));
        }
        let rel = rel.replace('\\', "/");
        // Relative to the folder only: `/etc/x.html` would otherwise be read
        // as the folder's own `etc/x.html`.
        if rel.starts_with('/') {
            return Err(paths::Refusal::Outside.message(&rel));
        }
        let segs = paths::segments(&rel).map_err(|r| r.message(&rel))?;
        let lower = rel.to_ascii_lowercase();
        if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
            return Err(format!("Only .html and .htm files can be previewed: {rel}"));
        }
        paths::resolve(&root, &rel).map_err(|r| r.message(&rel))?;

        let port = self.ensure_running().await?;
        let token = {
            let mut st = self.0.lock();
            let existing = st.tokens.get(session_id).cloned();
            let token = match existing {
                Some(t) => t,
                None => {
                    let t = new_token();
                    st.tokens.insert(session_id.to_string(), t.clone());
                    t
                }
            };
            let m = st.mappings.entry(token.clone()).or_insert_with(|| Mapping {
                session_id: session_id.to_string(),
                root: root.clone(),
                served: HashSet::new(),
            });
            // A session whose folder moved (a fork into a worktree reuses
            // nothing, but be safe): serve the folder it names now.
            if m.root != root {
                m.root = root.clone();
                m.served.clear();
            }
            token
        };
        let path: Vec<String> = segs
            .iter()
            .map(|s| urlencoding::encode(s).into_owned())
            .collect();
        Ok(format!(
            "http://127.0.0.1:{port}/{token}/{}",
            path.join("/")
        ))
    }

    /// Stop serving `session_id`; the listener stops with the last session.
    pub fn stop(&self, session_id: &str) {
        let mut st = self.0.lock();
        if let Some(token) = st.tokens.remove(session_id) {
            st.mappings.remove(&token);
        }
        if st.mappings.is_empty() {
            if let Some(running) = st.running.take() {
                let _ = running.shutdown.send(());
            }
        }
    }

    /// The listener's port, starting it if it isn't running.
    async fn ensure_running(&self) -> Result<u16, String> {
        if let Some(r) = &self.0.lock().running {
            return Ok(r.port);
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("Couldn't start the preview server: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Couldn't start the preview server: {e}"))?
            .port();
        let mut st = self.0.lock();
        // Another call got there while this one was binding: use its.
        if let Some(r) = &st.running {
            return Ok(r.port);
        }
        let (tx, rx) = oneshot::channel();
        let router = http::router(self.0.clone(), port);
        tauri::async_runtime::spawn(async move {
            let serve = axum::serve(listener, router).with_graceful_shutdown(async {
                let _ = rx.await;
            });
            if let Err(e) = serve.await {
                log::warn!("preview: server stopped: {e}");
            }
        });
        st.running = Some(Running { port, shutdown: tx });
        Ok(port)
    }

    #[cfg(test)]
    fn port(&self) -> Option<u16> {
        self.0.lock().running.as_ref().map(|r| r.port)
    }
}

fn new_token() -> String {
    crate::hash_util::random_hex(16).expect("the system's random source")
}

/// The session id a preview window's label names: `preview-<id>`.
pub fn session_for_label(label: &str) -> Option<&str> {
    label.strip_prefix("preview-").filter(|s| !s.is_empty())
}

/// Serve a Code session's folder and return the address of `path` in it,
/// an `.html` or `.htm` file relative to `root`.
#[tauri::command]
pub async fn preview_serve(
    server: tauri::State<'_, PreviewServer>,
    session_id: String,
    root: String,
    path: String,
) -> Result<PreviewServe, String> {
    let url = server.serve(&session_id, &root, &path).await?;
    Ok(PreviewServe { url })
}

/// Stop serving a session's folder (its preview window closed).
#[tauri::command]
pub fn preview_stop(app: tauri::AppHandle, session_id: String) {
    stop_session(&app, &session_id);
}

/// Stop `session_id`'s preview: its address and its watched files.
pub fn stop_session(app: &tauri::AppHandle, session_id: &str) {
    use tauri::Manager;
    if let Some(watches) = app.try_state::<watch::PreviewWatches>() {
        watches.stop(session_id);
    }
    if let Some(server) = app.try_state::<PreviewServer>() {
        server.stop(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    pub(super) fn site() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("mockup")).unwrap();
        fs::write(dir.path().join("mockup/index.html"), "<h1>hi</h1>").unwrap();
        fs::write(dir.path().join("notes.md"), "# notes").unwrap();
        dir
    }

    fn root(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn serve_checks_the_path_and_returns_its_address() {
        let dir = site();
        let server = PreviewServer::default();
        let url = server
            .serve("s1", &root(&dir), "mockup/index.html")
            .await
            .unwrap();
        assert!(url.starts_with("http://127.0.0.1:"), "{url}");
        assert!(url.ends_with("/mockup/index.html"), "{url}");
        let body = reqwest::get(&url).await.unwrap().text().await.unwrap();
        assert_eq!(body, "<h1>hi</h1>");

        let err = |e: Result<String, String>| e.unwrap_err();
        assert!(err(server.serve("s1", &root(&dir), "../x.html").await).starts_with("Not inside"));
        assert!(
            err(server.serve("s1", &root(&dir), "/mockup/index.html").await)
                .starts_with("Not inside")
        );
        assert!(err(server.serve("s1", &root(&dir), "notes.md").await).starts_with("Only .html"));
        assert!(err(server.serve("s1", &root(&dir), "gone.html").await).starts_with("Not found"));
        assert!(err(server.serve("s1", "/no/such/folder", "a.html").await).contains("missing"));
        server.stop("s1");
    }

    #[tokio::test]
    async fn a_path_with_spaces_is_encoded() {
        let dir = site();
        fs::write(dir.path().join("my page.html"), "x").unwrap();
        let server = PreviewServer::default();
        let url = server
            .serve("s", &root(&dir), "my page.html")
            .await
            .unwrap();
        assert!(url.ends_with("/my%20page.html"), "{url}");
        assert_eq!(reqwest::get(&url).await.unwrap().status(), 200);
        server.stop("s");
    }

    #[tokio::test]
    async fn one_port_a_token_each_and_it_stops_with_the_last() {
        let a = site();
        let b = site();
        let server = PreviewServer::default();
        let ua = server
            .serve("a", &root(&a), "mockup/index.html")
            .await
            .unwrap();
        let ub = server
            .serve("b", &root(&b), "mockup/index.html")
            .await
            .unwrap();
        let port = server.port().unwrap();
        assert!(ua.contains(&format!(":{port}/")) && ub.contains(&format!(":{port}/")));
        assert_ne!(ua, ub);
        // The same session keeps its address.
        assert_eq!(
            server
                .serve("a", &root(&a), "mockup/index.html")
                .await
                .unwrap(),
            ua
        );

        server.stop("a");
        assert_eq!(reqwest::get(&ua).await.unwrap().status(), 404);
        assert_eq!(reqwest::get(&ub).await.unwrap().status(), 200);

        server.stop("b");
        assert!(server.port().is_none());
        // Graceful shutdown takes a moment to close the socket.
        for _ in 0..50 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("the listener on {port} is still up");
    }

    #[tokio::test]
    async fn the_hook_hears_of_each_file_once() {
        let dir = site();
        let server = PreviewServer::default();
        let seen = Arc::new(Mutex::new(Vec::<(String, PathBuf)>::new()));
        let sink = seen.clone();
        server.on_served(move |s, p| sink.lock().unwrap().push((s.to_string(), p.to_path_buf())));
        let url = server
            .serve("s", &root(&dir), "mockup/index.html")
            .await
            .unwrap();
        reqwest::get(&url).await.unwrap();
        reqwest::get(&url).await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, "s");
        assert!(seen[0].1.ends_with("mockup/index.html"));
        server.stop("s");
    }

    #[test]
    fn labels_name_sessions() {
        assert_eq!(session_for_label("preview-abc"), Some("abc"));
        assert_eq!(session_for_label("preview-"), None);
        assert_eq!(session_for_label("code-abc"), None);
    }
}
