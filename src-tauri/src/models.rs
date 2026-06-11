use futures_util::StreamExt;
use log::info;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::sync::Mutex;

const GGUF_MAGIC: [u8; 4] = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
                                                      // Reserved for future use when implementing chunked progress
#[allow(dead_code)]
const DOWNLOAD_CHUNK_SIZE: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ModelInfo {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub description: String,
    pub downloaded: bool,
    /// Optional multimodal projector filename (e.g. "mmproj-F16.gguf").
    /// When present, it is downloaded alongside the main weights and passed
    /// to llama-server via --mmproj to enable vision support.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mmproj_filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mmproj_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub mmproj_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DownloadProgress {
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number")]
    pub total: u64,
    #[ts(type = "number")]
    pub speed_bps: u64,
    /// Human-readable label for the current download stage
    /// (e.g. "Downloading model", "Downloading vision projector").
    pub stage: String,
}

// mmproj sizes and hashes from the HuggingFace API (F16 variant) —
// the LFS oid of each file IS its sha256.
const QWEN_4B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_4B_MMPROJ_SIZE: u64 = 672_423_616;
const QWEN_4B_MMPROJ_SHA256: &str =
    "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864";
const QWEN_9B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_9B_MMPROJ_SIZE: u64 = 918_166_080;
const QWEN_9B_MMPROJ_SHA256: &str =
    "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f";

/// sha256 for the mmproj at `url`. Keyed by URL rather than stored per
/// registry entry because several models share one projector file.
fn mmproj_sha256_for_url(url: &str) -> Option<&'static str> {
    match url {
        QWEN_4B_MMPROJ_URL => Some(QWEN_4B_MMPROJ_SHA256),
        QWEN_9B_MMPROJ_URL => Some(QWEN_9B_MMPROJ_SHA256),
        _ => None,
    }
}

fn qwen_4b_mmproj_filename() -> String {
    "Qwen3.5-4B-mmproj-F16.gguf".to_string()
}

fn qwen_9b_mmproj_filename() -> String {
    "Qwen3.5-9B-mmproj-F16.gguf".to_string()
}

fn model_registry() -> Vec<ModelInfo> {
    vec![
        // Qwen 3.5 4B — lighter model for low-end hardware
        ModelInfo {
            id: "Qwen3.5-4B-Q4_K_M".to_string(),
            filename: "Qwen3.5-4B-Q4_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf"
                    .to_string(),
            sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4".to_string(),
            size_bytes: 2_740_937_888,
            description: "Qwen 3.5 4B Q4 — for integrated graphics or low VRAM (~2.7 GB)"
                .to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_4b_mmproj_filename()),
            mmproj_url: Some(QWEN_4B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_4B_MMPROJ_SIZE),
        },
        ModelInfo {
            id: "Qwen3.5-4B-Q6_K".to_string(),
            filename: "Qwen3.5-4B-Q6_K.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q6_K.gguf"
                .to_string(),
            sha256: "fdedd781c9ce676ab66b018ca247ff78e8a33c98098a822c1e2d5075e7718f66".to_string(),
            size_bytes: 3_525_956_768,
            description: "Qwen 3.5 4B Q6 — better quality 4B, needs 4+ GB VRAM (~3.5 GB)"
                .to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_4b_mmproj_filename()),
            mmproj_url: Some(QWEN_4B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_4B_MMPROJ_SIZE),
        },
        // Qwen 3.5 9B — best quality, native tool calling
        ModelInfo {
            id: "Qwen3.5-9B-Q4_K_M".to_string(),
            filename: "Qwen3.5-9B-Q4_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
                    .to_string(),
            sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8".to_string(),
            size_bytes: 5_680_522_464,
            description: "Qwen 3.5 9B Q4 — recommended for 8GB VRAM (~5.7 GB)".to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q5_K_M".to_string(),
            filename: "Qwen3.5-9B-Q5_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q5_K_M.gguf"
                    .to_string(),
            sha256: "dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c".to_string(),
            size_bytes: 6_577_841_376,
            description: "Qwen 3.5 9B Q5 — higher quality, tight on 8GB VRAM (~6.6 GB)".to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q6_K".to_string(),
            filename: "Qwen3.5-9B-Q6_K.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q6_K.gguf"
                .to_string(),
            sha256: "91898433cf5ce0a8f45516a4cc3e9343b6e01d052d01f684309098c66a326c59".to_string(),
            size_bytes: 7_458_301_152,
            description: "Qwen 3.5 9B Q6 — high quality, needs 10+ GB VRAM (~7.5 GB)".to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q8_0".to_string(),
            filename: "Qwen3.5-9B-Q8_0.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q8_0.gguf"
                .to_string(),
            sha256: "809626574d0cb43d4becfa56169980da2bb448f2299270f7be443cb89d0a6ae4".to_string(),
            size_bytes: 9_527_502_048,
            description: "Qwen 3.5 9B Q8 — best quality, needs 16+ GB VRAM (~9.5 GB)".to_string(),
            downloaded: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
        },
    ]
}

