//! Replacing an installed catalog server with its current pin, in place.
//!
//! The new version is installed beside the running one (`<id>.installing`, by
//! [`super::install::McpInstaller::stage_update`]); only then is the server
//! stopped and this module run. The server directory mixes the package with
//! things that are the user's — a setup file, a sign-in token, Playwright's
//! browser — so the swap moves every top-level name the old manifest does not
//! claim into the new directory, then swaps the directories:
//!
//! ```text
//! <id>            old package + user state
//! <id>.installing new package + new manifest
//!   a. user state   <id> -> <id>.installing
//!   b. <id>         -> <id>.previous
//!   c. <id>.installing -> <id>
//! ```
//!
//! `<id>.previous` stays until the caller has seen the new version start
//! ([`commit`]) or not ([`rollback`]). Moves rather than copies: same
//! filesystem, so a 400 MB browser costs nothing, and rollback moves it back.
//!
//! Plain functions over paths, so every step and every failure between them is
//! testable without npm or a running app.

use log::info;
use std::path::{Path, PathBuf};

use super::install::staging_dir;
use super::manifest::InstallManifest;

/// Suffix of the directory the replaced install waits in.
pub const PREVIOUS_SUFFIX: &str = ".previous";

pub fn previous_dir(dir: &Path) -> PathBuf {
    let mut name = dir.as_os_str().to_os_string();
    name.push(PREVIOUS_SUFFIX);
    PathBuf::from(name)
}

/// Swap the staged install in, carrying the user's files across.
///
/// `old_package_files` is what the installed manifest claims; everything else
/// in `dir` moves. On failure the directory is as it was, and the staged
/// install is left for [`rollback`] to clear.
pub fn swap(dir: &Path, old_package_files: &[String]) -> Result<(), String> {
    let staging = staging_dir(dir);
    if InstallManifest::read(&staging)?.is_none() {
        return Err("there is no staged update to swap in".into());
    }
    let state = user_state(dir, old_package_files)?;
    // A name on both sides would be overwritten or refused halfway through;
    // finding it first keeps the swap all or nothing.
    if let Some(clash) = state.iter().find(|name| staging.join(name).exists()) {
        return Err(format!(
            "the new version ships '{clash}', which is one of your files in this server's folder"
        ));
    }

    // a. The user's files into the new install.
    let mut moved = Vec::new();
    for name in &state {
        if let Err(e) = std::fs::rename(dir.join(name), staging.join(name)) {
            move_names(&moved, &staging, dir);
            return Err(format!("could not move '{name}' into the new version: {e}"));
        }
        moved.push(name.clone());
    }

    // b. The old install aside.
    let previous = previous_dir(dir);
    let _ = std::fs::remove_dir_all(&previous);
    if let Err(e) = std::fs::rename(dir, &previous) {
        move_names(&moved, &staging, dir);
        return Err(format!("could not set the old version aside: {e}"));
    }

    // c. The new install in.
    if let Err(e) = std::fs::rename(&staging, dir) {
        let _ = std::fs::rename(&previous, dir);
        move_names(&moved, &staging, dir);
        return Err(format!("could not put the new version in place: {e}"));
    }
    info!("mcp: swapped in an update at {}", dir.display());
    Ok(())
}

/// Keep the new version: drop the old one.
pub fn commit(dir: &Path) -> Result<(), String> {
    let previous = previous_dir(dir);
    match std::fs::remove_dir_all(&previous) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", previous.display())),
    }
}

