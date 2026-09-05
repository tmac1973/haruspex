//! Installing a catalog server onto the machine.
//!
//! Modelled on `ModelManager` in `models.rs`, which already solves this exact
//! problem for model weights: staged download, checksum verification, progress
//! events the UI can draw a bar from, cancellation, and cleanup of a failed
//! partial. The `DownloadProgress` struct is reused rather than cloned, on a
//! separate event channel.
//!
//! # Installs are explicit and up front
//!
//! Never `npx -y` at launch. That single decision is what makes launches
//! offline-capable, fast and version-pinned, and it is what turns an install
//! failure into a progress bar with an error message instead of opaque npm
//! output in the middle of a conversation. It is also why the catalog pins
//! exact versions rather than ranges.
//!
//! # One directory per server
//!
//! `<app_data>/mcp/servers/<server-id>/` holds everything a server owns: its
//! package tree, its virtualenv, its credentials file. Uninstall is therefore a
//! directory removal plus one settings entry, with nothing left behind in a
//! shared location to rot.
//!
//! Installation happens in `<server-id>.installing` and is renamed into place
//! only on success, so a cancelled or failed install leaves nothing that looks
//! like a working server.

use futures_util::StreamExt;
use log::info;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::catalog::{resolve_env, Acquisition, CatalogEntry};
use super::process::SpawnConfig;
use super::server_config::{McpServerConfig, McpServerSource};
use crate::models::DownloadProgress;
use crate::runtimes;

/// Progress events land here rather than on `download-progress`, so a model
/// download and a server install can be in flight at once without the two
/// progress bars fighting.
pub const INSTALL_PROGRESS_EVENT: &str = "mcp-install-progress";

/// Suffix for the staging directory. Never a valid server id, because ids come
/// from the catalog and are plain slugs.
const STAGING_SUFFIX: &str = ".installing";

/// Placeholder an entry's `env` can use for the server's own directory.
const SERVER_DIR_PLACEHOLDER: &str = "$serverDir";

/// Tauri-managed install state: just the cancel flag, so an in-flight install
/// can be stopped from the UI.
#[derive(Default)]
pub struct McpInstaller {
    cancel: Mutex<bool>,
}

impl McpInstaller {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn cancel(&self) {
        *self.cancel.lock().await = true;
    }

    async fn reset_cancel(&self) {
        *self.cancel.lock().await = false;
    }

    async fn cancelled(&self) -> bool {
        *self.cancel.lock().await
    }

