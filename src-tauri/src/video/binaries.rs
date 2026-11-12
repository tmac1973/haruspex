//! Finding ffmpeg, ffprobe and melt.
//!
//! ffmpeg and ffprobe ship with the app as LGPL builds (`haruspex-ffmpeg`,
//! `haruspex-ffprobe`), which the cameras need too. melt is not bundled: it
//! comes with Kdenlive (and Shotcut), so the one thing a user installs for the
//! video tools is Kdenlive. Each binary is looked for in these places, first
//! hit wins:
//!
//! 1. The path the user set in Settings → Video editing.
//! 2. The bundled copy (ffmpeg and ffprobe only), found as the other sidecars
//!    are: see `runtimes::resolve_binary`.
//! 3. PATH.
//! 4. Inside a Kdenlive install. On Linux that is the distro's `/usr/bin`,
//!    which PATH already covers; on macOS the app bundle; on Windows Kdenlive's
//!    `bin` folder.
//!
//! A candidate counts only when it answers `-version` in time. A file that
//! exists but does not run (a wrong architecture, a broken symlink) is
//! reported as not found, with a hint, rather than failing on first use.

use crate::runtimes::exe_name;
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

    /// The file names it goes by, in order of preference. Fedora installs melt
    /// only as `melt-7`, with a `mlt-melt` link to it.
    fn file_names(self) -> &'static [&'static str] {
        match self {
            Tool::Ffmpeg => &["ffmpeg"],
            Tool::Ffprobe => &["ffprobe"],
            Tool::Melt => &["melt", "mlt-melt", "melt-7"],
        }
    }
}

/// The paths set in Settings → Video editing. Empty means "find it".
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
    /// The path set in Settings → Video editing.
    Override,
    /// The copy that ships with Haruspex.
    Bundled,
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

/// What Settings → Video editing shows, and what decides whether the tools are offered.
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
                "{} was not found. The user can check Settings → Video editing.",
                tool.name()
            )
        })
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

/// The first of `names` found in `dirs`. Every directory is searched for one
/// name before the next name is tried.
pub(crate) fn which_any(dirs: &[PathBuf], names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .find_map(|name| which_in(dirs.iter().cloned(), name))
}

