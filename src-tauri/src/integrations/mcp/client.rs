//! Speaking MCP to a supervised server, across both protocol eras.
//!
//! # Two eras, one client
//!
//! The 2026-07-28 revision made MCP stateless: no `initialize` handshake, no
//! session id, with the protocol version and client capabilities travelling in
//! each request's `_meta`. Servers on 2025-11-25 and earlier still require the
//! handshake. Most of the ecosystem is still there, so this client speaks both.
//!
//! rmcp drives the probe and the fallback ([`ClientLifecycleMode::Auto`]), and
//! it gets the subtleties right that are easy to get wrong: a recognised modern
//! error such as `UnsupportedProtocolVersionError` identifies a *modern* server
//! and triggers a version retry rather than a fallback, and the fallback itself
//! is not keyed to any one error code, because legacy servers answer an unknown
//! pre-`initialize` method with `-32601`, with `-32602`, or with silence.
//!
//! What is ours is the policy: always probing rather than assuming, caching the
//! era per server, surfacing it, and the tests that hold each branch down.
//!
//! **Always probe.** A modern-only client technically need not, but the spec
//! recommends it anyway: some legacy servers do not check that a request
//! arrives after `initialize`, and would process an era-ambiguous `tools/call`
//! under legacy semantics. Probing turns that into a deterministic failure.
//!
//! # What dual-era does not extend to
//!
//! Connect, `tools/list` and `tools/call`. Nothing else.
//!
//! The interactive path is modern-only. A legacy server asks for input by
//! sending its own request (`elicitation/create`, `sampling/createMessage`,
//! `roots/list`); a modern one returns an `input_required` result and waits to
//! be called again. Supporting both would mean two question paths feeding one
//! modal — the real duplication in this phase, and the one worth refusing. So
//! [`HaruspexClient`] answers every server-initiated request with an error
//! naming the reason, which fails that tool call and leaves the server running.
//! When the ecosystem is majority-modern, retiring legacy support is deleting
//! the fallback arm and its fixture.
//!
//! # Why the MRTR loop is not here
//!
//! rmcp offers `call_tool`, which drives MRTR rounds itself by calling back
//! into this handler. This module deliberately uses `call_tool_once` instead
//! and returns [`McpCallOutcome::InputRequired`] to its caller.
//!
//! The question has to reach a person, and the machinery for that already
//! exists one layer up: `userQuestion.svelte.ts` with `UserQuestionModal`, and
//! `ToolContext.askUser`, which already routes a question to whoever can answer
//! it — including a remote guest rather than whoever is at this keyboard.
//! Driving the loop down here would mean building a second path from Rust back
//! out to that modal. Returning the question instead keeps one question path,
//! which is the actual requirement.

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, ClientCapabilities, ClientInfo, Implementation,
    InputRequest, ProtocolVersion,
};
use rmcp::service::RunningService;
use rmcp::transport::TokioChildProcess;
use rmcp::{
    ClientHandler, ClientLifecycleMode, ClientServiceExt, ErrorData as McpError, RoleClient,
};
use serde_json::Value;
use std::borrow::Cow;

use super::types::{
    McpCallOutcome, McpConnectionInfo, McpInputRequest, McpProtocolEra, McpToolAnnotations,
    McpToolDescriptor,
};

/// Protocol versions this client offers, newest first. rmcp picks the newest
/// the server also supports.
fn preferred_versions() -> Vec<ProtocolVersion> {
    vec![ProtocolVersion::V_2026_07_28]
}

/// The version used when a probe proves the server is handshake-era.
fn legacy_version() -> ProtocolVersion {
    ProtocolVersion::V_2025_11_25
}

/// The message a legacy server's server-initiated request fails with.
///
/// Written for the model, which is what receives it: it has to be able to tell
/// the user something true without knowing what MCP is.
const LEGACY_INTERACTION_REFUSAL: &str =
    "This server asked a question using the older MCP protocol, which Haruspex does not \
     support. Only servers on the 2026-07-28 revision can ask questions mid-call. Try \
     again with different arguments, or tell the user the server needs updating.";

/// Our end of the connection.
///
/// Carries client identity and capabilities, and refuses every server-initiated
/// request — see the module docs on why the interactive path is modern-only.
#[derive(Clone, Debug)]
pub struct HaruspexClient;

