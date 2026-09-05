//! Tauri commands for the MCP client.
//!
//! Thin by design: every one of these resolves managed state and forwards to
//! [`McpSupervisor`]. The supervisor takes no `AppHandle`, so the logic behind
//! these commands is testable without a running Tauri app — this file is the
//! only place the two worlds meet.

use serde_json::Value;
use std::collections::BTreeMap;
use tauri::State;

use super::process::{McpSupervisor, SpawnConfig};
use super::types::{McpCallOutcome, McpConnectionInfo, McpToolDescriptor};
use crate::sidecar_utils::SidecarStatus;

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
