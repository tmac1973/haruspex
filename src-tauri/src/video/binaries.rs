//! Finding ffmpeg, ffprobe and melt.
//!
//! None of them is bundled. melt comes with Kdenlive (and Shotcut), and so do
//! ffmpeg and ffprobe on macOS and Windows, so the one thing a user installs is
//! Kdenlive. Each binary is looked for in three places, first hit wins:
//!
//! 1. The path the user set in Settings → Video.
//! 2. PATH.
//! 3. Inside a Kdenlive install. On Linux that is the distro's `/usr/bin`,
//!    which PATH already covers; on macOS the app bundle; on Windows Kdenlive's
//!    `bin` folder.
//!
//! A candidate counts only when it answers `-version` in time. A file that
//! exists but does not run (a wrong architecture, a broken symlink) is
//! reported as not found, with a hint, rather than failing on first use.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long `-version` may take. melt loads its plugins first, which takes a
/// moment on a cold cache.
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// One of the three programs the video tools run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Ffmpeg,
    Ffprobe,
    Melt,
}

impl Tool {
    pub const ALL: [Tool; 3] = [Tool::Ffmpeg, Tool::Ffprobe, Tool::Melt];

    pub fn name(self) -> &'static str {
        match self {
            Tool::Ffmpeg => "ffmpeg",
            Tool::Ffprobe => "ffprobe",
            Tool::Melt => "melt",
        }
    }
}

/// The paths set in Settings → Video. Empty means "find it".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct BinaryOverrides {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub melt: String,
}

impl BinaryOverrides {
    fn get(&self, tool: Tool) -> &str {
        match tool {
            Tool::Ffmpeg => &self.ffmpeg,
            Tool::Ffprobe => &self.ffprobe,
            Tool::Melt => &self.melt,
        }
    }
}

/// Where a binary was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum BinarySource {
    /// The path set in Settings → Video.
    Override,
    Path,
    /// Inside a Kdenlive install.
    Kdenlive,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FoundBinary {
    pub path: String,
    /// The first line of its `-version` output.
    pub version: String,
    pub source: BinarySource,
}

/// What Settings → Video shows, and what decides whether the tools are offered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VideoBinariesStatus {
    pub ffmpeg: Option<FoundBinary>,
    pub ffprobe: Option<FoundBinary>,
    pub melt: Option<FoundBinary>,
    /// One line per problem worth telling the user about.
    pub hints: Vec<String>,
}

impl VideoBinariesStatus {
    pub fn get(&self, tool: Tool) -> Option<&FoundBinary> {
        match tool {
            Tool::Ffmpeg => self.ffmpeg.as_ref(),
            Tool::Ffprobe => self.ffprobe.as_ref(),
            Tool::Melt => self.melt.as_ref(),
        }
    }

    /// The path to run, or the error a tool reports when it is missing.
    pub fn require(&self, tool: Tool) -> Result<&str, String> {
        self.get(tool).map(|b| b.path.as_str()).ok_or_else(|| {
            format!(
                "{} was not found. The user can check Settings → Video.",
                tool.name()
            )
        })
    }
}

/// `name` as an executable file name on this platform.
fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Whether `path` is a file this user may run.
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// The first directory in `dirs` holding an executable `name`.
fn which_in(dirs: impl IntoIterator<Item = PathBuf>, name: &str) -> Option<PathBuf> {
    let file = exe_name(name);
    dirs.into_iter()
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable(candidate))
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// Where a Kdenlive install keeps its binaries, beyond PATH.
fn kdenlive_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/Applications/kdenlive.app/Contents/MacOS"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Applications/kdenlive.app/Contents/MacOS"));
        }
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                dirs.push(PathBuf::from(base).join("kdenlive").join("bin"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("kdenlive")
                    .join("bin"),
            );
        }
    }
    dirs
}

