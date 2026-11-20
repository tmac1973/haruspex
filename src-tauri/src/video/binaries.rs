//! Finding ffmpeg, ffprobe and melt.
//!
//! All three ship with the app (`haruspex-ffmpeg`, `haruspex-ffprobe`,
//! `haruspex-melt`, the media bundle), so nothing needs installing for the
//! video tools; the cameras use ffmpeg too. Each is looked for in these
//! places, first hit wins, as its choice in Settings → Video editing allows
//! (ffmpeg's covers ffprobe):
//!
//! 1. The path the user set (Custom only).
//! 2. The bundled copy (Auto and Bundled), found as the other sidecars are:
//!    see `runtimes::resolve_binary`.
//! 3. PATH (Auto and System).
//! 4. Inside a Shotcut or Kdenlive install (Auto and System). On Linux that is
//!    the distro's `/usr/bin` and Shotcut's tarball in `/opt/shotcut`; on
//!    macOS the app bundles; on Windows their install folders.
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

/// The choices in Settings → Video editing: which ffmpeg (and ffprobe with
/// it) and which melt, and the paths set for Custom.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct BinaryOverrides {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub melt: String,
    pub ffmpeg_choice: ToolChoice,
    pub melt_choice: ToolChoice,
}

/// Which copy of a tool to use: ffmpeg (with ffprobe), or melt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ToolChoice {
    /// The bundled one, then the system's (PATH), then an editor's.
    #[default]
    Auto,
    /// Only the one that ships with Haruspex.
    Bundled,
    /// The system's (PATH), then an editor's; never the bundled one.
    System,
    /// The paths set in Settings → Video editing, and nothing else.
    Custom,
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
    /// Inside a Shotcut or Kdenlive install.
    Editor,
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
        self.get(tool)
            .map(|b| b.path.as_str())
            .ok_or_else(|| not_found(tool))
    }
}

/// The error a tool reports when `tool` is missing.
fn not_found(tool: Tool) -> String {
    format!(
        "{} was not found. The user can check Settings → Video editing.",
        tool.name()
    )
}

/// Whether `path` is a file this user may run.
fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
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

/// Where Shotcut and Kdenlive installs keep their binaries, beyond PATH.
/// Flatpak and Snap installs aren't here: their melt only runs inside the
/// sandbox, and the bundled melt covers those users.
fn editor_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        // Shotcut's portable tarball.
        dirs.push(PathBuf::from("/opt/shotcut/Shotcut.app/bin"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Shotcut/Shotcut.app/bin"));
        }
    }
    if cfg!(target_os = "macos") {
        for app in ["Shotcut.app", "kdenlive.app"] {
            dirs.push(
                PathBuf::from("/Applications")
                    .join(app)
                    .join("Contents/MacOS"),
            );
            if let Some(home) = std::env::var_os("HOME") {
                dirs.push(
                    PathBuf::from(home)
                        .join("Applications")
                        .join(app)
                        .join("Contents/MacOS"),
                );
            }
        }
    }
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                dirs.push(PathBuf::from(&base).join("Shotcut"));
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

