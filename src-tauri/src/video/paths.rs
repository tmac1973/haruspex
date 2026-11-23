//! Which files the video tools may touch.
//!
//! The conversation's working folder is the boundary. It is usually a series
//! folder with one subfolder per episode (`videos/ep010/raw/…`, the intro in
//! `videos/intro001/`), but picking one episode folder directly works too: an
//! empty `episode` then means the working folder itself.
//!
//! Reads may also reach the intro and outro set in Settings → Video editing, which may
//! live anywhere, and nothing else outside. Writes stay inside the working
//! folder, always through `resolve_episode` or `resolve_in_working`.

use crate::fs_tools::path::strip_verbatim;
use crate::fs_tools::resolve_in_workdir;
use std::path::{Path, PathBuf};

/// A checked path as other programs can open it. Canonicalising gives a
/// `\\?\C:\…` path on Windows, which melt can't load and ffmpeg won't always
/// take; every path these return goes to one of them sooner or later.
fn plain(path: PathBuf) -> PathBuf {
    strip_verbatim(&path)
}

/// The episode folder `episode` names, inside `working_dir`. It must exist.
pub fn resolve_episode(working_dir: &str, episode: &str) -> Result<PathBuf, String> {
    let episode = episode.trim().trim_matches(['/', '\\']);
    let dir = plain(resolve_in_workdir(Path::new(working_dir), episode)?);
    if !dir.is_dir() {
        return Err(format!("No folder named {episode} in the working folder."));
    }
    Ok(dir)
}

/// Any path inside `working_dir`, existing or not (for a file about to be
/// written).
pub fn resolve_in_working(working_dir: &str, path: &str) -> Result<PathBuf, String> {
    resolve_in_workdir(Path::new(working_dir), path.trim()).map(plain)
}

/// A media file to read: inside `working_dir`, or exactly the intro or outro
/// set in Settings → Video editing.
pub fn resolve_media(
    working_dir: &str,
    path: &str,
    intro: &str,
    outro: &str,
) -> Result<PathBuf, String> {
    let wanted = path.trim();
    for setting in [intro, outro] {
        let setting = setting.trim();
        if !setting.is_empty() && same_file(Path::new(wanted), Path::new(setting)) {
            return Ok(plain(PathBuf::from(setting)));
        }
    }
    let resolved = resolve_in_working(working_dir, wanted)?;
    if !resolved.is_file() {
        return Err(format!("{wanted} is not a file in the working folder."));
    }
    Ok(resolved)
}

/// Where stills taken from clips go by default: `<episode>/.haruspex/stills/`.
pub fn stills_dir(episode: &Path) -> PathBuf {
    episode.join(".haruspex").join("stills")
}

/// A still's file: `out` when given (a `.png` inside the episode folder), else
/// `<stills_dir>/<default_name>`. Its folder is made.
pub fn still_target(
    working_dir: &str,
    episode_dir: &Path,
    out: Option<&str>,
    default_name: &str,
) -> Result<PathBuf, String> {
    let target = match out.map(str::trim).filter(|o| !o.is_empty()) {
        Some(o) => {
            if !o.to_ascii_lowercase().ends_with(".png") {
                return Err("save_as must end in .png.".into());
            }
            let t = resolve_in_working(working_dir, o)?;
            let root = episode_dir
                .canonicalize()
                .unwrap_or_else(|_| episode_dir.to_path_buf());
            let parent = t.parent().map(Path::to_path_buf).unwrap_or_default();
            std::fs::create_dir_all(&parent)
                .map_err(|e| format!("can't make {o}'s folder: {e}"))?;
            let parent = plain(parent.canonicalize().unwrap_or(parent));
            if !parent.starts_with(plain(root)) {
                return Err(format!("{o} is outside the episode folder."));
            }
            t
        }
        None => stills_dir(episode_dir).join(default_name),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("can't make the stills folder: {e}"))?;
    }
    Ok(target)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// `path` relative to `working_dir` with forward slashes, for the model and
