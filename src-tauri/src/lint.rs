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

/// Diagnostic returned by the sandbox lint pass — a flattened view of the
/// fields ruff emits in `--output-format=json` that the frontend cares about.
/// Coordinates are 1-based (ruff's convention).
#[derive(serde::Serialize, Debug)]
pub struct LintDiagnostic {
    pub code: String,
    pub message: String,
    pub line: u32,
    pub column: u32,
    #[serde(rename = "endLine")]
    pub end_line: u32,
    #[serde(rename = "endColumn")]
    pub end_column: u32,
    pub url: Option<String>,
}

/// Rule selection for the sandbox pre-run lint. Because a hit here *blocks*
/// execution, this is deliberately limited to bugs Python would surface only
/// late (after side effects) or never:
///   - F82  undefined names — Python raises NameError only when the line runs,
///          possibly after a fetch/write already happened.
///   - F63  comparison bugs (`is` with a literal, assert on a tuple) — run fine
///          and silently misbehave.
///   - B006 mutable default argument — runs fine, latent bug.
/// Syntax errors (E9/F7) are intentionally NOT included: Pyodide's compile step
/// rejects them before execution with a clear traceback and no side effects, so
/// blocking on them only duplicates what Python already reports. Style/format
/// nits (e.g. F541 f-string-without-placeholders) are excluded outright — they
/// reject runnable code and trap small models in a fix-resubmit loop.
/// Kept in lock-step with the `args` validator in capabilities/default.json.
const SANDBOX_LINT_SELECT: &str = "F63,F82,B006";

fn temp_python_path() -> PathBuf {
    let suffix = format!(
        "{:x}-{:x}",
        std::process::id(),
        crate::time_util::now_nanos()
    );
    std::env::temp_dir().join(format!("haruspex_ruff_{}.py", suffix))
}

/// Parse a `[{...}, ...]` ruff JSON payload into our flattened diagnostic
/// shape. Split out from `lint_python_source` so we can unit-test the
/// null-code → E999 mapping without spawning the sidecar.
fn parse_ruff_diagnostics(raw: &[u8]) -> Vec<LintDiagnostic> {
    let json: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match json.as_array() {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let raw_code = item.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let code = if raw_code.is_empty() {
            "E999".to_string()
        } else {
            raw_code.to_string()
        };
        let message = item
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let location_row = item
            .get("location")
            .and_then(|v| v.get("row"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let location_col = item
            .get("location")
            .and_then(|v| v.get("column"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let end_row = item
            .get("end_location")
            .and_then(|v| v.get("row"))
            .and_then(|v| v.as_u64())
            .unwrap_or(location_row as u64) as u32;
        let end_col = item
            .get("end_location")
            .and_then(|v| v.get("column"))
            .and_then(|v| v.as_u64())
            .unwrap_or(location_col as u64) as u32;
        let url = item
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        out.push(LintDiagnostic {
            code,
            message,
            line: location_row,
            column: location_col,
            end_line: end_row,
            end_column: end_col,
            url,
        });
    }
    out
}

/// Lint a snippet of Python source about to be executed in the sandbox.
/// `builtins` is the list of names already defined in the chat's persistent
/// Pyodide namespace — passed through to ruff as `--config builtins=[...]`
/// so F821 (undefined-name) doesn't false-positive on a `df.head()` follow-up
/// to a prior `df = pd.read_csv(...)`.
///
/// Returns the parsed diagnostics. On any failure (sidecar missing, ruff
/// crashed, JSON parse failed, tempfile write failed) returns an empty list —
/// lint is advisory and must never block a run.
#[tauri::command]
pub async fn lint_python_source(
    app: tauri::AppHandle,
    code: String,
    builtins: Vec<String>,
) -> Result<Vec<LintDiagnostic>, String> {
    let tmp = temp_python_path();
    if let Err(e) = tokio::fs::write(&tmp, code.as_bytes()).await {
        log::debug!("lint_python_source: tempfile write failed: {}", e);
        return Ok(Vec::new());
    }

    let sidecar = match app.shell().sidecar("ruff") {
        Ok(cmd) => cmd,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            log::debug!("ruff sidecar unavailable: {}", e);
            return Ok(Vec::new());
        }
    };

    let builtins_json = serde_json::to_string(&builtins).unwrap_or_else(|_| "[]".to_string());
    let config_arg = format!("builtins={}", builtins_json);

    let output = sidecar
        .args([
            "check",
            "--output-format=json",
            "--exit-zero",
            "--isolated",
            &format!("--select={}", SANDBOX_LINT_SELECT),
            "--config",
            &config_arg,
            tmp.to_string_lossy().as_ref(),
        ])
        .output()
        .await;

    let _ = tokio::fs::remove_file(&tmp).await;

    let raw = match output {
        Ok(out) => out.stdout,
        Err(e) => {
            log::debug!("ruff invocation failed: {}", e);
            return Ok(Vec::new());
        }
    };

    Ok(parse_ruff_diagnostics(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_null_code_syntax_error_to_e999() {
        // Real ruff output for `def hello\n    print("Hello World")` — the
        // failure mode in the field log: ruff emits parser-level diagnostics
        // with `code: null` and the earlier filter was dropping them, so the
        // run went all the way to Pyodide before failing.
        let raw = br#"[
            {
                "cell": null,
                "code": null,
                "end_location": {"column": 1, "row": 2},
                "filename": "/tmp/x.py",
                "fix": null,
                "location": {"column": 10, "row": 1},
                "message": "SyntaxError: Expected '(', found newline",
                "noqa_row": null,
                "url": null
            }
        ]"#;
        let diags = parse_ruff_diagnostics(raw);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, "E999");
        assert_eq!(diags[0].line, 1);
        assert_eq!(diags[0].column, 10);
        assert!(diags[0].message.starts_with("SyntaxError"));
        assert!(diags[0].url.is_none());
    }

    #[test]
    fn preserves_rule_codes_for_normal_diagnostics() {
        let raw = br#"[
            {
                "code": "F821",
                "message": "Undefined name `df_cleand`",
                "location": {"row": 4, "column": 7},
                "end_location": {"row": 4, "column": 16},
                "url": "https://docs.astral.sh/ruff/rules/undefined-name"
            }
        ]"#;
        let diags = parse_ruff_diagnostics(raw);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, "F821");
        assert_eq!(
            diags[0].url.as_deref(),
            Some("https://docs.astral.sh/ruff/rules/undefined-name")
        );
    }

    #[test]
    fn empty_array_returns_empty() {
        let diags = parse_ruff_diagnostics(b"[]");
        assert!(diags.is_empty());
    }

    #[test]
    fn malformed_json_returns_empty() {
        let diags = parse_ruff_diagnostics(b"not json");
        assert!(diags.is_empty());
    }
}
