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
use tauri::AppHandle;

/// Spawn a server and negotiate with it. Resolves once it is `Ready` or has
/// failed; a slow legacy handshake can take a few seconds.
#[tauri::command]
pub async fn mcp_start_server(
    supervisor: State<'_, McpSupervisor>,
    config: SpawnConfig,
) -> Result<(), String> {
    supervisor.start(config).await
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
) -> Result<(), String> {
    let catalog = catalog::load()?;
    let entry = catalog
        .entry(&entry_id)
        .ok_or_else(|| format!("no catalog entry named '{entry_id}'"))?;
    installer.install(&app, entry, &server_id).await?;
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

/// Build the spawn configuration for a configured server, catalog or custom.
///
/// Exposed rather than folded into `mcp_start_server` so the settings UI can
/// show exactly what will be run, and so a missing secret or an unfinished
/// setup surfaces as a setup problem before anything is spawned.
#[tauri::command]
pub async fn mcp_spawn_config(
    app: AppHandle,
    config: McpServerConfig,
) -> Result<SpawnConfig, String> {
    install::spawn_config_for(&app, &config)
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
) -> Result<String, String> {
    let spawn = install::setup_command_config(&app, &config, args)?;
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
    let url = config
        .remote_url()
        .ok_or_else(|| format!("{} is not a remote server", config.label))?;
    let http = http::HttpConfig::bearer(url, config.remote_token());
    supervisor
        .connect_remote(&config.id, &http, proxy.as_ref())
        .await
}