/// the user to read; an absolute path when it lies outside.
pub fn display_path(working_dir: &str, path: &Path) -> String {
    let root = Path::new(working_dir)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(working_dir));
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let path = crate::fs_tools::path::strip_verbatim(&path);
    let root = crate::fs_tools::path::strip_verbatim(&root);
    match path.strip_prefix(&root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use std::fs;

    fn series() -> crate::test_util::TestDir {
        let dir = temp_dir("video_series");
        fs::create_dir_all(dir.join("ep010/raw")).unwrap();
        fs::write(dir.join("ep010/raw/obs.mp4"), b"x").unwrap();
        fs::create_dir_all(dir.join("intro001")).unwrap();
        fs::write(dir.join("intro001/intro.mp4"), b"x").unwrap();
        dir
    }

    #[test]
    fn an_episode_inside_the_working_folder_resolves() {
        let dir = series();
        let wd = dir.to_string_lossy();
        assert!(resolve_episode(&wd, "ep010").unwrap().ends_with("ep010"));
        assert!(resolve_episode(&wd, "ep010/raw").unwrap().ends_with("raw"));
        // Empty: the working folder is the episode.
        assert_eq!(resolve_episode(&wd, "").unwrap(), dir.to_path_buf());
    }

    #[test]
    fn escaping_the_working_folder_is_refused() {
        let dir = series();
        let wd = dir.join("ep010");
        let wd = wd.to_string_lossy();
        assert!(resolve_episode(&wd, "../intro001").is_err());
        assert!(resolve_in_working(&wd, "/etc/passwd").is_err());
        assert!(resolve_episode(&wd, "nope").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_working_folder_is_refused() {
        let dir = series();
        let outside = temp_dir("video_outside");
        std::os::unix::fs::symlink(&*outside, dir.join("ep010/escape")).unwrap();
        let wd = dir.join("ep010");
        assert!(resolve_episode(&wd.to_string_lossy(), "escape").is_err());
    }

    #[test]
    fn the_settings_intro_is_readable_from_outside() {
        let dir = series();
        let wd = dir.join("ep010");
        let wd = wd.to_string_lossy();
        let intro = dir.join("intro001/intro.mp4");
        let intro = intro.to_string_lossy();
        assert!(resolve_media(&wd, &intro, &intro, "").is_ok());
        // Without the setting, the same file is outside and refused.
        assert!(resolve_media(&wd, &intro, "", "").is_err());
        assert!(resolve_media(&wd, "raw/obs.mp4", "", "").is_ok());
    }

    #[test]
    fn checked_paths_are_never_verbatim() {
        let dir = series();
        let wd = dir.to_string_lossy();
        for p in [
            resolve_episode(&wd, "ep010").unwrap(),
            resolve_in_working(&wd, "ep010/new.kdenlive").unwrap(),
            resolve_media(&wd, "ep010/raw/obs.mp4", "", "").unwrap(),
        ] {
            assert!(!p.to_string_lossy().starts_with(r"\\?\"), "{}", p.display());
        }
    }

    #[test]
    fn stills_stay_in_the_episode() {
        let dir = series();
        let wd = dir.to_string_lossy();
        let ep = resolve_episode(&wd, "ep010").unwrap();
        let d = still_target(&wd, &ep, None, "obs-last.png").unwrap();
        assert!(
            d.ends_with("ep010/.haruspex/stills/obs-last.png"),
            "{}",
            d.display()
        );
        let given = still_target(&wd, &ep, Some("ep010/stills/a.png"), "x.png").unwrap();
        assert!(given.ends_with("ep010/stills/a.png"));
        assert!(still_target(&wd, &ep, Some("intro001/a.png"), "x.png").is_err());
        assert!(still_target(&wd, &ep, Some("ep010/a.jpg"), "x.png").is_err());
        assert!(still_target(&wd, &ep, Some("/tmp/a.png"), "x.png").is_err());
    }

    #[test]
    fn display_paths_are_relative_with_forward_slashes() {
        let dir = series();
        let wd = dir.to_string_lossy();
        assert_eq!(
            display_path(&wd, &dir.join("ep010/raw/obs.mp4")),
            "ep010/raw/obs.mp4"
        );
    }
}
