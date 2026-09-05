//! The MCP shapes the frontend consumes.
//!
//! Deliberately not rmcp's own types. rmcp's model tracks the spec and carries
//! protocol machinery (`Cow`, `Arc<JsonObject>`, `Extensions`, `_meta`) that has
//! no business in a Svelte component, and re-exporting it would make every
//! rmcp bump a frontend change. These are the narrow projections the UI and the
//! tool registry actually need, exported through ts-rs like every other IPC
//! type in the tree.

use serde::{Deserialize, Serialize};

/// Which protocol revision family a server turned out to speak.
///
/// Cached per server and surfaced in the UI: when a server misbehaves, "which
/// protocol is it actually speaking" is the first question, and the answer is
/// otherwise invisible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum McpProtocolEra {
    /// 2026-07-28 and later: stateless, per-request metadata, `server/discover`.
    Modern,
    /// 2025-11-25 and earlier: the `initialize` / `initialized` handshake.
    Legacy,
}

/// What a connected server turned out to be.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionInfo {
    pub era: McpProtocolEra,
    /// The negotiated protocol version, verbatim (e.g. `"2026-07-28"`).
    pub protocol_version: String,
    /// The server's self-reported name, when it gave one. Discovery responses
    /// are not required to identify the implementation.
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    /// Free-text usage guidance from the server, when offered.
    pub instructions: Option<String>,
}

/// A tool's annotation hints, carried through **verbatim**.
///
/// Every field stays `Option`. Phase 05's approval gate treats a missing
/// `readOnlyHint` as "not read-only" and prompts; if this layer defaulted the
/// absence to `false`, that gate would be deciding on a value this layer made
/// up rather than on what the server actually said. Absent must stay absent.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct McpToolAnnotations {
    pub title: Option<String>,
    pub read_only_hint: Option<bool>,
    pub destructive_hint: Option<bool>,
    pub idempotent_hint: Option<bool>,
    pub open_world_hint: Option<bool>,
}

/// One tool as discovered from a server.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The tool's JSON Schema, passed through unmodified — the model is given
    /// exactly what the server published.
    #[ts(type = "unknown")]
    pub input_schema: serde_json::Value,
    /// `None` when the server sent no annotations at all, which is a different
    /// statement from "sent an empty object".
    pub annotations: Option<McpToolAnnotations>,
}

/// A server-initiated request bundled into an `input_required` result.
///
/// The payload is kept as raw JSON. It is either an `elicitation/create`, a
/// `sampling/createMessage` or a `roots/list` request, and the layer that
/// renders a question to the user is the one that should interpret it — this
/// layer's job is to not lose anything on the way.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct McpInputRequest {
    /// The server-assigned key. Must be echoed back as the `inputResponses`
    /// key for this request.
    pub key: String,
    /// The request method, when it can be read off the payload.
    pub method: Option<String>,
    #[ts(type = "unknown")]
    pub payload: serde_json::Value,
}

/// The outcome of one `tools/call` round trip.
///
/// A round trip, not a completed call: under MRTR a server may answer with a
/// question instead of a result, and the caller drives the retry. See
/// `client.rs` on why that loop lives above this layer rather than inside it.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpCallOutcome {
    /// The call finished. `content` is rmcp's content array as JSON.
    #[serde(rename_all = "camelCase")]
    Complete {
        #[ts(type = "unknown")]
        content: serde_json::Value,
        #[ts(type = "unknown | null")]
        structured_content: Option<serde_json::Value>,
        /// The server's own `isError` flag: a tool that failed on its own
        /// terms, as opposed to a transport or protocol failure.
        is_error: bool,
    },
    /// The server needs input before it can finish. Answer the requests and
    /// call again with the same arguments plus `inputResponses` and this
    /// `requestState`.
    #[serde(rename_all = "camelCase")]
    InputRequired {
        requests: Vec<McpInputRequest>,
        /// Opaque server state. Echo it back untouched — the spec forbids
        /// inspecting or modifying it.
        request_state: Option<String>,
    },
}
