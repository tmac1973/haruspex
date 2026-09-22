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
//!     [`crate::sidecar_utils::library_paths`], because the executable's own
//!     directory carries llama.cpp's ggml under identical sonames at a
//!     different ABI.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use log::{info, warn};
use tauri::async_runtime::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::sidecar_utils::{
    base_url, http_client, kill_child, kill_process_on_port, new_log_buffer, poll_health,
    snapshot_logs, spawn_log_reader, LogBuffer, SidecarStatus,
};

/// Reserved in `CLAUDE.md`'s localhost table; the next free port after
/// whisper's 8766.
pub const IMAGE_PORT: u16 = 8767;

/// Readiness. sd-server serves no `/health`; this is the cheapest route it
/// does serve, and it only answers once the weights are loaded — which is the
/// question "is it ready" actually asks.
const READY_PATH: &str = "/sdcpp/v1/capabilities";

/// Loading a multi-GB checkpoint and initializing Vulkan takes appreciably
/// longer than any other sidecar's start, so this does not reuse
/// `HEALTH_POLL_TIMEOUT_SLOW`.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Where sd-server's private shared libraries live, relative to a root.
const LIBS_SUBDIR: &str = "sd-libs";

pub struct ImageEngine {
    status: Arc<Mutex<SidecarStatus>>,
    child: Mutex<Option<CommandChild>>,
    log: LogBuffer,
    /// The weights the running process was started with, so a request for
    /// different ones restarts rather than silently generating from the old.
    model: Mutex<Option<String>>,
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
            Self::NoModel => write!(f, "No image model is configured — Settings → Image"),
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
pub fn sd_libs_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(LIBS_SUBDIR));
    }
    // Dev: the binary runs from src-tauri/target/debug.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join("binaries").join(LIBS_SUBDIR));
        }
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// Place the sidecar beside its libraries and return the path to run.
///
/// A copy, not a symlink: Windows needs privileges for symlinks, and the
/// binary is ~2 MB against ~100 MB of libraries, so copying the small half is
/// the cheap direction. Re-copied only when absent or a different size, so
/// repeated starts do not touch the disk.
fn colocate(sidecar: &Path, libs: &Path) -> Result<PathBuf, ImageEngineError> {
    let name = sidecar
        .file_name()
        .ok_or_else(|| ImageEngineError::SidecarMissing(sidecar.display().to_string()))?;
    let dest = libs.join(name);

    let same = match (std::fs::metadata(sidecar), std::fs::metadata(&dest)) {
        (Ok(a), Ok(b)) => a.len() == b.len(),
        _ => false,
    };
    if !same {
        std::fs::copy(sidecar, &dest).map_err(|e| {
            ImageEngineError::Spawn(format!(
                "could not place the sidecar beside its libraries at {}: {e}",
                dest.display()
            ))
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
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

    /// Start the engine against `model_path`, or return a named reason.
    ///
    /// Idempotent for the same weights: a second call while ready or starting
    /// returns immediately. Different weights restart, because the alternative
    /// is generating from a checkpoint nobody asked for.
    pub async fn start(&self, app: &AppHandle, model_path: &str) -> Result<(), ImageEngineError> {
        let want = model_path.trim();
        if want.is_empty() {
            return Err(ImageEngineError::NoModel);
        }
        if !Path::new(want).exists() {
            return Err(ImageEngineError::ModelMissing(want.to_string()));
        }

        {
            let status = self.status.lock().await;
            let loaded = self.model.lock().await;
            let running = *status == SidecarStatus::Ready || *status == SidecarStatus::Starting;
            if running && loaded.as_deref() == Some(want) {
                return Ok(());
            }
        }

        self.stop().await;
        kill_process_on_port(IMAGE_PORT, "sd-server").await;

        let libs = sd_libs_dir(app).ok_or_else(|| {
            ImageEngineError::SidecarMissing(format!("no {LIBS_SUBDIR} directory was bundled"))
        })?;
        let sidecar_path = app
            .shell()
            .sidecar("sd-server")
            .map_err(|e| ImageEngineError::SidecarMissing(e.to_string()))
            .and_then(|_| {
                resolve_sidecar_binary(app)
                    .ok_or_else(|| ImageEngineError::SidecarMissing("sd-server".into()))
            })?;
        let exe = colocate(&sidecar_path, &libs)?;

        *self.status.lock().await = SidecarStatus::Starting;
        *self.model.lock().await = Some(want.to_string());
        info!("Starting sd-server on port {IMAGE_PORT}");

        let libs_str = libs.to_string_lossy().to_string();
        // sd-libs FIRST. The exe directory carries llama.cpp's ggml under the
        // same sonames at a different ABI; putting it first resolves
        // sd-server against the wrong library.
        let existing = std::env::var(LIB_PATH_VAR).unwrap_or_default();
        let lib_path = if existing.is_empty() {
            libs_str.clone()
        } else {
            format!("{libs_str}{LIB_PATH_SEP}{existing}")
        };

        let cmd = app
            .shell()
            .command(exe.to_string_lossy().to_string())
            .env(LIB_PATH_VAR, lib_path)
            .current_dir(libs.clone())
            .args([
                "--model".to_string(),
                want.to_string(),
                "--listen-ip".to_string(),
                "127.0.0.1".to_string(),
                "--listen-port".to_string(),
                IMAGE_PORT.to_string(),
            ]);

        let (rx, child) = cmd.spawn().map_err(|e| {
            let msg = e.to_string();
            ImageEngineError::Spawn(msg)
        })?;
        *self.child.lock().await = Some(child);
        spawn_log_reader(
            "sd-server",
            rx,
            Arc::clone(&self.status),
            Arc::clone(&self.log),
            &[],
        );

        let url = format!("{}{READY_PATH}", base_url(IMAGE_PORT));
        let status_for_poll = Arc::clone(&self.status);
        let keep_going = move || {
            let s = Arc::clone(&status_for_poll);
            async move { !matches!(&*s.lock().await, SidecarStatus::Error(_)) }
        };
        if poll_health(&url, "sd-server", READY_TIMEOUT, false, keep_going).await {
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

    /// Stop the engine. A no-op when nothing is running.
    pub async fn stop(&self) {
        if let Err(e) = kill_child(&self.child, "sd-server").await {
            warn!("sd-server: {e}");
        }
        *self.status.lock().await = SidecarStatus::Stopped;
        *self.model.lock().await = None;
    }
}

#[cfg(target_os = "linux")]
const LIB_PATH_VAR: &str = "LD_LIBRARY_PATH";
#[cfg(target_os = "macos")]
const LIB_PATH_VAR: &str = "DYLD_LIBRARY_PATH";
#[cfg(target_os = "windows")]
const LIB_PATH_VAR: &str = "PATH";

#[cfg(target_os = "windows")]
const LIB_PATH_SEP: &str = ";";
#[cfg(not(target_os = "windows"))]
const LIB_PATH_SEP: &str = ":";

/// Where the bundled `sd-server` binary is on disk.
///
/// `ShellExt::sidecar` builds a command but does not expose the path, and this
/// engine needs the path itself in order to copy the binary next to its
/// libraries.
///
/// Matched by PREFIX rather than by target triple. Tauri strips the triple
/// when it bundles a sidecar, so the packaged name is `sd-server` while a dev
/// tree holds `sd-server-x86_64-unknown-linux-gnu`; looking for both without
/// knowing which is which avoids threading a build-time triple through for
/// one comparison. The `.version` stamp that sits beside it is skipped.
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

/// The `sd-server` binary in one directory, if there is one.
fn first_sidecar_in(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("sd-server") && !n.ends_with(".version"))
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
    model_path: String,
) -> Result<(), ImageEngineError> {
    state.start(&app, &model_path).await
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
    let url = format!("{}{path}", base_url(IMAGE_PORT));
    let client = http_client(std::time::Duration::from_millis(
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

#[tauri::command]
pub async fn image_engine_logs(state: tauri::State<'_, ImageEngine>) -> Result<Vec<String>, ()> {
    Ok(state.logs().await)
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

    #[test]
    fn the_library_path_variable_matches_the_platform() {
        #[cfg(target_os = "linux")]
        assert_eq!(LIB_PATH_VAR, "LD_LIBRARY_PATH");
        #[cfg(target_os = "macos")]
        assert_eq!(LIB_PATH_VAR, "DYLD_LIBRARY_PATH");
        #[cfg(target_os = "windows")]
        assert_eq!(LIB_PATH_VAR, "PATH");
    }

    #[test]
    fn colocation_copies_the_binary_beside_the_libraries() {
        // ggml scans the directory containing /proc/self/exe for backends, so
        // a binary that is not beside its libraries finds none and the engine
        // reports "No devices found!" rather than starting.
        let tmp = std::env::temp_dir().join(format!("haruspex-colo-{}", std::process::id()));
        let libs = tmp.join("sd-libs");
        std::fs::create_dir_all(&libs).unwrap();
        let src = tmp.join("sd-server");
        std::fs::write(&src, b"binary").unwrap();

        let placed = colocate(&src, &libs).unwrap();
        assert_eq!(placed.parent().unwrap(), libs);
        assert_eq!(std::fs::read(&placed).unwrap(), b"binary");

        // A second call with the same bytes must not rewrite it.
        let before = std::fs::metadata(&placed).unwrap().len();
        let again = colocate(&src, &libs).unwrap();
        assert_eq!(std::fs::metadata(&again).unwrap().len(), before);

        // Different bytes replace it: a version bump must not keep running
        // the old binary against new libraries.
        std::fs::write(&src, b"a different binary").unwrap();
        let updated = colocate(&src, &libs).unwrap();
        assert_eq!(std::fs::read(&updated).unwrap(), b"a different binary");

        std::fs::remove_dir_all(&tmp).ok();
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
}
