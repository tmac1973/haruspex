//! Resolving the bundled Node/npm and uv runtimes.
//!
//! MCP servers are third-party programs published to npm or PyPI. Shipping the
//! runtimes that install and launch them is what lets a non-technical user add
//! an integration without ever opening a terminal — see
//! `plan/integrations-expansion/phase-01-bundled-runtimes.md`. `uv` provisions
//! its own CPython on demand, so Python itself is not bundled.
//!
//! **Why paths rather than `app.shell().sidecar(...)`.** `lint.rs` runs ruff
//! through the Tauri shell plugin because all it wants is the output. MCP needs
//! a long-lived child whose stdin/stdout *are* the protocol transport, spawned
//! by rmcp from a `tokio::process::Command`, so this module hands back real
//! filesystem paths instead.
//!
//! **Layouts.** Tauri copies `bundle.externalBin` entries next to the running
//! executable — `target/debug/haruspex-node` under `tauri dev`, the install's
//! bin directory when packaged — so one lookup covers both. The npm tree is a
//! bundle *resource*, and resources are not staged into `target/` during dev,
//! so it follows the source-tree-first pattern `shell::integration_dir` already
//! uses.
//!
//! **Why every bundled binary is `haruspex-` prefixed.** That install bin
//! directory is `/usr/bin` on Linux: the deb and rpm bundlers put the app and
//! all of its sidecars there, under the externalBin stem with the target
//! triple stripped. Shipping a file called `node` or `uv` means claiming a
//! name the distribution has already given to a real package, and rpm refuses
//! the whole transaction rather than let two packages own one path — so the
//! app would not install at all on a machine that has nodejs or uv. The prefix
//! keeps us inside our own namespace. [`node_shim_dir`] covers the one thing
//! it costs.
//!
//! **npm is never a shim.** It is invoked as `node <npm-cli.js>`. The platform
//! `npm` / `npm.cmd` wrappers resolve their own interpreter off `PATH`, and a
//! `PATH` we do not control is exactly how a "works on my machine" bug reaches
//! someone else's install. For the same reason every spawned runtime gets a
//! scrubbed environment rather than inheriting the user's shell.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

/// Environment variables that redirect where a runtime looks for its
/// interpreter, its global prefix or its cache. Inheriting any of these from
/// the user's shell makes a bundled runtime behave differently on their machine
/// than on ours, so they are stripped from every spawn.
const SCRUBBED_ENV_PREFIXES: [&str; 3] = ["NODE_", "NPM_CONFIG_", "UV_"];

/// Which bundled runtimes actually resolved.
///
/// The settings UI shows this so a broken install is explained up front, with
/// the acquisition kinds it breaks disabled — rather than letting the failure
/// surface as a spawn error in the middle of a conversation.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAvailability {
    pub node: bool,
    pub npm: bool,
    pub uv: bool,
}

impl RuntimeAvailability {
    /// True when everything needed to install and launch an MCP server is
    /// present. npm without node is useless, so this is not just a count.
    #[cfg(test)]
    pub fn is_complete(&self) -> bool {
        self.node && self.npm && self.uv
    }

    /// The runtimes that are missing, for a message the user can act on. The
    /// frontend composes the message; this is the fact it needs.
    #[cfg(test)]
    pub fn missing(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if !self.node {
            out.push("node");
        }
        if !self.npm {
            out.push("npm");
        }
        if !self.uv {
            out.push("uv");
        }
        out
    }
}

/// A bundled executable's on-disk name for this platform.
fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// The file name a tool is bundled under, from the name it is known by.
///
/// Every `bundle.externalBin` entry carries this prefix; see the module docs
/// on why `node` and `uv` cannot be shipped under their own names.
fn bundled_stem(tool: &str) -> String {
    format!("haruspex-{tool}")
}

/// Look for a Tauri-staged sidecar directly inside `dir`. Tauri strips the
/// target triple when it copies `externalBin`, so the name is the bare stem.
fn binary_in(dir: &Path, stem: &str) -> Option<PathBuf> {
    let candidate = dir.join(exe_name(stem));
    candidate.is_file().then_some(candidate)
}

