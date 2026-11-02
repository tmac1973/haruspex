//! What was installed in a catalog server's directory.
//!
//! The catalog is compiled into the app, so a release that bumps a pin also
//! changes the entry every existing install is launched from. Launching an old
//! package with a new entry's `bin`, `args`, `env` or `defaultTools` breaks it
//! in ways whose error never names the cause. So an install writes a copy of
//! the entry it installed into its own directory, and launches read that copy.
//!
//! The manifest lives *inside* the server directory rather than in settings so
//! it can never disagree with what is on disk: it is written into the staging
//! directory and renamed into place with the package.
//!
//! An install made before manifests existed gets one the first time it is
//! needed — see [`load_or_backfill`].

use log::warn;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::catalog::{Acquisition, CatalogEntry, SetupStep};

/// File name of the manifest inside a server directory.
pub const MANIFEST_FILE: &str = ".haruspex-install.json";

/// The format version, bumped only on a change older code cannot read.
const SCHEMA: u32 = 1;

/// A catalog server as installed.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema: u32,
    /// The whole catalog entry as installed, so spawn, setup commands,
    /// optional-secret rules and `defaultTools` all read one snapshot.
    pub entry: CatalogEntry,
    /// Top-level names in the server directory that belong to the package.
    /// Everything else there is the user's — setup files, sign-in tokens,
    /// Playwright's browser — and is what an update has to carry over.
    pub package_files: Vec<String>,
    /// RFC 3339; for a backfilled manifest, when the backfill ran.
    pub installed_at: String,
}

impl InstallManifest {
    /// The installed version, as the catalog spells it.
    pub fn version(&self) -> &str {
        self.entry.acquisition.version()
    }

    /// A manifest for a freshly installed package in `dir`, taking every
    /// top-level name in it as the package's.
    pub fn for_install(dir: &Path, entry: &CatalogEntry) -> Result<Self, String> {
        let mut package_files = top_level_names(dir)?;
        package_files.push(MANIFEST_FILE.to_string());
        package_files.sort();
        package_files.dedup();
        Ok(Self::new(entry.clone(), package_files))
    }

    fn new(entry: CatalogEntry, package_files: Vec<String>) -> Self {
        Self {
            schema: SCHEMA,
            entry,
            package_files,
            installed_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    pub fn write(&self, dir: &Path) -> Result<(), String> {
        let path = dir.join(MANIFEST_FILE);
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| format!("could not encode the install manifest: {e}"))?;
        std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
    }

    /// The manifest in `dir`, or `None` when there is none.
    pub fn read(dir: &Path) -> Result<Option<Self>, String> {
        let path = dir.join(MANIFEST_FILE);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        };
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{} is not a valid install manifest: {e}", path.display()))
    }
}

/// The manifest for the server installed in `dir`, making one from the
/// current catalog entry if the install predates manifests.
///
/// A backfill takes the version from what is on disk where the package says
/// (npm and PyPI) and the current pin where it can't (a binary), and is written
/// back so it runs once. A directory that does not exist gets an unwritten
/// manifest from the current entry: there is nothing installed to describe,
/// and the launch that follows fails on the missing program as it always has.
///
/// With no manifest and no current entry there is nothing to launch from, and
/// the error says so the way it did before manifests.
pub fn load_or_backfill(
    dir: &Path,
    entry_id: &str,
    current: Option<&CatalogEntry>,
) -> Result<InstallManifest, String> {
    if let Some(manifest) = InstallManifest::read(dir)? {
        return Ok(manifest);
    }
    let entry = current.ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
    if !dir.is_dir() {
        return Ok(InstallManifest::new(
            entry.clone(),
            backfill_package_files(dir, entry),
        ));
    }
    let mut entry = entry.clone();
    if let Some(version) = version_on_disk(dir, &entry.acquisition) {
        set_version(&mut entry.acquisition, version);
    }
    let package_files = backfill_package_files(dir, &entry);
    let manifest = InstallManifest::new(entry, package_files);
    if let Err(e) = manifest.write(dir) {
        // Launching still works from the in-memory copy; the backfill just
        // runs again next time.
        warn!("mcp: {e}");
    }
    Ok(manifest)
}

