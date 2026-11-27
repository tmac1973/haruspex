//! Supervision for the bundled stable-diffusion.cpp server.
//!
//! Started on demand and never at boot. A user who has not chosen the local
//! backend gets no extra process and no startup cost, which is a hard
//! constraint of the feature rather than a preference — the sidecar loads
//! multi-gigabyte weights and holds VRAM for as long as it runs.
//!
//! Modelled on [`crate::tts`], which is the precedent for a sidecar that
//! starts when something asks for it. Two things here are NOT like the other
//! sidecars, and both were established by measurement — see
//! `docs/image-generation.md`:
//!
//!   * sd-server is launched from the directory holding its own shared
//!     libraries, because ggml discovers its compute backends by scanning the
//!     directory containing `/proc/self/exe`. Launched from anywhere else it
//!     reports "No devices found!" and refuses to start.
//!   * that directory comes FIRST on the library search path, the opposite of
//!     [`crate::sidecar_util::library_paths`], because the executable's own
//!     directory carries llama.cpp's ggml under identical sonames at a
//!     different ABI.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::sidecar_process::{sidecar_registry, spawn_sidecar, SidecarChild};
use log::{info, warn, Level};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::sidecar_util::{
    base_url, http_client_with_bearer, kill_child, kill_process_on_port, library_path_env,
    new_log_buffer, poll_health_with, ports::IMAGE as IMAGE_PORT, snapshot_logs, spawn_log_reader,
    timing, LogBuffer, SidecarStatus, LOOPBACK,
};

/// Readiness. sd-server serves no `/health`; this is the cheapest route it
/// does serve, and it only answers once the weights are loaded — which is the
/// question "is it ready" actually asks.
const READY_PATH: &str = "/sdcpp/v1/capabilities";

/// Loading a multi-GB checkpoint and initializing Vulkan takes appreciably
/// longer than the speech sidecars' start, so this does not reuse
/// `HEALTH_POLL_TIMEOUT`.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Where sd-server's private shared libraries live, relative to a root.
const LIBS_SUBDIR: &str = "sd-libs";

/// The key sd-server demands on every request but `GET /` (its web page),
/// made fresh for each run of the app. sd-server already refuses requests
/// from other web origins; the key also shuts out any other local process
/// that finds the port. sd-server reads it from a file (`--api-key-file`):
/// argv is readable by every user on the machine, and it takes no env var.
fn engine_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| crate::hash_util::random_hex(32).expect("the OS random source failed"))
}

/// A client for the running engine: it sends the key.
fn engine_client(timeout: std::time::Duration) -> reqwest::Client {
    http_client_with_bearer(timeout, engine_key())
}

/// Write `key` to `path`, readable by this user only.
fn write_key_file(path: &Path, key: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // `mode` applies only when the file is created; an older one keeps its
    // own permissions unless they are set again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(key.as_bytes())?;
    file.write_all(b"\n")
}

/// The arguments sd-server runs with: the model's, then where to listen and
/// where to read its key.
fn server_args(model_args: Vec<String>, key_file: &Path) -> Vec<String> {
    model_args
        .into_iter()
        .chain([
            "--listen-ip".to_string(),
            LOOPBACK.to_string(),
            "--listen-port".to_string(),
            IMAGE_PORT.to_string(),
            "--api-key-file".to_string(),
            key_file.to_string_lossy().to_string(),
        ])
        .collect()
}

pub struct ImageEngine {
    status: Arc<Mutex<SidecarStatus>>,
    child: Mutex<Option<SidecarChild>>,
    log: LogBuffer,
    /// The weights the running process was started with, so a request for
    /// different ones restarts rather than silently generating from the old.
    model: Mutex<Option<String>>,
    /// The model arguments it was started with. The same model with other
    /// files (Qwen's vision weights, added later for editing) restarts it.
    args: Mutex<Option<Vec<String>>>,
    /// `GGML_VK_VISIBLE_DEVICES` for this machine, decided on the first start
    /// (see [`discrete_vulkan_devices`]). `None` until then; `Some(None)` when
    /// nothing needs pinning.
    vk_devices: Mutex<Option<Option<String>>>,
}

/// The discrete Vulkan devices, when an integrated one sits beside them.
///
/// sd.cpp's auto-fit places the model on the device with the most free
/// memory, and an integrated GPU reports the system's RAM as its own: on a
/// Ryzen with a 9070 XT it put Ming on the iGPU (32 GB "free") instead of the
/// card (14 GB). ggml prints every device at start, `uma: 1` for integrated;
/// this reads that list and returns the indices to keep, comma-separated, or
/// `None` when there is nothing to choose between.
pub fn discrete_vulkan_devices(log: &[String]) -> Option<String> {
    let mut discrete = Vec::new();
    let mut integrated = false;
    for line in log {
        let Some(rest) = line.trim().strip_prefix("ggml_vulkan: ") else {
            continue;
        };
        let Some((index, tail)) = rest.split_once(" = ") else {
            continue;
        };
        let Ok(index) = index.trim().parse::<u32>() else {
            continue;
        };
        match tail.split('|').find_map(|f| f.trim().strip_prefix("uma: ")) {
            Some("0") => discrete.push(index.to_string()),
            Some(_) => integrated = true,
            None => {}
        }
    }
    (integrated && !discrete.is_empty()).then(|| discrete.join(","))
}