    /// Install a catalog entry into this server's own directory.
    ///
    /// Any failure — including cancellation — removes the staging directory, so
    /// a retry starts clean and a half-installed server never becomes
    /// startable.
    pub async fn install(
        &self,
        app: &AppHandle,
        entry: &CatalogEntry,
        server_id: &str,
    ) -> Result<PathBuf, String> {
        self.reset_cancel().await;
        let final_dir = server_dir(app, server_id)?;
        let staging = staging_dir(&final_dir);

        let _ = tokio::fs::remove_dir_all(&staging).await;
        tokio::fs::create_dir_all(&staging)
            .await
            .map_err(|e| format!("could not create {}: {e}", staging.display()))?;

        let result = self.install_into(app, entry, &staging).await;

        match result {
            Ok(()) => {
                let _ = tokio::fs::remove_dir_all(&final_dir).await;
                tokio::fs::rename(&staging, &final_dir)
                    .await
                    .map_err(|e| format!("could not finalize install: {e}"))?;
                info!("mcp: installed {} for server {server_id}", entry.id);
                emit(app, "Installed", 1, 1);
                Ok(final_dir)
            }
            Err(e) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                Err(e)
            }
        }
    }

    async fn install_into(
        &self,
        app: &AppHandle,
        entry: &CatalogEntry,
        dir: &Path,
    ) -> Result<(), String> {
        match &entry.acquisition {
            Acquisition::Npm {
                package, version, ..
            } => {
                emit(app, &format!("Installing {package}"), 0, 0);
                let mut cmd = runtimes::npm_command(app)?;
                cmd.args([
                    "install",
                    "--prefix",
                    &dir.to_string_lossy(),
                    "--no-audit",
                    "--no-fund",
                    &format!("{package}@{version}"),
                ]);
                run_to_completion(cmd, "npm install").await
            }
            Acquisition::Pypi {
                package, version, ..
            } => {
                emit(app, &format!("Installing {package}"), 0, 0);
                let venv = dir.join("venv");
                let mut create = runtimes::uv_command()?;
                create.args(["venv", &venv.to_string_lossy()]);
                run_to_completion(create, "uv venv").await?;

                let mut install = runtimes::uv_command()?;
                install.args([
                    "pip",
                    "install",
                    "--python",
                    &venv_python(&venv).to_string_lossy(),
                    &format!("{package}=={version}"),
                ]);
                run_to_completion(install, "uv pip install").await
            }
            Acquisition::Binary {
                repo,
                version,
                assets,
                sha256,
                executable,
            } => {
                let triple = host_triple();
                let asset = assets.get(&triple).ok_or_else(|| {
                    format!("{} does not publish a build for {triple}", entry.name)
                })?;
                // Validation guarantees a checksum exists for every listed
                // asset, so this only fires on a catalog edited past it.
                let expected = sha256
                    .get(&triple)
                    .ok_or_else(|| format!("no checksum recorded for {triple}"))?;

                let url = format!("https://github.com/{repo}/releases/download/{version}/{asset}");
                let archive = dir.join(asset);
                self.download(app, &url, &archive, &format!("Downloading {}", entry.name))
                    .await?;

                emit(app, "Verifying download", 0, 0);
                let actual = sha256_of(&archive).await?;
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(format!(
                        "checksum mismatch for {asset}: expected {expected}, got {actual}"
                    ));
                }

                emit(app, "Extracting", 0, 0);
                extract(&archive, dir)?;
                tokio::fs::remove_file(&archive).await.ok();

                let exe = dir.join(exe_name(executable));
                if !exe.is_file() {
                    return Err(format!(
                        "{} was not in the downloaded archive",
                        exe_name(executable)
                    ));
                }
                make_executable(&exe)?;
                Ok(())
            }
        }
    }

    /// Stream a URL to a file, emitting progress and honouring cancellation.
    async fn download(
        &self,
        app: &AppHandle,
        url: &str,
        dest: &Path,
        stage: &str,
    ) -> Result<(), String> {
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("download failed with status {}", response.status()));
        }
        let total = response.content_length().unwrap_or(0);

        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("could not write {}: {e}", dest.display()))?;
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        let mut last_emit = std::time::Instant::now();

        while let Some(chunk) = stream.next().await {
            if self.cancelled().await {
                drop(file);
                let _ = tokio::fs::remove_file(dest).await;
                return Err("Install cancelled".into());
            }
            let chunk = chunk.map_err(|e| format!("download error: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write error: {e}"))?;
            downloaded += chunk.len() as u64;
            if last_emit.elapsed().as_millis() >= 100 {
                emit(app, stage, downloaded, total);
                last_emit = std::time::Instant::now();
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("flush error: {e}"))?;
        emit(app, stage, downloaded, total);
        Ok(())
    }
}

/// `<app_data>/mcp/servers/`.
pub fn servers_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("mcp")
        .join("servers"))
}

pub fn server_dir(app: &AppHandle, server_id: &str) -> Result<PathBuf, String> {
    Ok(servers_root(app)?.join(server_id))
}

fn staging_dir(final_dir: &Path) -> PathBuf {
    let mut name = final_dir.as_os_str().to_os_string();
    name.push(STAGING_SUFFIX);
    PathBuf::from(name)
}

