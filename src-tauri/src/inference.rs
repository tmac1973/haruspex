//! Remote inference server discovery + probing.
//!
//! Haruspex defaults to running a local llama-server sidecar and talking
//! to it over OpenAI-compat on port 8765. This module adds an optional
//! "point at an external inference server" path so users who already
//! run LM Studio / Lemonade / Ollama / their own llama.cpp deployment /
//! llama-toolchest don't have to duplicate their model into Haruspex's
//! managed directory.
//!
//! The probe walks four detection strategies in order from most-informative
//! to least:
//!
//!   1. **llama-toolchest** — `GET /api/service/status` confirms the
//!      management layer, then `/api/service/loaded-models` and
//!      `/api/models/{id}/info` yield rich per-model metadata including
//!      context size and vision capability. Toolchest tracks loaded-vs-
//!      unloaded state explicitly so the UI can surface a "load this
//!      model" affordance when the user picks an unloaded entry.
//!   2. **stock llama-server** — `GET /props` is a llama.cpp-specific
//!      endpoint exposing `n_ctx` and chat_template. We use it for the
//!      default context size and then fall through to `/v1/models` for
//!      the model list.
//!   3. **generic OpenAI-compat** — `GET /v1/models` covers LM Studio,
//!      Lemonade, vLLM, TGI, llamafile, and Ollama's OpenAI-compat
//!      endpoint. Returns a flat model list with no capability metadata;
//!      the UI falls back to manual entry for context size and a vision
//!      override checkbox.
//!   4. **Ollama native** — `GET /api/tags` for the rare case where
//!      Ollama's OpenAI-compat endpoint is disabled. We'll still route
//!      chat completions through its OpenAI-compat path at
//!      `/v1/chat/completions` since that's universally available.
//!
//! Normalized output: regardless of which path hit, the probe returns a
//! `ProbeResult` with a `BackendKind` enum + a `Vec<NormalizedModel>` so
//! the frontend only needs to understand one shape.

use serde::Serialize;
use std::time::Duration;

/// Per-probe HTTP timeout. Kept tight so a fully-unreachable host doesn't
/// make the user wait 30+ seconds for the full detection chain to fail.
/// A TCP connection refused trips sub-second; only slow/misbehaving hosts
/// hit the full timeout.
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// Which backend detection path matched for this probe. Shapes the
/// frontend's expectations around what metadata is available and whether
/// the user needs to enter context size / vision manually.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendKind {
    /// Rich metadata via llama-toolchest management API.
    LlamaToolchest,
    /// Stock llama.cpp llama-server — has `/props` but no per-model info.
    LlamaServer,
    /// Anything else that speaks `GET /v1/models`.
    OpenAiCompat,
    /// Ollama when its OpenAI-compat endpoint is disabled (uncommon).
    Ollama,
}

/// One model entry from a probe, normalized across all backend shapes.
/// `context_size` and `vision_supported` are best-effort — `None` means
/// the backend didn't expose that metadata and the UI will ask the user
/// to fill it in manually.
#[derive(Clone, Debug, Serialize)]
pub struct NormalizedModel {
    pub id: String,
    pub display_name: String,
    pub context_size: Option<u32>,
    pub vision_supported: Option<bool>,
    /// Only meaningful for llama-toolchest, which distinguishes loaded
    /// from unloaded models. Other backends either list a model (meaning
    /// it's usable) or don't; for them this stays `None`.
    pub loaded: Option<bool>,
}

/// Complete probe outcome for the frontend. Everything the Settings page
/// needs to populate its form and dropdown lives here.
#[derive(Clone, Debug, Serialize)]
pub struct ProbeResult {
    /// The normalized base URL the probe succeeded against. May differ
    /// from what the user typed (trailing slash / `/v1` suffix stripped).
    pub base_url: String,
    pub kind: BackendKind,
    pub models: Vec<NormalizedModel>,
    /// Backend-reported default context window size, when detectable.
    /// llama-server: `/props.n_ctx`. llama-toolchest: the context of the
    /// first loaded model. OpenAI-compat / Ollama: `None`.
    pub default_context_size: Option<u32>,
    /// Short human-readable note for the UI — e.g. "llama-toolchest
    /// (2 models loaded)" or "OpenAI-compatible (4 models available)".
    pub notes: String,
}