/// Why a start failed, as a discriminant rather than a sentence.
///
/// Every one of these is a condition the UI should present differently: a
/// missing model is the user's next action, a missing sidecar is a broken
/// install, and a timeout is worth showing logs for.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", content = "detail")]
pub enum ImageEngineError {
    /// No weights configured. Nothing was spawned.
    NoModel,
    /// The configured weights are not on disk.
    ModelMissing(String),
    /// The sidecar is not bundled for this platform, or the install is broken.
    SidecarMissing(String),
    /// Spawned, but never became ready.
    Timeout(String),
    Spawn(String),
}

impl std::fmt::Display for ImageEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoModel => write!(
                f,
                "No image model is configured — Settings → Image generation"
            ),
            Self::ModelMissing(p) => write!(f, "The image model was not found at {p}"),
            Self::SidecarMissing(p) => write!(f, "The image sidecar is missing: {p}"),
            Self::Timeout(s) => write!(f, "The image engine did not become ready: {s}"),
            Self::Spawn(s) => write!(f, "The image engine could not be started: {s}"),
        }
    }
}

/// The directory holding `sd-libs`, in dev and in a packaged build.
///
/// Dev keeps it in the source tree; a bundle ships it under `resources/`.
/// Checked for existence rather than guessed at, so a missing bundle is a
/// named error instead of a spawn that fails obscurely.
///
/// The source tree comes first. An unbundled build (`tauri build
/// --no-bundle`, the e2e build) on a machine with the package installed gets
/// a `resource_dir` of `/usr/lib/Haruspex`, and taking the installed
/// libraries there would pair the tree's sd-server with another version's
/// ggml. A packaged build has no `../../binaries` beside its executable, so
/// the order costs it nothing.
pub fn sd_libs_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Dev: the binary runs from src-tauri/target/debug.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join("binaries").join(LIBS_SUBDIR));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(LIBS_SUBDIR));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// Where the engine is assembled before it runs: a directory of our own.
fn stage_dir(app: &AppHandle) -> Result<PathBuf, ImageEngineError> {
    app.path()
        .app_local_data_dir()
        .map(|d| d.join("sd-engine"))
        .map_err(|e| ImageEngineError::Spawn(format!("no data directory to run from: {e}")))
}