/// The copy of `tool` that ships with the app.
fn bundled(tool: Tool) -> Option<PathBuf> {
    crate::runtimes::resolve_binary(tool.name()).ok()
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
    let choice = match tool {
        Tool::Melt => overrides.melt_choice,
        Tool::Ffmpeg | Tool::Ffprobe => overrides.ffmpeg_choice,
    };
    let mut out = Vec::new();
    if choice == ToolChoice::Custom {
        let set = overrides.get(tool).trim();
        if !set.is_empty() {
            out.push((PathBuf::from(set), BinarySource::Override));
        }
        return out;
    }
    if matches!(choice, ToolChoice::Auto | ToolChoice::Bundled) {
        if let Some(p) = bundled {
            out.push((p, BinarySource::Bundled));
        }
    }
    if choice == ToolChoice::Bundled {
        return out;
    }
    if let Some(p) = which_any(&path_dirs(), tool.file_names()) {
        out.push((p, BinarySource::Path));
    }
    if let Some(p) = which_any(&editor_dirs(), tool.file_names()) {
        out.push((p, BinarySource::Editor));
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

/// An ffmpeg to ask which hardware encoders melt can open: the one chosen in
/// Settings → Video editing. The bundled build has the hardware encoders melt
/// is tried with (see `scripts/build-media.sh`).
pub async fn hardware_probe_ffmpeg(overrides: &BinaryOverrides) -> Option<String> {
    first_that_runs(
        Tool::Ffmpeg,
        candidates(Tool::Ffmpeg, overrides),
        &mut Vec::new(),
    )
    .await
    .map(|found| found.path)
}

/// One tool's path, found the same way as [`resolve`] without looking for the
/// others. The cameras need ffmpeg and ffprobe, not melt.
pub async fn resolve_tool(tool: Tool, overrides: &BinaryOverrides) -> Result<String, String> {
    let found = find(tool, overrides, &mut Vec::new()).await;
    found.map(|f| f.path).ok_or_else(|| not_found(tool))
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
            melt_choice: ToolChoice::Custom,
            ..Default::default()
        };
        let list = candidates(Tool::Melt, &overrides);
        assert_eq!(list, vec![(set, BinarySource::Override)]);
    }

    #[test]
    fn automatic_tries_the_bundled_copy_before_path_and_ignores_a_path_set() {
        let dir = temp_dir("bundled_order");
        let set = make_exe(&dir, "my-ffmpeg", "");
        let ours = make_exe(&dir, "haruspex-ffmpeg", "");
        let overrides = BinaryOverrides {
            ffmpeg: set.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let list = candidates_with(Tool::Ffmpeg, &overrides, Some(ours.clone()));
        assert_eq!(list[0], (ours, BinarySource::Bundled));
        let sources: Vec<_> = list.iter().map(|(_, s)| *s).collect();
        let after: Vec<_> = sources[1..].to_vec();
        assert!(
            after
                .iter()
                .all(|s| matches!(s, BinarySource::Path | BinarySource::Editor)),
            "{sources:?}"
        );
        // PATH, when there is one, is tried before Kdenlive.
        let first_kdenlive = after.iter().position(|s| *s == BinarySource::Editor);
        let last_path = after.iter().rposition(|s| *s == BinarySource::Path);
        if let (Some(k), Some(p)) = (first_kdenlive, last_path) {
            assert!(p < k, "{sources:?}");
        }
    }

    #[test]
    fn each_melt_choice_keeps_to_its_own_copies() {
        let dir = temp_dir("melt_choice");
        let set = make_exe(&dir, "my-melt", "");
        let ours = make_exe(&dir, "haruspex-melt", "");
        let sources = |choice| -> Vec<BinarySource> {
            let o = BinaryOverrides {
                melt: set.to_string_lossy().into_owned(),
                melt_choice: choice,
                ..Default::default()
            };
            candidates_with(Tool::Melt, &o, Some(ours.clone()))
                .into_iter()
                .map(|(_, s)| s)
                .collect()
        };
        assert_eq!(sources(ToolChoice::Auto)[0], BinarySource::Bundled);
        assert!(!sources(ToolChoice::Auto).contains(&BinarySource::Override));
        assert_eq!(sources(ToolChoice::Bundled), vec![BinarySource::Bundled]);
        assert!(!sources(ToolChoice::System).contains(&BinarySource::Bundled));
        assert_eq!(sources(ToolChoice::Custom), vec![BinarySource::Override]);
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

    #[test]
    fn each_ffmpeg_choice_keeps_to_its_own_copies() {
        let dir = temp_dir("ffmpeg_choice");
        let set = make_exe(&dir, "my-ffmpeg", "");
        let ours = make_exe(&dir, "haruspex-ffmpeg", "");
        let with = |choice| BinaryOverrides {
            ffmpeg: set.to_string_lossy().into_owned(),
            ffmpeg_choice: choice,
            ..Default::default()
        };
        let sources = |choice| -> Vec<BinarySource> {
            candidates_with(Tool::Ffmpeg, &with(choice), Some(ours.clone()))
                .into_iter()
                .map(|(_, s)| s)
                .collect()
        };
        assert_eq!(sources(ToolChoice::Custom), vec![BinarySource::Override]);
        assert_eq!(sources(ToolChoice::Bundled), vec![BinarySource::Bundled]);
        assert!(sources(ToolChoice::System)
            .iter()
            .all(|s| matches!(s, BinarySource::Path | BinarySource::Editor)));
        // melt keeps its own choice whatever ffmpeg's is.
        let melt = BinaryOverrides {
            melt: set.to_string_lossy().into_owned(),
            ffmpeg_choice: ToolChoice::Bundled,
            melt_choice: ToolChoice::Custom,
            ..Default::default()
        };
        assert_eq!(candidates(Tool::Melt, &melt)[0].1, BinarySource::Override);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_override_that_does_not_run_is_reported() {
        let dir = temp_dir("override_broken");
        let broken = make_exe(&dir, "melt", "#!/bin/sh\nexit 3\n");
        let overrides = BinaryOverrides {
            melt: broken.to_string_lossy().into_owned(),
            melt_choice: ToolChoice::Custom,
            ..Default::default()
        };
        let mut hints = Vec::new();
        let found = find(Tool::Melt, &overrides, &mut hints).await;
        // A melt on PATH may still be found after it; the hint is what matters.
        assert!(found.is_none_or(|f| f.source != BinarySource::Override));
        assert!(hints[0].contains("does not run"), "{hints:?}");
    }

    /// The real lookup on this machine: with Kdenlive installed and nothing on
    /// PATH, all three come from the Kdenlive install, bar a bundled one that
    /// runs.
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
                found.source == BinarySource::Editor || found.source == BinarySource::Bundled,
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
