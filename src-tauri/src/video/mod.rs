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

/// Ready a spawned ffmpeg, ffprobe or melt: undo an AppImage's environment,
/// whose bundled libraries stop the system ffmpeg starting, and hide the
/// console window it would open on Windows.
pub(crate) fn prepare_child(cmd: &mut tokio::process::Command) {
    crate::env_util::sanitize_appimage_env(cmd.as_std_mut());
    crate::shell::platform::apply_no_window(cmd.as_std_mut());
}
