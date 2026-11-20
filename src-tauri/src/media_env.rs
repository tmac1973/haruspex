//! The environment the bundled media tools (`haruspex-ffmpeg`,
//! `haruspex-ffprobe`, `haruspex-melt`) run with.
//!
//! They come from the media bundle (`scripts/build-media.sh`): shared libav*,
//! MLT and Qt in `binaries/media/lib`, MLT's modules and data, and Qt's
//! plugins. The libraries find each other by rpath on Linux and macOS, but the
//! binaries' rpaths only cover the layouts the bundle knows (beside them, and
//! the installed resources), not `tauri dev`'s copies in `target/`, and
//! Windows has no rpath. So every spawn of a bundled tool also gets the
//! library path, and melt gets where its modules and Qt's plugins are.
//!
//! A system ffmpeg or an editor's melt is never given any of this: our libav*
//! would load into it in place of its own.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Where the media bundle's folder is for a bundled binary: beside it (the
/// source tree's `binaries/`), in the Windows install (`binaries/media`), in a
/// deb/rpm/AppImage install (`/usr/bin` next to `/usr/lib/Haruspex`), or in
/// a macOS `.app` (`Contents/MacOS` next to `Contents/Resources`). `None` for
/// anything that isn't ours.
pub fn media_dir_for(binary: &Path) -> Option<PathBuf> {
    let name = binary.file_name()?.to_str()?;
    if !name.starts_with("haruspex-") {
        return None;
    }
    let dir = binary.parent()?;
    let mut candidates = vec![
        dir.join("media"),
        dir.join("binaries").join("media"),
        dir.join("../lib/Haruspex/binaries/media"),
        dir.join("../Resources/binaries/media"),
    ];
    // `tauri dev` runs the copies staged in target/; the bundle stays in the
    // source tree.
    #[cfg(debug_assertions)]
    candidates.push(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("media"),
    );
    candidates
        .into_iter()
        .find(|c| c.join("mlt").is_dir() && c.join("lib").is_dir())
        .map(|c| dunce_canonical(&c))
}

/// A canonical path without Windows' `\\?\` prefix, which the tools' own
/// path handling (and MLT's) doesn't understand.
fn dunce_canonical(p: &Path) -> PathBuf {
    match p.canonicalize() {
        Ok(c) => crate::fs_tools::path::strip_verbatim(&c),
        Err(_) => p.to_path_buf(),
    }
}

/// The variables a bundled tool runs with, for a media folder.
pub fn vars(media: &Path) -> Vec<(&'static str, OsString)> {
    let lib = media.join("lib");
    #[cfg(target_os = "linux")]
    let library = ("LD_LIBRARY_PATH", lib.into_os_string());
    #[cfg(target_os = "macos")]
    let library = ("DYLD_LIBRARY_PATH", lib.into_os_string());
    // Windows finds DLLs on PATH, which the tool needs whole.
    #[cfg(target_os = "windows")]
    let library = ("PATH", {
        let mut dirs = vec![lib];
        if let Some(existing) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&existing));
        }
        std::env::join_paths(dirs).unwrap_or_default()
    });
    vec![
        library,
        ("MLT_REPOSITORY", media.join("mlt").into_os_string()),
        ("MLT_DATA", media.join("mlt-data").into_os_string()),
        (
            "MLT_PROFILES_PATH",
            media.join("mlt-data").join("profiles").into_os_string(),
        ),
        (
            "MLT_PRESETS_PATH",
            media.join("mlt-data").join("presets").into_os_string(),
        ),
        ("QT_PLUGIN_PATH", media.join("qt-plugins").into_os_string()),
        // melt's qt6 module draws offscreen; it needs no display.
        ("QT_QPA_PLATFORM", OsString::from("offscreen")),
    ]
}

/// Give `cmd` the bundle's environment when its program is one of ours.
pub fn apply(cmd: &mut std::process::Command) {
    let program = PathBuf::from(cmd.get_program());
    if let Some(media) = media_dir_for(&program) {
        for (k, v) in vars(&media) {
            cmd.env(k, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn fake_bundle(dir: &Path) -> PathBuf {
        for d in [
            "media/lib",
            "media/mlt",
            "media/mlt-data/profiles",
            "media/qt-plugins",
        ] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
        }
        let melt = dir.join("haruspex-melt-x86_64-unknown-linux-gnu");
        std::fs::write(&melt, "").unwrap();
        melt
    }

    #[test]
    fn our_binaries_get_the_bundle_and_others_nothing() {
        let dir = temp_dir("media_env_ours");
        let melt = fake_bundle(&dir);
        let media = media_dir_for(&melt).unwrap();
        assert!(media.ends_with("media"));
        let vars = vars(&media);
        let get = |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("MLT_REPOSITORY"),
            Some(media.join("mlt").into_os_string())
        );
        assert_eq!(get("QT_QPA_PLATFORM"), Some("offscreen".into()));
        #[cfg(target_os = "linux")]
        assert_eq!(
            get("LD_LIBRARY_PATH"),
            Some(media.join("lib").into_os_string())
        );

        let system = dir.join("ffmpeg");
        std::fs::write(&system, "").unwrap();
        assert!(media_dir_for(&system).is_none());
        assert!(media_dir_for(Path::new("/usr/bin/melt-7")).is_none());
    }

    #[test]
    fn the_installed_layouts_are_found() {
        let root = temp_dir("media_env_layouts");
        // deb/rpm/AppImage: usr/bin and usr/lib/Haruspex/binaries/media.
        let usr = root.join("usr");
        for d in [
            "lib/Haruspex/binaries/media/lib",
            "lib/Haruspex/binaries/media/mlt",
            "bin",
        ] {
            std::fs::create_dir_all(usr.join(d)).unwrap();
        }
        let ffmpeg = usr.join("bin/haruspex-ffmpeg");
        std::fs::write(&ffmpeg, "").unwrap();
        assert!(media_dir_for(&ffmpeg)
            .unwrap()
            .ends_with("lib/Haruspex/binaries/media"));
        // A .app: Contents/MacOS and Contents/Resources/binaries/media.
        let app = root.join("Haruspex.app/Contents");
        for d in [
            "Resources/binaries/media/lib",
            "Resources/binaries/media/mlt",
            "MacOS",
        ] {
            std::fs::create_dir_all(app.join(d)).unwrap();
        }
        let melt = app.join("MacOS/haruspex-melt");
        std::fs::write(&melt, "").unwrap();
        assert!(media_dir_for(&melt)
            .unwrap()
            .ends_with("Resources/binaries/media"));
    }

    #[test]
    fn apply_sets_the_variables_only_for_ours() {
        let dir = temp_dir("media_env_apply");
        let melt = fake_bundle(&dir);
        let mut ours = std::process::Command::new(&melt);
        apply(&mut ours);
        assert!(ours.get_envs().any(|(k, _)| k == "MLT_REPOSITORY"));
        let mut theirs = std::process::Command::new("/usr/bin/ffmpeg");
        apply(&mut theirs);
        assert_eq!(theirs.get_envs().count(), 0);
    }
}
