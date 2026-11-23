//! What Kdenlive and Shotcut projects share: both are MLT XML, read and spliced
//! the same way, with times at the profile's frame rate.

pub mod fit;
pub mod fps;
pub mod gain_range;
pub mod profile;
pub mod project_file;
pub mod xml;

use std::path::Path;

/// A path as a project's `root` or `resource` says it: forward slashes, a
/// Windows drive kept as `C:/…`.
pub fn mlt_path(path: &Path) -> String {
    let s = crate::fs_tools::path::strip_verbatim(path)
        .to_string_lossy()
        .into_owned();
    s.replace('\\', "/")
}
