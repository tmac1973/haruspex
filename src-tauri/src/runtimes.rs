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
//! executable — `target/debug/node` under `tauri dev`, the install's bin
//! directory when packaged — so one lookup covers both. The npm tree is a
//! bundle *resource*, and resources are not staged into `target/` during dev,
//! so it follows the source-tree-first pattern `shell::integration_dir` already
//! uses.
//!
//! **npm is never a shim.** It is invoked as `node <npm-cli.js>`. The platform
//! `npm` / `npm.cmd` wrappers resolve their own interpreter off `PATH`, and a
//! `PATH` we do not control is exactly how a "works on my machine" bug reaches
//! someone else's install. For the same reason every spawned runtime gets a
//! scrubbed environment rather than inheriting the user's shell.

// Nothing consumes this module until Phase 02 spawns its first MCP server; the
// runtimes are bundled first because they are long-lead work (per-platform
// binaries, bundle config, CI). Drop this attribute in that phase.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

/// Environment variables that redirect where a runtime looks for its
/// interpreter, its global prefix or its cache. Inheriting any of these from
/// the user's shell makes a bundled runtime behave differently on their machine
/// than on ours, so they are stripped from every spawn.
const SCRUBBED_ENV_PREFIXES: [&str; 3] = ["NODE_", "NPM_CONFIG_", "UV_"];

/// Which bundled runtimes actually resolved. Phase 06's settings UI uses this
/// to explain a broken install up front rather than letting the failure surface
/// as a spawn error in the middle of a conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeAvailability {
    pub node: bool,
    pub npm: bool,
    pub uv: bool,
}

impl RuntimeAvailability {
    /// True when everything needed to install and launch an MCP server is
    /// present. npm without node is useless, so this is not just a count.
    pub fn is_complete(&self) -> bool {
        self.node && self.npm && self.uv
    }

    /// The runtimes that are missing, for a message the user can act on.
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
/// `node-modules` lives in the same directory and shares the `node-` prefix, so
/// directories are skipped rather than matched.
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

fn resolve_binary(stem: &str) -> Result<PathBuf, String> {
    if let Some(dir) = staged_dir() {
        if let Some(found) = binary_in(&dir, stem) {
            return Ok(found);
        }
    }
    #[cfg(debug_assertions)]
    if let Some(found) = binary_in_source_tree(&source_binaries_dir(), stem) {
        return Ok(found);
    }
    Err(format!(
        "bundled {stem} not found — run ./scripts/dev-setup.sh --skip-build --skip-models, \
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
    Ok(cmd)
}

/// A command that runs the bundled `uv`. Callers append uv's own arguments.
pub fn uv_command() -> Result<Command, String> {
    let mut cmd = Command::new(uv_path()?);
    scrub_runtime_env(&mut cmd);
    Ok(cmd)
}

/// Which runtimes resolved on this install.
pub fn runtimes_available(app: &AppHandle) -> RuntimeAvailability {
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
        touch(&dir.join(exe_name("node")));
        assert_eq!(
            binary_in(&dir, "node"),
            Some(dir.join(exe_name("node"))),
            "the staged layout drops the target triple"
        );
        assert_eq!(binary_in(&dir, "uv"), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn binary_in_ignores_directories() {
        let dir = temp_dir("staged_dir");
        fs::create_dir_all(dir.join(exe_name("node"))).unwrap();
        assert_eq!(
            binary_in(&dir, "node"),
            None,
            "a directory named node is not an interpreter"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_matches_the_triple_suffix() {
        let dir = temp_dir("source");
        touch(&dir.join("node-x86_64-unknown-linux-gnu"));
        touch(&dir.join("uv-x86_64-unknown-linux-gnu"));
        assert_eq!(
            binary_in_source_tree(&dir, "node"),
            Some(dir.join("node-x86_64-unknown-linux-gnu"))
        );
        assert_eq!(
            binary_in_source_tree(&dir, "uv"),
            Some(dir.join("uv-x86_64-unknown-linux-gnu"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_skips_the_npm_tree() {
        // `node-modules/` sits beside `node-<triple>` and shares the prefix.
        // Matching it would hand back a directory as the interpreter.
        let dir = temp_dir("source_npm");
        fs::create_dir_all(dir.join("node-modules").join("npm")).unwrap();
        assert_eq!(binary_in_source_tree(&dir, "node"), None);
        touch(&dir.join("node-aarch64-apple-darwin"));
        assert_eq!(
            binary_in_source_tree(&dir, "node"),
            Some(dir.join("node-aarch64-apple-darwin"))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn source_tree_lookup_is_stable_across_several_cross_builds() {
        let dir = temp_dir("source_multi");
        touch(&dir.join("node-x86_64-unknown-linux-gnu"));
        touch(&dir.join("node-aarch64-apple-darwin"));
        let first = binary_in_source_tree(&dir, "node");
        assert_eq!(first, binary_in_source_tree(&dir, "node"));
        assert_eq!(first, Some(dir.join("node-aarch64-apple-darwin")));
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