/// The first line of `<path> -version`, if it answers in time and succeeds.
async fn version_of(path: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("-version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::no_window(&mut cmd);
    let out = tokio::time::timeout(VERSION_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // melt prints its version on stderr; ffmpeg on stdout.
    let text = if out.stdout.is_empty() {
        out.stderr
    } else {
        out.stdout
    };
    let line = String::from_utf8_lossy(&text)
        .lines()
        .find(|l| !l.trim().is_empty())?
        .trim()
        .to_string();
    Some(line.chars().take(120).collect())
}

/// Candidates for `tool`, in the order they are tried.
fn candidates(tool: Tool, overrides: &BinaryOverrides) -> Vec<(PathBuf, BinarySource)> {
    let mut out = Vec::new();
    let set = overrides.get(tool).trim();
    if !set.is_empty() {
        out.push((PathBuf::from(set), BinarySource::Override));
    }
    if let Some(p) = which_in(path_dirs(), tool.name()) {
        out.push((p, BinarySource::Path));
    }
    if let Some(p) = which_in(kdenlive_dirs(), tool.name()) {
        out.push((p, BinarySource::Kdenlive));
    }
    out
}

async fn find(
    tool: Tool,
    overrides: &BinaryOverrides,
    hints: &mut Vec<String>,
) -> Option<FoundBinary> {
    for (path, source) in candidates(tool, overrides) {
        match version_of(&path).await {
            Some(version) => {
                return Some(FoundBinary {
                    path: path.to_string_lossy().into_owned(),
                    version,
                    source,
                })
            }
            None if source == BinarySource::Override => hints.push(format!(
                "The {} path in Settings → Video does not run: {}",
                tool.name(),
                path.display()
            )),
            None => {}
        }
    }
    None
}

/// Whether Kdenlive is installed as a Flatpak, whose melt can't be run from
/// outside its sandbox.
async fn flatpak_kdenlive() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let mut cmd = tokio::process::Command::new("flatpak");
    cmd.args(["info", "org.kde.kdenlive"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    matches!(
        tokio::time::timeout(VERSION_TIMEOUT, cmd.status()).await,
        Ok(Ok(status)) if status.success()
    )
}

/// Look for all three.
pub async fn resolve(overrides: &BinaryOverrides) -> VideoBinariesStatus {
    let mut status = VideoBinariesStatus::default();
    let mut hints = Vec::new();
    status.ffmpeg = find(Tool::Ffmpeg, overrides, &mut hints).await;
    status.ffprobe = find(Tool::Ffprobe, overrides, &mut hints).await;
    status.melt = find(Tool::Melt, overrides, &mut hints).await;
    let missing: Vec<&str> = Tool::ALL
        .iter()
        .filter(|t| status.get(**t).is_none())
        .map(|t| t.name())
        .collect();
    if !missing.is_empty() {
        if status.melt.is_none() && flatpak_kdenlive().await {
            hints.push(
                "Flatpak Kdenlive's melt can't be used; install the distro package or set a path."
                    .into(),
            );
        }
        hints.push(format!("Not found: {}.", missing.join(", ")));
    }
    status.hints = hints;
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn make_exe(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(exe_name(name));
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    #[test]
    fn which_in_finds_the_first_executable() {
        let a = temp_dir("which_a");
        let b = temp_dir("which_b");
        let in_b = make_exe(&b, "melt", "");
        assert_eq!(
            which_in([a.to_path_buf(), b.to_path_buf()], "melt"),
            Some(in_b)
        );
        assert_eq!(which_in([a.to_path_buf()], "melt"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_without_the_execute_bit_is_not_found() {
        let dir = temp_dir("which_noexec");
        std::fs::write(dir.join("ffmpeg"), "").unwrap();
        assert_eq!(which_in([dir.to_path_buf()], "ffmpeg"), None);
    }

    #[test]
    fn the_override_comes_first() {
        let dir = temp_dir("override_first");
        let set = make_exe(&dir, "my-melt", "");
        let overrides = BinaryOverrides {
            melt: set.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let list = candidates(Tool::Melt, &overrides);
        assert_eq!(list[0], (set, BinarySource::Override));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_is_the_first_line_from_either_stream() {
        let dir = temp_dir("version_line");
        let out = make_exe(
            &dir,
            "ffmpeg",
            "#!/bin/sh\necho 'ffmpeg version 7.1'\necho more\n",
        );
        assert_eq!(
            version_of(&out).await.as_deref(),
            Some("ffmpeg version 7.1")
        );
        let err = make_exe(&dir, "melt", "#!/bin/sh\necho 'melt 7.42.0' >&2\n");
        assert_eq!(version_of(&err).await.as_deref(), Some("melt 7.42.0"));
        let fails = make_exe(&dir, "broken", "#!/bin/sh\nexit 1\n");
        assert_eq!(version_of(&fails).await, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_override_that_does_not_run_is_reported() {
        let dir = temp_dir("override_broken");
        let broken = make_exe(&dir, "melt", "#!/bin/sh\nexit 3\n");
        let overrides = BinaryOverrides {
            melt: broken.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let mut hints = Vec::new();
        let found = find(Tool::Melt, &overrides, &mut hints).await;
        // A melt on PATH may still be found after it; the hint is what matters.
        assert!(found.is_none_or(|f| f.source != BinarySource::Override));
        assert!(hints[0].contains("does not run"), "{hints:?}");
    }

    #[test]
    fn require_names_the_settings_path() {
        let status = VideoBinariesStatus::default();
        let err = status.require(Tool::Melt).unwrap_err();
        assert!(err.contains("melt") && err.contains("Settings → Video"));
    }
}
