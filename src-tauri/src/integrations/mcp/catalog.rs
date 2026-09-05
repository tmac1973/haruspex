//! The bundled catalog of vetted MCP servers.
//!
//! One JSON file, shipped in the app bundle rather than fetched: reviewable in
//! git, updated on release, and — the point — available with no network. A
//! catalog behind an HTTP call would make "add an integration" fail in exactly
//! the situation a local-first app exists for.
//!
//! # Steps are data
//!
//! Adding a server to the catalog must never require a code change. Every
//! entry is parsed into the types below and validated at load; an unknown
//! acquisition kind or setup step is a **loud error**, not a silently skipped
//! field. A step we do not understand is a step the user will not be asked to
//! complete, and the failure would surface later as a server that will not
//! start for no visible reason.
//!
//! # Forward compatibility
//!
//! Entry structs deliberately do **not** use `deny_unknown_fields`. Phase 07
//! extends the entry shape with a `companion` block and an `optional` flag on
//! steps; an older build reading a newer catalog should ignore what it does not
//! know rather than refuse the whole file. The *closed* set is the tagged
//! enums — the kinds — where an unrecognised value genuinely cannot be handled.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The whole bundled file.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
}

/// How a server's code gets onto the machine.
///
/// Three kinds, and the third is not optional: GitHub's official MCP server
/// ships as a hosted endpoint, a Docker image, or a native Go binary — never as
/// an npm package. Docker is not bundled and is not a supported kind, so
/// without `binary` the flagship catalog entry could not exist.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Acquisition {
    /// Installed with the bundled node + npm into the server's own directory.
    #[serde(rename_all = "camelCase")]
    Npm {
        package: String,
        /// Pinned, never a range: an install that resolves differently on two
        /// machines is a support case nobody can reproduce.
        version: String,
        /// Path to the server's JS entry point, relative to `node_modules`.
        /// Run as `node <path>` rather than through npm's `.bin` shim, which
        /// resolves its own interpreter off `PATH`.
        bin: String,
    },
    /// Installed with the bundled `uv`, which also provisions CPython.
    #[serde(rename_all = "camelCase")]
    Pypi {
        package: String,
        version: String,
        /// The console script the package installs into the virtualenv.
        entrypoint: String,
    },
    /// A pinned per-platform release asset, downloaded and checksum-verified.
    #[serde(rename_all = "camelCase")]
    Binary {
        /// `owner/name` on GitHub.
        repo: String,
        version: String,
        /// Asset filename per target triple.
        assets: BTreeMap<String, String>,
        /// Expected sha256 per target triple. An entry missing for the running
        /// platform is a hard failure, not a skipped check.
        sha256: BTreeMap<String, String>,
        /// Name of the executable inside the asset (and on disk after install).
        executable: String,
    },
}

/// How the installed server is invoked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    /// Arguments appended after whatever the acquisition kind requires.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment for the child. Values of the form `$secret.<key>` are
    /// replaced with the secret collected by the setup step with that key.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// One step of guided setup.
///
/// Google Drive/Workspace is the forcing case for all four kinds: it needs a
/// Cloud project (instruction), an OAuth client (instruction), a downloaded
/// credentials file (file), and a browser auth run (command).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupStep {
    /// Text, and optionally a link the app opens in the user's browser.
    #[serde(rename_all = "camelCase")]
    Instruction {
        title: String,
        text: String,
        link: Option<String>,
    },
    /// A labelled masked input, stored in the server config's `secrets`.
    #[serde(rename_all = "camelCase")]
    Secret {
        key: String,
        label: String,
        help: Option<String>,
    },
    /// A file picker whose chosen file is copied into the server's directory
    /// under `filename`.
    #[serde(rename_all = "camelCase")]
    File {
        label: String,
        /// Destination name inside the server directory, e.g.
        /// `gcp-oauth.keys.json`.
        filename: String,
        help: Option<String>,
    },
    /// A command run once after install with the bundled runtime, its stdout
    /// and stderr streamed live — the "run this to authenticate in your
    /// browser" step.
    #[serde(rename_all = "camelCase")]
    Command {
        label: String,
        args: Vec<String>,
        help: Option<String>,
    },
}

