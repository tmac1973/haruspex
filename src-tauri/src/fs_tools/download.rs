//! `fs_download_url` — sandboxed HTTP download into the working directory.

use super::path::{refuse_if_exists, resolve_in_workdir, workdir_path_for_write};
use tokio::fs;

/// Max bytes we'll accept from a single HTTP download into the working
/// directory. Generous enough for a typical image, PDF, or font file, and
/// small enough to prevent a rogue URL from filling the disk. This caps
/// both the Content-Length header (pre-fetch) and the actual bytes read.
const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024; // 50 MB

/// File extensions we refuse to save via `fs_download_url`, even if the
/// URL is otherwise valid. This is a blocklist, not an allowlist — the
/// goal is to prevent the model from being tricked (or tricking itself)
/// into staging an executable payload in the user's working directory,
/// while still letting it download the long tail of legitimate binary
/// content (images, PDFs, office docs, archives, fonts, media, data).
///
/// Everything in here is a file format that can be executed or installed
/// on at least one mainstream OS without user supervision. `.sh` and
/// `.py` are NOT in the list because they're plain text and won't run
/// without an explicit chmod/invocation by the user — same bar as the
/// existing fs_write_text tool applies.
const EXECUTABLE_EXTENSION_BLOCKLIST: &[&str] = &[
    "exe", "msi", "scr", "com", "bat", "cmd", "ps1", "vbs", "vbe", "jse", "wsf", "wsh", "hta",
    "dll", "sys", "drv", "cpl", "ocx", "so", "dylib", "app", "pkg", "dmg", "deb", "rpm", "apk",
    "appimage", "snap", "flatpak", "jar",
];

/// Return an error if `rel_path` ends with an extension on the executable
/// blocklist. Case-insensitive. No extension at all is allowed — we can't
/// guess whether it's benign data or a shell script the caller forgot to
/// name.
fn reject_executable_extension(rel_path: &str) -> Result<(), String> {
    let ext = std::path::Path::new(rel_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    if let Some(ext) = ext {
        if EXECUTABLE_EXTENSION_BLOCKLIST.contains(&ext.as_str()) {
            return Err(format!(
                "Refusing to download '{}': .{} files are blocked to prevent staging \
                 executable payloads in the working directory.",
                rel_path, ext
            ));
        }
    }
    Ok(())
}

/// Download the bytes at `url` and save them to `rel_path` inside the
/// working directory. Shared SSRF protection with the web-search fetch
/// path (private IPs, localhost, non-HTTP schemes are all rejected).
///
/// Failure modes:
///   - URL fails `proxy::validate_url`
///   - Extension is on the executable blocklist
///   - HTTP response is not 2xx
///   - Declared `Content-Length` exceeds the size limit
///   - Actual streamed bytes exceed the size limit (caught mid-download)
///
/// On success, the returned string is a short confirmation including the
/// resolved local path so the model can reuse it in follow-up tool calls
/// (e.g. embedding a downloaded image in a slide via fs_write_pptx).
#[tauri::command]
pub async fn fs_download_url(
    workdir: String,
    url: String,
    rel_path: String,
    overwrite: Option<bool>,
) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let workdir = workdir_path_for_write(&workdir)?;
    let resolved = resolve_in_workdir(&workdir, &rel_path)?;

    // SSRF + scheme + private-IP guard. Uses the same helper as proxy_fetch.
    crate::proxy::validate_url(&url)?;

    // Extension-level safety net.
    reject_executable_extension(&rel_path)?;

    // Conflict guard — refuse to overwrite unless explicitly confirmed.
    refuse_if_exists(&resolved, overwrite, &rel_path)?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        // Re-validates every redirect hop — without this, a public URL
        // answering 302 into localhost/private ranges would stream an
        // internal response into the workdir where the model can read it.
        .redirect(crate::proxy::validating_redirect_policy())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .header("User-Agent", crate::proxy::USER_AGENT)
        .send()
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Remote file is too large ({} bytes). Maximum is {} bytes.",
                len, MAX_DOWNLOAD_BYTES
            ));
        }
    }

    if let Some(parent) = resolved.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create parent directory: {}", e))?;
        }
    }

    let mut file = fs::File::create(&resolved)
        .await
        .map_err(|e| format!("Failed to open output file: {}", e))?;

    let mut total: u64 = 0;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = fs::remove_file(&resolved).await;
            return Err(format!(
                "Download exceeded size limit ({} bytes streamed, max {}).",
                total, MAX_DOWNLOAD_BYTES
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Failed to write chunk: {}", e))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush file: {}", e))?;

    Ok(format!("Downloaded {} bytes to {}", total, rel_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reject_executable_extension_blocks_known_dangers() {
        for ext in EXECUTABLE_EXTENSION_BLOCKLIST {
            let path = format!("danger.{}", ext);
            assert!(
                reject_executable_extension(&path).is_err(),
                "expected {}.{} to be rejected",
                path,
                ext
            );
            let upper_path = format!("DANGER.{}", ext.to_uppercase());
            assert!(
                reject_executable_extension(&upper_path).is_err(),
                "expected {} to be rejected",
                upper_path
            );
        }
    }

    #[test]
    fn reject_executable_extension_allows_safe_formats() {
        let safe = [
            "images/hero.png",
            "docs/report.pdf",
            "fonts/Inter.ttf",
            "archives/bundle.zip",
            "data/rows.csv",
            "media/audio.mp3",
            "slides.pptx",
            "sheet.xlsx",
            "doc.docx",
            "template.odt",
        ];
        for path in safe {
            assert!(
                reject_executable_extension(path).is_ok(),
                "expected {} to be allowed",
                path
            );
        }
    }
}
