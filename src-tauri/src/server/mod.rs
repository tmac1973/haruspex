use crate::sidecar_process::{sidecar_registry, spawn_sidecar, SidecarChild};
use log::{error, info, warn};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::sidecar_utils::{
    self, kill_process_on_port, ports, push_log, strip_ansi, wait_for_port_release, SidecarStatus,
    LOG_RING_BUFFER_SIZE,
};

mod crash_telemetry;
mod log_classifier;
use log_classifier::{classify, LogSignal};

/// Lifecycle state of the llama-server sidecar. Type alias onto
/// `SidecarStatus` so all three sidecars share one wire shape.
pub type ServerStatus = SidecarStatus;

/// Surfaced to the UI when the CPU-fallback respawn succeeds. The banner
/// in the chat header reads `reason` so the user can see *why* their
/// 5080 isn't being used (typically VRAM exhaustion at mmproj load), and
/// the "Restart on GPU" action calls stop+start to retry.
#[derive(Clone, Debug, Serialize)]
pub struct GpuFallbackState {
    /// First GPU-related error line captured from llama-server stderr —
    /// usually the most informative root-cause line (e.g. the
    /// `Device memory allocation of size X failed` log that precedes the
    /// abort). ANSI codes are stripped before storage.
    pub reason: String,
}

/// Emitted (as `context-backoff`) when a start attempt died on a
/// context/KV-cache allocation failure and the supervisor is retrying
/// with the next smaller ladder rung. The frontend surfaces it as a
/// toast and persists `to` as the new context-size setting.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ContextBackoffState {
    /// Context size the failed attempt used.
    pub from: u32,
    /// Smaller size the retry is using.
    pub to: u32,
    /// First context-allocation error line from stderr (ANSI-stripped).
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ServerConfig {
    pub port: u16,
    pub ctx_size: u32,
    /// `Some(n)` pins `--n-gpu-layers n`: 99 keeps every layer in VRAM, 0 is
    /// the CPU fallback. `None` omits the flag so llama.cpp's own fit
    /// (`--fit`, on by default) places layers and MoE experts across VRAM
    /// and system RAM. Fit aborts the moment the layer count is set
    /// explicitly, so this is the only way to get it.
    pub n_gpu_layers: Option<i32>,
    /// `--cache-ram`, in MiB: the host-RAM prompt cache. llama.cpp defaults
    /// to 8 GiB, which competes with weights offloaded to RAM. See
    /// [`cache_ram_mib`].
    pub cache_ram_mib: u32,
    pub flash_attn: bool,
    /// Drive the model's multi-token-prediction head as a self-speculative
    /// draft. Only ever true for a model that actually has one, and for a
    /// sibling drafter only when its file is on disk — see
    /// `models::mtp_source_for`.
    pub mtp: bool,
    /// Path to a sibling drafter GGUF, for models whose MTP head ships as a
    /// separate file rather than inside the weights. `None` for a bundled
    /// head, which needs no `--model-draft`.
    pub mtp_draft_path: Option<String>,
    /// Load the vision projector onto the CPU backend (`--no-mmproj-offload`)
    /// instead of the GPU. Frees the projector's VRAM (0.9-1.2 GB for the
    /// models we ship) for the KV cache, at the cost of a slower encode on
    /// the turns that actually contain an image. Text-only turns never touch
    /// the projector either way.
    pub mmproj_on_cpu: bool,
    /// The one origin allowed to read llama-server's responses: the main
    /// webview's, which calls it with `fetch`. `None` when the window's URL
    /// can't be read, which leaves the API key as the only guard.
    pub cors_origin: Option<String>,
    pub extra_args: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            port: ports::LLAMA,
            // Placeholder for the pre-start `LlamaServer::new()` state only;
            // every real `start_server` overrides this with the caller's
            // value. The user-facing default lives in TS (`DEFAULT_CONTEXT_SIZE`).
            ctx_size: 16384,
            n_gpu_layers: Some(ALL_GPU_LAYERS),
            cache_ram_mib: CACHE_RAM_MAX_MIB,
            flash_attn: true,
            mtp: false,
            mtp_draft_path: None,
            mmproj_on_cpu: false,
            cors_origin: None,
            extra_args: Vec::new(),
        }
    }
}

impl ServerConfig {
    pub fn build_args(&self, model_path: &str) -> Vec<String> {
        self.build_args_for(model_path, cfg!(target_os = "windows"))
    }

    /// `build_args` with the host platform injected, so both branches of the
    /// Windows checkpoint workaround are reachable from tests on any host.
    fn build_args_for(&self, model_path: &str, is_windows: bool) -> Vec<String> {
        let mut args = vec![
            "--model".to_string(),
            model_path.to_string(),
            "--port".to_string(),
            self.port.to_string(),
            "--ctx-size".to_string(),
            self.ctx_size.to_string(),
            "--cache-ram".to_string(),
            self.cache_ram_mib.to_string(),
            "--cache-type-k".to_string(),
            "q8_0".to_string(),
            "--cache-type-v".to_string(),
            "q8_0".to_string(),
            // Haruspex only runs one conversation through llama-server at a
            // time, so we don't benefit from multiple parallel slots. Forcing
            // --parallel 1 gives the single slot the full KV budget and
            // eliminates the "failed to find free space in the KV cache /
            // purging slot N" warnings that show up in stderr whenever stale
            // slots from earlier turns get evicted to make room for a new
            // batch.
            "--parallel".to_string(),
            "1".to_string(),
            "--jinja".to_string(),
            "--host".to_string(),
            sidecar_utils::LOOPBACK.to_string(),
        ];

        if let Some(layers) = self.n_gpu_layers {
            args.push("--n-gpu-layers".to_string());
            args.push(layers.to_string());
        }

        args.push("--flash-attn".to_string());
        args.push(if self.flash_attn { "on" } else { "off" }.to_string());

        if is_windows {
            // Workaround for llama.cpp#27560: on Windows + Vulkan, llama-server
            // takes an access violation (0xC0000005) on the FIRST
            // /v1/chat/completions request whenever context checkpoints are
            // enabled. Qwen3.8-27B is the reported repro and is one of the
            // models we ship, so this would land as "the app crashes the moment
            // you send a message". `--ctx-checkpoints 0` is the maintainers'
            // workaround. Upstream is still open as of llama.cpp v0.6.0, though
            // the reporter saw it stop at b11026 (v0.6.0 is b11429); drop this
            // once a Windows run of the 27B confirms it.
            //
            // The cost is recomputing prefix state that a checkpoint would have
            // restored — slower reprocessing after a cache miss, no behaviour
            // change. Linux and macOS keep checkpoints on. Revisit when #27560
            // closes: https://github.com/ggml-org/llama.cpp/issues/27560
            args.push("--ctx-checkpoints".to_string());
            args.push("0".to_string());
        }

        if self.mtp {
            // A bundled head needs no draft model: llama-server builds the
            // MTP draft context against the target model itself. A sibling
            // drafter has to be named explicitly — llama.cpp auto-discovers
            // it only for `-hf` downloads, not for local `--model` paths.
            if let Some(draft) = self.mtp_draft_path.as_ref() {
                args.push("--model-draft".to_string());
                args.push(draft.clone());
                // `--spec-draft-ngl` defaults to `auto`, which decides how
                // much of the drafter to keep in VRAM *after* the target and
                // its KV cache have claimed theirs. Pin it to `all`: a
                // partially offloaded drafter still produces tokens, so the
                // host round-trips are invisible and just read as "MTP bought
                // nothing".
                args.push("--spec-draft-ngl".to_string());
                args.push("all".to_string());
                // 4 is what Unsloth's drafter card recommends; llama.cpp
                // defaults to 3. Scoped to the sibling path because that's
                // where the recommendation comes from — the bundled-head 27B
                // has no measurement behind changing it.
                args.push("--spec-draft-n-max".to_string());
                args.push("4".to_string());
            }
            // The type name is `draft-mtp` — a bare `mtp` is rejected as an
            // unknown speculative type.
            args.push("--spec-type".to_string());
            args.push("draft-mtp".to_string());
        }

        args.extend(cors_args(self.cors_origin.as_deref()));

        // Last, so a power user's extra args can still override anything above.
        args.extend(self.extra_args.clone());
        args
    }
}