pub struct ModelManager {
    models_dir: PathBuf,
    cancel_flag: Arc<Mutex<bool>>,
}

/// Total expected size for a (possibly resumed) download. When resuming, the
/// server's `Content-Length` covers only the *remaining* bytes, so add what's
/// already on disk; fall back to the registry's expected size when the server
/// omits `Content-Length`.
fn resume_total_size(existing_size: u64, content_length: Option<u64>, expected_size: u64) -> u64 {
    if existing_size > 0 {
        existing_size + content_length.unwrap_or(expected_size.saturating_sub(existing_size))
    } else {
        content_length.unwrap_or(expected_size)
    }
}

/// Bytes/sec for the current session — excludes the pre-existing resumed
/// bytes so a resumed download doesn't report an inflated initial speed.
fn download_speed_bps(downloaded: u64, existing_size: u64, elapsed_secs: f64) -> u64 {
    if elapsed_secs > 0.0 {
        (downloaded.saturating_sub(existing_size) as f64 / elapsed_secs) as u64
    } else {
        0
    }
}

impl ModelManager {
    pub fn new(app: &AppHandle) -> Self {
        let models_dir = app
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data dir")
            .join("models");

        Self {
            models_dir,
            cancel_flag: Arc::new(Mutex::new(false)),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub async fn ensure_models_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.models_dir)
            .await
            .map_err(|e| format!("Failed to create models directory: {}", e))
    }

    pub async fn list_models(&self) -> Vec<ModelInfo> {
        let mut registry = model_registry();
        for model in &mut registry {
            let path = self.models_dir.join(&model.filename);
            model.downloaded = path.exists();
        }
        registry
    }

