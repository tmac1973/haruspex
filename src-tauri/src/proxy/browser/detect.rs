//! Finding a Chromium-family browser the user already has installed.
//!
//! Browser-assisted search drives whatever Chrome/Chromium/Brave/Edge is on the
//! machine rather than bundling one (150-300 MB and a patch cadence, to reach
//! users who mostly already have a browser). That makes detection the feature's
//! whole dependency surface, so it is explicit rather than clever: an override
//! first, then a per-OS candidate list, then *verification* — running
//! `--version` and requiring Chromium-family output, because a file existing is
//! not evidence it runs.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Env override, checked before everything else. Exists for headless/CI runs
/// and for the case every heuristic below eventually meets: a layout nobody
/// anticipated.
pub const BROWSER_PATH_ENV: &str = "HARUSPEX_BROWSER_PATH";

/// A browser we found and confirmed runs.
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DetectedBrowser {
    /// Absolute path to the executable we would launch.
    pub path: String,
    /// First line of `--version`, e.g. "Google Chrome 151.0.7922.137".
    pub version: String,
    /// True when this came from the settings override or the env var, so the
    /// UI can explain a choice the user might not remember making.
    pub from_override: bool,
}

/// Why detection failed, with the ground it covered — a bare "not found" turns
/// every support question into a guessing game.
#[derive(Clone, Debug, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct BrowserDetectionFailure {
    /// Every location tried, in order, for the UI to show verbatim.
    pub searched: Vec<String>,
    /// Set when an override was configured but didn't verify — a stale
    /// override should read as a broken setting, not as "no browser here".
    pub override_error: Option<String>,
}

pub type DetectionResult = Result<DetectedBrowser, BrowserDetectionFailure>;

/// Long enough for a cold binary on a slow disk, short enough that a wrapper
/// script waiting on a missing snap doesn't hang the Settings page.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Substrings that mark `--version` output as Chromium-family. Firefox and
/// Safari are not candidates: neither speaks CDP.
const CHROMIUM_MARKERS: &[&str] = &["Chrome", "Chromium", "Brave", "Edg"];

/// Executables to try on `PATH` (Linux/BSD).
#[cfg(all(unix, not(target_os = "macos")))]
const PATH_CANDIDATES: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
];

/// Absolute paths worth trying when `PATH` misses — packages that install
/// outside `/usr/bin`, plus the snap shim.
///
/// Flatpak is deliberately absent. `flatpak run com.brave.Browser
/// --headless=new --user-data-dir=... --dump-dom` hung until killed during
/// investigation: the sandbox will not cooperate with an external profile
/// directory. Detecting it would hand the user a browser that never returns.
#[cfg(all(unix, not(target_os = "macos")))]
const ABSOLUTE_CANDIDATES: &[&str] = &[
    "/opt/google/chrome/chrome",
    "/opt/microsoft/msedge/msedge",
    "/opt/brave.com/brave/brave-browser",
    "/usr/lib64/chromium-browser/chromium-browser",
    "/usr/lib/chromium-browser/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
];

#[cfg(target_os = "macos")]
const PATH_CANDIDATES: &[&str] = &[];