impl HaruspexClient {
    fn refuse(what: &str) -> McpError {
        McpError::invalid_request(
            Cow::Owned(format!("{LEGACY_INTERACTION_REFUSAL} (requested: {what})")),
            None,
        )
    }
}

impl ClientHandler for HaruspexClient {
    fn get_info(&self) -> ClientInfo {
        // No `sampling` or `roots` capability is declared, so a well-behaved
        // server will not ask for them at all. The refusals below are for
        // servers that ask anyway.
        ClientInfo::new(
            ClientCapabilities::default(),
            Implementation::new("haruspex", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::V_2026_07_28)
    }

    async fn create_elicitation(
        &self,
        _params: rmcp::model::ElicitRequestParams,
        _context: rmcp::service::RequestContext<RoleClient>,
    ) -> Result<rmcp::model::ElicitResult, McpError> {
        Err(Self::refuse("elicitation/create"))
    }

    // Sampling and roots are deprecated by SEP-2577 and will be removed. They
    // are overridden anyway, and precisely because they are deprecated: a
    // legacy server may still ask, and an unanswered request is a hung tool
    // call. These go away with the legacy arm.
    #[allow(deprecated)]
    async fn create_message(
        &self,
        _params: rmcp::model::CreateMessageRequestParams,
        _context: rmcp::service::RequestContext<RoleClient>,
    ) -> Result<rmcp::model::CreateMessageResult, McpError> {
        Err(Self::refuse("sampling/createMessage"))
    }

    #[allow(deprecated)]
    async fn list_roots(
        &self,
        _context: rmcp::service::RequestContext<RoleClient>,
    ) -> Result<rmcp::model::ListRootsResult, McpError> {
        Err(Self::refuse("roots/list"))
    }
}

/// A live MCP session over one supervised child process.
pub struct McpSession {
    service: RunningService<RoleClient, HaruspexClient>,
    info: McpConnectionInfo,
}

impl McpSession {
    /// Negotiate with a server over an already-spawned transport.
    ///
    /// The transport is consumed: from here on the child's stdin/stdout belong
    /// to rmcp, which is why the supervisor hands ownership over rather than
    /// keeping a copy.
    pub async fn connect(transport: TokioChildProcess) -> Result<Self, String> {
        Self::negotiate(transport).await
    }

    /// Negotiate with a server reached over HTTP.
    ///
    /// Identical from here up: the transport is the only difference, and the
    /// dual-era logic, discovery and tool calls are all unchanged. A remote
    /// legacy server gets the `initialize` handshake and its `Mcp-Session-Id`;
    /// a modern one gets per-request `_meta` and the `MCP-Protocol-Version`
    /// header. rmcp sends whichever the negotiation settled on.
    pub async fn connect_http(
        config: &super::http::HttpConfig,
        proxy: Option<&crate::proxy::ProxyConfig>,
    ) -> Result<Self, String> {
        Self::negotiate(super::http::transport(config, proxy)?).await
    }

    async fn negotiate<T, E, A>(transport: T) -> Result<Self, String>
    where
        T: rmcp::transport::IntoTransport<RoleClient, E, A>,
        E: std::error::Error + Send + Sync + 'static,
    {
        let service = HaruspexClient
            .serve_with_lifecycle(
                transport,
                ClientLifecycleMode::Auto {
                    preferred_versions: preferred_versions(),
                    legacy_version: Some(legacy_version()),
                },
            )
            .await
            .map_err(|e| format!("MCP negotiation failed: {e}"))?;

        let info = connection_info(&service)?;
        Ok(Self { service, info })
    }

    pub fn info(&self) -> &McpConnectionInfo {
        &self.info
    }

    /// Every tool the server publishes, paginated to exhaustion.
    pub async fn list_tools(&self) -> Result<Vec<McpToolDescriptor>, String> {
        let tools = self
            .service
            .list_all_tools()
            .await
            .map_err(|e| format!("tools/list failed: {e}"))?;
        Ok(tools.iter().map(describe_tool).collect())
    }

