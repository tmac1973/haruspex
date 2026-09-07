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

/// How a server's companion application is probed.
///
/// Two kinds, because Blender and Godot wire themselves up in opposite
/// directions; see `companion.rs`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompanionProbe {
    /// Connect to a port the companion's addon listens on.
    #[serde(rename_all = "camelCase")]
    Tcp { host: String, port: u16 },
    /// Call a tool and classify the error. **Must** name a tool carrying
    /// `readOnlyHint` — validated against the discovered tool list, because a
    /// probe is something the app calls on its own initiative and must never
    /// reach a tool the approval gate would have prompted for.
    #[serde(rename_all = "camelCase")]
    Tool {
        tool: String,
        /// The marker the server puts in its error when the companion is not
        /// attached, e.g. `BRIDGE_DISCONNECTED`.
        disconnected_error: String,
    },
}

/// A third-party application this server bridges to.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Companion {
    /// The application's name, as the user knows it.
    pub app: String,
    pub min_version: Option<String>,
    /// Where to get it. We neither bundle nor install it.
    pub download: Option<String>,
    pub probe: CompanionProbe,
    /// What to tell the user when it is not reachable. Carried through
    /// verbatim: a third companion entry must be a JSON change, not a code
    /// change.
    pub hint: String,
}

/// Who maintains a server and under what licence.
///
/// Shown in the catalog browser **before** install. Both companion entries are
/// community projects that execute code inside an application holding the
/// user's unsaved work, and "vetted" has to mean something the user can see.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// e.g. `"ahujasid/blender-mcp"`.
    pub maintainer: String,
    pub license: String,
    /// False for a community project. Absent means false.
    #[serde(default)]
    pub first_party: bool,
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
        /// An optional step may be skipped, and its absence must not stop the
        /// server starting. Blender's asset-service keys are the case: useful
        /// to have, useless to require.
        #[serde(default)]
        optional: bool,
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
        #[serde(default)]
        optional: bool,
    },
    /// A command run once after install with the bundled runtime, its stdout
    /// and stderr streamed live — the "run this to authenticate in your
    /// browser" step.
    #[serde(rename_all = "camelCase")]
    Command {
        label: String,
        args: Vec<String>,
        help: Option<String>,
        #[serde(default)]
        optional: bool,
    },
}