/// Assemble the sidecar and its libraries in `dir` and return the path to run.
///
/// ggml finds its backends by scanning the directory of `/proc/self/exe`, so
/// the binary must sit beside the libraries — but the directory that ships
/// them is not ours to write: root-owned in a deb or rpm, read-only in an
/// AppImage, inside the signed bundle on macOS, under Program Files from the
/// MSI. So `dir` gets a copy of the ~2 MB binary (a symlinked executable
/// would resolve `/proc/self/exe`, and `$ORIGIN`, back to where it came from)
/// and a link to each of the ~100 MB of libraries, through
/// [`crate::runtimes::place_shim`]. ggml's scan follows the links.
///
/// Idempotent: the binary is re-copied only when absent or a different size,
/// links already pointing at the right file are left alone, and anything an
/// older version left behind is removed, so a stale backend cannot be picked
/// up beside new libraries.
fn stage(sidecar: &Path, libs: &Path, dir: &Path) -> Result<PathBuf, ImageEngineError> {
    let fail = |what: &str, path: &Path, e: std::io::Error| {
        ImageEngineError::Spawn(format!("could not {what} {}: {e}", path.display()))
    };
    let name = sidecar
        .file_name()
        .ok_or_else(|| ImageEngineError::SidecarMissing(sidecar.display().to_string()))?;
    std::fs::create_dir_all(dir).map_err(|e| fail("create", dir, e))?;

    let mut wanted = vec![name.to_os_string()];
    for entry in std::fs::read_dir(libs).map_err(|e| fail("read", libs, e))? {
        let entry = entry.map_err(|e| fail("read", libs, e))?;
        let file = entry.file_name();
        if file == name {
            continue;
        }
        let link = dir.join(&file);
        crate::runtimes::place_shim(&entry.path(), &link)
            .map_err(|e| fail("link a library at", &link, e))?;
        wanted.push(file);
    }
    for entry in std::fs::read_dir(dir).map_err(|e| fail("read", dir, e))? {
        let entry = entry.map_err(|e| fail("read", dir, e))?;
        if !wanted.contains(&entry.file_name()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }

    let dest = dir.join(name);
    let same = match (std::fs::metadata(sidecar), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len(),
        _ => false,
    };
    if !same {
        // Through a temporary name, so a half-written binary is never the
        // one that runs.
        let tmp = dir.join(".sd-server.partial");
        std::fs::copy(sidecar, &tmp).map_err(|e| fail("copy the sidecar to", &tmp, e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| fail("place the sidecar at", &dest, e))?;
    }
    Ok(dest)
}

impl Default for ImageEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ImageEngine {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(SidecarStatus::Stopped)),
            child: Mutex::new(None),
            log: new_log_buffer(),
            model: Mutex::new(None),
            args: Mutex::new(None),
            vk_devices: Mutex::new(None),
        }
    }

    pub async fn status(&self) -> SidecarStatus {
        self.status.lock().await.clone()
    }

    pub async fn logs(&self) -> Vec<String> {
        snapshot_logs(&self.log).await
    }

    /// The weights the running engine loaded, if any.
    pub async fn loaded_model(&self) -> Option<String> {
        self.model.lock().await.clone()
    }

    /// Start the engine on catalogue entry `model_id`, or return a named reason.
    ///
    /// Idempotent for the same model and files: a second call while ready or
    /// starting returns immediately. A different model, or the same one with
    /// files added since, restarts, because the alternative is generating from
    /// weights nobody asked for, or without the ones they just downloaded.
    pub async fn start(
        &self,
        app: &AppHandle,
        models_dir: &Path,
        model_id: &str,
    ) -> Result<(), ImageEngineError> {
        let want = model_id.trim();
        if want.is_empty() {
            return Err(ImageEngineError::NoModel);
        }
        let model_args = crate::image_models::engine_args(models_dir, want).ok_or_else(|| {
            ImageEngineError::ModelMissing(
                crate::image_models::model_dir(models_dir, want)
                    .display()
                    .to_string(),
            )
        })?;

        {
            let status = self.status.lock().await;
            let loaded = self.model.lock().await;
            let args = self.args.lock().await;
            let running = *status == SidecarStatus::Ready || *status == SidecarStatus::Starting;
            if running && loaded.as_deref() == Some(want) && args.as_ref() == Some(&model_args) {
                return Ok(());
            }
        }

        self.stop().await;
        kill_process_on_port(IMAGE_PORT, "sd-server", sidecar_registry(app))
            .await
            .map_err(ImageEngineError::Spawn)?;

        let libs = sd_libs_dir(app).ok_or_else(|| {
            ImageEngineError::SidecarMissing(format!("no {LIBS_SUBDIR} directory was bundled"))
        })?;
        // No `shell().sidecar(...)` probe first. It built a command only to
        // throw it away, because this engine needs the path (see
        // [`resolve_sidecar_binary`]) — and asking the shell plugin for a name
        // it never spawns implied the capability allowlist had a say here,
        // which it does not: that scope governs what the webview may invoke,
        // and every spawn in this module is Rust-side. Finding the binary is
        // the only thing that actually decides whether the engine can run.
        let sidecar_path = resolve_sidecar_binary(app)
            .ok_or_else(|| ImageEngineError::SidecarMissing("sd-server".into()))?;
        let staged = stage_dir(app)?;
        let exe = stage(&sidecar_path, &libs, &staged)?;
        // Beside the staged directory, not in it: staging removes whatever
        // it did not put there.
        let key_file = staged.with_extension("key");
        write_key_file(&key_file, engine_key()).map_err(|e| {
            ImageEngineError::Spawn(format!(
                "could not write the engine's key to {}: {e}",
                key_file.display()
            ))
        })?;

        *self.status.lock().await = SidecarStatus::Starting;
        *self.model.lock().await = Some(want.to_string());
        *self.args.lock().await = Some(model_args.clone());
        info!("Starting sd-server on port {IMAGE_PORT}");

        let args = server_args(model_args, &key_file);
        let decided = self.vk_devices.lock().await.clone();
        self.spawn(app, &exe, &staged, &args, decided.clone().flatten())
            .await?;
        if decided.is_none() {
            // First start on this machine: read the device list ggml prints
            // before loading anything, and restart pinned to the discrete GPU
            // if auto-fit could pick an integrated one.
            let pin = self.wait_for_devices().await;
            *self.vk_devices.lock().await = Some(pin.clone());
            if let Some(ids) = pin {
                info!("Pinning sd-server to discrete Vulkan device(s) {ids}");
                // Stopped first: the old process's log reader marks the engine
                // as errored when it exits, unless it was stopped on purpose —
                // and that exit can land after the new process has started.
                *self.status.lock().await = SidecarStatus::Stopped;
                if let Err(e) = kill_child(&self.child, "sd-server").await {
                    warn!("{e}");
                }
                for _ in 0..30 {
                    if snapshot_logs(&self.log)
                        .await
                        .iter()
                        .any(|l| l.starts_with("[terminated]"))
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                crate::sidecar_util::clear_logs(&self.log).await;
                *self.status.lock().await = SidecarStatus::Starting;
                self.spawn(app, &exe, &staged, &args, Some(ids)).await?;
            }
        }

        let url = format!("{}{READY_PATH}", base_url(IMAGE_PORT));
        let status_for_poll = Arc::clone(&self.status);
        let keep_going = move || {
            let s = Arc::clone(&status_for_poll);
            async move { !matches!(&*s.lock().await, SidecarStatus::Error(_)) }
        };
        let client = engine_client(timing::SHORT_HTTP_TIMEOUT);
        if poll_health_with(&client, &url, "sd-server", READY_TIMEOUT, false, keep_going).await {
            *self.status.lock().await = SidecarStatus::Ready;
            info!("sd-server ready");
            return Ok(());
        }

        // Hand back what the process said rather than "timed out": a failure
        // to load weights is the usual cause and it is in the log.
        let tail = snapshot_logs(&self.log)
            .await
            .into_iter()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .join(" / ");
        self.stop().await;
        let msg = if tail.is_empty() {
            format!(
                "no response on {READY_PATH} within {}s",
                READY_TIMEOUT.as_secs()
            )
        } else {
            tail
        };
        *self.status.lock().await = SidecarStatus::Error(msg.clone());
        Err(ImageEngineError::Timeout(msg))
    }

    /// Spawn sd-server with `args`, restricted to the Vulkan devices `vk` names.
    async fn spawn(
        &self,
        app: &AppHandle,
        exe: &Path,
        libs: &Path,
        args: &[String],
        vk: Option<String>,
    ) -> Result<(), ImageEngineError> {
        // The staged libraries only, not `with_library_paths`. The app's exe
        // directory carries llama.cpp's ggml under the same sonames at a
        // different ABI; putting it on the path resolves sd-server against
        // the wrong library.
        let (lib_var, lib_path) = library_path_env(vec![libs.to_string_lossy().to_string()]);

        let mut cmd = app
            .shell()
            .command(exe.to_string_lossy().to_string())
            .env(lib_var, lib_path)
            .current_dir(libs)
            .args(args);
        if let Some(ids) = vk {
            cmd = cmd.env("GGML_VK_VISIBLE_DEVICES", ids);
        }

        let (rx, child) = spawn_sidecar(cmd, "sd-server", sidecar_registry(app))
            .map_err(ImageEngineError::Spawn)?;
        *self.child.lock().await = Some(child);
        spawn_log_reader(
            "sd-server",
            rx,
            Arc::clone(&self.status),
            Arc::clone(&self.log),
            &[],
            Level::Warn,
        );
        Ok(())
    }

    /// The device list from a fresh process's log, waited for briefly: ggml
    /// prints it before any weights load, so it is there within a second or
    /// two. `None` (pin nothing) when it never appears — Metal, or no Vulkan.
    async fn wait_for_devices(&self) -> Option<String> {
        for _ in 0..50 {
            let lines = snapshot_logs(&self.log).await;
            if lines
                .iter()
                .any(|l| l.contains("load_backend") || l.contains("loading"))
            {
                return discrete_vulkan_devices(&lines);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        discrete_vulkan_devices(&snapshot_logs(&self.log).await)
    }

    /// Stop the engine. A no-op when nothing is running.
    pub async fn stop(&self) {
        if let Err(e) = kill_child(&self.child, "sd-server").await {
            warn!("{e}");
        }
        *self.status.lock().await = SidecarStatus::Stopped;
        *self.model.lock().await = None;
        *self.args.lock().await = None;
    }
}

/// Where the bundled `sd-server` binary is on disk.
///
/// `ShellExt::sidecar` builds a command but does not expose the path, and this
/// engine needs the path itself in order to copy the binary next to its
/// libraries.
///
/// Matched by PREFIX rather than by target triple. Tauri strips the triple
/// when it bundles a sidecar, so the packaged name is `haruspex-sd-server`
/// while a dev tree holds `haruspex-sd-server-x86_64-unknown-linux-gnu`;
/// looking for both without knowing which is which avoids threading a
/// build-time triple through for one comparison. The `.version` stamp that
/// sits beside it is skipped.
fn resolve_sidecar_binary(app: &AppHandle) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("..").join("..").join("binaries"));
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.join("binaries"));
        dirs.push(resource_dir);
    }
    dirs.into_iter().find_map(|d| first_sidecar_in(&d))
}