/// Environment variable llama-server reads its `--api-key` from. The key goes
/// in the environment rather than argv because `/proc/<pid>/cmdline` is
/// readable by every user on the machine; `environ` is not.
const API_KEY_ENV: &str = "LLAMA_API_KEY";

/// The key llama-server demands on every request but `/health`, made fresh
/// for each run of the app. Without it, any web page open in the user's
/// browser could POST to the loopback port: CORS only stops a page reading
/// the reply, and a `text/plain` POST needs no preflight, so the generation
/// would still run. Only the webview (through `get_llama_api_key`) knows it.
pub fn api_key() -> &'static str {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| {
        use ring::rand::{SecureRandom, SystemRandom};
        let mut b = [0u8; 32];
        SystemRandom::new()
            .fill(&mut b)
            .expect("the OS random source failed");
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

/// llama-server's CORS flags (llama.cpp#25655), which by default let every
/// origin read every response.
///
/// `--cors-origins` takes a single literal origin despite its help text: any
/// value but `*` or `localhost` is copied into `Access-Control-Allow-Origin`
/// as is, so a comma-separated list matches nothing. Its `localhost` mode
/// won't do either: it rejects `tauri://` origins outright, and it would admit
/// any other web server on the machine. `Authorization` is listed by name
/// because a `*` in `Access-Control-Allow-Headers` never covers it, and
/// nothing here uses cookies, so credentials are off.
fn cors_args(origin: Option<&str>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(origin) = origin {
        args.push("--cors-origins".to_string());
        args.push(origin.to_string());
    }
    args.extend(
        [
            "--cors-methods",
            "GET, POST, OPTIONS",
            "--cors-headers",
            "Authorization, Content-Type",
            "--no-cors-credentials",
        ]
        .map(String::from),
    );
    args
}