impl SetupStep {
    /// Whether this step may be left undone.
    pub fn is_optional(&self) -> bool {
        match self {
            // An instruction has nothing to satisfy, so "optional" would be a
            // distinction without a difference.
            SetupStep::Instruction { .. } => false,
            SetupStep::Secret { optional, .. }
            | SetupStep::File { optional, .. }
            | SetupStep::Command { optional, .. } => *optional,
        }
    }
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
    /// Present only for companion-app entries: a third-party application this
    /// server bridges to, which the user installs and runs themselves.
    #[serde(default)]
    pub companion: Option<Companion>,
    /// Who wrote the server. Optional so the format stays additive, but
    /// required for a companion entry — see `validate`.
    #[serde(default)]
    pub provenance: Option<Provenance>,
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
        // A companion entry drives an application holding the user's unsaved
        // work. Saying who wrote it is not optional for those.
        if entry.companion.is_some() && entry.provenance.is_none() {
            return Err(format!(
                "entry {}: a companion-app entry must record its provenance",
                entry.id
            ));
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

/// Reject a `tool`-kind probe that names a tool the approval gate would prompt
/// for.
///
/// This is the rule that keeps the probe safe. The app runs it on its own
/// initiative — at start, on a poll, after a failed call — so if it could name
/// any tool, a catalog entry could have Haruspex silently invoke something
/// destructive on a timer. Blender's `execute_blender_code` runs arbitrary
/// Python inside the user's Blender, which is why this is written down rather
/// than assumed.
///
/// Checked against the *discovered* tool list, because only the server can say
/// what its annotations are. A tool that is missing, or that does not declare
/// `readOnlyHint`, is rejected — absence of a claim is not a claim, the same
/// rule the approval gate follows.
pub fn validate_probe_tool(
    entry: &CatalogEntry,
    tools: &[(String, Option<bool>)],
) -> Result<(), String> {
    let Some(Companion {
        probe: CompanionProbe::Tool { tool, .. },
        ..
    }) = &entry.companion
    else {
        return Ok(());
    };
    match tools.iter().find(|(name, _)| name == tool) {
        Some((_, Some(true))) => Ok(()),
        Some(_) => Err(format!(
            "entry {}: probe tool '{tool}' does not declare readOnlyHint, so it cannot be \
             called without asking the user",
            entry.id
        )),
        None => Err(format!(
            "entry {}: probe tool '{tool}' is not one of the server's tools",
            entry.id
        )),
    }
}

/// The key in a `$secret.<key>` reference, if the value is one.
pub fn secret_reference(value: &str) -> Option<&str> {
    value.strip_prefix("$secret.")
}

/// Resolve a catalog entry's environment against a server's stored secrets.
///
/// A missing **required** secret is an error naming the key rather than an
/// empty string: an empty credential produces an authentication failure from
/// the server, which is a much worse diagnostic than "you have not filled this
/// in yet".
///
/// A missing **optional** secret drops its variable entirely rather than
/// passing an empty one. Blender's asset-service keys are the case: a server
/// handed `BLENDERMCP_SKETCHFAB_API_KEY=""` may well try to use it and fail,
/// where an absent variable simply means the feature is off. Skipping the whole
/// entry is what makes an optional step genuinely optional.
pub fn resolve_env(
    entry: &CatalogEntry,
    secrets: &BTreeMap<String, String>,
) -> Result<Vec<(String, String)>, String> {
    let optional_keys: std::collections::BTreeSet<&str> = entry
        .setup
        .iter()
        .filter(|step| step.is_optional())
        .filter_map(|step| match step {
            SetupStep::Secret { key, .. } => Some(key.as_str()),
            _ => None,
        })
        .collect();

    let mut resolved = Vec::new();
    for (var, value) in &entry.command.env {
        match secret_reference(value) {
            None => resolved.push((var.clone(), value.clone())),
            Some(key) => match secrets.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
                Some(secret) => resolved.push((var.clone(), secret.to_string())),
                None if optional_keys.contains(key) => continue,
                None => {
                    return Err(format!(
                        "{var} needs the '{key}' value from setup, which is unset"
                    ))
                }
            },
        }
    }
    Ok(resolved)
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
        // `companion` was exactly this case one phase ago. An older build must
        // ignore a field it has never heard of rather than refuse the entire
        // file and lose every other entry with it.
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"npm","package":"p","version":"1.0.0","bin":"p/i.js"},
            "defaultTools":["a"],
            "somethingFromALaterRelease":{"whatever":true}
        }]}"#;
        assert_eq!(parse(text).unwrap().entries.len(), 1);
    }

    // ---- companion entries ----------------------------------------------

    fn companion_entry(id: &str) -> &'static CatalogEntry {
        // Leaked so the tests can hold a reference without threading a Catalog
        // through every one; the catalog is a compiled-in constant anyway.
        let catalog = Box::leak(Box::new(load().unwrap()));
        catalog
            .entries
            .iter()
            .find(|e| e.id == id)
            .unwrap_or_else(|| panic!("no {id} entry"))
    }

    #[test]
    fn blender_probes_the_port_its_addon_listens_on() {
        let companion = companion_entry("blender").companion.clone().unwrap();
        assert_eq!(companion.app, "Blender");
        assert_eq!(
            companion.probe,
            CompanionProbe::Tcp {
                host: "127.0.0.1".into(),
                port: 9876
            }
        );
        assert!(
            companion.hint.contains("Start MCP Server"),
            "the hint has to name the thing the user actually clicks"
        );
    }

    #[test]
    fn godot_probes_by_asking_because_a_port_check_would_always_succeed() {
        // Godot's addon dials *out* to the server's bridge, so something is
        // always listening there whether or not an editor is attached.
        let companion = companion_entry("godot").companion.clone().unwrap();
        let CompanionProbe::Tool {
            tool,
            disconnected_error,
        } = companion.probe
        else {
            panic!("a port check on Godot would report connected with no editor");
        };
        assert_eq!(tool, "get_editor_state");
        assert_eq!(disconnected_error, "BRIDGE_DISCONNECTED");
    }

    #[test]
    fn godots_hint_says_the_plugin_is_per_project() {
        // The user who hits "not connected" six months later will be in a
        // different project and will not remember.
        let hint = companion_entry("godot").companion.clone().unwrap().hint;
        assert!(hint.contains("per project"), "got {hint}");
    }

    #[test]
    fn blender_pins_the_environment_that_makes_it_shippable() {
        // The server reports usage by default. A catalog entry that phones
        // home would contradict what this app is for, so the setting is in the
        // entry and asserted rather than trusted to stay.
        let env = &companion_entry("blender").command.env;
        assert_eq!(
            env.get("DISABLE_TELEMETRY").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            env.get("BLENDER_MCP_SAFE_MODE").map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn godot_pins_its_transport_rather_than_relying_on_the_default() {
        // stdio is the default today. Phase 08 adds HTTP, and an entry that
        // depends on a default is an entry that breaks quietly when it moves.
        let env = &companion_entry("godot").command.env;
        assert_eq!(
            env.get("GODOT_MCP_TRANSPORT").map(String::as_str),
            Some("stdio")
        );
    }

    #[test]
    fn blenders_arbitrary_code_tool_is_not_enabled_by_default() {
        // execute_blender_code runs arbitrary Python inside the user's Blender.
        let entry = companion_entry("blender");
        assert!(!entry
            .default_tools
            .contains(&"execute_blender_code".to_string()));
    }

    #[test]
    fn blenders_optional_keys_are_marked_optional() {
        // Asset-service keys are useful to have and useless to require; a
        // required-but-blank secret would make the server unstartable.
        let optional: Vec<_> = companion_entry("blender")
            .setup
            .iter()
            .filter(|s| s.is_optional())
            .collect();
        assert_eq!(optional.len(), 2, "both asset keys should be skippable");
    }

    #[test]
    fn an_instruction_is_never_optional() {
        // There is nothing to satisfy, so the flag would be a distinction
        // without a difference.
        let step = SetupStep::Instruction {
            title: "t".into(),
            text: "x".into(),
            link: None,
        };
        assert!(!step.is_optional());
    }

    #[test]
    fn every_companion_entry_says_who_wrote_it() {
        for entry in load().unwrap().entries {
            if entry.companion.is_some() {
                let p = entry
                    .provenance
                    .unwrap_or_else(|| panic!("entry {} has no provenance", entry.id));
                assert!(!p.maintainer.is_empty());
                assert!(!p.license.is_empty());
            }
        }
    }

    #[test]
    fn a_companion_entry_without_provenance_is_rejected() {
        let text = r#"{"entries":[{
            "id":"x","name":"X","description":"d","homepage":"h",
            "acquisition":{"kind":"pypi","package":"p","version":"1.0.0","entrypoint":"p"},
            "companion":{"app":"Thing","probe":{"kind":"tcp","host":"127.0.0.1","port":1},
                         "hint":"open it","minVersion":null,"download":null}
        }]}"#;
        let err = parse(text).expect_err("a companion entry must say who wrote it");
        assert!(err.contains("provenance"), "got {err}");
    }

    #[test]
    fn a_probe_tool_must_declare_itself_read_only() {
        // The rule that keeps the probe safe: the app calls it unprompted, so
        // it must never be able to reach a tool the approval gate would ask
        // about. Blender's execute_blender_code is why this is written down.
        let entry = companion_entry("godot");
        assert!(validate_probe_tool(entry, &[("get_editor_state".into(), Some(true))]).is_ok());

        let not_declared = validate_probe_tool(entry, &[("get_editor_state".into(), None)]);
        assert!(
            not_declared.unwrap_err().contains("readOnlyHint"),
            "an unannotated tool is not a safe probe"
        );

        let writes = validate_probe_tool(entry, &[("get_editor_state".into(), Some(false))]);
        assert!(writes.is_err());

        let missing = validate_probe_tool(entry, &[("something_else".into(), Some(true))]);
        assert!(missing
            .unwrap_err()
            .contains("not one of the server's tools"));
    }

    #[test]
    fn an_entry_with_no_companion_needs_no_probe_validation() {
        assert!(validate_probe_tool(companion_entry("github"), &[]).is_ok());
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

    /// A minimal entry whose env and setup can be varied per test.
    fn entry_with(env: BTreeMap<String, String>, setup: Vec<SetupStep>) -> CatalogEntry {
        CatalogEntry {
            id: "x".into(),
            name: "X".into(),
            description: "d".into(),
            homepage: "h".into(),
            acquisition: Acquisition::Pypi {
                package: "p".into(),
                version: "1".into(),
                entrypoint: "p".into(),
            },
            command: CommandSpec {
                args: Vec::new(),
                env,
            },
            default_tools: Vec::new(),
            setup,
            companion: None,
            provenance: None,
        }
    }

    fn required_secret(key: &str) -> SetupStep {
        SetupStep::Secret {
            key: key.into(),
            label: key.into(),
            help: None,
            optional: false,
        }
    }

    fn optional_secret(key: &str) -> SetupStep {
        SetupStep::Secret {
            key: key.into(),
            label: key.into(),
            help: None,
            optional: true,
        }
    }

    #[test]
    fn secrets_resolve_into_the_spawn_environment() {
        let entry = entry_with(
            BTreeMap::from([
                ("TOKEN".to_string(), "$secret.token".to_string()),
                ("MODE".to_string(), "stdio".to_string()),
            ]),
            vec![required_secret("token")],
        );
        let secrets = BTreeMap::from([("token".to_string(), "ghp_abc".to_string())]);
        assert_eq!(
            resolve_env(&entry, &secrets).unwrap(),
            vec![
                ("MODE".to_string(), "stdio".to_string()),
                ("TOKEN".to_string(), "ghp_abc".to_string()),
            ],
            "literals pass through and references are substituted"
        );
    }

    #[test]
    fn a_missing_secret_names_the_key_instead_of_spawning_with_an_empty_one() {
        let entry = entry_with(
            BTreeMap::from([("TOKEN".to_string(), "$secret.token".to_string())]),
            vec![required_secret("token")],
        );
        let err = resolve_env(&entry, &BTreeMap::new()).expect_err("nothing to substitute");
        assert!(err.contains("'token'"), "got {err}");
        assert!(
            err.contains("setup"),
            "the message should point at the thing the user has to do: {err}"
        );
    }

    #[test]
    fn an_unset_optional_secret_drops_its_variable_rather_than_blanking_it() {
        // Blender's asset keys. A server handed KEY="" may well try to use it
        // and fail; an absent variable simply means the feature is off.
        let entry = entry_with(
            BTreeMap::from([
                ("KEY".to_string(), "$secret.sketchfab".to_string()),
                ("MODE".to_string(), "stdio".to_string()),
            ]),
            vec![optional_secret("sketchfab")],
        );
        assert_eq!(
            resolve_env(&entry, &BTreeMap::new()).unwrap(),
            vec![("MODE".to_string(), "stdio".to_string())],
            "an optional step left blank must not make the server unstartable"
        );
    }

    #[test]
    fn a_whitespace_only_secret_counts_as_unset() {
        // Required: an error, not a credential made of spaces.
        let required = entry_with(
            BTreeMap::from([("TOKEN".to_string(), "$secret.token".to_string())]),
            vec![required_secret("token")],
        );
        let blank = BTreeMap::from([("token".to_string(), "   ".to_string())]);
        assert!(resolve_env(&required, &blank).is_err());

        // Optional: dropped, same as absent.
        let optional = entry_with(
            BTreeMap::from([("KEY".to_string(), "$secret.k".to_string())]),
            vec![optional_secret("k")],
        );
        let blank = BTreeMap::from([("k".to_string(), "  ".to_string())]);
        assert!(resolve_env(&optional, &blank).unwrap().is_empty());
    }

    #[test]
    fn blenders_optional_keys_do_not_block_a_spawn() {
        // The whole point, against the real entry: a user who skips both asset
        // keys still gets a working Blender server.
        let entry = companion_entry("blender");
        let resolved = resolve_env(entry, &BTreeMap::new())
            .expect("Blender must start with no asset keys at all");
        let vars: Vec<&str> = resolved.iter().map(|(k, _)| k.as_str()).collect();
        assert!(vars.contains(&"DISABLE_TELEMETRY"));
        assert!(!vars.iter().any(|v| v.contains("SKETCHFAB")));
    }

    #[test]
    fn a_value_that_merely_contains_a_dollar_sign_is_a_literal() {
        assert_eq!(secret_reference("$secret.token"), Some("token"));
        assert_eq!(secret_reference("prefix$secret.token"), None);
        assert_eq!(secret_reference("$SECRET.token"), None);
        assert_eq!(secret_reference("plain"), None);
    }
}