    #[allow(dead_code)]
    pub async fn list_downloaded(&self) -> Vec<String> {
        let mut downloaded = Vec::new();
        if let Ok(mut entries) = fs::read_dir(&self.models_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".gguf") {
                    downloaded.push(name);
                }
            }
        }
        downloaded
    }

    #[allow(dead_code)]
    pub fn get_model_path(&self, filename: &str) -> PathBuf {
        self.models_dir.join(filename)
    }

    pub fn find_any_model(&self) -> Option<PathBuf> {
        if let Ok(entries) = std::fs::read_dir(&self.models_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Skip partial downloads and mmproj files (they are not standalone models)
                if name.ends_with(".gguf")
                    && !name.ends_with(".partial")
                    && !name.contains("mmproj")
                {
                    return Some(entry.path());
                }
            }
        }
        None
    }

    /// Given a path to a downloaded model weights file, return the path to
    /// its multimodal projector file if one exists on disk. Returns None if
    /// the model has no mmproj or the mmproj file is not present.
    pub fn find_mmproj_for_model(&self, model_path: &Path) -> Option<PathBuf> {
        let model_filename = model_path.file_name()?.to_string_lossy().to_string();
        let registry = model_registry();
        let entry = registry.iter().find(|m| m.filename == model_filename)?;
        let mmproj_filename = entry.mmproj_filename.as_ref()?;
        let mmproj_path = self.models_dir.join(mmproj_filename);
        if mmproj_path.exists() {
            Some(mmproj_path)
        } else {
            None
        }
    }

    /// Download a single file with resume support and progress events.
    /// `stage_label` is included in the progress event so the UI can show
    /// "Downloading model" vs "Downloading vision projector".
    async fn download_file(
        &self,
        app: &AppHandle,
        url: &str,
        filename: &str,
        expected_size: u64,
        stage_label: &str,
    ) -> Result<PathBuf, String> {
        self.ensure_models_dir().await?;
        let final_path = self.models_dir.join(filename);
        let partial_path = self.models_dir.join(format!("{}.partial", filename));

        // Skip if already downloaded
        if final_path.exists() {
            info!("{} already downloaded: {}", stage_label, filename);
            return Ok(final_path);
        }

        let existing_size = if partial_path.exists() {
            fs::metadata(&partial_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        info!(
            "{}: {} (resume from {} bytes)",
            stage_label, filename, existing_size
        );

        let client = reqwest::Client::new();
        let mut request = client.get(url);
        if existing_size > 0 {
            request = request.header("Range", format!("bytes={}-", existing_size));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() && response.status().as_u16() != 206 {
            return Err(format!(
                "Download failed with status: {}",
                response.status()
            ));
        }

        // Only treat this as a resume when the server actually honored the
        // Range header (206). A 200 means it's sending the whole file —
        // appending that to the partial would silently corrupt it (and the
        // corrupt file would pass the 4-byte GGUF magic check).
        let resumed = existing_size > 0 && response.status().as_u16() == 206;
        if existing_size > 0 && !resumed {
            info!(
                "{}: server ignored Range (status {}), restarting from zero",
                stage_label,
                response.status()
            );
        }
        let base_offset = if resumed { existing_size } else { 0 };

        let total_size = resume_total_size(base_offset, response.content_length(), expected_size);

        let mut open_opts = tokio::fs::OpenOptions::new();
        open_opts.create(true);
        if resumed {
            open_opts.append(true);
        } else {
            open_opts.write(true).truncate(true);
        }
        let mut file = open_opts
            .open(&partial_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;

        let mut downloaded = base_offset;
        let start_time = std::time::Instant::now();
        let mut last_progress_time = start_time;

        use tokio::io::AsyncWriteExt;
        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = StreamExt::next(&mut stream).await {
            {
                let cancel = self.cancel_flag.lock().await;
                if *cancel {
                    drop(file);
                    info!("Download cancelled");
                    return Err("Download cancelled".to_string());
                }
            }

            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write error: {}", e))?;

            downloaded += chunk.len() as u64;

            let now = std::time::Instant::now();
            if now.duration_since(last_progress_time).as_millis() >= 100 {
                let elapsed = now.duration_since(start_time).as_secs_f64();
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        downloaded,
                        total: total_size,
                        speed_bps: download_speed_bps(downloaded, base_offset, elapsed),
                        stage: stage_label.to_string(),
                    },
                );
                last_progress_time = now;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;
        drop(file);

        let elapsed = start_time.elapsed().as_secs_f64();
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                downloaded,
                total: total_size,
                speed_bps: download_speed_bps(downloaded, base_offset, elapsed),
                stage: stage_label.to_string(),
            },
        );

        fs::rename(&partial_path, &final_path)
            .await
            .map_err(|e| format!("Failed to finalize download: {}", e))?;

        info!("{} download complete: {}", stage_label, filename);
        Ok(final_path)
    }

    pub async fn download_model(&self, app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
        let registry = model_registry();
        let model = registry
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Unknown model: {}", model_id))?
            .clone();

        // Reset cancel flag
        {
            let mut cancel = self.cancel_flag.lock().await;
            *cancel = false;
        }

        // Download main weights
        let final_path = self
            .download_file(
                app,
                &model.url,
                &model.filename,
                model.size_bytes,
                "Downloading model",
            )
            .await?;

        // Verify SHA256 if we have a hash
        if !model.sha256.is_empty() {
            info!("Verifying SHA256...");
            verify_sha256(&final_path, &model.sha256).await?;
        }

        // Download mmproj (vision projector) if the model has one
        if let (Some(mmproj_url), Some(mmproj_filename), Some(mmproj_size)) = (
            model.mmproj_url.as_ref(),
            model.mmproj_filename.as_ref(),
            model.mmproj_size_bytes,
        ) {
            let mmproj_path = self
                .download_file(
                    app,
                    mmproj_url,
                    mmproj_filename,
                    mmproj_size,
                    "Downloading vision projector",
                )
                .await?;
            if let Some(expected) = mmproj_sha256_for_url(mmproj_url) {
                info!("Verifying mmproj SHA256...");
                verify_sha256(&mmproj_path, expected).await?;
            }
        }

        Ok(final_path)
    }

    pub async fn cancel_download(&self) {
        let mut cancel = self.cancel_flag.lock().await;
        *cancel = true;
    }

    pub async fn import_model(&self, source_path: &str) -> Result<ModelInfo, String> {
        let source = Path::new(source_path);

        if !source.exists() {
            return Err("File not found".to_string());
        }

        // Validate GGUF magic bytes
        validate_gguf(source).await?;

        let filename = source
            .file_name()
            .ok_or("Invalid filename")?
            .to_string_lossy()
            .to_string();

        self.ensure_models_dir().await?;
        let dest = self.models_dir.join(&filename);

        // Copy file to models dir
        fs::copy(source, &dest)
            .await
            .map_err(|e| format!("Failed to copy model: {}", e))?;

        info!("Imported model: {}", filename);

        Ok(ModelInfo {
            id: filename.trim_end_matches(".gguf").to_string(),
            filename,
            url: String::new(),
            sha256: String::new(),
            size_bytes: fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0),
            description: "Imported model".to_string(),
            downloaded: true,
            mmproj_filename: None,
            mmproj_url: None,
            mmproj_size_bytes: None,
        })
    }

    #[allow(dead_code)]
    pub async fn delete_model(&self, filename: &str) -> Result<(), String> {
        let path = self.models_dir.join(filename);
        if path.exists() {
            fs::remove_file(&path)
                .await
                .map_err(|e| format!("Failed to delete model: {}", e))?;
            info!("Deleted model: {}", filename);
        }
        Ok(())
    }
}