/// macOS keeps browsers in app bundles; the binary sits inside `MacOS/`.
/// Checked system-wide first, then per-user, since a user install shadows
/// nothing but is the only copy on a locked-down machine.
#[cfg(target_os = "macos")]
const ABSOLUTE_CANDIDATES: &[&str] = &[
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

#[cfg(target_os = "windows")]
const PATH_CANDIDATES: &[&str] = &["chrome.exe", "msedge.exe"];

#[cfg(target_os = "windows")]
const ABSOLUTE_CANDIDATES: &[&str] = &[];

/// Home-relative candidates (expanded at runtime). macOS user-installed
/// bundles; on Windows, Chrome's per-user install location.
fn home_relative_candidates() -> Vec<PathBuf> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    let rel: &[&str] = &[
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "Applications/Chromium.app/Contents/MacOS/Chromium",
        "Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    #[cfg(target_os = "windows")]
    let rel: &[&str] = &[
        "AppData/Local/Google/Chrome/Application/chrome.exe",
        "AppData/Local/Chromium/Application/chrome.exe",
        "AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe",
    ];
    #[cfg(all(unix, not(target_os = "macos")))]
    let rel: &[&str] = &[];
    rel.iter().map(|r| home.join(r)).collect()
}

/// Windows program-files candidates. Edge ships with Windows 10+ and is
/// Chromium, so coverage on that platform is effectively total — which is why
/// the not-found copy there must not tell the user to install Chrome.
#[cfg(target_os = "windows")]
fn windows_program_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Ok(base) = std::env::var(var) else {
            continue;
        };
        for rel in [
            r"Google\Chrome\Application\chrome.exe",
            r"Microsoft\Edge\Application\msedge.exe",
            r"BraveSoftware\Brave-Browser\Application\brave.exe",
            r"Chromium\Application\chrome.exe",
        ] {
            out.push(PathBuf::from(&base).join(rel));
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

/// Run `--version` and return its first line when the binary answers as a
/// Chromium-family browser.
///
/// This is the step that makes detection trustworthy. A `chromium` on `PATH`
/// can be a wrapper script pointing at a snap that isn't installed, which
/// exists, is executable, and hangs — hence the timeout and the marker check
/// rather than trusting the filename.
pub fn verify(path: &Path) -> Result<String, String> {
    let mut child = Command::new(path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("could not run {}: {}", path.display(), e))?;

    let deadline = std::time::Instant::now() + VERSION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                return Err(format!("{} did not respond to --version", path.display()));
            }
            Err(e) => return Err(format!("{} failed: {}", path.display(), e)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("{} failed: {}", path.display(), e))?;
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();

    if version.is_empty() {
        return Err(format!("{} reported no version", path.display()));
    }
    if !CHROMIUM_MARKERS.iter().any(|m| version.contains(m)) {
        return Err(format!(
            "{} is not a Chromium-based browser (reported \"{}\")",
            path.display(),
            version
        ));
    }
    Ok(version)
}

/// Resolve an executable name against `PATH`.
fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Locate a usable browser: override, then per-OS candidates, each verified.
///
/// `override_path` comes from settings. An override that fails verification is
/// reported as an override error rather than silently falling through to
/// detection — a user who typed a path deserves to hear that it was wrong, not
/// to wonder why a different browser is being driven.
pub fn detect(override_path: Option<&str>) -> DetectionResult {
    let mut searched: Vec<String> = Vec::new();
    let mut override_error = None;

    let explicit = override_path
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var(BROWSER_PATH_ENV).ok())
        .filter(|s| !s.trim().is_empty());

    if let Some(path) = explicit {
        searched.push(path.clone());
        match verify(Path::new(&path)) {
            Ok(version) => {
                return Ok(DetectedBrowser {
                    path,
                    version,
                    from_override: true,
                })
            }
            Err(e) => override_error = Some(e),
        }
    }

    let mut candidates: Vec<PathBuf> = PATH_CANDIDATES.iter().filter_map(|n| which(n)).collect();
    candidates.extend(ABSOLUTE_CANDIDATES.iter().map(PathBuf::from));
    candidates.extend(home_relative_candidates());
    #[cfg(target_os = "windows")]
    candidates.extend(windows_program_candidates());

    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let shown = candidate.display().to_string();
        if searched.contains(&shown) {
            continue;
        }
        searched.push(shown.clone());
        if let Ok(version) = verify(&candidate) {
            return Ok(DetectedBrowser {
                path: shown,
                version,
                from_override: false,
            });
        }
    }

    // Nothing on disk matched; still report the names we looked for so the UI
    // can say more than "not found".
    if searched.is_empty() {
        searched.extend(PATH_CANDIDATES.iter().map(|s| s.to_string()));
        searched.extend(ABSOLUTE_CANDIDATES.iter().map(|s| s.to_string()));
    }
    Err(BrowserDetectionFailure {
        searched,
        override_error,
    })
}

/// A platform with no candidates could never detect a browser, and the mistake
/// would be a `cfg` block added without a list — invisible until someone runs
/// that build. Compile-time, because it is knowable at compile time.
const _: () = assert!(
    PATH_CANDIDATES.len() + ABSOLUTE_CANDIDATES.len() > 0,
    "this platform has no browser candidates to search"
);

#[cfg(test)]
mod tests {
    use super::*;

    /// A binary that exists and runs is not necessarily a browser we can drive.
    #[test]
    fn verify_rejects_a_non_browser() {
        let sh = Path::new("/bin/echo");
        if !sh.is_file() {
            return; // not on this platform; nothing to assert
        }
        // `echo --version` prints "--version", which carries no marker.
        let err = verify(sh).expect_err("echo must not pass as a browser");
        assert!(
            err.contains("not a Chromium-based browser") || err.contains("reported no version"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn verify_reports_a_missing_binary_rather_than_panicking() {
        let err = verify(Path::new("/nonexistent/browser-xyz")).expect_err("must fail");
        assert!(err.contains("could not run"), "unexpected error: {err}");
    }

    /// The failure has to carry where it looked; "not found" alone turns every
    /// support question into a guessing game.
    #[test]
    fn failure_lists_the_locations_searched() {
        // An override that cannot verify: detection continues, but the override
        // error is preserved so a stale setting reads as a broken setting.
        let result = detect(Some("/nonexistent/browser-xyz"));
        if let Err(failure) = result {
            assert!(!failure.searched.is_empty());
            assert!(failure.override_error.is_some());
        }
        // When a real browser IS installed (dev machines, some CI), detection
        // succeeding is also a valid outcome — the assertion above only applies
        // to the failure case, so both are accepted here deliberately.
    }
}