/// The origin a page at `url` sends in its `Origin` header:
/// `http://localhost:1420` in dev, `tauri://localhost` packaged on Linux and
/// macOS, `http://tauri.localhost` on Windows. Built by hand because the `url`
/// crate calls the origin of a non-special scheme like `tauri:` opaque.
fn webview_origin(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

/// The main webview's origin, or `None` (logged) when it can't be read.
fn main_webview_origin(app: &AppHandle) -> Option<String> {
    use tauri::Manager;
    let origin = app
        .get_webview_window("main")
        .and_then(|w| w.url().ok())
        .and_then(|u| webview_origin(&u));
    if origin.is_none() {
        warn!("Could not read the main window's origin; llama-server CORS stays open");
    }
    origin
}

struct ServerInner {
    child: Option<SidecarChild>,
    status: ServerStatus,
    config: ServerConfig,
    log_buffer: VecDeque<String>,
    gpu_fallback_attempted: bool,
    gpu_error_detected: bool,
    /// First GPU-error stderr line captured during the current start
    /// attempt. Kept across the in-process fallback respawn so the UI
    /// banner can show the root cause; cleared on the next manual
    /// `start()` call (so a successful retry hides the banner).
    gpu_error_reason: Option<String>,
    /// True once a CPU-fallback respawn has actually been launched.
    /// Drives the "Running on CPU" banner. Cleared on the next manual
    /// `start()` call.
    cpu_fallback_active: bool,
    /// An MTP/speculative-decoding failure was seen during the current start
    /// attempt — arms the one-shot retry without `--spec-type draft-mtp`.
    mtp_error_detected: bool,
    /// First MTP-related error line for the current attempt, surfaced as the
    /// fallback reason.
    mtp_error_reason: Option<String>,
    /// Whether the MTP fallback has already fired for this start, so a model
    /// that dies for an unrelated reason isn't retried forever.
    mtp_fallback_attempted: bool,
    /// A context/KV-cache allocation failure was seen during the current
    /// start attempt — arms the context-backoff retry on exit. Cleared
    /// on each backoff respawn (every retry re-detects for itself).
    ctx_alloc_error_detected: bool,
    /// First context-allocation error line for the current attempt,
    /// surfaced as the backoff reason.
    ctx_alloc_error_reason: Option<String>,
    generation: u64, // incremented on each start, used to ignore stale events
    /// When the current child process was spawned — used to report uptime in
    /// crash telemetry (how long it survived before dying).
    started_at: Option<Instant>,
}

impl ServerInner {
    /// Inspect a stderr line for a GPU-init or context-allocation failure
    /// and arm the matching recovery path (CPU fallback / context backoff).
    /// Keeps the *first* matching line as the reason — it's almost always
    /// the most informative root cause (e.g. `Device memory allocation of
    /// size X failed`); subsequent lines are downstream effects (assert
    /// aborts, buffer alloc retries) that read worse out of context.
    fn note_stderr_signal(&mut self, line_str: &str) {
        match classify(line_str) {
            LogSignal::CtxAllocError => {
                if !self.ctx_alloc_error_detected {
                    warn!("context allocation error detected, will retry smaller on exit");
                }
                self.ctx_alloc_error_detected = true;
                if self.ctx_alloc_error_reason.is_none() {
                    let cleaned = strip_ansi(line_str).trim().to_string();
                    if !cleaned.is_empty() {
                        self.ctx_alloc_error_reason = Some(cleaned);
                    }
                }
            }
            LogSignal::MtpError if !self.mtp_fallback_attempted => {
                warn!("MTP error detected, will retry without speculative decoding on exit");
                self.mtp_error_detected = true;
                if self.mtp_error_reason.is_none() {
                    let cleaned = strip_ansi(line_str).trim().to_string();
                    if !cleaned.is_empty() {
                        self.mtp_error_reason = Some(cleaned);
                    }
                }
            }
            LogSignal::GpuError if !self.gpu_fallback_attempted => {
                warn!("GPU error detected, will attempt CPU fallback on exit");
                self.gpu_error_detected = true;
                if self.gpu_error_reason.is_none() {
                    let cleaned = strip_ansi(line_str).trim().to_string();
                    if !cleaned.is_empty() {
                        self.gpu_error_reason = Some(cleaned);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Largest standard rung strictly below `ctx`, or `None` when `ctx` is
/// already at (or below) the ladder floor. Custom sizes that fall between
/// rungs back down to the nearest rung underneath them.
fn next_lower_ctx(ctx: u32) -> Option<u32> {
    crate::models::CONTEXT_LADDER
        .iter()
        .rev()
        .find(|&&rung| rung < ctx)
        .copied()
}

pub struct LlamaServer {
    inner: Arc<Mutex<ServerInner>>,
}

impl LlamaServer {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ServerInner {
                child: None,
                status: ServerStatus::Stopped,
                config: ServerConfig::default(),
                log_buffer: VecDeque::with_capacity(LOG_RING_BUFFER_SIZE),
                gpu_fallback_attempted: false,
                gpu_error_detected: false,
                gpu_error_reason: None,
                cpu_fallback_active: false,
                mtp_error_detected: false,
                mtp_error_reason: None,
                mtp_fallback_attempted: false,
                ctx_alloc_error_detected: false,
                ctx_alloc_error_reason: None,
                generation: 0,
                started_at: None,
            })),
        }
    }

    async fn set_status(&self, status: ServerStatus, app: &AppHandle) {
        let mut inner = self.inner.lock().await;
        if inner.status != status {
            inner.status = status.clone();
            let _ = app.emit("server-status-changed", &status);
        }
    }

    pub async fn start(
        &self,
        app: &AppHandle,
        model_path: &str,
        config: Option<ServerConfig>,
    ) -> Result<(), String> {
        // Stop any existing instance first
        self.stop().await?;

        let config = config.unwrap_or_default();

        // Kill an orphaned llama-server of ours on the port (e.g. from a
        // previous hot-reload). Someone else's server there is left alone,
        // and the start fails saying whose it is.
        if let Err(msg) =
            kill_process_on_port(config.port, "llama-server", sidecar_registry(app)).await
        {
            self.set_status(ServerStatus::Error(msg.clone()), app).await;
            return Err(msg);
        }

        if !Path::new(model_path).exists() {
            let msg = format!("Model file not found: {}", model_path);
            self.set_status(ServerStatus::Error(msg.clone()), app).await;
            return Err(msg);
        }

        {
            let mut inner = self.inner.lock().await;
            inner.config = config;
            inner.gpu_fallback_attempted = false;
            inner.gpu_error_detected = false;
            inner.gpu_error_reason = None;
            inner.cpu_fallback_active = false;
            inner.mtp_error_detected = false;
            inner.mtp_error_reason = None;
            inner.mtp_fallback_attempted = false;
            inner.ctx_alloc_error_detected = false;
            inner.ctx_alloc_error_reason = None;
        }
        // Banner clears as soon as a fresh start begins, regardless of
        // whether this attempt ultimately ends up on GPU or falls back
        // again. The frontend store wipes its own copy on `startServer()`,
        // but we also emit the cleared state so any other listener (or a
        // late `get_cpu_fallback_state` poll) sees the truth.
        let _ = app.emit("gpu-fallback-cleared", ());

        self.spawn_and_monitor(app, model_path).await
    }

    async fn spawn_and_monitor(&self, app: &AppHandle, model_path: &str) -> Result<(), String> {
        self.set_status(ServerStatus::Starting, app).await;

        let args = Self::build_llama_args(app, &self.inner, model_path).await;

        info!("Starting llama-server with args: {:?}", args);

        let (rx, child) = Self::spawn_llama(app, &args)?;

        let gen = {
            let mut inner = self.inner.lock().await;
            inner.child = Some(child);
            inner.started_at = Some(Instant::now());
            inner.generation += 1;
            inner.generation
        };

        // Spawn stdout/stderr reader
        Self::spawn_output_reader(
            self.inner.clone(),
            app.clone(),
            model_path.to_string(),
            rx,
            gen,
        );

        // Spawn health poller
        Self::spawn_health_poller(self.inner.clone(), app.clone(), gen);

        Ok(())
    }

    /// `--mmproj <path>`, plus `--no-mmproj-offload` when the user has asked
    /// to keep the projector in system RAM. Split out from `build_llama_args`
    /// (which needs an `AppHandle` to locate the projector) so the flag
    /// itself is unit-testable.
    fn mmproj_args(path: &Path, on_cpu: bool) -> Vec<String> {
        let mut args = vec!["--mmproj".to_string(), path.to_string_lossy().to_string()];
        if on_cpu {
            args.push("--no-mmproj-offload".to_string());
        }
        args
    }

    /// Build the llama-server CLI args for `model_path`: the configured base
    /// args plus `--mmproj` when the model has a multimodal projector. Shared
    /// by the initial spawn and both respawn paths (CPU fallback, auto-restart).
    async fn build_llama_args(
        app: &AppHandle,
        inner: &Arc<Mutex<ServerInner>>,
        model_path: &str,
    ) -> Vec<String> {
        let mmproj_path = {
            use tauri::Manager;
            app.try_state::<crate::models::ModelManager>()
                .and_then(|mgr| mgr.find_mmproj_for_model(std::path::Path::new(model_path)))
        };
        let state = inner.lock().await;
        let mut args = state.config.build_args(model_path);
        if let Some(path) = mmproj_path.as_ref() {
            let on_cpu = state.config.mmproj_on_cpu;
            args.extend(Self::mmproj_args(path, on_cpu));
            info!(
                "Vision projector enabled ({}): {}",
                if on_cpu { "system RAM" } else { "VRAM" },
                path.display()
            );
        }
        args
    }

    /// Spawn the llama-server sidecar with `args` and the platform library
    /// paths applied. Returns the event stream + child handle. Shared by the
    /// initial spawn and both respawn paths.
    fn spawn_llama(
        app: &AppHandle,
        args: &[String],
    ) -> Result<
        (
            tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
            SidecarChild,
        ),
        String,
    > {
        let cmd = app
            .shell()
            .sidecar("haruspex-llama-server")
            .map_err(|e| format!("Failed to create sidecar command: {}", e))?
            .args(args)
            .env(API_KEY_ENV, api_key());
        spawn_sidecar(
            sidecar_utils::with_library_paths(cmd, app),
            "llama-server",
            sidecar_registry(app),
        )
    }

    fn spawn_output_reader(
        inner: Arc<Mutex<ServerInner>>,
        app: AppHandle,
        model_path: String,
        mut rx: tauri::async_runtime::Receiver<tauri_plugin_shell::process::CommandEvent>,
        generation: u64,
    ) {
        tauri::async_runtime::spawn(async move {
            use tauri_plugin_shell::process::CommandEvent;

            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        info!("llama-server: {}", line_str);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &line_str);
                    }
                    CommandEvent::Stderr(line) => {
                        let line_str = String::from_utf8_lossy(&line).to_string();
                        // llama-server writes its routine progress to stderr, so
                        // the stream says nothing about severity.
                        info!("llama-server stderr: {}", line_str);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &format!("[stderr] {}", line_str));
                        state.note_stderr_signal(&line_str);
                    }
                    CommandEvent::Terminated(payload) => {
                        Self::handle_termination(
                            &inner,
                            &app,
                            &model_path,
                            generation,
                            payload.code,
                            payload.signal,
                        )
                        .await;
                        // The process is gone; this reader's rx is spent. Any
                        // recovery path has already spawned a fresh reader.
                        return;
                    }
                    CommandEvent::Error(err) => {
                        error!("llama-server error: {}", err);
                        let mut state = inner.lock().await;
                        push_log(&mut state.log_buffer, &format!("[error] {}", err));
                    }
                    _ => {}
                }
            }
        });
    }

    /// Handle a `Terminated` event for `generation`: skip stale generations,
    /// record crash telemetry, then route to exactly one recovery path
    /// (CPU fallback, auto-restart) or report a terminal error.
    async fn handle_termination(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
        code: Option<i32>,
        signal: Option<i32>,
    ) {
        let exit_code = code.unwrap_or(-1);
        info!(
            "llama-server (gen {}) exited with code: {} signal: {:?}",
            generation, exit_code, signal
        );

        // Ignore termination events from old generations.
        {
            let state = inner.lock().await;
            if state.generation != generation {
                info!(
                    "Ignoring stale termination event from generation {}",
                    generation
                );
                return;
            }
        }

        // Capture a post-mortem before any recovery logic mutates state.
        if let Some(report) =
            Self::capture_crash_report(inner, code, signal, generation, model_path).await
        {
            crash_telemetry::record(app, &report);
        }

        // Speculative decoding blamed? Drop that flag first. It is the one
        // piece of the configuration that is pure optimization, so losing it
        // costs only speed — where a smaller context costs the user's
        // conversation length and CPU fallback costs an order of magnitude of
        // throughput. Also catches the memory case at the ladder floor, where
        // there is no smaller context left to try.
        if let Some(reason) = Self::take_mtp_fallback(inner).await {
            Self::respawn_without_mtp(inner, app, model_path, reason).await;
            return;
        }

        // Context too big to allocate? Back down one ladder rung and retry
        // on the same device before considering the CPU fallback — a smaller
        // KV cache on the GPU beats the full context on the CPU.
        if let Some(backoff) = Self::take_ctx_backoff(inner).await {
            Self::respawn_ctx_backoff(inner, app, model_path, backoff).await;
            return;
        }

        if Self::take_gpu_fallback(inner).await {
            Self::respawn_cpu_fallback(inner, app, model_path, generation).await;
            return;
        }

        // Crashed mid-operation: if the server was Ready and this wasn't a
        // clean stop, attempt one auto-restart. This recovers from in-request
        // crashes (e.g. image batch overflow during vision processing) without
        // requiring the user to manually restart.
        let should_auto_restart = {
            let state = inner.lock().await;
            matches!(state.status, ServerStatus::Ready)
        };
        if should_auto_restart {
            Self::respawn_auto_restart(inner, app, model_path, generation).await;
            return;
        }

        // Not a recovery situation — report error.
        let mut state = inner.lock().await;
        if state.status != ServerStatus::Stopped {
            state.status = ServerStatus::Error(format!("Server exited with code {}", exit_code));
            let _ = app.emit("server-status-changed", &state.status);
        }
    }

    /// Build a crash post-mortem from the current state, or `None` for a clean
    /// stop (status already `Stopped`) or a non-crash exit. A clean stop sets
    /// the status to `Stopped` first, so we skip those; anything else (a crash
    /// signal, or a non-zero exit while Starting/Ready) is recorded with the
    /// last stderr lines — where llama.cpp prints the abort reason.
    async fn capture_crash_report(
        inner: &Arc<Mutex<ServerInner>>,
        code: Option<i32>,
        signal: Option<i32>,
        generation: u64,
        model_path: &str,
    ) -> Option<crash_telemetry::CrashReport> {
        let state = inner.lock().await;
        let clean_stop = state.status == ServerStatus::Stopped;
        let crashed = signal
            .map(crash_telemetry::is_crash_signal)
            .unwrap_or(false)
            || code.map(|c| c != 0).unwrap_or(true);
        if clean_stop || !crashed {
            return None;
        }
        Some(crash_telemetry::CrashReport {
            generation,
            code,
            signal,
            status_before: format!("{:?}", state.status),
            model_path: model_path.to_string(),
            n_gpu_layers: state
                .config
                .n_gpu_layers
                .map_or_else(|| "auto".to_string(), |n| n.to_string()),
            ctx_size: state.config.ctx_size,
            flash_attn: state.config.flash_attn,
            cpu_fallback_active: state.cpu_fallback_active,
            uptime_secs: state.started_at.map(|t| t.elapsed().as_secs()),
            recent_log: state
                .log_buffer
                .iter()
                .rev()
                .take(crash_telemetry::TAIL_LINES)
                .rev()
                .cloned()
                .collect(),
        })
    }

    /// Decide whether the exit that just happened should be retried with a
    /// smaller context: a context/KV-allocation error was detected during a
    /// `Starting` attempt and there's a ladder rung below the current size.
    /// On yes, clears the dead child, drops `config.ctx_size` to the next
    /// rung, and resets the per-attempt error flags (both context and GPU —
    /// the GPU lines that accompany a KV overflow describe a failure the
    /// smaller context may fix, so they must not arm the CPU fallback).
    /// At the ladder floor this returns `None` and the normal GPU-fallback /
    /// error paths take over.
    async fn take_ctx_backoff(inner: &Arc<Mutex<ServerInner>>) -> Option<ContextBackoffState> {
        let mut state = inner.lock().await;
        if state.status != ServerStatus::Starting || !state.ctx_alloc_error_detected {
            return None;
        }
        let from = state.config.ctx_size;
        let to = next_lower_ctx(from)?;
        state.child = None;
        state.config.ctx_size = to;
        state.ctx_alloc_error_detected = false;
        state.gpu_error_detected = false;
        state.gpu_error_reason = None;
        let reason = state
            .ctx_alloc_error_reason
            .take()
            .unwrap_or_else(|| "context allocation failed".to_string());
        Some(ContextBackoffState { from, to, reason })
    }

    /// Respawn after a context-allocation failure with the (already lowered)
    /// `config.ctx_size`. Bumps the generation so the retry gets its own
    /// output reader and a fresh health-poll window — several rungs may be
    /// walked in sequence, and each attempt reloads the model from scratch.
    async fn respawn_ctx_backoff(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        backoff: ContextBackoffState,
    ) {
        warn!(
            "context size {} failed to allocate ({}) — retrying with {}",
            backoff.from, backoff.reason, backoff.to
        );
        let _ = app.emit("context-backoff", &backoff);
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                let gen = {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                    state.generation += 1;
                    state.generation
                };
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    gen,
                );
                Self::spawn_health_poller(inner.clone(), app.clone(), gen);
            }
            Err(e) => {
                error!("Context-backoff respawn failed: {}", e);
                let mut state = inner.lock().await;
                state.status =
                    ServerStatus::Error(format!("Context-backoff respawn failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    /// Clear the dead child and decide whether to retry once without
    /// `--spec-type draft-mtp`, returning the reason to show the user.
    ///
    /// Fires when the start attempt had MTP on and either (a) a log line named
    /// MTP/speculative decoding as the failure, or (b) memory allocation
    /// failed with no smaller context rung left — at the ladder floor the
    /// draft context is the only thing still worth giving up.
    ///
    /// This exists because llama.cpp's Vulkan MTP support is new (upstream
    /// #26827, #27237 open at the time of writing) and a flag that stops the
    /// app from starting needs the app to fix itself, not a settings edit the
    /// user can't reach.
    async fn take_mtp_fallback(inner: &Arc<Mutex<ServerInner>>) -> Option<String> {
        let mut state = inner.lock().await;
        if state.status != ServerStatus::Starting
            || state.mtp_fallback_attempted
            || !state.config.mtp
        {
            return None;
        }
        let out_of_rungs =
            state.ctx_alloc_error_detected && next_lower_ctx(state.config.ctx_size).is_none();
        if !state.mtp_error_detected && !out_of_rungs {
            return None;
        }
        state.child = None;
        state.mtp_fallback_attempted = true;
        state.mtp_error_detected = false;
        state.config.mtp = false;
        // The retry is a different configuration, so the previous attempt's
        // signals must not carry into it and trip a second recovery path.
        state.ctx_alloc_error_detected = false;
        state.gpu_error_detected = false;
        state.gpu_error_reason = None;
        Some(state.mtp_error_reason.take().unwrap_or_else(|| {
            "Multi-token prediction failed to start — retrying without it.".to_string()
        }))
    }

    /// Respawn with MTP off after `take_mtp_fallback` armed it. Bumps the
    /// generation like the context backoff does: the model reloads from
    /// scratch, so the retry needs its own reader and health-poll window.
    async fn respawn_without_mtp(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        reason: String,
    ) {
        warn!("multi-token prediction failed ({reason}) — retrying without it");
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                let gen = {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                    state.generation += 1;
                    state.generation
                };
                let _ = app.emit("mtp-fallback-active", &reason);
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    gen,
                );
                Self::spawn_health_poller(inner.clone(), app.clone(), gen);
            }
            Err(e) => {
                error!("MTP fallback respawn failed: {}", e);
                let mut state = inner.lock().await;
                state.status = ServerStatus::Error(format!("MTP fallback respawn failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    /// Clear the dead child and decide whether to attempt a one-shot CPU
    /// fallback. Returns `true` (and arms the fallback flags) only when a GPU
    /// error was detected during a `Starting` attempt that used GPU layers.
    async fn take_gpu_fallback(inner: &Arc<Mutex<ServerInner>>) -> bool {
        let mut state = inner.lock().await;
        state.child = None;
        if state.status == ServerStatus::Starting
            && !state.gpu_fallback_attempted
            && state.gpu_error_detected
            && state.config.n_gpu_layers != Some(0)
        {
            state.gpu_fallback_attempted = true;
            state.gpu_error_detected = false;
            state.config.n_gpu_layers = Some(0);
            true
        } else {
            false
        }
    }

    /// Respawn on CPU (`--n-gpu-layers 0`) after a GPU-init failure and surface
    /// the captured reason to the UI banner. The health poller is still running
    /// and will pick up the new process, so we only spawn a fresh reader.
    async fn respawn_cpu_fallback(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
    ) {
        warn!("Attempting CPU fallback (--n-gpu-layers 0)");
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                let fallback_state = {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                    state.cpu_fallback_active = true;
                    // Reason was captured from the pre-abort stderr; if none
                    // was matched, fall back to a generic message so the banner
                    // still has something to display.
                    let reason = state.gpu_error_reason.clone().unwrap_or_else(|| {
                        "GPU initialization failed — running on CPU.".to_string()
                    });
                    GpuFallbackState { reason }
                };
                let _ = app.emit("gpu-fallback-active", &fallback_state);
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    generation,
                );
            }
            Err(e) => {
                error!("CPU fallback failed: {}", e);
                let mut state = inner.lock().await;
                state.status = ServerStatus::Error(format!("CPU fallback failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    /// Respawn after a mid-operation crash while `Ready`. Moves status back to
    /// `Starting` and restarts both the reader and the health poller for the
    /// new process.
    async fn respawn_auto_restart(
        inner: &Arc<Mutex<ServerInner>>,
        app: &AppHandle,
        model_path: &str,
        generation: u64,
    ) {
        warn!("llama-server crashed while Ready — attempting auto-restart");
        {
            let mut state = inner.lock().await;
            state.status = ServerStatus::Starting;
            let _ = app.emit("server-status-changed", &state.status);
        }
        let args = Self::build_llama_args(app, inner, model_path).await;
        match Self::spawn_llama(app, &args) {
            Ok((new_rx, new_child)) => {
                {
                    let mut state = inner.lock().await;
                    state.child = Some(new_child);
                    state.started_at = Some(Instant::now());
                }
                Self::spawn_output_reader(
                    inner.clone(),
                    app.clone(),
                    model_path.to_string(),
                    new_rx,
                    generation,
                );
                Self::spawn_health_poller(inner.clone(), app.clone(), generation);
            }
            Err(e) => {
                error!("Auto-restart failed: {}", e);
                let mut state = inner.lock().await;
                state.status = ServerStatus::Error(format!("Auto-restart failed: {}", e));
                let _ = app.emit("server-status-changed", &state.status);
            }
        }
    }

    fn spawn_health_poller(inner: Arc<Mutex<ServerInner>>, app: AppHandle, generation: u64) {
        tauri::async_runtime::spawn(async move {
            let port = {
                let state = inner.lock().await;
                state.config.port
            };
            let url = sidecar_utils::health_url(port);

            // keep_going: bail if this poller's generation is stale (a
            // newer start() has taken over) or if the status has moved
            // off Starting (e.g. an explicit stop or an early error).
            let inner_for_keep = Arc::clone(&inner);
            let ok = sidecar_utils::poll_health(
                &url,
                "llama-server",
                sidecar_utils::timing::HEALTH_POLL_TIMEOUT_SLOW,
                false,
                move || {
                    let s = Arc::clone(&inner_for_keep);
                    async move {
                        let state = s.lock().await;
                        state.generation == generation && state.status == ServerStatus::Starting
                    }
                },
            )
            .await;

            let mut state = inner.lock().await;
            if state.generation != generation {
                return; // stale poller; another start() has taken over
            }
            if ok {
                if state.status == ServerStatus::Starting {
                    state.status = ServerStatus::Ready;
                    let _ = app.emit("server-status-changed", &ServerStatus::Ready);
                }
            } else if state.status == ServerStatus::Starting {
                let msg = "Health check timed out after 60 seconds".to_string();
                error!("{}", msg);
                state.status = ServerStatus::Error(msg.clone());
                let _ = app.emit("server-status-changed", &ServerStatus::Error(msg));
            }
        });
    }

    pub async fn stop(&self) -> Result<(), String> {
        let port = {
            let mut inner = self.inner.lock().await;
            let port = inner.config.port;
            if let Some(child) = inner.child.take() {
                info!("Stopping llama-server");
                child
                    .kill()
                    .map_err(|e| format!("Failed to kill llama-server: {}", e))?;
            }
            inner.status = ServerStatus::Stopped;
            port
        };

        wait_for_port_release(port).await;
        Ok(())
    }

    pub async fn get_status(&self) -> ServerStatus {
        let inner = self.inner.lock().await;
        inner.status.clone()
    }

    pub async fn get_logs(&self) -> Vec<String> {
        let inner = self.inner.lock().await;
        inner.log_buffer.iter().cloned().collect()
    }

    pub async fn clear_logs(&self) {
        let mut inner = self.inner.lock().await;
        inner.log_buffer.clear();
    }

    pub async fn get_cpu_fallback_state(&self) -> Option<GpuFallbackState> {
        let inner = self.inner.lock().await;
        if !inner.cpu_fallback_active {
            return None;
        }
        let reason = inner
            .gpu_error_reason
            .clone()
            .unwrap_or_else(|| "GPU initialization failed — running on CPU.".to_string());
        Some(GpuFallbackState { reason })
    }
}

// Tauri commands

// Each optional flag is its own IPC argument so the TS side can name them.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_server(
    app: AppHandle,
    state: tauri::State<'_, LlamaServer>,
    model_path: String,
    // Required: the TS caller always resolves this to `DEFAULT_CONTEXT_SIZE`
    // before invoking, so there's a single user-facing default (audit X4).
    ctx_size: u32,
    extra_args: Option<Vec<String>>,
    // The user's `mtpEnabled` preference. `None` (first-run setup, which
    // doesn't read settings) means "no objection" — the model's own capability
    // decides, which is the same answer the default preference gives.
    mtp: Option<bool>,
    // The user's "keep the vision projector in system RAM" preference.
    // `None` (first-run setup) means the default: projector on the GPU.
    mmproj_on_cpu: Option<bool>,
    // The user's "let models use system RAM" preference. `None` means off:
    // every layer pinned to VRAM.
    ram_offload: Option<bool>,
) -> Result<(), String> {
    let filename = Path::new(&model_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // A sibling drafter is only usable once it's actually on disk; without
    // the file, `--spec-type draft-mtp` would fail the start and burn a
    // fallback retry, so treat a missing drafter as "no MTP" up front.
    let draft_path = {
        use tauri::Manager;
        app.try_state::<crate::models::ModelManager>()
            .and_then(|mgr| mgr.find_mtp_draft_for_model(Path::new(&model_path)))
            .map(|p| p.to_string_lossy().to_string())
    };
    let mtp_usable = match crate::models::mtp_source_for(&filename) {
        crate::models::MtpSource::None => false,
        crate::models::MtpSource::Bundled => true,
        crate::models::MtpSource::Sibling {
            filename: draft, ..
        } => {
            if draft_path.is_none() {
                // Happens to anyone who downloaded the weights before the
                // drafter was wired into the registry. Silence here reads as
                // "MTP made no difference", so say it out loud in the logs.
                warn!(
                    "MTP drafter {draft} is not in the models dir — starting without \
                     speculative decoding. Re-run the download for {filename} to fetch it."
                );
            }
            draft_path.is_some()
        }
    };
    // Both have to agree: the user hasn't turned it off AND this GGUF
    // actually has a head to draft from.
    let mtp_on = mtp.unwrap_or(true) && mtp_usable;
    let ram_offload = ram_offload.unwrap_or(false);
    // With offload on, assume the whole file may land in RAM: fit decides how
    // much actually does, and over-counting only shrinks the prompt cache.
    let offloaded_bytes = if ram_offload {
        std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let config = ServerConfig {
        ctx_size,
        n_gpu_layers: if ram_offload {
            None
        } else {
            Some(ALL_GPU_LAYERS)
        },
        cache_ram_mib: cache_ram_mib(crate::hardware::total_ram_bytes(), offloaded_bytes),
        mtp: mtp_on,
        mtp_draft_path: if mtp_on { draft_path } else { None },
        mmproj_on_cpu: mmproj_on_cpu.unwrap_or(false),
        cors_origin: main_webview_origin(&app),
        extra_args: extra_args.unwrap_or_default(),
        ..Default::default()
    };
    state.start(&app, &model_path, Some(config)).await
}

/// `--n-gpu-layers` value that keeps every layer in VRAM.
const ALL_GPU_LAYERS: i32 = 99;

/// Ceiling for the host-RAM prompt cache. It only saves re-reading a prompt
/// after switching between conversations, so it never earns more than this.
pub(crate) const CACHE_RAM_MAX_MIB: u32 = 2048;

/// RAM left to the OS, the webview and everything else before any goes to
/// the prompt cache.
const CACHE_RAM_HEADROOM_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// `--cache-ram` for a machine with `total_ram` bytes when up to
/// `offloaded_bytes` of model weights may sit in RAM: a quarter of what is
/// left after the weights and [`CACHE_RAM_HEADROOM_BYTES`], capped at
/// [`CACHE_RAM_MAX_MIB`]. 0 disables the cache, which is what a machine
/// already short of RAM wants.
pub(crate) fn cache_ram_mib(total_ram: u64, offloaded_bytes: u64) -> u32 {
    let spare = total_ram.saturating_sub(offloaded_bytes + CACHE_RAM_HEADROOM_BYTES);
    ((spare / 4) / (1024 * 1024)).min(CACHE_RAM_MAX_MIB as u64) as u32
}

/// The key the webview sends to llama-server as `Authorization: Bearer`.
/// See `api_key`.
#[tauri::command]
pub fn get_llama_api_key() -> String {
    api_key().to_string()
}

#[tauri::command]
pub async fn stop_server(state: tauri::State<'_, LlamaServer>) -> Result<(), String> {
    state.stop().await
}

#[tauri::command]
pub async fn get_server_status(state: tauri::State<'_, LlamaServer>) -> Result<ServerStatus, ()> {
    Ok(state.get_status().await)
}

#[tauri::command]
pub async fn get_server_logs(state: tauri::State<'_, LlamaServer>) -> Result<Vec<String>, ()> {
    Ok(state.get_logs().await)
}

#[tauri::command]
pub async fn clear_server_logs(state: tauri::State<'_, LlamaServer>) -> Result<(), ()> {
    state.clear_logs().await;
    Ok(())
}

#[tauri::command]
pub async fn get_cpu_fallback_state(
    state: tauri::State<'_, LlamaServer>,
) -> Result<Option<GpuFallbackState>, ()> {
    Ok(state.get_cpu_fallback_state().await)
}

/// Read the persisted llama-server crash log (empty string if none yet).
#[tauri::command]
pub fn get_llama_crash_log(app: AppHandle) -> String {
    crash_telemetry::read(&app)
}

/// Delete the persisted crash log.
#[tauri::command]
pub fn clear_llama_crash_log(app: AppHandle) {
    crash_telemetry::clear(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_lower_ctx_walks_the_ladder() {
        assert_eq!(next_lower_ctx(262144), Some(131072));
        assert_eq!(next_lower_ctx(131072), Some(65536));
        assert_eq!(next_lower_ctx(16384), Some(8192));
        // Floor: nothing below the smallest rung.
        assert_eq!(next_lower_ctx(8192), None);
        assert_eq!(next_lower_ctx(4096), None);
        // Custom off-ladder size backs down to the rung underneath it.
        assert_eq!(next_lower_ctx(100_000), Some(65536));
    }

    /// A `Starting` state with MTP on, as the supervisor would have it after
    /// spawning the child that then died.
    fn starting_with_mtp(ctx_size: u32) -> Arc<Mutex<ServerInner>> {
        Arc::new(Mutex::new(ServerInner {
            child: None,
            status: ServerStatus::Starting,
            config: ServerConfig {
                ctx_size,
                mtp: true,
                ..Default::default()
            },
            log_buffer: VecDeque::new(),
            gpu_fallback_attempted: false,
            gpu_error_detected: false,
            gpu_error_reason: None,
            cpu_fallback_active: false,
            mtp_error_detected: false,
            mtp_error_reason: None,
            mtp_fallback_attempted: false,
            ctx_alloc_error_detected: false,
            ctx_alloc_error_reason: None,
            generation: 1,
            started_at: None,
        }))
    }

    #[tokio::test]
    async fn mtp_fallback_fires_once_on_a_named_mtp_failure() {
        let inner = starting_with_mtp(65536);
        {
            let mut state = inner.lock().await;
            state.mtp_error_detected = true;
            state.mtp_error_reason = Some("MTP requires ctx_tgt and ctx_dft".to_string());
        }

        let reason = LlamaServer::take_mtp_fallback(&inner).await;
        assert_eq!(reason.as_deref(), Some("MTP requires ctx_tgt and ctx_dft"));
        {
            let state = inner.lock().await;
            assert!(!state.config.mtp, "the flag must be dropped for the retry");
            // Context is untouched: MTP is the suspect, not the size.
            assert_eq!(state.config.ctx_size, 65536);
        }

        // One shot only — a model that keeps dying must not respawn forever.
        let mut state = inner.lock().await;
        state.mtp_error_detected = true;
        state.config.mtp = true;
        drop(state);
        assert!(LlamaServer::take_mtp_fallback(&inner).await.is_none());
    }

    /// At the ladder floor there is no smaller context left to try, so the
    /// draft context is the only thing still worth giving up before the
    /// harsher CPU fallback.
    #[tokio::test]
    async fn mtp_fallback_covers_the_context_ladder_floor() {
        let inner = starting_with_mtp(crate::models::MIN_CONTEXT);
        {
            let mut state = inner.lock().await;
            state.ctx_alloc_error_detected = true;
        }
        assert!(LlamaServer::take_mtp_fallback(&inner).await.is_some());

        // With a rung still below, the context backoff owns the retry instead.
        let inner = starting_with_mtp(65536);
        {
            let mut state = inner.lock().await;
            state.ctx_alloc_error_detected = true;
        }
        assert!(LlamaServer::take_mtp_fallback(&inner).await.is_none());
    }

    /// The retry runs a different configuration, so signals from the failed
    /// attempt must not survive into it and trip a second recovery path —
    /// that is how one bad start turns into a CPU fallback nobody asked for.
    #[tokio::test]
    async fn mtp_fallback_clears_sibling_signals() {
        let inner = starting_with_mtp(crate::models::MIN_CONTEXT);
        {
            let mut state = inner.lock().await;
            state.mtp_error_detected = true;
            state.ctx_alloc_error_detected = true;
            state.gpu_error_detected = true;
            state.gpu_error_reason = Some("vulkan: something".to_string());
        }

        assert!(LlamaServer::take_mtp_fallback(&inner).await.is_some());
        let state = inner.lock().await;
        assert!(!state.ctx_alloc_error_detected);
        assert!(!state.gpu_error_detected);
        assert!(state.gpu_error_reason.is_none());
    }

    #[tokio::test]
    async fn mtp_fallback_stays_out_of_the_way_when_mtp_is_off() {
        let inner = starting_with_mtp(65536);
        {
            let mut state = inner.lock().await;
            state.config.mtp = false;
            // Even a line that named MTP: without the flag, it isn't ours.
            state.mtp_error_detected = true;
        }
        assert!(LlamaServer::take_mtp_fallback(&inner).await.is_none());
    }

    #[test]
    fn default_config_values() {
        let config = ServerConfig::default();
        assert_eq!(config.port, 8765);
        assert_eq!(config.ctx_size, 16384);
        assert_eq!(config.n_gpu_layers, Some(99));
        assert!(config.flash_attn);
        assert!(config.extra_args.is_empty());
    }

    #[test]
    fn build_args_includes_all_flags() {
        let config = ServerConfig::default();
        let args = config.build_args("/path/to/model.gguf");

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"/path/to/model.gguf".to_string()));
        assert!(args.contains(&"--port".to_string()));
        assert!(args.contains(&"8765".to_string()));
        assert!(args.contains(&"--ctx-size".to_string()));
        assert!(args.contains(&"16384".to_string()));
        assert!(args.contains(&"--n-gpu-layers".to_string()));
        assert!(args.contains(&"99".to_string()));
        assert!(args.contains(&"--flash-attn".to_string()));
        assert!(args.contains(&"on".to_string()));
        assert!(args.contains(&"--cache-type-k".to_string()));
        assert!(args.contains(&"q8_0".to_string()));
        // Parallel must be pinned to 1 — Haruspex only runs one conversation
        // through llama-server at a time and the KV cache gets fragmented by
        // stale slots otherwise, producing "failed to find free space"
        // warnings in stderr.
        assert!(args.contains(&"--parallel".to_string()));
        let parallel_idx = args.iter().position(|a| a == "--parallel").unwrap();
        assert_eq!(args[parallel_idx + 1], "1");
        assert!(args.contains(&"--jinja".to_string()));
        assert!(args.contains(&"--host".to_string()));
        assert!(args.contains(&"127.0.0.1".to_string()));
    }

    /// `draft-mtp` is the exact type name — llama.cpp's name map has no bare
    /// `mtp`, and an unknown speculative type throws rather than degrading.
    #[test]
    fn build_args_adds_the_mtp_spec_type_only_when_enabled() {
        let off = ServerConfig::default().build_args("/path/to/model.gguf");
        assert!(!off.contains(&"--spec-type".to_string()));

        let on = ServerConfig {
            mtp: true,
            ..Default::default()
        }
        .build_args("/path/to/model.gguf");
        let idx = on
            .iter()
            .position(|a| a == "--spec-type")
            .expect("--spec-type present when mtp is on");
        assert_eq!(on[idx + 1], "draft-mtp");
    }

    /// Extra args land last so a power user can still override anything the
    /// config decided — including the MTP flag.
    #[test]
    fn build_args_keeps_extra_args_after_the_mtp_flag() {
        let args = ServerConfig {
            mtp: true,
            extra_args: vec!["--spec-type".to_string(), "none".to_string()],
            ..Default::default()
        }
        .build_args("/path/to/model.gguf");
        let last = args.iter().rposition(|a| a == "--spec-type").unwrap();
        assert_eq!(args[last + 1], "none");
    }

    /// A sibling drafter has to be named explicitly: llama.cpp auto-discovers
    /// the MTP file only for `-hf` downloads, never for the local `--model`
    /// paths we pass, so `--spec-type draft-mtp` alone would fail the start.
    #[test]
    fn sibling_drafter_is_passed_as_model_draft() {
        let cfg = ServerConfig {
            mtp: true,
            mtp_draft_path: Some("/models/mtp-draft.gguf".to_string()),
            ..Default::default()
        };
        let args = cfg.build_args("/models/target.gguf");
        let draft = args
            .iter()
            .position(|a| a == "--model-draft")
            .expect("--model-draft present for a sibling drafter");
        assert_eq!(args[draft + 1], "/models/mtp-draft.gguf");
        assert!(args.iter().any(|a| a == "draft-mtp"));

        // The drafter's weights belong on the GPU, and at the depth its
        // publisher recommends rather than llama.cpp's default of 3.
        let ngl = args
            .iter()
            .position(|a| a == "--spec-draft-ngl")
            .expect("--spec-draft-ngl pinned for a sibling drafter");
        assert_eq!(args[ngl + 1], "all");
        let nmax = args
            .iter()
            .position(|a| a == "--spec-draft-n-max")
            .expect("--spec-draft-n-max set for a sibling drafter");
        assert_eq!(args[nmax + 1], "4");
    }

    /// A bundled head drafts against the target model itself — passing a
    /// draft path there would point llama-server at a file that isn't one.
    #[test]
    fn bundled_head_needs_no_model_draft() {
        let cfg = ServerConfig {
            mtp: true,
            ..Default::default()
        };
        let args = cfg.build_args("/models/target.gguf");
        assert!(!args.iter().any(|a| a == "--model-draft"));
        assert!(args.iter().any(|a| a == "draft-mtp"));
        // The draft-tuning flags ride with the sibling drafter, not with MTP
        // in general: there is no separate drafter here to offload, and no
        // measurement behind moving this model off llama.cpp's defaults.
        assert!(!args.iter().any(|a| a == "--spec-draft-ngl"));
        assert!(!args.iter().any(|a| a == "--spec-draft-n-max"));
    }

    /// The MTP fallback clears `mtp`; the draft path must go quiet with it
    /// rather than being left on the command line for the retry.
    #[test]
    fn clearing_mtp_drops_the_draft_path_too() {
        let cfg = ServerConfig {
            mtp: false,
            mtp_draft_path: Some("/models/mtp-draft.gguf".to_string()),
            ..Default::default()
        };
        let args = cfg.build_args("/models/target.gguf");
        assert!(!args.iter().any(|a| a == "--model-draft"));
        assert!(!args.iter().any(|a| a == "--spec-type"));
    }

    #[test]
    fn mmproj_args_place_the_projector() {
        let path = Path::new("/models/mmproj-F16.gguf");

        let vram = LlamaServer::mmproj_args(path, false);
        assert_eq!(vram, vec!["--mmproj", "/models/mmproj-F16.gguf"]);

        // On CPU the path is unchanged — only the placement flag is added, so
        // llama-server still loads the same projector, just onto the CPU
        // backend. Dropping --mmproj here would silently disable vision.
        let ram = LlamaServer::mmproj_args(path, true);
        assert_eq!(
            ram,
            vec!["--mmproj", "/models/mmproj-F16.gguf", "--no-mmproj-offload"]
        );
    }

    /// The flag rides with `--mmproj`, not in the base args, so a text-only
    /// model never gets a projector flag it has no projector for.
    #[test]
    fn base_args_carry_no_projector_flags() {
        let cfg = ServerConfig {
            mmproj_on_cpu: true,
            ..Default::default()
        };
        let args = cfg.build_args("/models/text-only.gguf");
        assert!(!args.iter().any(|a| a == "--no-mmproj-offload"));
        assert!(!args.iter().any(|a| a == "--mmproj"));
    }

    /// llama.cpp#27560: Windows + Vulkan + Qwen3.8-27B takes an access
    /// violation on the first chat request unless checkpoints are off. Both
    /// branches are asserted from the host-independent seam so this keeps
    /// working on Linux CI, where the Windows job is opt-in.
    #[test]
    fn build_args_disables_ctx_checkpoints_on_windows() {
        let cfg = ServerConfig::default();
        let args = cfg.build_args_for("/models/qwen.gguf", true);
        let idx = args
            .iter()
            .position(|a| a == "--ctx-checkpoints")
            .expect("windows build must disable context checkpoints");
        assert_eq!(args[idx + 1], "0");
    }

    #[test]
    fn build_args_keeps_ctx_checkpoints_off_windows() {
        let cfg = ServerConfig::default();
        let args = cfg.build_args_for("/models/qwen.gguf", false);
        assert!(!args.iter().any(|a| a == "--ctx-checkpoints"));
    }

    /// The workaround must stay overridable: extra_args is appended last so a
    /// power user can re-enable checkpoints, and llama.cpp takes the last value.
    #[test]
    fn build_args_extra_args_override_ctx_checkpoints() {
        let cfg = ServerConfig {
            extra_args: vec!["--ctx-checkpoints".to_string(), "8".to_string()],
            ..Default::default()
        };
        let args = cfg.build_args_for("/models/qwen.gguf", true);
        let last = args
            .iter()
            .rposition(|a| a == "--ctx-checkpoints")
            .expect("flag present");
        assert_eq!(args[last + 1], "8");
    }

    /// The value following `flag` in `args`, if the flag is there.
    fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let i = args.iter().position(|a| a == flag)?;
        args.get(i + 1).map(String::as_str)
    }

    #[test]
    fn build_args_pin_cors_to_the_webview_origin() {
        let cfg = ServerConfig {
            cors_origin: Some("tauri://localhost".to_string()),
            ..Default::default()
        };
        let args = cfg.build_args_for("/models/qwen.gguf", false);
        assert_eq!(
            flag_value(&args, "--cors-origins"),
            Some("tauri://localhost")
        );
        assert_eq!(
            flag_value(&args, "--cors-methods"),
            Some("GET, POST, OPTIONS")
        );
        // `*` never covers Authorization, so it has to be named.
        assert_eq!(
            flag_value(&args, "--cors-headers"),
            Some("Authorization, Content-Type")
        );
        assert!(args.iter().any(|a| a == "--no-cors-credentials"));
    }

    #[test]
    fn build_args_without_an_origin_still_drop_credentials() {
        let args = ServerConfig::default().build_args_for("/models/qwen.gguf", false);
        assert!(!args.iter().any(|a| a == "--cors-origins"));
        assert!(args.iter().any(|a| a == "--no-cors-credentials"));
    }

    #[test]
    fn build_args_never_carry_the_api_key() {
        // It travels in the environment; argv is world-readable in /proc.
        let args = ServerConfig::default().build_args_for("/models/qwen.gguf", false);
        assert!(!args.iter().any(|a| a == "--api-key" || a == api_key()));
    }

    #[test]
    fn extra_args_can_reopen_cors() {
        let cfg = ServerConfig {
            cors_origin: Some("tauri://localhost".to_string()),
            extra_args: vec!["--cors-origins".to_string(), "*".to_string()],
            ..Default::default()
        };
        let args = cfg.build_args_for("/models/qwen.gguf", false);
        let last = args.iter().rposition(|a| a == "--cors-origins").unwrap();
        assert_eq!(args[last + 1], "*");
    }

    #[test]
    fn api_key_is_stable_and_unguessable() {
        assert_eq!(api_key(), api_key());
        assert_eq!(api_key().len(), 64);
        assert!(api_key().chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn webview_origin_matches_what_each_platform_sends() {
        let origin = |s: &str| webview_origin(&url::Url::parse(s).unwrap());
        assert_eq!(
            origin("http://localhost:1420/chat").as_deref(),
            Some("http://localhost:1420")
        );
        assert_eq!(
            origin("tauri://localhost/").as_deref(),
            Some("tauri://localhost")
        );
        assert_eq!(
            origin("http://tauri.localhost/settings?x=1").as_deref(),
            Some("http://tauri.localhost")
        );
        assert_eq!(
            origin("https://tauri.localhost/").as_deref(),
            Some("https://tauri.localhost")
        );
        assert_eq!(origin("about:blank"), None);
    }

    #[test]
    fn build_args_without_flash_attn() {
        let config = ServerConfig {
            flash_attn: false,
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(args.contains(&"--flash-attn".to_string()));
        assert!(args.contains(&"off".to_string()));
        assert!(!args.contains(&"on".to_string()));
    }

    #[test]
    fn build_args_cpu_only() {
        let config = ServerConfig {
            n_gpu_layers: Some(0),
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert_eq!(flag_value(&args, "--n-gpu-layers"), Some("0"));
    }

    /// RAM offload works by leaving the layer count to llama.cpp's fit, which
    /// aborts on any explicit value — so the flag must be absent, not `auto`.
    #[test]
    fn build_args_omit_gpu_layers_for_ram_offload() {
        let config = ServerConfig {
            n_gpu_layers: None,
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(!args.iter().any(|a| a == "--n-gpu-layers"));
    }

    #[test]
    fn build_args_always_set_the_prompt_cache_size() {
        let args = ServerConfig {
            cache_ram_mib: 512,
            ..Default::default()
        }
        .build_args("/path/to/model.gguf");
        assert_eq!(flag_value(&args, "--cache-ram"), Some("512"));
    }

    #[test]
    fn cache_ram_scales_with_spare_ram_and_caps() {
        let gib = 1024 * 1024 * 1024u64;
        // 64 GB, nothing offloaded: plenty spare, capped.
        assert_eq!(cache_ram_mib(64 * gib, 0), CACHE_RAM_MAX_MIB);
        // 16 GB, nothing offloaded: (16 - 8) / 4 = 2 GiB, right at the cap.
        assert_eq!(cache_ram_mib(16 * gib, 0), 2048);
        // 32 GB with an 18 GB MoE in RAM: (32 - 18 - 8) / 4 = 1.5 GiB.
        assert_eq!(cache_ram_mib(32 * gib, 18 * gib), 1536);
        // 16 GB with an 18 GB model offloaded: no room, cache off.
        assert_eq!(cache_ram_mib(16 * gib, 18 * gib), 0);
        // 8 GB machine: under the headroom, cache off.
        assert_eq!(cache_ram_mib(8 * gib, 0), 0);
    }

    #[test]
    fn build_args_extra_args() {
        let config = ServerConfig {
            extra_args: vec![
                "--verbose".to_string(),
                "--threads".to_string(),
                "4".to_string(),
            ],
            ..Default::default()
        };
        let args = config.build_args("/path/to/model.gguf");
        assert!(args.contains(&"--verbose".to_string()));
        assert!(args.contains(&"--threads".to_string()));
        assert!(args.contains(&"4".to_string()));
    }

    #[test]
    fn log_buffer_capacity() {
        let mut inner = ServerInner {
            child: None,
            status: ServerStatus::Stopped,
            config: ServerConfig::default(),
            log_buffer: VecDeque::with_capacity(LOG_RING_BUFFER_SIZE),
            gpu_fallback_attempted: false,
            gpu_error_detected: false,
            gpu_error_reason: None,
            cpu_fallback_active: false,
            mtp_error_detected: false,
            mtp_error_reason: None,
            mtp_fallback_attempted: false,
            ctx_alloc_error_detected: false,
            ctx_alloc_error_reason: None,
            generation: 0,
            started_at: None,
        };

        for i in 0..LOG_RING_BUFFER_SIZE + 100 {
            push_log(&mut inner.log_buffer, &format!("line {}", i));
        }

        assert_eq!(inner.log_buffer.len(), LOG_RING_BUFFER_SIZE);
        assert_eq!(inner.log_buffer.front().unwrap(), "line 100");
    }
}