    /// One `tools/call` round trip.
    ///
    /// Returns [`McpCallOutcome::InputRequired`] rather than driving the MRTR
    /// retry; see the module docs. `input_responses` and `request_state` carry
    /// the previous round's answers back.
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: Option<serde_json::Map<String, Value>>,
        input_responses: Option<std::collections::BTreeMap<String, Value>>,
        request_state: Option<String>,
    ) -> Result<McpCallOutcome, String> {
        let mut params = CallToolRequestParams::new(name.to_string());
        params.arguments = arguments;
        params.input_responses = input_responses;
        params.request_state = request_state;

        match self
            .service
            .call_tool_once(params)
            .await
            .map_err(|e| format!("tools/call failed: {e}"))?
        {
            CallToolResponse::Complete(result) => Ok(McpCallOutcome::Complete {
                content: serde_json::to_value(&result.content).unwrap_or(Value::Null),
                structured_content: result.structured_content.clone(),
                is_error: result.is_error.unwrap_or(false),
            }),
            CallToolResponse::InputRequired(result) => Ok(McpCallOutcome::InputRequired {
                requests: result
                    .input_requests
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(key, request)| describe_input_request(key, request))
                    .collect(),
                request_state: result.request_state,
            }),
            // SEP-2663 tasks are an extension this client does not declare, so
            // a server returning one is not answering the question we asked.
            CallToolResponse::Task(_) => {
                Err("server replied with a task handle, which Haruspex does not support".into())
            }
            // `CallToolResponse` is #[non_exhaustive]: a future revision can
            // add a reply shape. Refusing it beats guessing at its meaning.
            other => Err(format!(
                "server replied with an unsupported result: {other:?}"
            )),
        }
    }

    /// Close the session, taking the child down with it.
    pub async fn shutdown(self) {
        if let Err(e) = self.service.cancel().await {
            log::warn!("mcp: session shutdown was not clean: {e}");
        }
    }
}

/// Read back what the negotiation settled on.
///
/// The era is derived from the negotiated version rather than tracked
/// separately: the version *is* the era, and a second field recording it would
/// be a second source of truth that could disagree.
fn connection_info(
    service: &RunningService<RoleClient, HaruspexClient>,
) -> Result<McpConnectionInfo, String> {
    let peer = service
        .peer_info()
        .ok_or("server did not report its protocol version")?;
    let version = peer.protocol_version.clone();
    Ok(McpConnectionInfo {
        era: era_of(&version),
        protocol_version: version.as_str().to_string(),
        server_name: peer.server_info.as_ref().map(|i| i.name.clone()),
        server_version: peer.server_info.as_ref().map(|i| i.version.clone()),
        instructions: peer.instructions.clone(),
    })
}

/// Classify a negotiated version.
///
/// Anything from 2026-07-28 onwards is modern. Comparison is on the date string
/// because that is what the spec versions are, and it sorts correctly as text —
/// which keeps a future revision modern by default rather than silently
/// dropping to the handshake path.
pub fn era_of(version: &ProtocolVersion) -> McpProtocolEra {
    if version.as_str() >= "2026-07-28" {
        McpProtocolEra::Modern
    } else {
        McpProtocolEra::Legacy
    }
}

/// Project one rmcp tool onto the frontend shape.
///
/// Annotations are copied field by field with no defaulting: absent stays
/// absent, all the way to the approval gate.
fn describe_tool(tool: &rmcp::model::Tool) -> McpToolDescriptor {
    McpToolDescriptor {
        name: tool.name.to_string(),
        title: tool.title.clone(),
        description: tool.description.as_ref().map(|d| d.to_string()),
        input_schema: serde_json::to_value(tool.input_schema.as_ref()).unwrap_or(Value::Null),
        annotations: tool.annotations.as_ref().map(|a| McpToolAnnotations {
            title: a.title.clone(),
            read_only_hint: a.read_only_hint,
            destructive_hint: a.destructive_hint,
            idempotent_hint: a.idempotent_hint,
            open_world_hint: a.open_world_hint,
        }),
    }
}