/// Whether a catalog server is behind its pin, and whether what it has must not
/// start.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdateStatus {
    pub server_id: String,
    pub installed_version: String,
    pub pinned_version: String,
    pub update_available: bool,
    pub blocked_reason: Option<String>,
}

/// `installed` measured against the current catalog entry. `None` when the
/// entry has left the catalog: there is nothing to update to, and the server
/// keeps launching from its manifest.
pub fn update_status(
    server_id: &str,
    installed: &InstallManifest,
    current: Option<&CatalogEntry>,
) -> Option<McpUpdateStatus> {
    let current = current?;
    let installed_version = installed.version();
    let pinned_version = current.acquisition.version();
    Some(McpUpdateStatus {
        server_id: server_id.to_string(),
        installed_version: installed_version.to_string(),
        pinned_version: pinned_version.to_string(),
        // String equality, not ordering: the catalog only ever moves a pin to
        // the version it wants installed, and npm, PyPI and GitHub tags order
        // versions three different ways.
        update_available: installed_version != pinned_version,
        blocked_reason: current
            .blocked_reason(installed_version)
            .map(str::to_string),
    })
}

fn set_version(acquisition: &mut Acquisition, to: String) {
    match acquisition {
        Acquisition::Npm { version, .. }
        | Acquisition::Pypi { version, .. }
        | Acquisition::Binary { version, .. } => *version = to,
    }
}

/// The version the package manager recorded, where there is one to read.
fn version_on_disk(dir: &Path, acquisition: &Acquisition) -> Option<String> {
    match acquisition {
        Acquisition::Npm { package, .. } => {
            let path = dir.join("node_modules").join(package).join("package.json");
            let text = std::fs::read_to_string(path).ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            json.get("version")?.as_str().map(str::to_string)
        }
        Acquisition::Pypi { package, .. } => pypi_version(&dir.join("venv"), package),
        // A release asset carries no version we could read back.
        Acquisition::Binary { .. } => None,
    }
}

/// The `Version:` of `package`'s `*.dist-info` in a virtualenv.
fn pypi_version(venv: &Path, package: &str) -> Option<String> {
    let wanted = normalise_pypi_name(package);
    for site in site_packages_dirs(venv) {
        let Ok(entries) = std::fs::read_dir(&site) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(stem) = name.strip_suffix(".dist-info") else {
                continue;
            };
            let project = stem.split('-').next().unwrap_or(stem);
            if normalise_pypi_name(project) != wanted {
                continue;
            }
            let metadata = std::fs::read_to_string(entry.path().join("METADATA")).ok()?;
            return metadata
                .lines()
                .find_map(|line| line.strip_prefix("Version:"))
                .map(|v| v.trim().to_string());
        }
    }
    None
}

/// `venv/lib/python3.x/site-packages` on Unix, `venv/Lib/site-packages` on
/// Windows.
fn site_packages_dirs(venv: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![venv.join("Lib").join("site-packages")];
    if let Ok(entries) = std::fs::read_dir(venv.join("lib")) {
        dirs.extend(entries.flatten().map(|e| e.path().join("site-packages")));
    }
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// PEP 503: lowercase, with every run of `-`, `_` and `.` made one `-`.
fn normalise_pypi_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for c in name.chars() {
        if matches!(c, '-' | '_' | '.') {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.extend(c.to_lowercase());
            in_run = false;
        }
    }
    out
}

/// What an install made before manifests owns, by the rules of its kind.
///
/// A binary install owns everything but the files its setup steps placed. That
/// holds only while no binary entry has a `command` step, which could leave
/// other state in the directory; a catalog test keeps it so.
fn backfill_package_files(dir: &Path, entry: &CatalogEntry) -> Vec<String> {
    let mut files: Vec<String> = match &entry.acquisition {
        Acquisition::Npm { .. } => ["node_modules", "package.json", "package-lock.json"]
            .map(String::from)
            .to_vec(),
        Acquisition::Pypi { .. } => vec!["venv".to_string()],
        Acquisition::Binary { .. } => {
            let placed: Vec<&str> = entry
                .setup
                .iter()
                .filter_map(|step| match step {
                    SetupStep::File { filename, .. } => Some(filename.as_str()),
                    _ => None,
                })
                .collect();
            top_level_names(dir)
                .unwrap_or_default()
                .into_iter()
                .filter(|name| !placed.contains(&name.as_str()))
                .collect()
        }
    };
    files.push(MANIFEST_FILE.to_string());
    files.sort();
    files.dedup();
    files
}