/// Look for the un-staged, triple-suffixed copy the fetch scripts write into
/// `src-tauri/binaries/`. Only used as a debug fallback: it covers `cargo run`
/// and `cargo test` outside `tauri dev`, where nothing has staged the sidecars.
///
/// Directories are skipped rather than matched. `node-modules` no longer
/// shares a prefix with `haruspex-node-`, but a bundled stem that happens to
/// prefix a sibling directory must not be handed back as an interpreter.
///
/// Gated to match its only callers. A release build stages every sidecar beside
/// the executable, so reaching back into the source tree there would mean
/// reading a developer's checkout on a user's machine — and without the gate it
/// is dead code that warns on every release build.
#[cfg(any(debug_assertions, test))]
fn binary_in_source_tree(binaries_dir: &Path, stem: &str) -> Option<PathBuf> {
    let prefix = format!("{stem}-");
    let mut matches: Vec<PathBuf> = std::fs::read_dir(binaries_dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    // Sorted so a machine holding several cross-compiled copies resolves the
    // same one every run instead of following readdir order.
    matches.sort();
    matches.into_iter().next()
}

/// `npm/bin/npm-cli.js` beneath a candidate `node-modules` parent, if present.
fn npm_cli_under(node_modules_dir: &Path) -> Option<PathBuf> {
    let candidate = node_modules_dir.join("npm").join("bin").join("npm-cli.js");
    candidate.is_file().then_some(candidate)
}

/// The directory Tauri staged the sidecars into: the running executable's own.
fn staged_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(|p| p.to_path_buf())
}

/// `src-tauri/binaries/` in the source tree.
fn source_binaries_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries")
}

