//! Tauri commands for the MCP client.
//!
//! Thin by design: every one of these resolves managed state and forwards to
//! [`McpSupervisor`]. The supervisor takes no `AppHandle`, so the logic behind
//! these commands is testable without a running Tauri app — this file is the
//! only place the two worlds meet.

use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

use super::catalog::{self, CatalogEntry};
use super::install::{self, McpInstaller};
use super::process::{McpSupervisor, SpawnConfig};
use super::server_config::McpServerConfig;
use super::types::{McpCallOutcome, McpConnectionInfo, McpToolDescriptor};
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