fn top_level_names(dir: &Path) -> Result<Vec<String>, String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("could not list {}: {e}", dir.display()))?;
    Ok(entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::mcp::catalog::{self, BlockedVersion, CommandSpec};
    use std::collections::BTreeMap;

    fn entry(acquisition: Acquisition) -> CatalogEntry {
        CatalogEntry {
            id: "e".into(),
            name: "E".into(),
            description: String::new(),
            homepage: String::new(),
            acquisition,
            command: CommandSpec::default(),
            default_tools: vec!["a".into()],
            setup: Vec::new(),
            companion: None,
            provenance: None,
            blocked_versions: Vec::new(),
        }
    }

    fn npm(version: &str) -> Acquisition {
        Acquisition::Npm {
            package: "@scope/pkg".into(),
            version: version.into(),
            bin: "@scope/pkg/cli.js".into(),
        }
    }

    fn pypi(package: &str, version: &str) -> Acquisition {
        Acquisition::Pypi {
            package: package.into(),
            version: version.into(),
            entrypoint: "p".into(),
        }
    }

    fn binary(version: &str) -> Acquisition {
        Acquisition::Binary {
            repo: "o/r".into(),
            version: version.into(),
            assets: BTreeMap::new(),
            sha256: BTreeMap::new(),
            executable: "r".into(),
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn an_npm_backfill_takes_the_version_from_disk_and_is_written_once() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("node_modules/@scope/pkg/package.json"),
            r#"{"name":"@scope/pkg","version":"0.0.83"}"#,
        );
        let current = entry(npm("0.0.90"));

        let manifest = load_or_backfill(dir.path(), "e", Some(&current)).unwrap();
        assert_eq!(manifest.version(), "0.0.83");
        assert_eq!(
            manifest.package_files,
            [
                MANIFEST_FILE,
                "node_modules",
                "package-lock.json",
                "package.json"
            ]
        );

        // The second load reads the file rather than backfilling again, so a
        // later pin cannot leak in.
        let later = entry(npm("0.1.0"));
        let again = load_or_backfill(dir.path(), "e", Some(&later)).unwrap();
        assert_eq!(again, manifest);
    }

    #[test]
    fn a_pypi_backfill_matches_the_dist_info_by_normalised_name() {
        let dir = tempfile::tempdir().unwrap();
        // Unix layout; the dist-info spells the name differently.
        write(
            &dir.path()
                .join("venv/lib/python3.12/site-packages/My_Pkg-1.2.0.dist-info/METADATA"),
            "Metadata-Version: 2.1\nName: my-pkg\nVersion: 1.2.0\n",
        );
        // A different package that merely starts with the same letters.
        write(
            &dir.path()
                .join("venv/lib/python3.12/site-packages/my_pkg_extra-9.9.9.dist-info/METADATA"),
            "Version: 9.9.9\n",
        );
        let manifest =
            load_or_backfill(dir.path(), "e", Some(&entry(pypi("my-pkg", "2.0.0")))).unwrap();
        assert_eq!(manifest.version(), "1.2.0");
        assert_eq!(manifest.package_files, [MANIFEST_FILE, "venv"]);
    }

    #[test]
    fn a_pypi_backfill_finds_the_windows_layout() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path()
                .join("venv/Lib/site-packages/blender_mcp-1.1.0.dist-info/METADATA"),
            "Version: 1.1.0\n",
        );
        let manifest =
            load_or_backfill(dir.path(), "e", Some(&entry(pypi("blender-mcp", "1.2.0")))).unwrap();
        assert_eq!(manifest.version(), "1.1.0");
    }

    #[test]
    fn an_unreadable_version_keeps_the_pin() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = load_or_backfill(dir.path(), "e", Some(&entry(npm("0.0.90")))).unwrap();
        assert_eq!(manifest.version(), "0.0.90");
    }

    #[test]
    fn a_binary_backfill_owns_everything_but_the_placed_files() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("r"), "");
        write(&dir.path().join("lib/libx.so"), "");
        write(&dir.path().join("keys.json"), "{}");
        let mut current = entry(binary("v2"));
        current.setup = vec![SetupStep::File {
            label: "Keys".into(),
            filename: "keys.json".into(),
            help: None,
            optional: false,
        }];
        let manifest = load_or_backfill(dir.path(), "e", Some(&current)).unwrap();
        assert_eq!(manifest.version(), "v2");
        assert_eq!(manifest.package_files, [MANIFEST_FILE, "lib", "r"]);
    }

    #[test]
    fn a_missing_directory_is_described_but_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone");
        let manifest = load_or_backfill(&missing, "e", Some(&entry(npm("1.0.0")))).unwrap();
        assert_eq!(manifest.version(), "1.0.0");
        assert!(!missing.exists());
    }

    #[test]
    fn with_no_manifest_and_no_entry_there_is_nothing_to_launch() {
        let dir = tempfile::tempdir().unwrap();
        let err = load_or_backfill(dir.path(), "gone", None).unwrap_err();
        assert!(err.contains("no catalog entry named 'gone'"), "{err}");
    }

    #[test]
    fn an_install_manifest_owns_what_the_install_left() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("node_modules/x"), "");
        write(&dir.path().join("package.json"), "{}");
        let manifest = InstallManifest::for_install(dir.path(), &entry(npm("1.0.0"))).unwrap();
        assert_eq!(
            manifest.package_files,
            [MANIFEST_FILE, "node_modules", "package.json"]
        );
        manifest.write(dir.path()).unwrap();
        assert_eq!(InstallManifest::read(dir.path()).unwrap(), Some(manifest));
    }

    #[test]
    fn update_status_compares_the_install_with_the_pin() {
        let installed = InstallManifest::new(entry(npm("0.0.83")), Vec::new());

        let same = update_status("s", &installed, Some(&entry(npm("0.0.83")))).unwrap();
        assert!(!same.update_available);
        assert_eq!(same.blocked_reason, None);

        let mut current = entry(npm("0.0.90"));
        let newer = update_status("s", &installed, Some(&current)).unwrap();
        assert!(newer.update_available);
        assert_eq!(
            (
                newer.installed_version.as_str(),
                newer.pinned_version.as_str()
            ),
            ("0.0.83", "0.0.90")
        );

        current.blocked_versions = vec![BlockedVersion {
            version: "0.0.83".into(),
            reason: "Runs any page's script.".into(),
        }];
        let blocked = update_status("s", &installed, Some(&current)).unwrap();
        assert_eq!(
            blocked.blocked_reason.as_deref(),
            Some("Runs any page's script.")
        );

        // An entry that left the catalog has nothing to update to.
        assert_eq!(update_status("s", &installed, None), None);
    }

    #[test]
    fn pypi_names_normalise_the_pep_503_way() {
        assert_eq!(normalise_pypi_name("Godot_Editor.MCP"), "godot-editor-mcp");
        assert_eq!(normalise_pypi_name("a__-b"), "a-b");
    }

    #[test]
    fn no_binary_entry_has_a_command_step() {
        // The binary backfill rule above counts every unplaced file as the
        // package's. A command step could leave a token beside the executable,
        // which an update would then throw away. Revisit that rule before
        // adding one.
        for entry in catalog::load().unwrap().entries {
            if matches!(entry.acquisition, Acquisition::Binary { .. }) {
                assert!(
                    !entry
                        .setup
                        .iter()
                        .any(|s| matches!(s, SetupStep::Command { .. })),
                    "{} is a binary entry with a command step",
                    entry.id
                );
            }
        }
    }
}
