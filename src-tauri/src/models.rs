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

#[derive(Clone, Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub description: String,
    pub downloaded: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub speed_bps: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct HardwareInfo {
    pub gpu_available: bool,
    pub gpu_name: Option<String>,
    pub gpu_api: Option<String>,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub recommended_quant: String,
}

fn model_registry() -> Vec<ModelInfo> {
    vec![
        // Qwen 3.5 9B — best quality, native tool calling
        ModelInfo {
            id: "Qwen3.5-9B-Q4_K_M".to_string(),
            filename: "Qwen3.5-9B-Q4_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
                    .to_string(),
            sha256: String::new(),
            size_bytes: 5_680_000_000,
            description: "Qwen 3.5 9B Q4 — recommended for 8GB VRAM (~5.7 GB)".to_string(),
            downloaded: false,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q5_K_M".to_string(),
            filename: "Qwen3.5-9B-Q5_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q5_K_M.gguf"
                    .to_string(),
            sha256: String::new(),
            size_bytes: 6_580_000_000,
            description: "Qwen 3.5 9B Q5 — higher quality, tight on 8GB VRAM (~6.6 GB)".to_string(),
            downloaded: false,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q6_K".to_string(),
            filename: "Qwen3.5-9B-Q6_K.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q6_K.gguf"
                .to_string(),
            sha256: String::new(),
            size_bytes: 7_460_000_000,
            description: "Qwen 3.5 9B Q6 — best quality, needs 10+ GB VRAM (~7.5 GB)".to_string(),
            downloaded: false,
        },
    ]
}