/// Normalize a user-entered base URL to a "service root" that downstream
/// code can append paths onto. Strips trailing slashes and a trailing
/// `/v1` segment if present, so the caller can build either management
/// endpoints (`{root}/api/service/status`) or OpenAI-compat endpoints
/// (`{root}/v1/chat/completions`) without worrying about how the user
/// typed it.
///
/// Accepts:
///   - `http://host:port`
///   - `http://host:port/`
///   - `https://host/v1`
///   - `https://host/v1/`
///   - `https://host/custom/path`   (kept as-is minus trailing slash)
///
/// Rejects: empty strings, non-HTTP schemes, unparseable URLs.
pub fn normalize_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("URL is empty".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("Invalid URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("Unsupported URL scheme: {}", scheme)),
    }
    // Reject URLs with no host at all — e.g. `http:///path`.
    if parsed.host().is_none() {
        return Err("URL is missing a host".to_string());
    }

    let mut as_str = parsed.as_str().trim_end_matches('/').to_string();
    // Strip a trailing `/v1` segment — users often enter the OpenAI-compat
    // base URL directly, but our detection chain needs the service root
    // to hit management endpoints at `/api/...` or `/props`.
    if let Some(stripped) = as_str.strip_suffix("/v1") {
        as_str = stripped.to_string();
    }
    // And trim any slash the suffix strip exposed.
    let as_str = as_str.trim_end_matches('/').to_string();
    Ok(as_str)
}

/// Attach an `Authorization: Bearer {key}` header to a request builder if
/// `api_key` is set and non-empty. Self-hosted servers typically run
/// without auth; cloud providers require it. Blank means skip it.
fn attach_auth(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key {
        Some(key) if !key.trim().is_empty() => {
            req.header("Authorization", format!("Bearer {}", key.trim()))
        }
        _ => req,
    }
}