/// One vetted server.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub homepage: String,
    pub acquisition: Acquisition,
    #[serde(default)]
    pub command: CommandSpec,
    /// The subset of tools enabled on install. Not a nicety: a 30-tool server
    /// wrecks tool selection on the 9B tier, and this is the tested answer to
    /// "which of these actually earn their schema".
    #[serde(default)]
    pub default_tools: Vec<String>,
    #[serde(default)]
    pub setup: Vec<SetupStep>,
}

/// The bundled catalog, compiled in.
///
/// Also shipped as a bundle resource so it is readable and diffable in an
/// installed app, but the parse happens against this copy: a resource that
/// failed to install would otherwise leave the app with no catalog at all, and
/// the file is small.
const BUNDLED_CATALOG: &str = include_str!("../../../resources/mcp-catalog.json");

/// Parse and validate the bundled catalog.
pub fn load() -> Result<Catalog, String> {
    parse(BUNDLED_CATALOG)
}

/// Parse a catalog from JSON, then check the things serde cannot.
pub fn parse(text: &str) -> Result<Catalog, String> {
    let catalog: Catalog =
        serde_json::from_str(text).map_err(|e| format!("catalog is not valid: {e}"))?;
    validate(&catalog)?;
    Ok(catalog)
}

/// Structural checks beyond deserialization.
///
/// Every one of these is a mistake that would otherwise surface as a confusing
/// runtime failure long after the catalog was edited.
fn validate(catalog: &Catalog) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for entry in &catalog.entries {
        if !seen.insert(entry.id.as_str()) {
            return Err(format!("duplicate catalog entry id: {}", entry.id));
        }
        if entry.id.is_empty() {
            return Err("catalog entry has an empty id".into());
        }
        // A `$secret.x` with no step collecting `x` is a server that installs
        // fine and then starts with an empty credential.
        let collected: std::collections::BTreeSet<&str> = entry
            .setup
            .iter()
            .filter_map(|step| match step {
                SetupStep::Secret { key, .. } => Some(key.as_str()),
                _ => None,
            })
            .collect();
        for (var, value) in &entry.command.env {
            if let Some(key) = secret_reference(value) {
                if !collected.contains(key) {
                    return Err(format!(
                        "entry {}: {var} refers to $secret.{key}, but no setup step collects it",
                        entry.id
                    ));
                }
            }
        }
        if let Acquisition::Binary { assets, sha256, .. } = &entry.acquisition {
            for triple in assets.keys() {
                if !sha256.contains_key(triple) {
                    return Err(format!(
                        "entry {}: asset for {triple} has no sha256",
                        entry.id
                    ));
                }
            }
        }
    }
    Ok(())
}

/// The key in a `$secret.<key>` reference, if the value is one.
pub fn secret_reference(value: &str) -> Option<&str> {
    value.strip_prefix("$secret.")
}

/// Resolve a catalog entry's environment against a server's stored secrets.
///
/// A missing secret is an error naming the key rather than an empty string: an
/// empty credential produces an authentication failure from the server, which
/// is a much worse diagnostic than "you have not filled this in yet".
pub fn resolve_env(
    env: &BTreeMap<String, String>,
    secrets: &BTreeMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    env.iter()
        .map(|(var, value)| match secret_reference(value) {
            Some(key) => secrets
                .get(key)
                .map(|secret| (var.clone(), secret.clone()))
                .ok_or_else(|| format!("{var} needs the '{key}' value from setup, which is unset")),
            None => Ok((var.clone(), value.clone())),
        })
        .collect()
}

impl Catalog {
    pub fn entry(&self, id: &str) -> Option<&CatalogEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_catalog_parses_and_validates() {
        let catalog = load().expect("the shipped catalog must be loadable");
        assert!(
            catalog.entry("github").is_some(),
            "GitHub is the flagship entry"
        );
        assert!(catalog.entry("google-workspace").is_some());
    }

    #[test]
    fn the_bundled_catalog_exercises_every_setup_step_kind() {
        // The v1 entries were chosen to force the whole format. If this stops
        // being true, the format is being carried by tests alone.
        let catalog = load().unwrap();
        let mut has = (false, false, false, false);
        for step in catalog.entries.iter().flat_map(|e| &e.setup) {
            match step {
                SetupStep::Instruction { .. } => has.0 = true,
                SetupStep::Secret { .. } => has.1 = true,
                SetupStep::File { .. } => has.2 = true,
                SetupStep::Command { .. } => has.3 = true,
            }
        }
        assert_eq!(
            has,
            (true, true, true, true),
            "instruction/secret/file/command must all be represented"
        );
    }