/// Copy a file the user picked into a server's directory, under the name the
/// catalog entry asked for.
///
/// Copied rather than referenced: the original is somewhere in the user's
/// Downloads folder and will be tidied away eventually, and a credentials file
/// that vanishes three weeks later produces a failure nobody connects to the
/// cleanup. The server directory is the one place whose lifetime we control.
pub async fn place_setup_file(
    app: &AppHandle,
    server_id: &str,
    source: &Path,
    filename: &str,
) -> Result<(), String> {
    // The name comes from the catalog, but a badly edited catalog must not be
    // able to write outside the server's own directory.
    if !is_plain_filename(filename) {
        return Err(format!("'{filename}' is not a plain file name"));
    }
    let dir = server_dir(app, server_id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    tokio::fs::copy(source, dir.join(filename))
        .await
        .map_err(|e| format!("could not copy {}: {e}", source.display()))?;
    Ok(())
}

/// One path component, no separators, no `..`, no root.
fn is_plain_filename(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    let path = Path::new(name);
    path.components().count() == 1 && path.file_name().is_some_and(|f| f == name)
}

/// Remove a server's directory. Missing is success — uninstall is idempotent,
/// and a settings entry outliving its directory is exactly the state this is
/// called to clean up.
pub async fn uninstall(app: &AppHandle, server_id: &str) -> Result<(), String> {
    let dir = server_dir(app, server_id)?;
    let staging = staging_dir(&dir);
    let _ = tokio::fs::remove_dir_all(&staging).await;
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("could not remove {}: {e}", dir.display())),
    }
}

/// Build the spawn configuration for a configured server.
///
/// Both tiers land here. A tier-3 custom server is a program path the user
/// typed; a catalog server goes through [`catalog_spawn_config`]. Refusing a
/// server that is not startable here rather than at spawn time is what turns
/// "it did nothing" into "finish the setup first".
pub fn spawn_config_for(app: &AppHandle, config: &McpServerConfig) -> Result<SpawnConfig, String> {
    if !config.is_startable() {
        return Err(if config.enabled {
            format!("{} has not finished its setup", config.label)
        } else {
            format!("{} is turned off", config.label)
        });
    }
    build_spawn_config(app, config)
}

/// The same resolution, with the entry's own arguments replaced and the
/// startable check skipped.
///
/// Guided setup runs the installed program *before* setup is complete — that is
/// what a `command` step is — so the check that protects a normal start would
/// make the step that satisfies it impossible. And the entry's `command.args`
/// are for running the *server*; a setup step supplies its own, where an empty
/// list is meaningful (Google's auth step runs the program bare, which is what
/// triggers the browser flow).
pub fn setup_command_config(
    app: &AppHandle,
    config: &McpServerConfig,
    args: Vec<String>,
) -> Result<SpawnConfig, String> {
    let mut spawn = build_spawn_config(app, config)?;
    let entry_args = catalog_command_args(config);
    spawn
        .args
        .truncate(spawn.args.len().saturating_sub(entry_args.len()));
    spawn.args.extend(args);
    Ok(spawn)
}

/// The trailing arguments `build_spawn_config` appended from the catalog entry.
fn catalog_command_args(config: &McpServerConfig) -> Vec<String> {
    let McpServerSource::Catalog { entry_id } = &config.source else {
        return Vec::new();
    };
    super::catalog::load()
        .ok()
        .and_then(|c| c.entry(entry_id).map(|e| e.command.args.clone()))
        .unwrap_or_default()
}

fn build_spawn_config(app: &AppHandle, config: &McpServerConfig) -> Result<SpawnConfig, String> {
    match &config.source {
        // A remote server is not spawned at all. Reaching here means a caller
        // branched wrong, and saying so beats fabricating a command.
        McpServerSource::Remote { .. } => Err(format!(
            "{} is a remote server; there is nothing to launch on this machine",
            config.label
        )),
        McpServerSource::Custom { program, args } => Ok(SpawnConfig {
            id: config.id.clone(),
            program: PathBuf::from(program),
            args: args.clone(),
            // A custom server has no catalog entry to declare an environment,
            // and inheriting ours would undo the guarantee in process.rs that a
            // server behaves the same everywhere.
            env: Vec::new(),
            cwd: server_dir(app, &config.id).ok(),
        }),
        McpServerSource::Catalog { entry_id } => {
            let catalog = super::catalog::load()?;
            let entry = catalog
                .entry(entry_id)
                .ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
            catalog_spawn_config(app, entry, &config.id, &config.secrets)
        }
    }
}