pub struct ModelManager {
    models_dir: PathBuf,
    cancel_flag: Arc<Mutex<bool>>,
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
                if name.ends_with(".gguf") && !name.ends_with(".partial") {
                    return Some(entry.path());
                }
            }
        }
        None
    }

    pub async fn download_model(&self, app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
        let registry = model_registry();
        let model = registry
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Unknown model: {}", model_id))?;

        self.ensure_models_dir().await?;

        let final_path = self.models_dir.join(&model.filename);
        let partial_path = self.models_dir.join(format!("{}.partial", model.filename));

        // Reset cancel flag
        {
            let mut cancel = self.cancel_flag.lock().await;
            *cancel = false;
        }

        // Check if partial download exists for resume
        let existing_size = if partial_path.exists() {
            fs::metadata(&partial_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        info!(
            "Downloading model {} (resume from {} bytes)",
            model_id, existing_size
        );

        let client = reqwest::Client::new();
        let mut request = client.get(&model.url);

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

        let total_size = if existing_size > 0 {
            // For range requests, content-length is remaining bytes
            existing_size
                + response
                    .content_length()
                    .unwrap_or(model.size_bytes - existing_size)
        } else {
            response.content_length().unwrap_or(model.size_bytes)
        };

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;

        let mut downloaded = existing_size;
        let start_time = std::time::Instant::now();
        let mut last_progress_time = start_time;

        use tokio::io::AsyncWriteExt;
        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = StreamExt::next(&mut stream).await {
            // Check cancellation
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

            // Emit progress every 100ms
            let now = std::time::Instant::now();
            if now.duration_since(last_progress_time).as_millis() >= 100 {
                let elapsed = now.duration_since(start_time).as_secs_f64();
                let speed_bps = if elapsed > 0.0 {
                    ((downloaded - existing_size) as f64 / elapsed) as u64
                } else {
                    0
                };

                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        downloaded,
                        total: total_size,
                        speed_bps,
                    },
                );
                last_progress_time = now;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;
        drop(file);

        // Final progress event
        let elapsed = start_time.elapsed().as_secs_f64();
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                downloaded,
                total: total_size,
                speed_bps: if elapsed > 0.0 {
                    ((downloaded - existing_size) as f64 / elapsed) as u64
                } else {
                    0
                },
            },
        );

        // Verify SHA256 if we have a hash
        if !model.sha256.is_empty() {
            info!("Verifying SHA256...");
            let hash = compute_sha256(&partial_path).await?;
            if hash != model.sha256 {
                fs::remove_file(&partial_path).await.ok();
                return Err("Download verification failed: SHA256 mismatch".to_string());
            }
        }

        // Rename partial to final
        fs::rename(&partial_path, &final_path)
            .await
            .map_err(|e| format!("Failed to finalize download: {}", e))?;

        info!("Model download complete: {}", model.filename);
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

async fn compute_sha256(path: &Path) -> Result<String, String> {
    let data = fs::read(path)
        .await
        .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

async fn validate_gguf(path: &Path) -> Result<(), String> {
    let data = fs::read(path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    if data.len() < 4 {
        return Err("File too small to be a valid GGUF".to_string());
    }

    if data[0..4] != GGUF_MAGIC {
        return Err("Not a valid GGUF file (wrong magic bytes)".to_string());
    }

    Ok(())
}

pub fn detect_hardware() -> HardwareInfo {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mb = sys.total_memory() / 1_048_576;
    let available_ram_mb = sys.available_memory() / 1_048_576;

    // GPU detection
    let (gpu_available, gpu_name, gpu_api) = detect_gpu();

    let recommended_quant = if available_ram_mb < 8192 {
        "Qwen3.5-9B-Q4_K_M"
    } else if available_ram_mb < 12288 {
        "Qwen3.5-9B-Q5_K_M"
    } else {
        "Qwen3.5-9B-Q6_K"
    };

    HardwareInfo {
        gpu_available,
        gpu_name,
        gpu_api,
        total_ram_mb,
        available_ram_mb,
        recommended_quant: recommended_quant.to_string(),
    }
}

#[cfg(target_os = "linux")]
fn detect_gpu() -> (bool, Option<String>, Option<String>) {
    // Check for Vulkan runtime
    let vulkan_available = Path::new("/usr/lib/libvulkan.so").exists()
        || Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so").exists()
        || Path::new("/usr/lib64/libvulkan.so").exists()
        || Path::new("/usr/lib/libvulkan.so.1").exists()
        || Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so.1").exists()
        || Path::new("/usr/lib64/libvulkan.so.1").exists();

    if vulkan_available {
        // Try to get GPU name from /proc or lspci
        let gpu_name = get_linux_gpu_name();
        (true, gpu_name, Some("Vulkan".to_string()))
    } else {
        (false, None, None)
    }
}

#[cfg(target_os = "linux")]
fn get_linux_gpu_name() -> Option<String> {
    // Try reading from DRM subsystem
    for i in 0..4 {
        let path = format!("/sys/class/drm/card{}/device/label", i);
        if let Ok(name) = std::fs::read_to_string(&path) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }

    // Fallback: try lspci
    if let Ok(output) = std::process::Command::new("lspci").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if line.contains("VGA") || line.contains("3D") || line.contains("Display") {
                if let Some(name) = line.split(": ").nth(1) {
                    return Some(name.to_string());
                }
            }
        }
    }

    None
}

#[cfg(target_os = "macos")]
fn detect_gpu() -> (bool, Option<String>, Option<String>) {
    // Metal is always available on supported macOS hardware
    (
        true,
        Some("Apple GPU".to_string()),
        Some("Metal".to_string()),
    )
}

#[cfg(target_os = "windows")]
fn detect_gpu() -> (bool, Option<String>, Option<String>) {
    let vulkan_available = Path::new("C:\\Windows\\System32\\vulkan-1.dll").exists();
    if vulkan_available {
        (true, None, Some("Vulkan".to_string()))
    } else {
        (false, None, None)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn detect_gpu() -> (bool, Option<String>, Option<String>) {
    (false, None, None)
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
pub fn cmd_detect_hardware() -> HardwareInfo {
    detect_hardware()
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
) -> Result<Option<String>, ()> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_registry_has_expected_entries() {
        let models = model_registry();
        assert_eq!(models.len(), 3);

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"Qwen3.5-9B-Q4_K_M"));
        assert!(ids.contains(&"Qwen3.5-9B-Q5_K_M"));
        assert!(ids.contains(&"Qwen3.5-9B-Q6_K"));
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

    #[test]
    fn hardware_detection_returns_valid_info() {
        let info = detect_hardware();
        assert!(info.total_ram_mb > 0);
        assert!(info.available_ram_mb > 0);
        assert!(info.available_ram_mb <= info.total_ram_mb);
        assert!(!info.recommended_quant.is_empty());
    }

    #[test]
    fn recommended_quant_based_on_ram() {
        let info = detect_hardware();
        let valid_quants = ["Qwen3.5-9B-Q4_K_M", "Qwen3.5-9B-Q5_K_M", "Qwen3.5-9B-Q6_K"];
        assert!(
            valid_quants.contains(&info.recommended_quant.as_str()),
            "Unexpected quant: {}",
            info.recommended_quant
        );
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
