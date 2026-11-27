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

use crate::sync_util::LockExt;
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

/// The bundled tools the model's own commands may call.
const SHIMMED: [&str; 3] = ["ffmpeg", "ffprobe", "melt"];

/// The shim folder while it is in use: Settings → Video editing is on and the
/// bundle is here. `None` otherwise.
static SHIMS: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// `<app data>/runtime-bin/media/`, beside node's shim.
fn shim_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    Some(
        app.path()
            .app_local_data_dir()
            .ok()?
            .join("runtime-bin")
            .join("media"),
    )
}

/// A POSIX shell word for `s`.
#[cfg(unix)]
fn sh_quote(s: &std::ffi::OsStr) -> String {
    format!("'{}'", s.to_string_lossy().replace('\'', "'\\''"))
}

/// Write `ffmpeg`, `ffprobe` and `melt` into `dir` for the bundled `binaries`
/// (name, path). On Linux and macOS each is a script that sets the bundle's
/// variables for that one process and execs the tool, so the shell around it
/// never gets our library path. On Windows each is a copy of the tool: a
/// `.cmd` would mangle a `%` in the model's arguments (`frame_%04d.png`), and
/// the shell gets the variables instead (see [`shell_env`]).
pub fn write_shims(dir: &Path, binaries: &[(&str, PathBuf)]) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    for (name, binary) in binaries {
        let media = media_dir_for(binary)
            .ok_or_else(|| format!("{} has no media bundle beside it", binary.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut text =
                String::from("#!/bin/sh\n# Haruspex's bundled tool, with its libraries.\n");
            for (k, v) in vars(&media) {
                text.push_str(&format!("{k}={}; export {k}\n", sh_quote(&v)));
            }
            text.push_str(&format!("exec {} \"$@\"\n", sh_quote(binary.as_os_str())));
            let path = dir.join(name);
            std::fs::write(&path, text)
                .map_err(|e| format!("can't write {}: {e}", path.display()))?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        #[cfg(windows)]
        {
            let _ = media;
            let path = dir.join(format!("{name}.exe"));
            std::fs::copy(binary, &path)
                .map_err(|e| format!("can't copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Put the shims in place, or take them away. Called by the frontend at
/// startup and whenever Settings → Video editing changes.
pub fn set_shims(app: &tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let dir = shim_dir(app).ok_or("no app data folder")?;
    let binaries: Vec<(&str, PathBuf)> = SHIMMED
        .iter()
        .filter_map(|t| {
            crate::runtimes::resolve_binary(t)
                .ok()
                .filter(|p| media_dir_for(p).is_some())
                .map(|p| (*t, p))
        })
        .collect();
    let mut on = SHIMS.lock_or_recover();
    if !enabled || binaries.len() != SHIMMED.len() {
        let _ = std::fs::remove_dir_all(&dir);
        *on = None;
        return Ok(false);
    }
    // Rewritten every time, so an update that moved the app fixes them.
    write_shims(&dir, &binaries)?;
    *on = Some(dir);
    Ok(true)
}

/// What a shell for the model's own commands (the Code tab's, a Shell tab's)
/// needs set so `ffmpeg`, `ffprobe` and `melt` are the bundled ones, given the
/// `PATH` it would otherwise get. Empty while the shims are off.
pub fn shell_env(path: Option<&std::ffi::OsStr>) -> Vec<(&'static str, OsString)> {
    let on = SHIMS.lock_or_recover().clone();
    let Some(dir) = on else { return Vec::new() };
    shell_env_for(&dir, path)
}

fn shell_env_for(dir: &Path, path: Option<&std::ffi::OsStr>) -> Vec<(&'static str, OsString)> {
    let mut dirs = vec![dir.to_path_buf()];
    if let Some(p) = path {
        dirs.extend(std::env::split_paths(p));
    }
    #[cfg(windows)]
    let extra: Vec<(&'static str, OsString)> = {
        // The copies' DLLs: last on PATH, so no other program's are displaced.
        let media = crate::runtimes::resolve_binary("melt")
            .ok()
            .and_then(|m| media_dir_for(&m));
        if let Some(m) = &media {
            dirs.push(m.join("lib"));
        }
        media
            .map(|m| vars(&m).into_iter().filter(|(k, _)| *k != "PATH").collect())
            .unwrap_or_default()
    };
    #[cfg(not(windows))]
    let extra: Vec<(&'static str, OsString)> = Vec::new();
    let mut out = vec![("PATH", std::env::join_paths(dirs).unwrap_or_default())];
    out.extend(extra);
    out
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

    #[cfg(unix)]
    #[test]
    fn shims_exec_the_bundled_tool_with_its_libraries() {
        let dir = temp_dir("media_env_shims");
        let melt = fake_bundle(&dir);
        let shims = dir.join("shims");
        write_shims(&shims, &[("melt", melt.clone())]).unwrap();
        let text = std::fs::read_to_string(shims.join("melt")).unwrap();
        assert!(text.starts_with("#!/bin/sh\n"));
        assert!(text.contains("MLT_REPOSITORY="));
        assert!(text.contains(&format!("exec '{}' \"$@\"", melt.display())));
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(shims.join("melt"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
        // A quote in a path survives.
        assert_eq!(sh_quote(std::ffi::OsStr::new("it's")), "'it'\\''s'");
        // Something that isn't ours is refused.
        assert!(write_shims(&shims, &[("ffmpeg", PathBuf::from("/usr/bin/ffmpeg"))]).is_err());
    }

    /// With the media bundle fetched (`./scripts/fetch-media.sh`), the shims
    /// run the real tools from a shell's PATH, and the shell itself gets no
    /// library path. Skipped without the bundle.
    #[cfg(unix)]
    #[test]
    fn real_shims_run_from_a_shell() {
        let binaries: Vec<(&str, PathBuf)> = SHIMMED
            .iter()
            .filter_map(|t| {
                let p = crate::runtimes::resolve_binary(t).ok()?;
                media_dir_for(&p)?;
                Some((*t, p))
            })
            .collect();
        if binaries.len() != SHIMMED.len() {
            eprintln!("skipped: no media bundle");
            return;
        }
        let dir = temp_dir("media_env_real_shims");
        write_shims(&dir, &binaries).unwrap();
        let env = shell_env_for(&dir, std::env::var_os("PATH").as_deref());
        let out = std::process::Command::new("sh")
            .args(["-c", "command -v melt; melt -version 2>&1 | head -1; ffmpeg -hide_banner -version | head -1; echo \"lib=${LD_LIBRARY_PATH:-none}\""])
            .env_remove("LD_LIBRARY_PATH")
            .envs(env.iter().map(|(k, v)| (*k, v)))
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.contains(&dir.join("melt").to_string_lossy().to_string()),
            "{text}"
        );
        assert!(text.contains("7.40"), "{text}");
        assert!(text.contains("ffmpeg version"), "{text}");
        assert!(text.contains("lib=none"), "{text}");
    }

    #[test]
    fn the_shell_gets_the_shims_first() {
        let dir = temp_dir("media_env_shell");
        let env = shell_env_for(&dir, Some(std::ffi::OsStr::new("/usr/bin")));
        let path = &env.iter().find(|(k, _)| *k == "PATH").unwrap().1;
        let parts: Vec<PathBuf> = std::env::split_paths(path).collect();
        assert_eq!(parts[0], dir.to_path_buf());
        assert_eq!(parts[1], PathBuf::from("/usr/bin"));
        #[cfg(unix)]
        assert_eq!(env.len(), 1, "no library path on a unix shell: {env:?}");
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
