//! Video editing: finding ffmpeg and melt, reading an episode's clips, and
//! (in later modules) building and rendering Kdenlive projects.
//!
//! See `plan/archive/video-editing/` for the design and `docs/guide/video-editing.md` for what
//! the user sees.

pub mod binaries;
pub mod check;
pub mod commands;
pub mod encode;
pub mod format;
pub mod frames;
pub mod kdenlive;
pub mod loudness;
pub mod mlt;
pub mod paths;
pub mod probe;
pub mod project;
pub mod scenes;
pub mod shotcut;
pub mod silence;
pub mod subtitles;
pub mod tasks;
pub mod thumbnail;
pub mod timeline;
pub mod transcribe;

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
/// whose bundled libraries stop the system ffmpeg starting; give a bundled
/// one the media bundle's libraries, modules and plugins (after the scrub, so
/// it can't take them away again); and hide the console window it would open
/// on Windows. Every spawn of the three, cameras' and the audio cache's
/// included, comes through here.
pub(crate) fn prepare_child(cmd: &mut tokio::process::Command) {
    crate::env_util::sanitize_appimage_env(cmd.as_std_mut());
    crate::media_env::apply(cmd.as_std_mut());
    crate::shell::platform::apply_no_window(cmd.as_std_mut());
}

/// Why ffmpeg failed, from its stderr: a codec or format this ffmpeg
/// lacks, said in words, or else its first line (`fallback` when it said
/// nothing).
pub(crate) fn ffmpeg_error(stderr: &str, fallback: &str) -> String {
    const CHOOSE: &str = "Update Haruspex, or choose another ffmpeg under \
                          Settings → Video editing → ffmpeg and ffprobe.";
    let between = |line: &str, start: &str, end: &str| -> Option<String> {
        let rest = &line[line.find(start)? + start.len()..];
        Some(rest[..rest.find(end)?].to_string())
    };
    for line in stderr.lines() {
        // The native av1 decoder, with no hardware decoder to hand it to.
        if let Some(codec) = between(line, "support hardware accelerated ", " decoding") {
            return format!(
                "this ffmpeg can't decode {} video without a hardware decoder. {CHOOSE}",
                codec.to_uppercase()
            );
        }
        if let Some(codec) = between(line, "Decoder (codec ", ") not found") {
            return format!("this ffmpeg can't decode {codec}. {CHOOSE}");
        }
        if let Some(name) = between(line, "Unknown encoder '", "'") {
            return format!("this ffmpeg has no {name} encoder. {CHOOSE}");
        }
        if let Some(name) = between(line, "Unknown decoder '", "'") {
            return format!("this ffmpeg has no {name} decoder. {CHOOSE}");
        }
        if let Some(format) = between(line, "Requested output format '", "'") {
            return format!("this ffmpeg can't write {format} files. {CHOOSE}");
        }
    }
    stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(fallback)
        .to_string()
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

    #[test]
    fn ffmpeg_error_names_what_this_ffmpeg_lacks() {
        use super::ffmpeg_error;
        let hw =
            "[av1 @ 0x5581] Your platform doesn't support hardware accelerated AV1 decoding.\n\
                  [av1 @ 0x5581] Failed to get pixel format.";
        assert!(ffmpeg_error(hw, "x").starts_with("this ffmpeg can't decode AV1 video"));
        let muxer = "[AVFormatContext @ 0x55] Requested output format 'webm' is not known.";
        assert!(ffmpeg_error(muxer, "x").starts_with("this ffmpeg can't write webm files."));
        let enc = "[aost#0:1 @ 0x55] Unknown encoder 'libopus'";
        assert!(ffmpeg_error(enc, "x").starts_with("this ffmpeg has no libopus encoder."));
        assert!(ffmpeg_error(enc, "x").contains("Settings → Video editing → ffmpeg and ffprobe"));
        assert_eq!(
            ffmpeg_error("\n  clip.mp4: No such file\nmore", "x"),
            "clip.mp4: No such file"
        );
        assert_eq!(ffmpeg_error("", "past the end?"), "past the end?");
    }
}