/// Put the old version back, with the user's files, from wherever an update
/// stopped. Returns whether an old version was restored.
///
/// - After the swap: the user's files move from `<id>` back to
///   `<id>.previous`, which becomes `<id>` again. Files made during the update
///   (a newly downloaded browser) move too; they are the user's now.
/// - Between b and c (`<id>` missing): the same, from `<id>.installing`.
/// - Before b, or never swapped: any of the user's files already moved into
///   `<id>.installing` go back to `<id>`, and the staged install is dropped.
pub fn rollback(dir: &Path) -> Result<bool, String> {
    let staging = staging_dir(dir);
    let previous = previous_dir(dir);

    if !previous.is_dir() {
        if dir.is_dir() {
            if let Some(staged) = InstallManifest::read(&staging).ok().flatten() {
                let back: Vec<String> = user_state(&staging, &staged.package_files)?
                    .into_iter()
                    .filter(|name| !dir.join(name).exists())
                    .collect();
                move_names(&back, &staging, dir);
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Ok(false);
    }

    let source = if dir.is_dir() {
        dir.to_path_buf()
    } else {
        staging.clone()
    };
    let new_package_files = InstallManifest::read(&source)?
        .map(|m| m.package_files)
        .ok_or_else(|| format!("{} has no install manifest", source.display()))?;
    let state = user_state(&source, &new_package_files)?;
    for name in &state {
        let to = previous.join(name);
        if to.exists() {
            continue;
        }
        std::fs::rename(source.join(name), &to)
            .map_err(|e| format!("could not move '{name}' back: {e}"))?;
    }
    std::fs::remove_dir_all(&source)
        .map_err(|e| format!("could not remove {}: {e}", source.display()))?;
    std::fs::rename(&previous, dir)
        .map_err(|e| format!("could not restore the old version: {e}"))?;
    let _ = std::fs::remove_dir_all(&staging);
    info!("mcp: rolled back an update at {}", dir.display());
    Ok(true)
}

/// Undo every update a previous run of the app left half done, and clear
/// stale staging directories. Returns the ids whose old version came back.
///
/// Run at launch, before any server starts: nothing is mid-install then.
pub fn recover(root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(PREVIOUS_SUFFIX)
                .or_else(|| name.strip_suffix(super::install::STAGING_SUFFIX))
                .map(str::to_string)
        })
        .collect();
    ids.sort();
    ids.dedup();
    let mut restored = Vec::new();
    for id in ids {
        match rollback(&root.join(&id)) {
            Ok(true) => restored.push(id),
            Ok(false) => {}
            Err(e) => log::warn!("mcp: could not recover {id}: {e}"),
        }
    }
    restored
}

/// The top-level names in `dir` its package does not claim.
fn user_state(dir: &Path, package_files: &[String]) -> Result<Vec<String>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("could not list {}: {e}", dir.display()))?;
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| !package_files.contains(name))
        .collect();
    names.sort();
    Ok(names)
}