/// The `haruspex-sd-server` binary in one directory, if there is one.
fn first_sidecar_in(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                    n.starts_with("haruspex-sd-server") && !n.ends_with(".version")
                })
        })
        .collect();
    // Deterministic across platforms: read_dir order is not.
    found.sort();
    found.into_iter().next()
}

// Tauri commands
//
// Deliberately four small ones rather than one that does everything: the
// Settings panel starts, stops, polls status and reads logs independently,
// the same affordances the TTS section already gives koko.

#[tauri::command]
pub async fn image_engine_start(
    app: AppHandle,
    state: tauri::State<'_, ImageEngine>,
    models: tauri::State<'_, crate::models::ModelManager>,
    model_id: String,
) -> Result<(), ImageEngineError> {
    state.start(&app, models.models_dir(), &model_id).await
}

#[tauri::command]
pub async fn image_engine_stop(state: tauri::State<'_, ImageEngine>) -> Result<(), ()> {
    state.stop().await;
    Ok(())
}

/// Status plus which weights are loaded, in one call: the UI shows them on
/// one line and two commands would let them disagree.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageEngineStatus {
    pub status: SidecarStatus,
    pub model: Option<String>,
    /// False when no sidecar is bundled for this platform, which is the
    /// availability gate the Settings panel hides the Local option behind.
    pub available: bool,
}