/// GET a URL and parse the body as JSON, returning `None` on any failure
/// (connection error, non-2xx status, invalid JSON). Used throughout the
/// probe paths so individual endpoint failures degrade gracefully — if
/// /api/models/ happens to return 500 we still show the user whatever
/// we learned from /api/service/loaded-models.
async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    api_key: Option<&str>,
) -> Option<serde_json::Value> {
    let resp = attach_auth(client.get(url), api_key).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

/// Main entry point: walk the detection chain and return the richest
/// backend that responds successfully.
#[tauri::command]
pub async fn probe_inference_server(
    base_url: String,
    api_key: Option<String>,
) -> Result<ProbeResult, String> {
    let normalized = normalize_base_url(&base_url)?;
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    let api_key_ref = api_key.as_deref();

    if let Some(result) = try_llama_toolchest(&client, &normalized, api_key_ref).await {
        return Ok(result);
    }
    if let Some(result) = try_llama_server(&client, &normalized, api_key_ref).await {
        return Ok(result);
    }
    if let Some(result) = try_openai_compat(&client, &normalized, api_key_ref).await {
        return Ok(result);
    }
    if let Some(result) = try_ollama_native(&client, &normalized, api_key_ref).await {
        return Ok(result);
    }

    Err(format!(
        "Couldn't detect a supported inference server at {}. Tried: llama-toolchest (/api/service/status), llama-server (/props), OpenAI-compat (/v1/models), Ollama (/api/tags). Check that the URL is correct and the server is reachable.",
        normalized
    ))
}

// ---------------------------------------------------------------------
// Detection strategies
// ---------------------------------------------------------------------

async fn try_llama_toolchest(
    client: &reqwest::Client,
    base: &str,
    api_key: Option<&str>,
) -> Option<ProbeResult> {
    // Step 1: confirm it's toolchest by hitting the management status.
    let status_url = format!("{}/api/service/status", base);
    let status_resp = attach_auth(client.get(&status_url), api_key)
        .send()
        .await
        .ok()?;
    if !status_resp.status().is_success() {
        return None;
    }

    // Step 2: loaded models — the router-facing list (what's actually
    // usable for chat requests right now).
    let loaded_url = format!("{}/api/service/loaded-models", base);
    let loaded_json = fetch_json(client, &loaded_url, api_key).await?;
    let loaded = parse_toolchest_model_list(&loaded_json);

    // Step 3: also list ALL models so the user can see unloaded ones and
    // potentially activate them from the Settings UI. Optional — if this
    // fails we still return whatever we got from loaded-models.
    let all_url = format!("{}/api/models/", base);
    let all_json = fetch_json(client, &all_url, api_key).await;
    let all_listed: Vec<ToolchestModelEntry> = all_json
        .as_ref()
        .map(parse_toolchest_model_list)
        .unwrap_or_default();

    // Step 4: merge loaded + all, preferring loaded status when known.
    let mut model_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut entries: std::collections::HashMap<String, ToolchestModelEntry> =
        std::collections::HashMap::new();
    for m in all_listed {
        model_ids.insert(m.id.clone());
        entries.insert(m.id.clone(), m);
    }
    for m in &loaded {
        model_ids.insert(m.id.clone());
        entries
            .entry(m.id.clone())
            .and_modify(|e| e.loaded = true)
            .or_insert_with(|| m.clone());
    }

    // Step 5: for each model, fetch capabilities via /api/models/{id}/info.
    // We do this sequentially because toolchest is typically small-scale
    // and the probe latency is dominated by the per-request handshake
    // rather than wall time; parallelism via join_all would add ~100 lines
    // of scaffolding for a marginal speedup.
    let mut models: Vec<NormalizedModel> = Vec::new();
    let mut default_context_size: Option<u32> = None;
    for id in &model_ids {
        let entry = entries.get(id).cloned().unwrap_or(ToolchestModelEntry {
            id: id.clone(),
            name: id.clone(),
            loaded: false,
        });
        let info_url = format!("{}/api/models/{}/info", base, id);
        let info = fetch_json(client, &info_url, api_key).await;
        let (ctx_size, vision) = info
            .as_ref()
            .map(parse_toolchest_model_info)
            .unwrap_or((None, None));

        // Use the first loaded model's context size as the deck-wide default.
        if default_context_size.is_none() && entry.loaded {
            default_context_size = ctx_size;
        }

        models.push(NormalizedModel {
            id: entry.id.clone(),
            display_name: entry.name,
            context_size: ctx_size,
            vision_supported: vision,
            loaded: Some(entry.loaded),
        });
    }

    let loaded_count = models.iter().filter(|m| m.loaded == Some(true)).count();
    Some(ProbeResult {
        base_url: base.to_string(),
        kind: BackendKind::LlamaToolchest,
        models,
        default_context_size,
        notes: format!(
            "llama-toolchest ({} loaded of {} total)",
            loaded_count,
            model_ids.len()
        ),
    })
}

async fn try_llama_server(
    client: &reqwest::Client,
    base: &str,
    api_key: Option<&str>,
) -> Option<ProbeResult> {
    // `/props` is the llama.cpp-specific endpoint. A 200 here plus a
    // parseable JSON body with `n_ctx` confirms we're talking to stock
    // llama-server (or something pretending to be it well enough that
    // the ctx-size read is still meaningful).
    let props_url = format!("{}/props", base);
    let props = fetch_json(client, &props_url, api_key).await?;
    let n_ctx = props
        .get("default_generation_settings")
        .and_then(|v| v.get("n_ctx"))
        .and_then(|v| v.as_u64())
        .or_else(|| props.get("n_ctx").and_then(|v| v.as_u64()))
        .map(|v| v as u32);

    // For the model list fall through to OpenAI-compat /v1/models which
    // llama-server also serves. Vision detection: llama-server doesn't
    // expose a clean "multimodal" flag, so we leave it as None and let
    // the Settings UI surface a manual override checkbox.
    let models_url = format!("{}/v1/models", base);
    let models_json = fetch_json(client, &models_url, api_key).await?;
    let model_ids = parse_openai_model_list(&models_json);

    let models: Vec<NormalizedModel> = model_ids
        .into_iter()
        .map(|id| NormalizedModel {
            display_name: id.clone(),
            id,
            context_size: n_ctx,
            vision_supported: None,
            loaded: None,
        })
        .collect();

    let notes = format!(
        "llama-server ({} model{}{})",
        models.len(),
        if models.len() == 1 { "" } else { "s" },
        n_ctx.map(|n| format!(", n_ctx={}", n)).unwrap_or_default()
    );

    Some(ProbeResult {
        base_url: base.to_string(),
        kind: BackendKind::LlamaServer,
        models,
        default_context_size: n_ctx,
        notes,
    })
}

async fn try_openai_compat(
    client: &reqwest::Client,
    base: &str,
    api_key: Option<&str>,
) -> Option<ProbeResult> {
    let url = format!("{}/v1/models", base);
    let json = fetch_json(client, &url, api_key).await?;
    let ids = parse_openai_model_list(&json);
    if ids.is_empty() {
        return None;
    }
    let models: Vec<NormalizedModel> = ids
        .into_iter()
        .map(|id| NormalizedModel {
            display_name: id.clone(),
            id,
            context_size: None,
            vision_supported: None,
            loaded: None,
        })
        .collect();
    let notes = format!(
        "OpenAI-compatible ({} model{})",
        models.len(),
        if models.len() == 1 { "" } else { "s" }
    );
    Some(ProbeResult {
        base_url: base.to_string(),
        kind: BackendKind::OpenAiCompat,
        models,
        default_context_size: None,
        notes,
    })
}

async fn try_ollama_native(
    client: &reqwest::Client,
    base: &str,
    api_key: Option<&str>,
) -> Option<ProbeResult> {
    let url = format!("{}/api/tags", base);
    let json = fetch_json(client, &url, api_key).await?;
    let models = parse_ollama_tags(&json);
    if models.is_empty() {
        return None;
    }
    let notes = format!(
        "Ollama native ({} model{})",
        models.len(),
        if models.len() == 1 { "" } else { "s" }
    );
    Some(ProbeResult {
        base_url: base.to_string(),
        kind: BackendKind::Ollama,
        models,
        default_context_size: None,
        notes,
    })
}

// ---------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------

/// An entry from llama-toolchest's model-list endpoints, before it gets
/// merged with per-model capability info into a `NormalizedModel`.
#[derive(Clone, Debug)]
struct ToolchestModelEntry {
    id: String,
    name: String,
    loaded: bool,
}

/// Parse a toolchest model list response. Handles both `{"models": [...]}`
/// and a bare `[...]` shape since we don't have the exact schema nailed
/// down — be tolerant. Fields probed: `id`, `name`, `loaded`, `status`.
fn parse_toolchest_model_list(v: &serde_json::Value) -> Vec<ToolchestModelEntry> {
    let arr = v
        .get("models")
        .and_then(|x| x.as_array())
        .or_else(|| v.as_array())
        .cloned()
        .unwrap_or_default();
    arr.into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("model_id").and_then(|x| x.as_str()))
                .or_else(|| item.get("name").and_then(|x| x.as_str()))?
                .to_string();
            let name = item
                .get("name")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("display_name").and_then(|x| x.as_str()))
                .map(|s| s.to_string())
                .unwrap_or_else(|| id.clone());
            // Accept several shapes for loaded state: a bool `loaded` field,
            // a string `status` of "loaded"/"ready", or presence in a
            // loaded-models list (handled at the call site).
            let loaded = item
                .get("loaded")
                .and_then(|x| x.as_bool())
                .or_else(|| {
                    item.get("status")
                        .and_then(|x| x.as_str())
                        .map(|s| matches!(s, "loaded" | "ready" | "running"))
                })
                .unwrap_or(true); // default to true when coming from the loaded-models endpoint
            Some(ToolchestModelEntry { id, name, loaded })
        })
        .collect()
}

