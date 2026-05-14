use std::path::PathBuf;
use tauri_plugin_shell::ShellExt;

use crate::fs_tools::resolve_in_workdir;

fn workdir_path(workdir: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(workdir);
    if !path.is_dir() {
        return Err(format!("Working directory does not exist: {}", workdir));
    }
    Ok(path)
}

/// Run ruff against a single file inside `workdir` and return its raw JSON
/// output (`[{"code":"F821", "message":"...", "location":{"row":..,"column":..}}, ...]`).
/// Limited to syntax errors (E9*) and pyflakes (F*) so style noise doesn't
/// drown the signal. Returns an empty array string `"[]"` if ruff is missing,
/// crashes, or produces non-UTF-8 output — diagnostics are best-effort and
/// must never block a successful write.
#[tauri::command]
pub async fn fs_lint_python(
    app: tauri::AppHandle,
    workdir: String,
    rel_path: String,
) -> Result<String, String> {
    let workdir = workdir_path(&workdir)?;
    let abs = resolve_in_workdir(&workdir, &rel_path)?;

    let sidecar = match app.shell().sidecar("ruff") {
        Ok(cmd) => cmd,
        Err(e) => {
            log::debug!("ruff sidecar unavailable: {}", e);
            return Ok("[]".to_string());
        }
    };

    let output = sidecar
        .args([
            "check",
            "--output-format=json",
            "--exit-zero",
            "--isolated",
            "--select=E9,F",
            abs.to_string_lossy().as_ref(),
        ])
        .output()
        .await;

    match output {
        Ok(out) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        Err(e) => {
            log::debug!("ruff invocation failed: {}", e);
            Ok("[]".to_string())
        }
    }
}
