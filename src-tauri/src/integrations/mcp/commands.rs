//! Tauri commands for the MCP client.
//!
//! Thin by design: every one of these resolves managed state and forwards to
//! [`McpSupervisor`]. The supervisor takes no `AppHandle`, so the logic behind
//! these commands is testable without a running Tauri app — this file is the
//! only place the two worlds meet.

use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

use super::catalog::{self, CatalogEntry, CompanionProbe};
use super::companion::{self, CompanionStatus};
use super::http;
use super::install::{self, McpInstaller};
use super::process::{McpSupervisor, SpawnConfig};
use super::server_config::McpServerConfig;
use super::types::{McpCallOutcome, McpConnectionInfo, McpToolDescriptor};
use crate::proxy::ProxyConfig;
use crate::sidecar_utils::SidecarStatus;
use tauri::{AppHandle, Emitter};

/// Carries the id of a server whose toolset changed under it.
pub const TOOLS_CHANGED_EVENT: &str = "mcp-tools-changed";

/// Bridge the supervisor's tool-change notifications to the frontend.
///
/// Returns the sender to hand to [`McpSupervisor::on_tools_changed`]. The
/// draining task lives as long as the app; it ends when the supervisor and
/// every session holding a clone of the sender are dropped.
///
/// Only the id crosses. Re-listing on this side would race the frontend's own
/// registry — which is the thing that actually decides what the model sees —
/// so the frontend asks for the new list when it is ready to install it.
pub fn spawn_tools_changed_bridge(app: AppHandle) -> tokio::sync::mpsc::UnboundedSender<String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tauri::async_runtime::spawn(async move {
        while let Some(id) = rx.recv().await {
            log::info!("mcp: server {id} says its tool list changed");
            let _ = app.emit(TOOLS_CHANGED_EVENT, id);
        }
    });
    tx
}

/// Build a configured server's spawn configuration, stored secrets included,
/// and start it. Resolves once it is `Ready` or has failed; a slow legacy
/// handshake can take a few seconds.
///
/// One command rather than "get the spawn config, then start it": the
/// configuration carries the resolved secrets in its environment, and handing
/// it to the webview and back put every one of them across IPC twice.
#[tauri::command]
pub async fn mcp_start_server(
    app: AppHandle,
    supervisor: State<'_, McpSupervisor>,
    config: McpServerConfig,
    proxy: Option<ProxyConfig>,
) -> Result<(), String> {
    let config = config.resolved().await?;
    let spawn = install::spawn_config_for(&app, &config, proxy.as_ref())?;
    supervisor.start(spawn).await
}