/// Extract context size and vision capability from llama-toolchest's
/// `/api/models/{id}/info` response. Field names aren't standardized, so
/// probe a handful of plausible shapes and return the first that matches.
fn parse_toolchest_model_info(v: &serde_json::Value) -> (Option<u32>, Option<bool>) {
    // Context size — try nested config, flat fields, and common aliases.
    let ctx_size = v
        .get("context_size")
        .and_then(|x| x.as_u64())
        .or_else(|| v.get("n_ctx").and_then(|x| x.as_u64()))
        .or_else(|| v.get("ctx_size").and_then(|x| x.as_u64()))
        .or_else(|| v.get("max_context_length").and_then(|x| x.as_u64()))
        .or_else(|| {
            v.get("config")
                .and_then(|c| c.get("context_size"))
                .and_then(|x| x.as_u64())
        })
        .or_else(|| {
            v.get("config")
                .and_then(|c| c.get("n_ctx"))
                .and_then(|x| x.as_u64())
        })
        .map(|n| n as u32);

    // Vision capability — nested under capabilities, or a flat bool.
    let vision = v
        .get("vision")
        .and_then(|x| x.as_bool())
        .or_else(|| v.get("multimodal").and_then(|x| x.as_bool()))
        .or_else(|| v.get("vision_supported").and_then(|x| x.as_bool()))
        .or_else(|| {
            v.get("capabilities")
                .and_then(|c| c.get("vision"))
                .and_then(|x| x.as_bool())
        })
        .or_else(|| {
            v.get("capabilities")
                .and_then(|c| c.get("multimodal"))
                .and_then(|x| x.as_bool())
        });

    (ctx_size, vision)
}