#[tauri::command]
pub async fn image_engine_status(
    app: AppHandle,
    state: tauri::State<'_, ImageEngine>,
) -> Result<ImageEngineStatus, ()> {
    Ok(ImageEngineStatus {
        status: state.status().await,
        model: state.loaded_model().await,
        available: sd_libs_dir(&app).is_some() && resolve_sidecar_binary(&app).is_some(),
    })
}

/// The engine's requests, one at a time; see `image_engine_request`.
static ENGINE_REQUESTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// POST JSON to the running engine and return its response body.
///
/// The URL is built here from [`IMAGE_PORT`], and the caller supplies only a
/// path. That is the point: a general "POST to any URL" command reachable
/// from the webview is a request-forgery primitive, and this backend only
/// ever needs to reach one loopback process.
///
/// It also sidesteps CORS entirely. A webview `fetch` sends an `Origin`
/// header, and a bare HTTP server has no reason to accept it — which is
/// exactly how the ComfyUI backend came to need a launch flag.
#[tauri::command]
pub async fn image_engine_request(
    path: String,
    body: String,
    timeout_ms: u64,
) -> Result<String, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains("://") {
        return Err(format!("Not an engine path: {path}"));
    }
    // A DGL script reads any file this user can, so the webview may not send
    // one; the scripts the app runs are its own (`image_engine_upscale`).
    if is_dgl_path(&path) {
        return Err(format!("Not an engine path: {path}"));
    }
    // sd-server draws one picture at a time and fails a second rather than
    // queueing it, so requests take turns here: a background task's and a
    // turn's, from every window.
    let _turn = ENGINE_REQUESTS.lock().await;
    let url = format!("{}{path}", base_url(IMAGE_PORT));
    let client = engine_client(std::time::Duration::from_millis(
        timeout_ms.clamp(1_000, 1_800_000),
    ));
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("The image engine did not answer {path}: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("The image engine's reply to {path} could not be read: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "The image engine refused {path} ({status}): {}",
            text.chars().take(200).collect::<String>()
        ));
    }
    Ok(text)
}

/// The DGL routes, which run a script with this user's file access.
fn is_dgl_path(path: &str) -> bool {
    let route = path.split(['?', '#']).next().unwrap_or(path);
    let route = route.trim_end_matches('/').to_ascii_lowercase();
    route.starts_with("/sdcpp/v1/dgl") || route.contains("/../") || route.contains("/./")
}

/// The DGL script that upscales the picture at `input` with the ESRGAN model
/// at `upscaler`. Paths go in as JSON string literals, as the DGL guide says
/// to build a script, so a quote or a backslash in one cannot change it.
fn upscale_script(upscaler: &Path, input: &Path) -> String {
    let lit =
        |p: &Path| serde_json::to_string(&p.to_string_lossy()).expect("a string always serializes");
    format!(
        "# version: 0.0.0\n\
         fn main() {{\n\
         \x20   upscaler = load_upscaler({})\n\
         \x20   image = image::load({})\n\
         \x20   return image::encode(upscale(upscaler, image))\n\
         }}\n",
        lit(upscaler),
        lit(input)
    )
}

/// The picture in a finished DGL job: the media named `result`, which is
/// what a script that returns one `image::encode` dict produces.
fn upscaled_from(job: &serde_json::Value) -> Option<String> {
    job.pointer("/result/media")?
        .as_array()?
        .iter()
        .find(|m| m.get("name").and_then(|n| n.as_str()) == Some("result"))?
        .get("b64_json")?
        .as_str()
        .map(String::from)
}

/// How long between looks at a queued upscale.
const JOB_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

/// Upscale one picture ×4 with the Real-ESRGAN model the engine was started
/// with, and return it as base64 PNG.
///
/// sd-server dropped its `/sdcpp/v1/upscale` route (sd.cpp #2404); an upscale
/// is now a DGL job. The script is built here, never in the webview, because
/// a DGL script can read any file. The picture goes to the engine through a
/// file of our own beside the staged engine, removed once the job ends.
#[tauri::command]
pub async fn image_engine_upscale(
    app: AppHandle,
    models: tauri::State<'_, crate::models::ModelManager>,
    image: String,
    timeout_ms: u64,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image.trim())
        .map_err(|e| format!("The picture to upscale is not base64: {e}"))?;
    let upscaler = crate::image_models::upscaler_path(models.models_dir());
    if !upscaler.is_file() {
        return Err(
            "The upscaler is not downloaded — Settings → Image generation → Bundled engine.".into(),
        );
    }
    let input = stage_dir(&app)
        .map_err(|e| e.to_string())?
        .with_extension("upscale-input.png");
    std::fs::write(&input, rgb_png(&bytes)?)
        .map_err(|e| format!("Could not write the picture to {}: {e}", input.display()))?;
    let result = run_upscale(&upscale_script(&upscaler, &input), timeout_ms).await;
    let _ = std::fs::remove_file(&input);
    result
}