    #[test]
    fn every_entry_names_the_tools_it_enables_by_default() {
        for entry in load().unwrap().entries {
            assert!(
                !entry.default_tools.is_empty(),
                "entry {} would enable its whole toolset on a 9B model",
                entry.id
            );
        }
    }

    #[test]
    fn an_unknown_acquisition_kind_is_a_loud_error() {
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"docker","image":"x"}
        }]}"#;
        let err = parse(text).expect_err("docker is not a supported kind");
        assert!(err.contains("catalog is not valid"), "got {err}");
    }

    #[test]
    fn an_unknown_setup_step_kind_is_a_loud_error() {
        // Silently skipping it would leave the user never asked for something
        // the server needs, and a start failure with no explanation.
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"npm","package":"p","version":"1.0.0","bin":"p/i.js"},
            "setup":[{"kind":"captcha","label":"Prove it"}]
        }]}"#;
        assert!(parse(text).is_err());
    }

    #[test]
    fn an_unknown_entry_field_is_tolerated_so_an_old_build_reads_a_new_catalog() {
        // Phase 07 adds a `companion` block. An older build must ignore it
        // rather than refuse the entire file and lose every other entry.
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"npm","package":"p","version":"1.0.0","bin":"p/i.js"},
            "defaultTools":["a"],
            "companion":{"app":"Blender"}
        }]}"#;
        assert_eq!(parse(text).unwrap().entries.len(), 1);
    }

    #[test]
    fn a_secret_reference_with_no_step_collecting_it_is_rejected() {
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"npm","package":"p","version":"1.0.0","bin":"p/i.js"},
            "command":{"env":{"TOKEN":"$secret.token"}}
        }]}"#;
        let err = parse(text).expect_err("nothing collects 'token'");
        assert!(err.contains("$secret.token"), "got {err}");
    }

    #[test]
    fn a_binary_asset_without_a_checksum_is_rejected() {
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"binary","repo":"o/r","version":"v1","executable":"r",
                "assets":{"x86_64-unknown-linux-gnu":"r-linux.tar.gz"},
                "sha256":{}}
        }]}"#;
        let err = parse(text).expect_err("an unverifiable asset must not ship");
        assert!(err.contains("sha256"), "got {err}");
    }

    #[test]
    fn duplicate_entry_ids_are_rejected() {
        let one = r#"{"id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"npm","package":"p","version":"1.0.0","bin":"p/i.js"}}"#;
        let text = format!("{{\"entries\":[{one},{one}]}}");
        assert!(parse(&text).unwrap_err().contains("duplicate"));
    }

    #[test]
    fn secrets_resolve_into_the_spawn_environment() {
        let env = BTreeMap::from([
            ("TOKEN".to_string(), "$secret.token".to_string()),
            ("MODE".to_string(), "stdio".to_string()),
        ]);
        let secrets = BTreeMap::from([("token".to_string(), "ghp_abc".to_string())]);
        let resolved = resolve_env(&env, &secrets).unwrap();
        assert_eq!(
            resolved,
            vec![
                ("MODE".to_string(), "stdio".to_string()),
                ("TOKEN".to_string(), "ghp_abc".to_string()),
            ],
            "literals pass through and references are substituted"
        );
    }

    #[test]
    fn a_missing_secret_names_the_key_instead_of_spawning_with_an_empty_one() {
        let env = BTreeMap::from([("TOKEN".to_string(), "$secret.token".to_string())]);
        let err = resolve_env(&env, &BTreeMap::new()).expect_err("nothing to substitute");
        assert!(err.contains("'token'"), "got {err}");
        assert!(
            err.contains("setup"),
            "the message should point at the thing the user has to do: {err}"
        );
    }

    #[test]
    fn a_value_that_merely_contains_a_dollar_sign_is_a_literal() {
        assert_eq!(secret_reference("$secret.token"), Some("token"));
        assert_eq!(secret_reference("prefix$secret.token"), None);
        assert_eq!(secret_reference("$SECRET.token"), None);
        assert_eq!(secret_reference("plain"), None);
    }
}
