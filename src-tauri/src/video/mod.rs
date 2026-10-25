//! Video editing: finding ffmpeg and melt, reading an episode's clips, and
//! (in later modules) building and rendering Kdenlive projects.
//!
//! See `plan/video-editing/` for the design and `docs/guide/video.md` for what
//! the user sees.

pub mod binaries;
pub mod commands;
pub mod kdenlive;
pub mod paths;
pub mod probe;
pub mod project;

/// Hide the console window a spawned program would open on Windows.
pub(crate) fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    cmd.creation_flags(crate::shell::platform::CREATE_NO_WINDOW);
    #[cfg(not(windows))]
    let _ = cmd;
}