pub(crate) fn path_dirs() -> Vec<PathBuf> {
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
    super::prepare_child(&mut cmd);
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

/// The copy of `tool` that ships with the app. melt is not bundled.
fn bundled(tool: Tool) -> Option<PathBuf> {
    match tool {
        Tool::Ffmpeg | Tool::Ffprobe => crate::runtimes::resolve_binary(tool.name()).ok(),
        Tool::Melt => None,
    }
}

/// Candidates for `tool`, in the order they are tried.
fn candidates(tool: Tool, overrides: &BinaryOverrides) -> Vec<(PathBuf, BinarySource)> {
    candidates_with(tool, overrides, bundled(tool))
}

/// [`candidates`] with the bundled copy given, so tests can place one.
fn candidates_with(
    tool: Tool,
    overrides: &BinaryOverrides,
    bundled: Option<PathBuf>,
) -> Vec<(PathBuf, BinarySource)> {
    let mut out = Vec::new();
    let set = overrides.get(tool).trim();
    if !set.is_empty() {
        out.push((PathBuf::from(set), BinarySource::Override));
    }
    if let Some(p) = bundled {
        out.push((p, BinarySource::Bundled));
    }
    if let Some(p) = which_any(&path_dirs(), tool.file_names()) {
        out.push((p, BinarySource::Path));
    }
    if let Some(p) = which_any(&kdenlive_dirs(), tool.file_names()) {
        out.push((p, BinarySource::Kdenlive));
    }
    out
}

async fn find(
    tool: Tool,
    overrides: &BinaryOverrides,
    hints: &mut Vec<String>,
) -> Option<FoundBinary> {
    first_that_runs(tool, candidates(tool, overrides), hints).await
}

/// The first of `list` that answers `-version`. A bundled copy that doesn't
/// (a placeholder in a dev checkout, a wrong architecture) is passed over
/// quietly for PATH; only a broken override earns a hint.
async fn first_that_runs(
    tool: Tool,
    list: Vec<(PathBuf, BinarySource)>,
    hints: &mut Vec<String>,
) -> Option<FoundBinary> {
    for (path, source) in list {
        match version_of(&path).await {
            Some(version) => {
                return Some(FoundBinary {
                    path: path.to_string_lossy().into_owned(),
                    version,
                    source,
                })
            }
            None if source == BinarySource::Override => hints.push(format!(
                "The {} path in Settings → Video editing does not run: {}",
                tool.name(),
                path.display()
            )),
            None => {}
        }
    }
    None
}

/// An ffmpeg to ask which hardware encoders melt can open: the first that
/// runs, passing over the bundled one. Our LGPL build has no hardware
/// encoders, so it would turn every one down; an ffmpeg from the system or
/// Kdenlive is built like melt's own.
pub async fn hardware_probe_ffmpeg(overrides: &BinaryOverrides) -> Option<String> {
    let list = candidates(Tool::Ffmpeg, overrides)
        .into_iter()
        .filter(|(_, source)| *source != BinarySource::Bundled)
        .collect();
    first_that_runs(Tool::Ffmpeg, list, &mut Vec::new())
        .await
        .map(|found| found.path)
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
    super::prepare_child(&mut cmd);
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

    /// On Unix the script is put in place by `install`, a child process, so
    /// this process never holds a write fd on it. Writing it here would race
    /// the other tests' spawns: a child forked while the fd is open keeps a
    /// copy until it execs, and running the script then fails with ETXTBSY.
    fn make_exe(dir: &Path, name: &str, script: &str) -> PathBuf {
        let path = dir.join(exe_name(name));
        #[cfg(unix)]
        {
            let src = dir.join(format!(".{name}.src"));
            std::fs::write(&src, script).unwrap();
            let status = std::process::Command::new("install")
                .args(["-m", "755"])
                .arg(&src)
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success(), "install {}", path.display());
            std::fs::remove_file(&src).unwrap();
        }
        #[cfg(not(unix))]
        std::fs::write(&path, script).unwrap();
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

    #[test]
    fn melt_is_found_under_fedoras_names() {
        let a = temp_dir("which_any_a");
        let b = temp_dir("which_any_b");
        let dirs = [a.to_path_buf(), b.to_path_buf()];
        let names = Tool::Melt.file_names();
        let versioned = make_exe(&a, "melt-7", "");
        assert_eq!(which_any(&dirs, names), Some(versioned));
        let link = make_exe(&b, "mlt-melt", "");
        assert_eq!(which_any(&dirs, names), Some(link));
        // A plain melt anywhere wins over the other names.
        let plain = make_exe(&b, "melt", "");
        assert_eq!(which_any(&dirs, names), Some(plain));
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

    #[test]
    fn the_bundled_copy_comes_after_the_override_and_before_path() {
        let dir = temp_dir("bundled_order");
        let set = make_exe(&dir, "my-ffmpeg", "");
        let ours = make_exe(&dir, "haruspex-ffmpeg", "");
        let overrides = BinaryOverrides {
            ffmpeg: set.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let list = candidates_with(Tool::Ffmpeg, &overrides, Some(ours.clone()));
        assert_eq!(list[0], (set, BinarySource::Override));
        assert_eq!(list[1], (ours, BinarySource::Bundled));
        let sources: Vec<_> = list.iter().map(|(_, s)| *s).collect();
        let after: Vec<_> = sources[2..].to_vec();
        assert!(
            after
                .iter()
                .all(|s| matches!(s, BinarySource::Path | BinarySource::Kdenlive)),
            "{sources:?}"
        );
        // PATH, when there is one, is tried before Kdenlive.
        let first_kdenlive = after.iter().position(|s| *s == BinarySource::Kdenlive);
        let last_path = after.iter().rposition(|s| *s == BinarySource::Path);
        if let (Some(k), Some(p)) = (first_kdenlive, last_path) {
            assert!(p < k, "{sources:?}");
        }
    }

    #[test]
    fn melt_is_never_bundled() {
        assert_eq!(bundled(Tool::Melt), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_bundled_copy_that_does_not_run_is_skipped() {
        let dir = temp_dir("bundled_broken");
        let broken = make_exe(&dir, "haruspex-ffmpeg", "#!/bin/sh\nexit 1\n");
        let fallback = make_exe(&dir, "ffmpeg", "#!/bin/sh\necho 'ffmpeg version 8.1'\n");
        let list = vec![
            (broken, BinarySource::Bundled),
            (fallback.clone(), BinarySource::Path),
        ];
        let mut hints = Vec::new();
        let found = first_that_runs(Tool::Ffmpeg, list, &mut hints)
            .await
            .expect("PATH copy should be found");
        assert_eq!(found.source, BinarySource::Path);
        assert_eq!(found.path, fallback.to_string_lossy());
        assert!(hints.is_empty(), "{hints:?}");
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

    /// The real lookup on this machine: with Kdenlive installed and nothing on
    /// PATH, all three come from the Kdenlive install, bar a bundled ffmpeg or
    /// ffprobe that runs.
    /// `PATH=/usr/bin:/bin cargo test -- --ignored finds_kdenlives_own --nocapture`
    #[tokio::test]
    #[ignore = "needs Kdenlive installed"]
    async fn finds_kdenlives_own() {
        let status = resolve(&BinaryOverrides::default()).await;
        println!("{status:#?}");
        for tool in Tool::ALL {
            let found = status
                .get(tool)
                .unwrap_or_else(|| panic!("{} not found", tool.name()));
            assert!(
                found.source == BinarySource::Kdenlive
                    || (tool != Tool::Melt && found.source == BinarySource::Bundled),
                "{}: {:?}",
                tool.name(),
                found.source
            );
        }
    }

    #[test]
    fn require_names_the_settings_path() {
        let status = VideoBinariesStatus::default();
        let err = status.require(Tool::Melt).unwrap_err();
        assert!(err.contains("melt") && err.contains("Settings → Video editing"));
    }
}