fn resolve_binary(tool: &str) -> Result<PathBuf, String> {
    let stem = bundled_stem(tool);
    if let Some(dir) = staged_dir() {
        if let Some(found) = binary_in(&dir, &stem) {
            return Ok(found);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(found) = binary_in_source_tree(&source_binaries_dir(), &stem) {
        return Ok(found);
    }
    Err(format!(
        "bundled {tool} not found — run ./scripts/dev-setup.sh --skip-build --skip-models, \
         or reinstall the app"
    ))
}

/// Absolute path to the bundled Node interpreter.
///
/// Takes no `AppHandle`: externalBin sidecars sit next to the running
/// executable, which `current_exe()` already knows. Only `npm_cli_path` needs
/// the handle, because the npm tree is a bundle *resource*.
pub fn node_path() -> Result<PathBuf, String> {
    resolve_binary("node")
}

/// Absolute path to the bundled `uv`. See [`node_path`] on the missing handle.
pub fn uv_path() -> Result<PathBuf, String> {
    resolve_binary("uv")
}

/// Absolute path to npm's CLI entry point, `npm/bin/npm-cli.js`.
///
/// Checks the source tree first in debug builds: bundle resources are not
/// staged into `target/` during `tauri dev`, and a stale staged copy would
/// otherwise shadow a freshly fetched one.
pub fn npm_cli_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Some(found) = npm_cli_under(&source_binaries_dir().join("node-modules")) {
        return Ok(found);
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri 2 sometimes flattens the resource layout, so try the leaf too.
        for candidate in [
            resource_dir.join("binaries").join("node-modules"),
            resource_dir.join("node-modules"),
        ] {
            if let Some(found) = npm_cli_under(&candidate) {
                return Ok(found);
            }
        }
    }
    #[cfg(not(debug_assertions))]
    if let Some(found) = npm_cli_under(&source_binaries_dir().join("node-modules")) {
        return Ok(found);
    }
    Err(
        "bundled npm not found — run ./scripts/dev-setup.sh --skip-build --skip-models, \
         or reinstall the app"
            .to_string(),
    )
}

/// Point `link` at `target`, cheaply and idempotently.
///
/// A symlink where there is one to be had. [`crate::image_engine::colocate`]
/// copies for the same job, but it moves a 2 MB binary; Node is ~110 MB, and
/// duplicating that into the user's data directory to work around a naming
/// rule is not a trade worth making. Windows needs privileges for symlinks, so
/// it gets a hard link and falls back to a copy across volumes.
#[cfg(unix)]
fn place_shim(target: &Path, link: &Path) -> std::io::Result<()> {
    if std::fs::read_link(link).is_ok_and(|current| current == target) {
        return Ok(());
    }
    let _ = std::fs::remove_file(link);
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn place_shim(target: &Path, link: &Path) -> std::io::Result<()> {
    // Size, as `colocate` does: enough to notice that an app upgrade replaced
    // the interpreter this link was made from.
    let same = match (std::fs::metadata(target), std::fs::metadata(link)) {
        (Ok(a), Ok(b)) => a.len() == b.len(),
        _ => false,
    };
    if same {
        return Ok(());
    }
    let _ = std::fs::remove_file(link);
    std::fs::hard_link(target, link).or_else(|_| std::fs::copy(target, link).map(|_| ()))
}

/// A directory holding the bundled Node under the name `node`, for npm's own
/// children to find.
///
/// The one cost of the `haruspex-` prefix (see the module docs). npm puts
/// `dirname(process.execPath)` on the `PATH` it gives a lifecycle script and
/// then lets the script call plain `node`; that resolved before the prefix
/// only because the unprefixed copy was sitting in `/usr/bin`, which is to say
/// it worked by way of the packaging bug. A link under our own data directory
/// restores it without claiming a name the distribution owns.
///
/// This is the deliberate exception to "never a `PATH` we do not control": the
/// directory is one we create, holding one entry we put there, and it is
/// *prepended*, so it wins over whatever node the user's shell would find.
///
/// Best effort — `None` costs a lifecycle script its interpreter, and an
/// install with no build hooks still succeeds, which is most of them.
fn node_shim_dir(app: &AppHandle) -> Option<PathBuf> {
    let node = node_path().ok()?;
    let dir = app.path().app_local_data_dir().ok()?.join("runtime-bin");
    std::fs::create_dir_all(&dir).ok()?;
    let link = dir.join(exe_name("node"));
    place_shim(&node, &link).ok()?;
    Some(dir)
}

/// Prepend `dir` to the `PATH` the child will see.
fn prepend_path(cmd: &mut Command, dir: &Path) {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![dir.to_path_buf()];
    entries.extend(std::env::split_paths(&existing));
    if let Ok(joined) = std::env::join_paths(entries) {
        cmd.env("PATH", joined);
    }
}

/// Strip every environment variable that could redirect a bundled runtime
/// somewhere we did not put it. Applied to every runtime spawn.
fn scrub_runtime_env(cmd: &mut Command) {
    for (key, _) in std::env::vars() {
        if SCRUBBED_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
        {
            cmd.env_remove(&key);
        }
    }
}

/// A command that runs npm through the bundled Node: `node <npm-cli.js>`.
/// Callers append npm's own arguments.
pub fn npm_command(app: &AppHandle) -> Result<Command, String> {
    let node = node_path()?;
    let npm_cli = npm_cli_path(app)?;
    let mut cmd = Command::new(node);
    cmd.arg(npm_cli);
    scrub_runtime_env(&mut cmd);
    if let Some(shim) = node_shim_dir(app) {
        prepend_path(&mut cmd, &shim);
    }
    Ok(cmd)
}

/// A command that runs the bundled `uv`. Callers append uv's own arguments.
pub fn uv_command() -> Result<Command, String> {
    let mut cmd = Command::new(uv_path()?);
    scrub_runtime_env(&mut cmd);
    Ok(cmd)
}

/// Which runtimes resolved on this install.
#[tauri::command]
pub async fn mcp_runtimes_available(app: AppHandle) -> Result<RuntimeAvailability, String> {
    Ok(runtimes_available(&app))
}

fn runtimes_available(app: &AppHandle) -> RuntimeAvailability {
    RuntimeAvailability {
        node: node_path().is_ok(),
        npm: npm_cli_path(app).is_ok(),
        uv: uv_path().is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_runtimes_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"").unwrap();
    }

    #[test]
    fn binary_in_finds_a_staged_sidecar() {
        let dir = temp_dir("staged");
        let node = exe_name(&bundled_stem("node"));
        touch(&dir.join(&node));
        assert_eq!(
            binary_in(&dir, &bundled_stem("node")),
            Some(dir.join(&node)),
            "the staged layout drops the target triple"
        );
        assert_eq!(binary_in(&dir, &bundled_stem("uv")), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn binary_in_ignores_directories() {
        let dir = temp_dir("staged_dir");
        fs::create_dir_all(dir.join(exe_name(&bundled_stem("node")))).unwrap();
        assert_eq!(
            binary_in(&dir, &bundled_stem("node")),
            None,
            "a directory named haruspex-node is not an interpreter"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_matches_the_triple_suffix() {
        let dir = temp_dir("source");
        touch(&dir.join("haruspex-node-x86_64-unknown-linux-gnu"));
        touch(&dir.join("haruspex-uv-x86_64-unknown-linux-gnu"));
        assert_eq!(
            binary_in_source_tree(&dir, &bundled_stem("node")),
            Some(dir.join("haruspex-node-x86_64-unknown-linux-gnu"))
        );
        assert_eq!(
            binary_in_source_tree(&dir, &bundled_stem("uv")),
            Some(dir.join("haruspex-uv-x86_64-unknown-linux-gnu"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_never_returns_a_directory() {
        // A bundled stem that prefixes a sibling directory must not be handed
        // back as an interpreter. `node-modules/` was that sibling before the
        // `haruspex-` prefix separated them.
        let dir = temp_dir("source_npm");
        fs::create_dir_all(dir.join("haruspex-node-modules")).unwrap();
        assert_eq!(binary_in_source_tree(&dir, &bundled_stem("node")), None);
        touch(&dir.join("haruspex-node-aarch64-apple-darwin"));
        assert_eq!(
            binary_in_source_tree(&dir, &bundled_stem("node")),
            Some(dir.join("haruspex-node-aarch64-apple-darwin"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_is_stable_across_several_cross_builds() {
        let dir = temp_dir("source_multi");
        touch(&dir.join("haruspex-node-x86_64-unknown-linux-gnu"));
        touch(&dir.join("haruspex-node-aarch64-apple-darwin"));
        let first = binary_in_source_tree(&dir, &bundled_stem("node"));
        assert_eq!(first, binary_in_source_tree(&dir, &bundled_stem("node")));
        assert_eq!(first, Some(dir.join("haruspex-node-aarch64-apple-darwin")));
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The regression guard for the packaging bug this prefix exists to fix.
    ///
    /// The deb and rpm bundlers install every `externalBin` into `/usr/bin`
    /// under its stem with the triple stripped, and rpm fails the whole
    /// transaction when two packages claim one path. `node`, `uv`, `ruff`,
    /// `llama-server` and `koko` are all names Fedora ships packages for, so
    /// an unprefixed entry here is an app that cannot be installed.
    #[test]
    fn every_bundled_binary_stays_out_of_the_distro_namespace() {
        let conf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&conf).unwrap()).unwrap();
        let external = parsed["bundle"]["externalBin"].as_array().unwrap();
        assert!(!external.is_empty(), "externalBin should not be empty");
        for entry in external {
            let path = entry.as_str().unwrap();
            let stem = path.rsplit('/').next().unwrap();
            assert!(
                stem.starts_with("haruspex-"),
                "externalBin {path} installs /usr/bin/{stem}, a name we do not own"
            );
        }
    }

    #[test]
    fn a_shim_link_resolves_to_the_bundled_interpreter() {
        let dir = temp_dir("shim");
        let real = dir.join(exe_name(&bundled_stem("node")));
        touch(&real);
        let link = dir.join(exe_name("node"));
        place_shim(&real, &link).unwrap();
        assert!(link.exists(), "npm's children need a plain `node` to find");
        // Idempotent: repeated npm commands must not churn the link.
        place_shim(&real, &link).unwrap();
        assert!(link.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_shim_directory_wins_over_the_users_own_node() {
        let dir = temp_dir("shim_path");
        let mut cmd = Command::new("true");
        prepend_path(&mut cmd, &dir);
        let path = cmd
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, v)| v)
            .expect("PATH should be set")
            .to_owned();
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, dir, "the shim must come before the ambient PATH");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn npm_cli_lookup_wants_the_real_entry_point() {
        let dir = temp_dir("npm");
        assert_eq!(npm_cli_under(&dir), None);
        // A tree that exists but has no CLI entry point is not usable.
        fs::create_dir_all(dir.join("npm").join("bin")).unwrap();
        assert_eq!(npm_cli_under(&dir), None);
        touch(&dir.join("npm").join("bin").join("npm-cli.js"));
        assert_eq!(
            npm_cli_under(&dir),
            Some(dir.join("npm").join("bin").join("npm-cli.js"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn availability_reports_what_is_missing() {
        let all = RuntimeAvailability {
            node: true,
            npm: true,
            uv: true,
        };
        assert!(all.is_complete());
        assert!(all.missing().is_empty());

        let no_npm = RuntimeAvailability {
            node: true,
            npm: false,
            uv: true,
        };
        assert!(!no_npm.is_complete(), "node alone cannot install a server");
        assert_eq!(no_npm.missing(), vec!["npm"]);

        let none = RuntimeAvailability {
            node: false,
            npm: false,
            uv: false,
        };
        assert_eq!(none.missing(), vec!["node", "npm", "uv"]);
    }

    #[test]
    fn scrubbed_prefixes_cover_the_redirect_variables() {
        // The named variables are the ones that actually relocate a runtime;
        // this asserts the prefix list still catches each of them.
        for var in [
            "NODE_PATH",
            "NODE_OPTIONS",
            "NPM_CONFIG_PREFIX",
            "NPM_CONFIG_REGISTRY",
            "UV_PYTHON",
            "UV_CACHE_DIR",
        ] {
            assert!(
                SCRUBBED_ENV_PREFIXES.iter().any(|p| var.starts_with(p)),
                "{var} would be inherited from the user's shell"
            );
        }
        assert!(
            !SCRUBBED_ENV_PREFIXES.iter().any(|p| "PATH".starts_with(p)),
            "PATH itself must survive — the child still needs a system PATH"
        );
    }
}