#[tauri::command]
pub async fn mcp_stop_server(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<(), String> {
    supervisor.stop(&id).await
}

#[tauri::command]
pub async fn mcp_server_status(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<SidecarStatus, String> {
    Ok(supervisor.status(&id).await)
}

/// The negotiated era and version, or `None` if the server is not connected.
/// The settings row shows this: when a server misbehaves, "which protocol is it
/// actually speaking" is the first question.
#[tauri::command]
pub async fn mcp_connection_info(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<Option<McpConnectionInfo>, String> {
    Ok(supervisor.connection(&id).await)
}

#[tauri::command]
pub async fn mcp_list_tools(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<Vec<McpToolDescriptor>, String> {
    supervisor.list_tools(&id).await
}

/// One `tools/call` round trip.
///
/// May answer with [`McpCallOutcome::InputRequired`] rather than a result: a
/// modern server can ask a question mid-call. Answer it and call again with the
/// same `name` and `arguments` plus `input_responses` and the `request_state`
/// handed back. The round-trip cap belongs to the caller driving that loop.
#[tauri::command]
pub async fn mcp_call_tool(
    supervisor: State<'_, McpSupervisor>,
    id: String,
    name: String,
    arguments: Option<serde_json::Map<String, Value>>,
    input_responses: Option<BTreeMap<String, Value>>,
    request_state: Option<String>,
) -> Result<McpCallOutcome, String> {
    supervisor
        .call_tool(&id, &name, arguments, input_responses, request_state)
        .await
}

#[tauri::command]
pub async fn mcp_server_logs(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<Vec<String>, String> {
    Ok(supervisor.logs(&id).await)
}

#[tauri::command]
pub async fn mcp_clear_server_logs(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<(), String> {
    supervisor.clear_logs(&id).await;
    Ok(())
}

/// The bundled catalog, for the browser in Settings.
///
/// Parsed on every call rather than cached: it is a small compiled-in string,
/// and a cache would be one more thing to invalidate for no measurable gain.
#[tauri::command]
pub async fn mcp_catalog() -> Result<Vec<CatalogEntry>, String> {
    Ok(catalog::load()?.entries)
}

/// Install a catalog entry for a configured server, streaming progress on
/// `mcp-install-progress`.
#[tauri::command]
pub async fn mcp_install_server(
    app: AppHandle,
    installer: State<'_, McpInstaller>,
    entry_id: String,
    server_id: String,
    proxy: Option<ProxyConfig>,
) -> Result<(), String> {
    let catalog = catalog::load()?;
    let entry = catalog
        .entry(&entry_id)
        .ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
    installer
        .install(&app, entry, &server_id, proxy.as_ref())
        .await?;
    Ok(())
}

/// Stop an install in flight. The staging directory goes with it, so a retry
/// starts clean.
#[tauri::command]
pub async fn mcp_cancel_install(installer: State<'_, McpInstaller>) -> Result<(), String> {
    installer.cancel().await;
    Ok(())
}

/// Remove a server's directory. Idempotent: the caller drops the settings entry
/// separately, and either order has to work.
#[tauri::command]
pub async fn mcp_uninstall_server(app: AppHandle, server_id: String) -> Result<(), String> {
    install::uninstall(&app, &server_id).await
}

/// Where a server's files live, for the file step of guided setup and for a
/// "show me the folder" affordance.
#[tauri::command]
pub async fn mcp_server_dir(app: AppHandle, server_id: String) -> Result<String, String> {
    Ok(install::server_dir(&app, &server_id)?
        .to_string_lossy()
        .to_string())
}

/// Copy a file the user picked in the setup wizard into the server's directory.
#[tauri::command]
pub async fn mcp_place_setup_file(
    app: AppHandle,
    server_id: String,
    source_path: String,
    filename: String,
) -> Result<(), String> {
    install::place_setup_file(
        &app,
        &server_id,
        std::path::Path::new(&source_path),
        &filename,
    )
    .await
}

/// Install a companion application's addon into a project directory the user
/// picked, for a guided-setup `addon` step.
///
/// Takes the step's position rather than its contents: the archive URL and its
/// checksum then come from the bundled catalog on this side of the IPC
/// boundary, so the frontend cannot be talked into fetching something else.
#[tauri::command]
pub async fn mcp_install_addon(
    app: AppHandle,
    installer: State<'_, McpInstaller>,
    entry_id: String,
    step_index: usize,
    target_dir: String,
    proxy: Option<ProxyConfig>,
) -> Result<String, String> {
    let catalog = catalog::load()?;
    let spec = addon_step(&catalog, &entry_id, step_index)?;
    let installed = installer
        .install_addon(
            &app,
            &spec,
            std::path::Path::new(&target_dir),
            proxy.as_ref(),
        )
        .await?;
    Ok(installed.to_string_lossy().to_string())
}

/// Run a guided-setup `command` step and return everything it printed.
///
/// Runs to completion rather than streaming: these are one-shot auth flows that
/// hand off to a browser and then finish, and the output only matters
/// afterwards — when it says whether the sign-in worked. Both streams come
/// back, because the useful line is as often on stderr as on stdout and the
/// user should not have to know which.
#[tauri::command]
pub async fn mcp_run_setup_command(
    app: AppHandle,
    config: McpServerConfig,
    args: Vec<String>,
    proxy: Option<ProxyConfig>,
) -> Result<String, String> {
    // A setup command is usually a sign-in that talks to the service, so it
    // needs the proxy as much as the server does.
    let config = config.resolved().await?;
    let spawn = install::setup_command_config(&app, &config, args, proxy.as_ref())?;
    run_setup(&spawn).await
}

/// Look up a catalog entry's addon step by position.
fn addon_step<'a>(
    catalog: &'a catalog::Catalog,
    entry_id: &str,
    step_index: usize,
) -> Result<install::AddonSpec<'a>, String> {
    let entry = catalog
        .entry(entry_id)
        .ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
    let Some(catalog::SetupStep::Addon {
        label,
        url,
        sha256,
        marker,
        install_path,
        ..
    }) = entry.setup.get(step_index)
    else {
        return Err(format!(
            "step {step_index} of {entry_id} is not an addon step"
        ));
    };
    Ok(install::AddonSpec {
        label,
        url,
        sha256,
        marker,
        install_path,
    })
}

/// Run a setup command to completion in exactly the environment `spawn`
/// gives it, and fold both output streams into the answer.
async fn run_setup(spawn: &SpawnConfig) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(&spawn.program);
    cmd.args(&spawn.args);
    cmd.env_clear();
    for (key, value) in &spawn.env {
        cmd.env(key, value);
    }
    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("could not run {}: {e}", spawn.program.display()))?;

    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if output.status.success() {
        Ok(text)
    } else if text.trim().is_empty() {
        Err(format!("the command exited with {}", output.status))
    } else {
        Err(text)
    }
}

/// Probe a server's companion application and record the answer.
///
/// Called on start, from the row's "Check again" control, on a slow poll while
/// the settings panel is open, and after a failed tool call — a failed call is
/// the strongest signal the companion dropped, and re-probing there turns the
/// model's error into a specific one.
///
/// A server with no companion answers `Unknown`, which the UI reads as "nothing
/// to say" rather than as a problem.
#[tauri::command]
pub async fn mcp_probe_companion(
    supervisor: State<'_, McpSupervisor>,
    id: String,
    entry_id: Option<String>,
) -> Result<CompanionStatus, String> {
    let Some(entry_id) = entry_id else {
        return Ok(CompanionStatus::Unknown);
    };
    let catalog = catalog::load()?;
    let Some(companion) = catalog.entry(&entry_id).and_then(|e| e.companion.clone()) else {
        return Ok(CompanionStatus::Unknown);
    };

    let status = match &companion.probe {
        CompanionProbe::Tcp { host, port } => {
            if companion::probe_tcp(host, *port).await {
                CompanionStatus::Connected
            } else {
                CompanionStatus::Disconnected {
                    hint: companion.hint.clone(),
                }
            }
        }
        CompanionProbe::Tool {
            tool,
            disconnected_error,
        } => {
            // The safety rule, enforced against what this server actually
            // published rather than against the catalog's word for it: a probe
            // runs unprompted, so it must never reach a tool the approval gate
            // would have asked about.
            let tools = supervisor.list_tools(&id).await?;
            let annotations: Vec<(String, Option<bool>)> = tools
                .iter()
                .map(|t| {
                    (
                        t.name.clone(),
                        t.annotations.as_ref().and_then(|a| a.read_only_hint),
                    )
                })
                .collect();
            let entry = catalog
                .entry(&entry_id)
                .ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
            catalog::validate_probe_tool(entry, &annotations)?;

            let called = supervisor
                .call_tool(&id, tool, None, None, None)
                .await
                .map(|_| ());
            companion::classify_tool_probe(called, disconnected_error, &companion.hint)
        }
    };

    supervisor.set_companion(&id, status.clone()).await;
    Ok(status)
}

/// The last recorded companion state, without probing again.
#[tauri::command]
pub async fn mcp_companion_status(
    supervisor: State<'_, McpSupervisor>,
    id: String,
) -> Result<CompanionStatus, String> {
    Ok(supervisor.companion(&id).await)
}

/// Connect to a server reached over the network.
///
/// Separate from `mcp_start_server` rather than folded into it: a remote server
/// has no spawn configuration at all — no program, no arguments, no environment
/// — and threading an empty one through the stdio path would mean every caller
/// carrying a shape that means nothing for half its cases.
#[tauri::command]
pub async fn mcp_connect_remote_server(
    supervisor: State<'_, McpSupervisor>,
    config: McpServerConfig,
    proxy: Option<ProxyConfig>,
) -> Result<(), String> {
    if !config.is_startable() {
        return Err(format!("{} is turned off", config.label));
    }
    let config = config.resolved().await?;
    let url = config
        .remote_url()
        .ok_or_else(|| format!("{} is not a remote server", config.label))?;
    let http = http::HttpConfig::bearer(url, config.remote_token());
    supervisor
        .connect_remote(&config.id, &http, proxy.as_ref(), config.proxy_use)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_addon_step_comes_from_the_catalog_by_position() {
        let catalog = catalog::load().unwrap();
        let godot = catalog.entry("godot").unwrap();
        let index = godot
            .setup
            .iter()
            .position(|s| matches!(s, catalog::SetupStep::Addon { .. }))
            .unwrap();
        let spec = addon_step(&catalog, "godot", index).unwrap();
        assert!(spec.url.starts_with("https://"), "{}", spec.url);
        assert_eq!(spec.sha256.len(), 64);

        let err = addon_step(&catalog, "godot", 0).err().unwrap();
        assert!(err.contains("is not an addon step"), "{err}");
        assert!(addon_step(&catalog, "godot", 99).is_err());
        let err = addon_step(&catalog, "no-such-entry", 0).err().unwrap();
        assert!(err.contains("no catalog entry"), "{err}");
    }

    #[cfg(unix)]
    fn sh(script: &str, env: Vec<(String, String)>) -> SpawnConfig {
        SpawnConfig {
            id: "t".into(),
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env,
            cwd: None,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_setup_command_sees_only_the_environment_it_was_given() {
        std::env::set_var("HARUSPEX_SETUP_TEST_LEAK", "leaked");
        let out = run_setup(&sh(
            "echo \"given=$GIVEN leak=$HARUSPEX_SETUP_TEST_LEAK\"",
            vec![("GIVEN".into(), "yes".into())],
        ))
        .await
        .unwrap();
        assert_eq!(out.trim(), "given=yes leak=");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn both_streams_come_back_on_success_and_on_failure() {
        let ok = run_setup(&sh("echo out; echo err >&2", vec![]))
            .await
            .unwrap();
        assert_eq!(ok, "out\n\nerr\n");

        let failed = run_setup(&sh("echo signed out >&2; exit 3", vec![]))
            .await
            .unwrap_err();
        assert_eq!(failed.trim(), "signed out");

        let silent = run_setup(&sh("exit 4", vec![])).await.unwrap_err();
        assert!(silent.contains("exited with"), "{silent}");
    }

    #[tokio::test]
    async fn a_missing_program_is_reported_by_path() {
        let spawn = SpawnConfig {
            id: "t".into(),
            program: "/no/such/haruspex-setup-program".into(),
            args: vec![],
            env: vec![],
            cwd: None,
        };
        let err = run_setup(&spawn).await.unwrap_err();
        assert!(err.contains("haruspex-setup-program"), "{err}");
    }
}