/// Build the spawn configuration for an installed catalog server.
///
/// This is where the acquisition kind stops mattering: all three produce an
/// absolute program path and an argument list, and nothing downstream needs to
/// know which one it came from.
pub fn catalog_spawn_config(
    app: &AppHandle,
    entry: &CatalogEntry,
    server_id: &str,
    secrets: &BTreeMap<String, String>,
) -> Result<SpawnConfig, String> {
    let dir = server_dir(app, server_id)?;
    let (program, mut args) = match &entry.acquisition {
        // `node <entry point>`, never npm's `.bin` shim: the shim resolves its
        // own interpreter off `PATH`, and a `PATH` we do not control is how a
        // working install becomes a broken one on someone else's machine.
        Acquisition::Npm { bin, .. } => (
            runtimes::node_path()?,
            vec![dir
                .join("node_modules")
                .join(bin)
                .to_string_lossy()
                .to_string()],
        ),
        Acquisition::Pypi { entrypoint, .. } => (
            venv_bin(&dir.join("venv")).join(exe_name(entrypoint)),
            Vec::new(),
        ),
        Acquisition::Binary { executable, .. } => (dir.join(exe_name(executable)), Vec::new()),
    };
    args.extend(entry.command.args.iter().cloned());

    let mut env = resolve_env(entry, secrets)?;
    substitute_server_dir(&mut env, &dir);

    Ok(SpawnConfig {
        id: server_id.to_string(),
        program,
        args,
        env,
        cwd: Some(dir),
    })
}

/// Replace the `$serverDir` placeholder with the server's own directory.
///
/// A server that needs a config or credentials directory has to be told where
/// its one is, and the guided setup's `file` step writes into exactly that
/// place. Whole-value only, like `$secret.*`: a partial match would make a
/// literal path containing the token unrepresentable.
fn substitute_server_dir(env: &mut [(String, String)], dir: &Path) {
    for (_, value) in env.iter_mut() {
        if value == SERVER_DIR_PLACEHOLDER {
            *value = dir.to_string_lossy().to_string();
        }
    }
}

/// The Rust target triple this build runs on, matching the keys the catalog
/// uses for per-platform assets.
pub fn host_triple() -> String {
    // Composed rather than read from a build script: `TARGET` is only exposed
    // to build scripts, and the pieces are stable.
    let arch = std::env::consts::ARCH;
    match std::env::consts::OS {
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        other => format!("{arch}-unknown-{other}"),
    }
}

fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn venv_bin(venv: &Path) -> PathBuf {
    venv.join(if cfg!(windows) { "Scripts" } else { "bin" })
}

fn venv_python(venv: &Path) -> PathBuf {
    venv_bin(venv).join(exe_name("python"))
}

fn emit(app: &AppHandle, stage: &str, downloaded: u64, total: u64) {
    let _ = app.emit(
        INSTALL_PROGRESS_EVENT,
        DownloadProgress {
            downloaded,
            total,
            speed_bps: 0,
            stage: stage.to_string(),
        },
    );
}

