//! A slide deck rendered to PDF by LibreOffice, so the model can look at what
//! `fs_write_slides` wrote. LibreOffice is the user's, not bundled: without
//! it there is no preview, and the deck is written all the same.

use super::path::{resolve_in_workdir, workdir_path};
use crate::video::binaries::{path_dirs, which_any};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The first conversion creates LibreOffice's profile, which takes a while.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(90);

/// The error when LibreOffice can't be found. The frontend treats it as "no
/// preview", not as a failure worth telling anyone about.
pub const NO_LIBREOFFICE: &str = "LibreOffice is not installed.";

/// Two conversions sharing a profile fight over its lock, so they take turns.
static CONVERTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Where LibreOffice installs itself when it isn't on PATH.
fn install_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![PathBuf::from(
            "/Applications/LibreOffice.app/Contents/MacOS",
        )]
    }
    #[cfg(windows)]
    {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|dir| PathBuf::from(dir).join("LibreOffice").join("program"))
            .collect()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        vec![
            PathBuf::from("/usr/lib/libreoffice/program"),
            PathBuf::from("/opt/libreoffice/program"),
        ]
    }
}

/// LibreOffice's command-line program, if it is installed.
pub fn find_soffice() -> Option<PathBuf> {
    which_any(&path_dirs(), &["soffice", "libreoffice"])
        .or_else(|| which_any(&install_dirs(), &["soffice"]))
}

/// Only a deck: this runs a program on the file, so it takes no other kind.
fn check_deck_path(rel_path: &str) -> Result<(), String> {
    let lower = rel_path.to_ascii_lowercase();
    if lower.ends_with(".pptx") || lower.ends_with(".odp") {
        Ok(())
    } else {
        Err(format!("{rel_path} is not a .pptx or .odp deck."))
    }
}

/// Convert `deck` to PDF in `out_dir` with `soffice`, using `profile` as
/// LibreOffice's settings folder (its own, so a copy the user has open
/// doesn't block it), and read the PDF back.
async fn convert(
    soffice: &Path,
    deck: &Path,
    out_dir: &Path,
    profile: &Path,
) -> Result<Vec<u8>, String> {
    let profile_url = url::Url::from_directory_path(profile)
        .map_err(|_| format!("{} is not an absolute path", profile.display()))?;
    let mut cmd = tokio::process::Command::new(soffice);
    cmd.arg(format!("-env:UserInstallation={profile_url}"))
        .args([
            "--headless",
            "--norestore",
            "--nolockcheck",
            "--convert-to",
            "pdf",
            "--outdir",
        ])
        .arg(out_dir)
        .arg(deck)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::video::prepare_child(&mut cmd);
    let out = tokio::time::timeout(CONVERT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "LibreOffice took too long to render the deck.".to_string())?
        .map_err(|e| format!("Could not run LibreOffice: {e}"))?;
    let stem = deck.file_stem().unwrap_or_default();
    let pdf = out_dir.join(stem).with_extension("pdf");
    tokio::fs::read(&pdf).await.map_err(|_| {
        let stderr = String::from_utf8_lossy(&out.stderr);
        format!("LibreOffice did not render the deck: {}", stderr.trim())
    })
}

/// Render a deck in the working directory to PDF with LibreOffice, for the
/// preview `fs_write_slides` shows the model. Errors with [`NO_LIBREOFFICE`]
/// when it isn't installed.
#[tauri::command]
pub async fn slides_preview_pdf(
    app: AppHandle,
    workdir: String,
    rel_path: String,
) -> Result<tauri::ipc::Response, String> {
    check_deck_path(&rel_path)?;
    let workdir = workdir_path(&workdir)?;
    let deck = resolve_in_workdir(&workdir, &rel_path)?;
    if !deck.is_file() {
        return Err(format!("Not a file: {rel_path}"));
    }
    let soffice = find_soffice().ok_or(NO_LIBREOFFICE)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve the cache dir: {e}"))?;
    let profile = cache.join("libreoffice-profile");
    let out_dir = ScratchDir::new(cache.join(format!("slides-preview-{}", uuid::Uuid::new_v4())))?;
    let _turn = CONVERTING.lock().await;
    let pdf = convert(&soffice, &deck, &out_dir.0, &profile).await?;
    Ok(tauri::ipc::Response::new(pdf))
}

/// A folder for one conversion's output, removed when it goes out of scope.
struct ScratchDir(PathBuf);

impl ScratchDir {
    fn new(path: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("Failed to make a folder for the preview: {e}"))?;
        Ok(Self(path))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn only_a_deck_is_rendered() {
        assert!(check_deck_path("talk.pptx").is_ok());
        assert!(check_deck_path("Talk.ODP").is_ok());
        assert!(check_deck_path("notes.txt")
            .unwrap_err()
            .contains("not a .pptx"));
        assert!(check_deck_path("talk.pptx.sh").is_err());
    }

    /// Renders a real deck when LibreOffice is installed; passes quietly when
    /// it isn't, since CI has none.
    #[tokio::test]
    async fn renders_a_deck_to_pdf_when_libreoffice_is_installed() {
        let Some(soffice) = find_soffice() else {
            return;
        };
        let dir = temp_dir("slides_preview");
        let deck = dir.join("deck.odp");
        let slides: Vec<super::super::slides::Slide> =
            serde_json::from_str(r#"[{"title":"Hello"},{"title":"Two","bullets":["a"]}]"#).unwrap();
        let bytes = super::super::odp::build_odp(
            &slides,
            &Default::default(),
            super::super::slides::SlideOrientation::Landscape,
        )
        .unwrap();
        std::fs::write(&deck, bytes).unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let pdf = convert(&soffice, &deck, &out, &dir.join("profile"))
            .await
            .unwrap();
        assert!(pdf.starts_with(b"%PDF"));
    }
}
