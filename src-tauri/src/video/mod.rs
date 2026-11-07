//! Video editing: finding ffmpeg and melt, reading an episode's clips, and
//! (in later modules) building and rendering Kdenlive projects.
//!
//! See `plan/video-editing/` for the design and `docs/guide/video-editing.md` for what
//! the user sees.

pub mod binaries;
pub mod check;
pub mod commands;
pub mod encode;
pub mod frames;
pub mod kdenlive;
pub mod loudness;
pub mod paths;
pub mod probe;
pub mod project;
pub mod scenes;
pub mod silence;
pub mod subtitles;
pub mod tasks;
pub mod thumbnail;
pub mod transcribe;
pub mod youtube;

/// Copy `from`'s bytes to `to`, removing `to` again if the copy fails.
///
/// Not `std::fs::copy`: that also copies the permissions, and a share that
/// refuses chmod (TrueNAS NFS with an ACL, say) fails it with EPERM after the
/// file is made, leaving an empty `to` — or, over an existing file, an emptied
/// one. Episodes live on shares like that.
pub(crate) fn copy_file(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mut dst = std::fs::File::create(to)?;
    let copied = std::io::copy(&mut src, &mut dst).and_then(|_| dst.sync_all());
    if copied.is_err() {
        drop(dst);
        let _ = std::fs::remove_file(to);
    }
    copied
}

/// Ready a spawned ffmpeg, ffprobe or melt: undo an AppImage's environment,
/// whose bundled libraries stop the system ffmpeg starting, and hide the
/// console window it would open on Windows.
pub(crate) fn prepare_child(cmd: &mut tokio::process::Command) {
    crate::env_util::sanitize_appimage_env(cmd.as_std_mut());
    crate::shell::platform::apply_no_window(cmd.as_std_mut());
}

#[cfg(test)]
mod tests {
    use super::copy_file;
    use crate::test_util::temp_dir;
    use std::fs;

    #[test]
    fn copy_file_copies_the_bytes_over_an_existing_file() {
        let dir = temp_dir("video_copy");
        let (from, to) = (dir.join("a.kdenlive"), dir.join("b.kdenlive"));
        fs::write(&from, "new").unwrap();
        fs::write(&to, "older and longer").unwrap();
        copy_file(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(&to).unwrap(), "new");
    }

    #[test]
    fn copy_file_makes_nothing_when_the_source_is_missing() {
        let dir = temp_dir("video_copy");
        let to = dir.join("b.kdenlive");
        assert!(copy_file(&dir.join("missing.kdenlive"), &to).is_err());
        assert!(!to.exists());
    }
}