/// Run a runtime command, failing with its own output.
///
/// npm and uv say useful things on failure; swallowing them would leave the UI
/// with "install failed" and the user with nothing to act on.
async fn run_to_completion(mut cmd: tokio::process::Command, what: &str) -> Result<(), String> {
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("{what} could not run: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let all: Vec<&str> = stderr.lines().collect();
    let tail = &all[all.len().saturating_sub(10)..];
    Err(format!("{what} failed: {}", tail.join(" | ")))
}

async fn sha256_of(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("read error: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Unpack a release asset. `.tar.gz` everywhere but Windows, `.zip` there.
fn extract(archive: &Path, dest: &Path) -> Result<(), String> {
    let name = archive.to_string_lossy().to_lowercase();
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive).map_err(|e| format!("could not open zip: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("bad zip: {e}"))?;
        zip.extract(dest)
            .map_err(|e| format!("could not extract zip: {e}"))
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = std::fs::File::open(archive).map_err(|e| format!("could not open tar: {e}"))?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        tar.unpack(dest)
            .map_err(|e| format!("could not extract tar: {e}"))
    } else {
        Err(format!(
            "unsupported archive format: {}",
            archive.file_name().unwrap_or_default().to_string_lossy()
        ))
    }
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("could not stat {}: {e}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("could not chmod {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_host_triple_matches_the_keys_the_catalog_uses() {
        let triple = host_triple();
        // The bundled GitHub entry has to have an asset for whatever we are
        // built as, or this platform silently cannot install it.
        let catalog = super::super::catalog::load().unwrap();
        let entry = catalog.entry("github").unwrap();
        let Acquisition::Binary { assets, .. } = &entry.acquisition else {
            panic!("the GitHub entry is the binary-kind example");
        };
        assert!(
            assets.contains_key(&triple),
            "no GitHub asset for {triple}; assets are {:?}",
            assets.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_staging_directory_is_a_sibling_that_can_never_be_a_server_id() {
        let staging = staging_dir(Path::new("/data/mcp/servers/github"));
        assert_eq!(
            staging,
            PathBuf::from("/data/mcp/servers/github.installing")
        );
        assert!(
            !staging.ends_with("github"),
            "a rename into place must actually move it"
        );
    }

    #[test]
    fn an_unknown_archive_format_is_refused_rather_than_guessed_at() {
        let dir = std::env::temp_dir().join("haruspex_mcp_extract_test");
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("server.bin");
        std::fs::write(&bogus, b"not an archive").unwrap();
        let err = extract(&bogus, &dir).expect_err("we do not know how to unpack this");
        assert!(err.contains("unsupported archive format"), "got {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sha256_matches_a_known_value() {
        let dir = std::env::temp_dir().join("haruspex_mcp_sha_test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("payload");
        std::fs::write(&path, b"abc").unwrap();
        let digest = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(sha256_of(&path))
            .unwrap();
        assert_eq!(
            digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_server_directory_placeholder_is_substituted_whole() {
        let mut env = vec![
            ("CREDS".to_string(), SERVER_DIR_PLACEHOLDER.to_string()),
            ("MODE".to_string(), "stdio".to_string()),
            // A literal that merely mentions the token stays literal, the same
            // rule `$secret.*` follows.
            ("NOTE".to_string(), "under $serverDir/creds".to_string()),
        ];
        substitute_server_dir(&mut env, Path::new("/data/mcp/servers/x"));
        assert_eq!(env[0].1, "/data/mcp/servers/x");
        assert_eq!(env[1].1, "stdio");
        assert_eq!(env[2].1, "under $serverDir/creds");
    }

    #[test]
    fn the_google_entry_asks_for_its_own_directory() {
        // The file step writes gcp-oauth.keys.json into the server directory,
        // so the server has to be told where that is or it will look in the
        // process's cwd and find nothing.
        let catalog = super::super::catalog::load().unwrap();
        let entry = catalog.entry("google-workspace").unwrap();
        assert_eq!(
            entry
                .command
                .env
                .get("GDRIVE_CREDS_DIR")
                .map(String::as_str),
            Some(SERVER_DIR_PLACEHOLDER)
        );
    }

    #[test]
    fn a_venv_layout_differs_per_platform_but_resolves_consistently() {
        let venv = Path::new("/srv/mcp/servers/x/venv");
        let bin = venv_bin(venv);
        if cfg!(windows) {
            assert!(bin.ends_with("Scripts"));
            assert!(venv_python(venv).ends_with("python.exe"));
        } else {
            assert!(bin.ends_with("bin"));
            assert!(venv_python(venv).ends_with("python"));
        }
    }
}