/// Parse a standard OpenAI `/v1/models` response into a flat list of
/// model IDs. Expected shape: `{"data": [{"id": "..."}, ...]}`. Some
/// servers return `{"models": [...]}` or a bare array; handle those too.
fn parse_openai_model_list(v: &serde_json::Value) -> Vec<String> {
    let arr = v
        .get("data")
        .and_then(|x| x.as_array())
        .or_else(|| v.get("models").and_then(|x| x.as_array()))
        .or_else(|| v.as_array())
        .cloned()
        .unwrap_or_default();
    arr.into_iter()
        .filter_map(|item| {
            item.get("id")
                .and_then(|x| x.as_str())
                .or_else(|| item.get("name").and_then(|x| x.as_str()))
                .map(|s| s.to_string())
        })
        .collect()
}

/// Parse Ollama's `/api/tags` response. Shape:
/// `{"models": [{"name": "qwen2.5:7b", "modified_at": "...", ...}, ...]}`.
fn parse_ollama_tags(v: &serde_json::Value) -> Vec<NormalizedModel> {
    let arr = v
        .get("models")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    arr.into_iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(|x| x.as_str())?.to_string();
            Some(NormalizedModel {
                display_name: name.clone(),
                id: name,
                context_size: None,
                vision_supported: None,
                loaded: None,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_strips_trailing_slash() {
        assert_eq!(
            normalize_base_url("http://host:8080/").unwrap(),
            "http://host:8080"
        );
        assert_eq!(
            normalize_base_url("http://host:8080").unwrap(),
            "http://host:8080"
        );
    }

    #[test]
    fn normalize_base_url_strips_trailing_v1() {
        assert_eq!(
            normalize_base_url("https://api.example.com/v1").unwrap(),
            "https://api.example.com"
        );
        assert_eq!(
            normalize_base_url("https://api.example.com/v1/").unwrap(),
            "https://api.example.com"
        );
    }

    #[test]
    fn normalize_base_url_keeps_custom_paths() {
        // A non-/v1 path is preserved — some reverse-proxied setups put
        // the server behind an arbitrary prefix.
        assert_eq!(
            normalize_base_url("https://gateway.example.com/llm-api/").unwrap(),
            "https://gateway.example.com/llm-api"
        );
    }

    #[test]
    fn normalize_base_url_rejects_bad_input() {
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("  ").is_err());
        assert!(normalize_base_url("not a url").is_err());
        assert!(normalize_base_url("ftp://host/path").is_err());
        assert!(normalize_base_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn parse_openai_model_list_standard_shape() {
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4", "object": "model" },
                { "id": "gpt-3.5-turbo", "object": "model" }
            ]
        });
        let ids = parse_openai_model_list(&json);
        assert_eq!(ids, vec!["gpt-4", "gpt-3.5-turbo"]);
    }

    #[test]
    fn parse_openai_model_list_llama_server_shape() {
        // llama-server returns the same shape; this is just a sanity check
        // with a realistic model id format.
        let json = serde_json::json!({
            "data": [
                { "id": "Qwen3.5-9B-Q4_K_M.gguf", "object": "model" }
            ]
        });
        let ids = parse_openai_model_list(&json);
        assert_eq!(ids, vec!["Qwen3.5-9B-Q4_K_M.gguf"]);
    }

    #[test]
    fn parse_openai_model_list_tolerates_missing_data_wrapper() {
        let json = serde_json::json!([
            { "id": "model-a" },
            { "id": "model-b" }
        ]);
        let ids = parse_openai_model_list(&json);
        assert_eq!(ids, vec!["model-a", "model-b"]);
    }

    #[test]
    fn parse_ollama_tags_returns_model_names() {
        let json = serde_json::json!({
            "models": [
                { "name": "qwen2.5:7b", "modified_at": "2024-01-01", "size": 4700000000_u64 },
                { "name": "llama3.1:8b", "modified_at": "2024-02-01", "size": 5100000000_u64 }
            ]
        });
        let models = parse_ollama_tags(&json);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen2.5:7b");
        assert_eq!(models[1].id, "llama3.1:8b");
    }

    #[test]
    fn parse_toolchest_model_list_standard() {
        let json = serde_json::json!({
            "models": [
                { "id": "qwen-7b", "name": "Qwen 7B", "loaded": true },
                { "id": "llama-8b", "name": "Llama 8B", "loaded": false }
            ]
        });
        let models = parse_toolchest_model_list(&json);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen-7b");
        assert_eq!(models[0].name, "Qwen 7B");
        assert!(models[0].loaded);
        assert!(!models[1].loaded);
    }

    #[test]
    fn parse_toolchest_model_list_status_string() {
        // Loaded state expressed as a string instead of a bool.
        let json = serde_json::json!({
            "models": [
                { "id": "a", "status": "loaded" },
                { "id": "b", "status": "unloaded" }
            ]
        });
        let models = parse_toolchest_model_list(&json);
        assert!(models[0].loaded);
        assert!(!models[1].loaded);
    }

    #[test]
    fn parse_toolchest_model_info_nested_capabilities() {
        let json = serde_json::json!({
            "id": "qwen-7b",
            "context_size": 32768,
            "capabilities": { "vision": true }
        });
        let (ctx, vision) = parse_toolchest_model_info(&json);
        assert_eq!(ctx, Some(32768));
        assert_eq!(vision, Some(true));
    }

    #[test]
    fn parse_toolchest_model_info_flat_fields() {
        let json = serde_json::json!({
            "id": "llama-8b",
            "n_ctx": 8192,
            "multimodal": false
        });
        let (ctx, vision) = parse_toolchest_model_info(&json);
        assert_eq!(ctx, Some(8192));
        assert_eq!(vision, Some(false));
    }

    #[test]
    fn parse_toolchest_model_info_missing_fields() {
        let json = serde_json::json!({ "id": "mystery-model" });
        let (ctx, vision) = parse_toolchest_model_info(&json);
        assert_eq!(ctx, None);
        assert_eq!(vision, None);
    }
}