/// Streaming hash — model files run to ~9.5 GB, far too large for the
/// previous read-whole-file-into-memory approach.
async fn compute_sha256(path: &Path) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Compare a downloaded file against its expected sha256; delete it on
/// mismatch so a corrupt artifact can't be picked up as a valid model.
async fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let hash = compute_sha256(path).await?;
    if !hash.eq_ignore_ascii_case(expected) {
        fs::remove_file(path).await.ok();
        return Err("Download verification failed: SHA256 mismatch".to_string());
    }
    Ok(())
}

async fn validate_gguf(path: &Path) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).await.is_err() {
        return Err("File too small to be a valid GGUF".to_string());
    }
    if magic != GGUF_MAGIC {
        return Err("Not a valid GGUF file (wrong magic bytes)".to_string());
    }
    Ok(())
}

// Tauri commands

#[tauri::command]
pub async fn list_models(state: tauri::State<'_, ModelManager>) -> Result<Vec<ModelInfo>, ()> {
    Ok(state.list_models().await)
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    model_id: String,
) -> Result<String, String> {
    let path = state.download_model(&app, &model_id).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn cancel_download(state: tauri::State<'_, ModelManager>) -> Result<(), ()> {
    state.cancel_download().await;
    Ok(())
}

#[tauri::command]
pub async fn import_model(
    state: tauri::State<'_, ModelManager>,
    path: String,
) -> Result<ModelInfo, String> {
    state.import_model(&path).await
}

#[tauri::command]
pub async fn get_models_dir(state: tauri::State<'_, ModelManager>) -> Result<String, ()> {
    Ok(state.models_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn has_any_model(state: tauri::State<'_, ModelManager>) -> Result<bool, ()> {
    let _ = state.ensure_models_dir().await;
    Ok(state.find_any_model().is_some())
}

#[tauri::command]
pub async fn get_active_model_path(
    state: tauri::State<'_, ModelManager>,
    preferred_filename: Option<String>,
) -> Result<Option<String>, ()> {
    // Honor the caller's stored preference when the file is actually on
    // disk; otherwise fall back to "any model" so first-run users (who
    // have no preference recorded yet) and users who deleted their
    // chosen model still get a working sidecar.
    if let Some(name) = preferred_filename.as_deref().filter(|s| !s.is_empty()) {
        let path = state.models_dir().join(name);
        if path.exists() {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }
    Ok(state
        .find_any_model()
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn delete_model(
    state: tauri::State<'_, ModelManager>,
    filename: String,
) -> Result<(), String> {
    state.delete_model(&filename).await
}

#[tauri::command]
pub async fn get_whisper_model_path(
    state: tauri::State<'_, ModelManager>,
) -> Result<Option<String>, ()> {
    let path = state.models_dir().join("whisper").join("ggml-base.en.bin");
    if path.exists() {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
) -> Result<String, String> {
    let whisper_dir = state.models_dir().join("whisper");
    fs::create_dir_all(&whisper_dir)
        .await
        .map_err(|e| format!("Failed to create whisper dir: {}", e))?;

    let final_path = whisper_dir.join("ggml-base.en.bin");
    if final_path.exists() {
        return Ok(final_path.to_string_lossy().to_string());
    }

    let partial_path = whisper_dir.join("ggml-base.en.bin.partial");
    let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
    let expected_size: u64 = 147_964_211;
    // LFS oid from the HuggingFace API for ggml-base.en.bin
    const WHISPER_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";

    // Reset cancel flag
    {
        let mut cancel = state.cancel_flag.lock().await;
        *cancel = false;
    }

    let existing_size = if partial_path.exists() {
        fs::metadata(&partial_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    info!(
        "Downloading whisper model (resume from {} bytes)",
        existing_size
    );

    let client = reqwest::Client::new();
    let mut request = client.get(url);
    if existing_size > 0 {
        request = request.header("Range", format!("bytes={}-", existing_size));
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() && response.status().as_u16() != 206 {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    // Only a 206 means the Range was honored; a 200 is the whole file and
    // appending it to the partial would corrupt the model.
    let resumed = existing_size > 0 && response.status().as_u16() == 206;
    if existing_size > 0 && !resumed {
        info!(
            "Whisper download: server ignored Range (status {}), restarting from zero",
            response.status()
        );
    }
    let base_offset = if resumed { existing_size } else { 0 };

    let total_size = resume_total_size(base_offset, response.content_length(), expected_size);

    let mut open_opts = tokio::fs::OpenOptions::new();
    open_opts.create(true);
    if resumed {
        open_opts.append(true);
    } else {
        open_opts.write(true).truncate(true);
    }
    let mut file = open_opts
        .open(&partial_path)
        .await
        .map_err(|e| format!("Failed to open file: {}", e))?;

    let mut downloaded = base_offset;
    let start_time = std::time::Instant::now();
    let mut last_progress_time = start_time;

    use tokio::io::AsyncWriteExt;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = StreamExt::next(&mut stream).await {
        {
            let cancel = state.cancel_flag.lock().await;
            if *cancel {
                drop(file);
                info!("Whisper download cancelled");
                return Err("Download cancelled".to_string());
            }
        }

        let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write error: {}", e))?;

        downloaded += chunk.len() as u64;

        let now = std::time::Instant::now();
        if now.duration_since(last_progress_time).as_millis() >= 100 {
            let elapsed = now.duration_since(start_time).as_secs_f64();
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    downloaded,
                    total: total_size,
                    speed_bps: download_speed_bps(downloaded, base_offset, elapsed),
                    stage: "Downloading speech model".to_string(),
                },
            );
            last_progress_time = now;
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Flush error: {}", e))?;
    drop(file);

    info!("Verifying whisper model SHA256...");
    verify_sha256(&partial_path, WHISPER_SHA256).await?;

    fs::rename(&partial_path, &final_path)
        .await
        .map_err(|e| format!("Failed to finalize download: {}", e))?;

    info!("Whisper model downloaded successfully");
    Ok(final_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_total_size_fresh_download_uses_content_length() {
        assert_eq!(resume_total_size(0, Some(1000), 5000), 1000);
        assert_eq!(resume_total_size(0, None, 5000), 5000);
    }

    #[test]
    fn resume_total_size_resumed_adds_existing_to_remaining() {
        // Server reports only the remaining 600 bytes; 400 already on disk.
        assert_eq!(resume_total_size(400, Some(600), 1000), 1000);
        // No Content-Length → expected(1000) - existing(400) = 600 remaining.
        assert_eq!(resume_total_size(400, None, 1000), 1000);
    }

    #[test]
    fn resume_total_size_existing_beyond_expected_saturates() {
        assert_eq!(resume_total_size(1200, None, 1000), 1200);
    }

    #[test]
    fn download_speed_bps_basics() {
        assert_eq!(download_speed_bps(1000, 0, 0.0), 0); // no elapsed time
                                                         // 500 new bytes (downloaded 900, resumed-from 400) over 0.5s = 1000 B/s.
        assert_eq!(download_speed_bps(900, 400, 0.5), 1000);
    }

    #[test]
    fn model_registry_has_expected_entries() {
        let models = model_registry();
        assert_eq!(models.len(), 6);

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"Qwen3.5-4B-Q4_K_M"));
        assert!(ids.contains(&"Qwen3.5-4B-Q6_K"));
        assert!(ids.contains(&"Qwen3.5-9B-Q4_K_M"));
        assert!(ids.contains(&"Qwen3.5-9B-Q5_K_M"));
        assert!(ids.contains(&"Qwen3.5-9B-Q6_K"));
        assert!(ids.contains(&"Qwen3.5-9B-Q8_0"));
    }

    #[test]
    fn model_registry_urls_are_valid() {
        for model in model_registry() {
            assert!(
                model.url.starts_with("https://huggingface.co/"),
                "Invalid URL for {}: {}",
                model.id,
                model.url
            );
            assert!(
                model.url.ends_with(".gguf"),
                "URL should end with .gguf for {}",
                model.id
            );
        }
    }

    #[test]
    fn model_registry_sizes_reasonable() {
        for model in model_registry() {
            assert!(
                model.size_bytes > 1_000_000_000,
                "Model {} size too small: {}",
                model.id,
                model.size_bytes
            );
            assert!(
                model.size_bytes < 10_000_000_000,
                "Model {} size too large: {}",
                model.id,
                model.size_bytes
            );
        }
    }

    #[tokio::test]
    async fn validate_gguf_rejects_invalid_file() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf");
        fs::create_dir_all(&dir).await.unwrap();

        let bad_file = dir.join("bad.gguf");
        fs::write(&bad_file, b"not a gguf file").await.unwrap();

        let result = validate_gguf(&bad_file).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("wrong magic bytes"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn validate_gguf_accepts_valid_magic() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf_valid");
        fs::create_dir_all(&dir).await.unwrap();

        let good_file = dir.join("good.gguf");
        let mut data = GGUF_MAGIC.to_vec();
        data.extend_from_slice(&[0u8; 100]); // pad with zeros
        fs::write(&good_file, &data).await.unwrap();

        let result = validate_gguf(&good_file).await;
        assert!(result.is_ok());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn validate_gguf_rejects_too_small() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf_small");
        fs::create_dir_all(&dir).await.unwrap();

        let small_file = dir.join("tiny.gguf");
        fs::write(&small_file, b"GG").await.unwrap();

        let result = validate_gguf(&small_file).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too small"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn compute_sha256_works() {
        let dir = std::env::temp_dir().join("haruspex_test_sha256");
        fs::create_dir_all(&dir).await.unwrap();

        let file = dir.join("test.bin");
        fs::write(&file, b"hello world").await.unwrap();

        let hash = compute_sha256(&file).await.unwrap();
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        fs::remove_dir_all(&dir).await.ok();
    }
}