/// `bytes` as an RGB PNG: the upscaler refuses any other channel count. The
/// alpha it drops is put back afterwards (`image_gen::upscale`).
fn rgb_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let rgb = image::load_from_memory(bytes)
        .map_err(|e| format!("Could not read the picture to upscale: {e}"))?
        .to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    rgb.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the picture to upscale: {e}"))?;
    Ok(out.into_inner())
}

async fn run_upscale(script: &str, timeout_ms: u64) -> Result<String, String> {
    let _turn = ENGINE_REQUESTS.lock().await;
    let timeout = std::time::Duration::from_millis(timeout_ms.clamp(1_000, 1_800_000));
    let client = engine_client(timing::SHORT_HTTP_TIMEOUT * 5);
    let base = base_url(IMAGE_PORT);
    let created: serde_json::Value = client
        .post(format!("{base}/sdcpp/v1/dgl/jobs"))
        .json(&serde_json::json!({ "source": script }))
        .send()
        .await
        .map_err(|e| format!("The image engine did not take the upscale: {e}"))?
        .error_for_status()
        .map_err(|e| format!("The image engine refused the upscale: {e}"))?
        .json()
        .await
        .map_err(|e| format!("The image engine's reply to the upscale could not be read: {e}"))?;
    let id = created
        .get("id")
        .and_then(|i| i.as_str())
        .ok_or("The image engine queued the upscale without an id")?
        .to_string();
    let poll = format!("{base}/sdcpp/v1/jobs/{id}");
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::time::sleep(JOB_POLL_INTERVAL).await;
        let job: serde_json::Value = match client.get(&poll).send().await {
            Ok(resp) => resp
                .json()
                .await
                .map_err(|e| format!("The upscale's status could not be read: {e}"))?,
            Err(e) if tokio::time::Instant::now() < deadline => {
                warn!("sd-server upscale poll failed: {e}");
                continue;
            }
            Err(e) => return Err(format!("The image engine stopped answering: {e}")),
        };
        match job.get("status").and_then(|s| s.as_str()) {
            Some("completed") => {
                return upscaled_from(&job)
                    .ok_or_else(|| "The image engine returned no upscaled picture.".to_string())
            }
            Some("failed") | Some("cancelled") => {
                let message = job
                    .pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("no reason given");
                return Err(format!("The upscale failed: {message}"));
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = client.post(format!("{poll}/cancel")).send().await;
            return Err(format!(
                "The upscale did not finish within {}s",
                timeout.as_secs()
            ));
        }
    }
}

#[tauri::command]
pub async fn image_engine_logs(state: tauri::State<'_, ImageEngine>) -> Result<Vec<String>, ()> {
    Ok(state.logs().await)
}