fn describe_input_request(key: String, request: InputRequest) -> McpInputRequest {
    let payload = serde_json::to_value(&request).unwrap_or(Value::Null);
    let method = payload
        .get("method")
        .and_then(|m| m.as_str())
        .map(str::to_string);
    McpInputRequest {
        key,
        method,
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ProtocolVersion` has no public constructor for an arbitrary string —
    /// it only deserializes into one — which is how a revision rmcp has never
    /// heard of actually arrives.
    fn version(s: &str) -> ProtocolVersion {
        serde_json::from_value(serde_json::json!(s)).unwrap()
    }

    #[test]
    fn the_current_revision_and_anything_later_is_modern() {
        assert_eq!(
            era_of(&ProtocolVersion::V_2026_07_28),
            McpProtocolEra::Modern
        );
        // A revision we have never heard of but which post-dates the stateless
        // change must not silently drop to the handshake path.
        assert_eq!(era_of(&version("2027-03-01")), McpProtocolEra::Modern);
    }

    #[test]
    fn everything_before_the_stateless_change_is_legacy() {
        assert_eq!(
            era_of(&ProtocolVersion::V_2025_11_25),
            McpProtocolEra::Legacy
        );
        assert_eq!(
            era_of(&ProtocolVersion::V_2025_06_18),
            McpProtocolEra::Legacy
        );
        assert_eq!(era_of(&version("2024-11-05")), McpProtocolEra::Legacy);
    }

    #[test]
    fn we_offer_only_the_modern_version_and_fall_back_to_one_legacy_one() {
        // Offering several modern versions would give rmcp's retry loop more
        // than one shot at a version mismatch; the plan bounds it at one.
        assert_eq!(preferred_versions(), vec![ProtocolVersion::V_2026_07_28]);
        assert_eq!(legacy_version(), ProtocolVersion::V_2025_11_25);
    }

    #[test]
    fn the_client_declares_no_capability_it_intends_to_refuse() {
        // Declaring sampling or roots and then erroring on every call would be
        // a lie told at negotiation time. A server that reads our capabilities
        // should not ask in the first place.
        let info = HaruspexClient.get_info();
        assert!(info.capabilities.sampling.is_none());
        assert!(info.capabilities.roots.is_none());
        assert_eq!(info.client_info.name, "haruspex");
        assert_eq!(info.protocol_version, ProtocolVersion::V_2026_07_28);
    }

    #[test]
    fn a_refusal_names_the_era_and_the_method() {
        let err = HaruspexClient::refuse("elicitation/create");
        let message = err.message.to_string();
        assert!(
            message.contains("older MCP protocol"),
            "the model has to be able to explain this: {message}"
        );
        assert!(message.contains("2026-07-28"));
        assert!(message.contains("elicitation/create"));
    }

    #[test]
    fn annotations_are_carried_through_verbatim_including_their_absence() {
        let annotations =
            rmcp::model::ToolAnnotations::from_raw(None, Some(true), None, Some(true), None);
        let annotated = rmcp::model::Tool::new(
            "read_thing",
            "Read a thing",
            std::sync::Arc::new(serde_json::Map::new()),
        )
        .annotate(annotations);
        let described = describe_tool(&annotated);
        let a = described.annotations.expect("annotations were present");
        assert_eq!(a.read_only_hint, Some(true));
        assert_eq!(a.idempotent_hint, Some(true));
        // The two the server did not send must stay unsent, not become false.
        assert_eq!(a.destructive_hint, None);
        assert_eq!(a.open_world_hint, None);

        let bare = rmcp::model::Tool::new(
            "read_thing",
            "Read a thing",
            std::sync::Arc::new(serde_json::Map::new()),
        );
        assert!(
            describe_tool(&bare).annotations.is_none(),
            "no annotations at all is a different statement from empty annotations"
        );
    }

    #[test]
    fn an_input_request_keeps_its_key_and_payload_intact() {
        let payload = serde_json::json!({
            "method": "elicitation/create",
            "params": {
                "message": "Which project?",
                "requestedSchema": {
                    "type": "object",
                    "properties": { "project": { "type": "string", "title": "Project" } },
                    "required": ["project"]
                }
            }
        });
        let request: InputRequest = serde_json::from_value(payload.clone()).unwrap();
        let described = describe_input_request("q1".into(), request);
        assert_eq!(described.key, "q1");
        assert_eq!(described.method.as_deref(), Some("elicitation/create"));
        assert_eq!(
            described
                .payload
                .get("params")
                .and_then(|p| p.get("message")),
            Some(&serde_json::json!("Which project?")),
            "the question text must survive to whoever renders it"
        );
    }
}