/// Best effort, for undoing a step that already failed: the error that
/// matters is the one being returned.
fn move_names(names: &[String], from: &Path, to: &Path) {
    for name in names {
        if let Err(e) = std::fs::rename(from.join(name), to.join(name)) {
            log::warn!("mcp: could not move '{name}' back: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::mcp::catalog::{Acquisition, CatalogEntry, CommandSpec};
    use crate::integrations::mcp::manifest::MANIFEST_FILE;

    fn entry(version: &str) -> CatalogEntry {
        CatalogEntry {
            id: "playwright".into(),
            name: "Browser".into(),
            description: String::new(),
            homepage: String::new(),
            acquisition: Acquisition::Npm {
                package: "@playwright/mcp".into(),
                version: version.into(),
                bin: "@playwright/mcp/cli.js".into(),
            },
            command: CommandSpec::default(),
            default_tools: Vec::new(),
            setup: Vec::new(),
            companion: None,
            provenance: None,
            blocked_versions: Vec::new(),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    /// An installed server: a package that says which version it is, its
    /// manifest, and three of the user's things.
    fn installed(root: &Path) -> (PathBuf, Vec<String>) {
        let dir = root.join("srv");
        write(&dir.join("node_modules/pkg/v"), "old");
        write(&dir.join("package.json"), "{}");
        let manifest = InstallManifest::for_install(&dir, &entry("0.0.83")).unwrap();
        manifest.write(&dir).unwrap();
        write(&dir.join("gcp-oauth.keys.json"), "keys");
        write(&dir.join("token.json"), "token");
        write(&dir.join("chromium-1247/chrome"), "browser");
        (dir, manifest.package_files)
    }

    /// The new version, staged beside it.
    fn staged(dir: &Path) {
        let staging = staging_dir(dir);
        write(&staging.join("node_modules/pkg/v"), "new");
        write(&staging.join("package.json"), "{}");
        InstallManifest::for_install(&staging, &entry("0.0.90"))
            .unwrap()
            .write(&staging)
            .unwrap();
    }

    fn version(dir: &Path) -> String {
        InstallManifest::read(dir)
            .unwrap()
            .unwrap()
            .entry
            .acquisition
            .version()
            .to_string()
    }

    fn keeps_user_state(dir: &Path) {
        assert_eq!(read(&dir.join("gcp-oauth.keys.json")), "keys");
        assert_eq!(read(&dir.join("token.json")), "token");
        assert_eq!(read(&dir.join("chromium-1247/chrome")), "browser");
    }

    #[test]
    fn a_swap_replaces_the_package_and_keeps_the_users_files() {
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        staged(&dir);

        swap(&dir, &old).unwrap();
        assert_eq!(read(&dir.join("node_modules/pkg/v")), "new");
        assert_eq!(version(&dir), "0.0.90");
        keeps_user_state(&dir);
        assert!(!staging_dir(&dir).exists());
        assert_eq!(version(&previous_dir(&dir)), "0.0.83");

        commit(&dir).unwrap();
        assert!(!previous_dir(&dir).exists());
        keeps_user_state(&dir);
    }

    #[test]
    fn a_rollback_restores_the_old_package_and_keeps_new_files() {
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        staged(&dir);
        swap(&dir, &old).unwrap();
        // The update's setup step downloaded a newer browser before the
        // handshake failed.
        write(&dir.join("chromium-1300/chrome"), "newer browser");

        assert!(rollback(&dir).unwrap());
        assert_eq!(read(&dir.join("node_modules/pkg/v")), "old");
        assert_eq!(version(&dir), "0.0.83");
        keeps_user_state(&dir);
        assert_eq!(read(&dir.join("chromium-1300/chrome")), "newer browser");
        assert!(!previous_dir(&dir).exists());
        assert!(!staging_dir(&dir).exists());
    }

    #[test]
    fn a_binary_archives_extra_files_are_replaced_not_carried_over() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("gh");
        write(&dir.join("github-mcp-server"), "old");
        write(&dir.join("LICENSE"), "old licence");
        let manifest = InstallManifest::for_install(&dir, &entry("v1")).unwrap();
        manifest.write(&dir).unwrap();
        let staging = staging_dir(&dir);
        write(&staging.join("github-mcp-server"), "new");
        write(&staging.join("LICENSE"), "new licence");
        InstallManifest::for_install(&staging, &entry("v2"))
            .unwrap()
            .write(&staging)
            .unwrap();

        swap(&dir, &manifest.package_files).unwrap();
        assert_eq!(read(&dir.join("LICENSE")), "new licence");
    }

    #[test]
    fn a_name_on_both_sides_stops_the_swap_before_it_starts() {
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        staged(&dir);
        write(&staging_dir(&dir).join("token.json"), "shipped");

        let err = swap(&dir, &old).unwrap_err();
        assert!(err.contains("token.json"), "{err}");
        assert_eq!(read(&dir.join("node_modules/pkg/v")), "old");
        keeps_user_state(&dir);
    }

    #[test]
    fn swapping_with_nothing_staged_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        assert!(swap(&dir, &old).is_err());
        keeps_user_state(&dir);
    }

    #[test]
    fn a_rollback_mends_a_swap_that_stopped_after_moving_the_users_files() {
        // Interrupted during step a: some files are in staging, no old
        // version is set aside.
        let root = tempfile::tempdir().unwrap();
        let (dir, _) = installed(root.path());
        staged(&dir);
        let staging = staging_dir(&dir);
        std::fs::rename(dir.join("token.json"), staging.join("token.json")).unwrap();

        assert!(!rollback(&dir).unwrap());
        keeps_user_state(&dir);
        assert_eq!(read(&dir.join("node_modules/pkg/v")), "old");
        assert!(!staging.exists());
    }

    #[test]
    fn a_rollback_mends_a_swap_that_stopped_between_the_renames() {
        // Interrupted between b and c: there is no `<id>` at all.
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        staged(&dir);
        let staging = staging_dir(&dir);
        for name in user_state(&dir, &old).unwrap() {
            std::fs::rename(dir.join(&name), staging.join(&name)).unwrap();
        }
        std::fs::rename(&dir, previous_dir(&dir)).unwrap();

        assert!(rollback(&dir).unwrap());
        assert_eq!(version(&dir), "0.0.83");
        keeps_user_state(&dir);
        assert!(!staging.exists());
    }

    #[test]
    fn recovery_restores_half_done_updates_and_clears_stale_staging() {
        let root = tempfile::tempdir().unwrap();
        let (dir, old) = installed(root.path());
        staged(&dir);
        swap(&dir, &old).unwrap();
        // Another server with only a stale staged install.
        let other = root.path().join("other");
        write(&other.join(MANIFEST_FILE), "{}");
        write(&staging_dir(&other).join("junk"), "");

        assert_eq!(recover(root.path()), ["srv"]);
        assert_eq!(version(&dir), "0.0.83");
        keeps_user_state(&dir);
        assert!(!staging_dir(&other).exists());
        assert!(other.exists());
    }

    #[test]
    fn committing_or_rolling_back_with_nothing_to_do_is_harmless() {
        let root = tempfile::tempdir().unwrap();
        let (dir, _) = installed(root.path());
        commit(&dir).unwrap();
        assert!(!rollback(&dir).unwrap());
        keeps_user_state(&dir);
    }
}