/// Empty the engine's log, for the log viewer's Clear.
#[tauri::command]
pub async fn image_engine_clear_logs(state: tauri::State<'_, ImageEngine>) -> Result<(), ()> {
    crate::sidecar_util::clear_logs(&state.log).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_request_command_refuses_anything_that_is_not_an_engine_path() {
        // The URL is built from IMAGE_PORT and the caller supplies only a
        // path, so a caller cannot aim this at another host. These are the
        // shapes that would escape if the check were dropped.
        for bad in [
            "http://evil.test/x",
            "//evil.test/x",
            "https://evil.test",
            "sdapi/v1/txt2img",
            "",
        ] {
            let err = image_engine_request(bad.to_string(), "{}".into(), 1_000)
                .await
                .unwrap_err();
            assert!(
                err.contains("Not an engine path"),
                "{bad} was allowed: {err}"
            );
        }
    }

    #[tokio::test]
    async fn the_request_command_refuses_dgl_scripts() {
        // A DGL script reads any file this user can; only the app's own
        // scripts may reach those routes.
        for bad in [
            "/sdcpp/v1/dgl/jobs",
            "/sdcpp/v1/dgl/jobs/",
            "/SDCPP/v1/DGL/jobs",
            "/sdcpp/v1/dgl/script?name=x.dgl",
            "/sdapi/v1/../../sdcpp/v1/dgl/jobs",
        ] {
            let err = image_engine_request(bad.to_string(), "{}".into(), 1_000)
                .await
                .unwrap_err();
            assert!(
                err.contains("Not an engine path"),
                "{bad} was allowed: {err}"
            );
        }
        assert!(!is_dgl_path("/sdapi/v1/txt2img"));
        assert!(!is_dgl_path("/sdcpp/v1/capabilities"));
    }

    #[test]
    fn the_engine_reads_its_key_from_a_file_and_never_from_argv() {
        let args = server_args(
            vec!["--diffusion-model".into(), "/m.gguf".into()],
            Path::new("/d/k"),
        );
        let at = args.iter().position(|a| a == "--api-key-file").unwrap();
        assert_eq!(args[at + 1], "/d/k");
        assert!(!args.iter().any(|a| a == "--api-key"));
        assert!(!args.iter().any(|a| a.contains(engine_key())));
        assert_eq!(engine_key(), engine_key());
        assert_eq!(engine_key().len(), 64);
    }

    #[test]
    fn the_key_file_holds_the_key_and_only_this_user_can_read_it() {
        let tmp = crate::test_util::temp_dir("engine_key");
        let path = tmp.join("sd-engine.key");
        std::fs::write(&path, "old and longer than the key, with other permissions").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_key_file(&path, "abc123").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abc123\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn the_upscale_script_quotes_its_paths() {
        let script = upscale_script(
            Path::new(r#"C:\Models\up "x".pth"#),
            Path::new("/tmp/in.png"),
        );
        assert!(script.starts_with("# version: 0.0.0\n"), "{script}");
        assert!(
            script.contains(r#"load_upscaler("C:\\Models\\up \"x\".pth")"#),
            "{script}"
        );
        assert!(script.contains(r#"image::load("/tmp/in.png")"#), "{script}");
        assert!(script.contains("    return image::encode(upscale(upscaler, image))\n}\n"));
    }

    #[test]
    fn the_upscaler_gets_rgb() {
        let rgba = image::RgbaImage::from_pixel(3, 2, image::Rgba([200, 40, 40, 0]));
        let mut png = std::io::Cursor::new(Vec::new());
        rgba.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let out = image::load_from_memory(&rgb_png(&png.into_inner()).unwrap()).unwrap();
        assert_eq!(out.color(), image::ColorType::Rgb8);
        assert_eq!((out.width(), out.height()), (3, 2));
        assert!(rgb_png(b"not a picture").is_err());
    }

    #[test]
    fn the_upscaled_picture_is_the_media_named_result() {
        let job = serde_json::json!({
            "status": "completed",
            "result": { "type": "dict", "outputs": [], "media": [
                { "name": "other", "mime_type": "image/png", "b64_json": "no" },
                { "name": "result", "mime_type": "image/png", "b64_json": "aGk=" }
            ]}
        });
        assert_eq!(upscaled_from(&job).as_deref(), Some("aGk="));
        assert_eq!(upscaled_from(&serde_json::json!({ "result": null })), None);
    }

    #[test]
    fn errors_say_what_to_do_about_them() {
        // Each variant is a different next action for the user, which is the
        // whole reason this is an enum and not a string.
        assert!(ImageEngineError::NoModel.to_string().contains("Settings"));
        assert!(ImageEngineError::ModelMissing("/w/x.safetensors".into())
            .to_string()
            .contains("/w/x.safetensors"));
        assert!(ImageEngineError::SidecarMissing("sd-server".into())
            .to_string()
            .contains("sd-server"));
        assert!(ImageEngineError::Timeout("no devices".into())
            .to_string()
            .contains("no devices"));
    }

    /// A shipped layout: the sidecar in one place, its libraries in another.
    fn shipped(tag: &str) -> (crate::test_util::TestDir, PathBuf, PathBuf, PathBuf) {
        let tmp = crate::test_util::temp_dir(tag);
        let libs = tmp.join("sd-libs");
        std::fs::create_dir_all(&libs).unwrap();
        std::fs::write(libs.join("libggml-vulkan.so"), b"vulkan").unwrap();
        std::fs::write(libs.join("libggml-cpu-zen4.so"), b"cpu").unwrap();
        let src = tmp.join("haruspex-sd-server");
        std::fs::write(&src, b"binary").unwrap();
        let dir = tmp.join("sd-engine");
        (tmp, src, libs, dir)
    }

    #[test]
    fn staging_puts_the_binary_beside_its_libraries() {
        // ggml scans the directory containing /proc/self/exe for backends, so
        // a binary that is not beside its libraries finds none and the engine
        // reports "No devices found!" rather than starting.
        let (_tmp, src, libs, dir) = shipped("stage");
        let exe = stage(&src, &libs, &dir).unwrap();
        assert_eq!(exe, dir.join("haruspex-sd-server"));
        assert_eq!(std::fs::read(&exe).unwrap(), b"binary");
        assert_eq!(
            std::fs::read(dir.join("libggml-vulkan.so")).unwrap(),
            b"vulkan"
        );
        assert_eq!(
            std::fs::read(dir.join("libggml-cpu-zen4.so")).unwrap(),
            b"cpu"
        );
        // The executable is a copy, never a link: a link would resolve
        // /proc/self/exe back to the directory the libraries are not in.
        assert!(!std::fs::symlink_metadata(&exe).unwrap().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn staging_never_writes_where_the_package_put_the_libraries() {
        // The deb/rpm installs sd-libs root-owned under /usr/lib, an AppImage
        // mounts it read-only: copying the binary in there was the bug.
        use std::os::unix::fs::PermissionsExt;
        let (_tmp, src, libs, dir) = shipped("stage_ro");
        std::fs::set_permissions(&libs, std::fs::Permissions::from_mode(0o555)).unwrap();
        let staged = stage(&src, &libs, &dir);
        std::fs::set_permissions(&libs, std::fs::Permissions::from_mode(0o755)).unwrap();
        staged.unwrap();
        let shipped: Vec<_> = std::fs::read_dir(&libs).unwrap().collect();
        assert_eq!(
            shipped.len(),
            2,
            "nothing was added to the shipped libraries"
        );
    }

    #[test]
    fn staging_again_follows_an_upgrade_and_drops_what_it_removed() {
        let (_tmp, src, libs, dir) = shipped("stage_again");
        stage(&src, &libs, &dir).unwrap();

        // Same bytes: nothing to do, and nothing breaks.
        let exe = stage(&src, &libs, &dir).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"binary");

        // An upgrade: a new binary, one backend gone, one added. The old
        // backend must not linger where ggml's scan would load it.
        std::fs::write(&src, b"a different binary").unwrap();
        std::fs::remove_file(libs.join("libggml-cpu-zen4.so")).unwrap();
        std::fs::write(libs.join("libggml-cpu-haswell.so"), b"cpu2").unwrap();
        let exe = stage(&src, &libs, &dir).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"a different binary");
        assert!(!dir.join("libggml-cpu-zen4.so").exists());
        assert!(std::fs::symlink_metadata(dir.join("libggml-cpu-zen4.so")).is_err());
        assert_eq!(
            std::fs::read(dir.join("libggml-cpu-haswell.so")).unwrap(),
            b"cpu2"
        );
    }

    #[test]
    fn a_binary_left_inside_the_libraries_is_not_linked_over_the_copy() {
        // Older builds copied sd-server into a dev tree's sd-libs, so one may
        // still be there; the staged executable must be the real copy.
        let (_tmp, src, libs, dir) = shipped("stage_leftover");
        // Same size as the real one, so only the name keeps it out.
        std::fs::write(libs.join("haruspex-sd-server"), b"binarx").unwrap();
        let exe = stage(&src, &libs, &dir).unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"binary");
    }

    #[tokio::test]
    async fn a_new_engine_is_stopped_and_has_loaded_nothing() {
        let e = ImageEngine::new();
        assert_eq!(e.status().await, SidecarStatus::Stopped);
        assert!(e.loaded_model().await.is_none());
        assert!(e.logs().await.is_empty());
    }

    #[tokio::test]
    async fn stopping_a_stopped_engine_is_a_no_op() {
        let e = ImageEngine::new();
        e.stop().await;
        e.stop().await;
        assert_eq!(e.status().await, SidecarStatus::Stopped);
    }

    fn lines(text: &str) -> Vec<String> {
        text.lines().map(String::from).collect()
    }

    #[test]
    fn pins_the_discrete_gpu_when_an_integrated_one_sits_beside_it() {
        // The log from the first real start: auto-fit put Ming on Vulkan1,
        // the Ryzen iGPU, because it reports 32 GB of shared RAM as free.
        let log = lines(
            "ggml_vulkan: Found 2 Vulkan devices:\n\
             ggml_vulkan: 0 = AMD Radeon RX 9070 XT (RADV GFX1201) (radv) | uma: 0 | fp16: dot2 | bf16: 0\n\
             ggml_vulkan: 1 = AMD Ryzen 7 9800X3D 8-Core Processor (RADV RAPHAEL_MENDOCINO) (radv) | uma: 1 | fp16: dot2\n\
             load_backend: loaded Vulkan backend from libggml-vulkan.so",
        );
        assert_eq!(discrete_vulkan_devices(&log), Some("0".into()));
    }

    #[test]
    fn pins_nothing_when_there_is_nothing_to_choose_between() {
        let one = lines("ggml_vulkan: 0 = AMD Radeon RX 9070 XT (radv) | uma: 0 | fp16: dot2");
        assert_eq!(discrete_vulkan_devices(&one), None);
        let laptop = lines("ggml_vulkan: 0 = Intel(R) Graphics (ADL GT2) | uma: 1 | fp16: 1");
        assert_eq!(
            discrete_vulkan_devices(&laptop),
            None,
            "an iGPU alone is still the GPU"
        );
        assert_eq!(discrete_vulkan_devices(&lines("Metal: Apple M3")), None);
        let two = lines(
            "ggml_vulkan: 0 = Radeon iGPU | uma: 1\nggml_vulkan: 1 = RX 7900 | uma: 0\nggml_vulkan: 2 = RX 6600 | uma: 0",
        );
        assert_eq!(discrete_vulkan_devices(&two), Some("1,2".into()));
    }
}
