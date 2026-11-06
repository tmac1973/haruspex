//! A generic client for `/v1/rerank` servers, and a server's model list with
//! the capabilities it reports.
//!
//! Neither is tied to code search: the Search helper reranks keyword
//! candidates with `rerank_run`, and memory recall can do the same
//! later. `server_models_list` lets Settings offer only rerank (or embedding)
//! models. It reads `GET /v1/models` rather than the inference probe, because
//! for llama-toolchest the probe lists only the models chat completions will
//! serve, while `/v1/models` lists every one with `meta.capabilities` such as
//! `["rerank"]` or `["embedding", "tools"]`.
//!
//! Both go through `sidecar_util::http_client`, which has no proxy, the same
//! as `probe_inference_server`: inference servers are reached directly.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::inference::normalize_base_url;

const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MODELS_TIMEOUT: Duration = Duration::from_secs(10);

/// Each document is cut to this many characters before it is sent, so one
/// long chunk can't overflow a reranker's context.
const MAX_DOCUMENT_CHARS: usize = 4_000;

/// How much of an unreadable body an error quotes.
const BODY_EXCERPT_CHARS: usize = 200;

/// One document's place in a rerank: its index in the documents sent, and
/// the score the server gave it.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RerankScore {
    pub index: u32,
    pub score: f32,
}

/// The documents in the order the server ranks them, highest score first.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RerankResult {
    pub order: Vec<RerankScore>,
}

/// One model a server lists. `capabilities` is what toolchest reports in
/// `meta.capabilities` (`["rerank"]`, `["embedding", "tools"]`); servers
/// that don't report it (llama-server, LM Studio) give `None`.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ServerModel {
    pub id: String,
    pub capabilities: Option<Vec<String>>,
}

/// Rank `documents` by how well each answers `query`, with the rerank model
/// `model` at `base_url`.
#[tauri::command]
pub async fn rerank_run(
    base_url: String,
    api_key: Option<String>,
    model: String,
    query: String,
    documents: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<RerankResult, String> {
    let base = normalize_base_url(&base_url)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let client = crate::sidecar_util::http_client(timeout);
    let body = serde_json::json!({
        "model": model,
        "query": query,
        "documents": documents.iter().map(|d| cut_document(d)).collect::<Vec<_>>(),
    });
    let resp = with_key(client.post(format!("{base}/v1/rerank")), api_key.as_deref())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Rerank request to {base} failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Couldn't read the rerank response from {base}: {e}"))?;
    parse_rerank(status.as_u16(), status.is_success(), &text)
}

/// The models a server lists at `GET /v1/models`, sorted by id.
#[tauri::command]
pub async fn server_models_list(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<ServerModel>, String> {
    let base = normalize_base_url(&base_url)?;
    let client = crate::sidecar_util::http_client(MODELS_TIMEOUT);
    let resp = with_key(client.get(format!("{base}/v1/models")), api_key.as_deref())
        .send()
        .await
        .map_err(|e| format!("Couldn't list models at {base}: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("Couldn't read the model list from {base}: {e}"))?;
    parse_models(status.as_u16(), status.is_success(), &text)
}

fn with_key(req: reqwest::RequestBuilder, api_key: Option<&str>) -> reqwest::RequestBuilder {
    match api_key.map(str::trim) {
        Some(key) if !key.is_empty() => req.bearer_auth(key),
        _ => req,
    }
}

fn cut_document(doc: &str) -> &str {
    match doc.char_indices().nth(MAX_DOCUMENT_CHARS) {
        Some((at, _)) => &doc[..at],
        None => doc,
    }
}

fn unexpected(what: &str, status: u16, body: &str) -> String {
    let excerpt: String = body.chars().take(BODY_EXCERPT_CHARS).collect();
    format!("Unexpected {what} (HTTP {status}): {excerpt}")
}

/// Read either response shape in use: `{ results: [{ index,
/// relevance_score }] }` (llama.cpp, toolchest, Cohere and Jina) or
/// `{ data: [{ index, score }] }`.
fn parse_rerank(status: u16, ok: bool, body: &str) -> Result<RerankResult, String> {
    let bad = || unexpected("rerank response", status, body);
    if !ok {
        return Err(bad());
    }
    let json: Value = serde_json::from_str(body).map_err(|_| bad())?;
    let (rows, score_key) = if let Some(rows) = json.get("results").and_then(Value::as_array) {
        (rows, "relevance_score")
    } else if let Some(rows) = json.get("data").and_then(Value::as_array) {
        (rows, "score")
    } else {
        return Err(bad());
    };
    let mut order = rows
        .iter()
        .map(|row| {
            let index = row.get("index").and_then(Value::as_u64)?;
            let score = row.get(score_key).and_then(Value::as_f64)?;
            Some(RerankScore {
                index: u32::try_from(index).ok()?,
                score: score as f32,
            })
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(bad)?;
    order.sort_by(|a, b| b.score.total_cmp(&a.score));
    Ok(RerankResult { order })
}

fn parse_models(status: u16, ok: bool, body: &str) -> Result<Vec<ServerModel>, String> {
    let bad = || unexpected("model list", status, body);
    if !ok {
        return Err(bad());
    }
    let json: Value = serde_json::from_str(body).map_err(|_| bad())?;
    let rows = json.get("data").and_then(Value::as_array).ok_or_else(bad)?;
    let mut models: Vec<ServerModel> = rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?.to_string();
            let capabilities = row
                .get("meta")
                .and_then(|m| m.get("capabilities"))
                .and_then(Value::as_array)
                .map(|caps| {
                    caps.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                });
            Some(ServerModel { id, capabilities })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};
    use std::sync::{Arc, Mutex};

    fn score(index: u32, score: f32) -> RerankScore {
        RerankScore { index, score }
    }

    #[test]
    fn reads_the_results_shape_highest_first() {
        let body = r#"{"results":[{"index":0,"relevance_score":0.1},
            {"index":2,"relevance_score":0.9},{"index":1,"relevance_score":0.5}]}"#;
        let got = parse_rerank(200, true, body).unwrap();
        assert_eq!(got.order, vec![score(2, 0.9), score(1, 0.5), score(0, 0.1)]);
    }

    #[test]
    fn reads_the_data_shape_highest_first() {
        let body = r#"{"data":[{"index":1,"score":-3.0},{"index":0,"score":2.5}]}"#;
        let got = parse_rerank(200, true, body).unwrap();
        assert_eq!(got.order, vec![score(0, 2.5), score(1, -3.0)]);
    }

    #[test]
    fn an_unknown_shape_names_the_status_and_quotes_the_body() {
        let err = parse_rerank(200, true, r#"{"ranking":[1,0]}"#).unwrap_err();
        assert_eq!(
            err,
            r#"Unexpected rerank response (HTTP 200): {"ranking":[1,0]}"#
        );
        // A row missing its score is no better than a shape we don't know.
        assert!(parse_rerank(200, true, r#"{"results":[{"index":0}]}"#).is_err());
    }

    #[test]
    fn an_http_error_quotes_only_the_first_200_characters() {
        let body = "x".repeat(500);
        let err = parse_rerank(503, false, &body).unwrap_err();
        assert_eq!(
            err,
            format!("Unexpected rerank response (HTTP 503): {}", "x".repeat(200))
        );
    }

    #[test]
    fn documents_are_cut_to_4000_characters() {
        let short = "fn main() {}";
        assert_eq!(cut_document(short), short);
        // Characters, not bytes: a multi-byte document is cut on a boundary.
        let long = "é".repeat(5_000);
        assert_eq!(cut_document(&long).chars().count(), 4_000);
    }

    #[test]
    fn a_toolchest_list_carries_capabilities_sorted_by_id() {
        let body = r#"{"object":"list","data":[
            {"id":"qwen-embed","meta":{"capabilities":["embedding","tools"]}},
            {"id":"ggml-org-Qwen3-Reranker-0.6B-Q8_0.Q8_0","meta":{"capabilities":["rerank"]}},
            {"id":"chat","meta":{"context":32768}}]}"#;
        let got = parse_models(200, true, body).unwrap();
        assert_eq!(
            got,
            vec![
                ServerModel {
                    id: "chat".into(),
                    capabilities: None
                },
                ServerModel {
                    id: "ggml-org-Qwen3-Reranker-0.6B-Q8_0.Q8_0".into(),
                    capabilities: Some(vec!["rerank".into()])
                },
                ServerModel {
                    id: "qwen-embed".into(),
                    capabilities: Some(vec!["embedding".into(), "tools".into()])
                },
            ]
        );
    }

    #[test]
    fn a_plain_openai_list_has_no_capabilities() {
        let body = r#"{"object":"list","data":[{"id":"b","object":"model"},{"id":"a"}]}"#;
        let got = parse_models(200, true, body).unwrap();
        assert_eq!(
            got.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(got.iter().all(|m| m.capabilities.is_none()));
        assert!(parse_models(404, false, "not found").is_err());
    }

    type Seen = Arc<Mutex<Option<(Option<String>, Value)>>>;

    /// A rerank server that records the bearer header and body it was sent,
    /// and answers in the `results` shape after `delay`.
    async fn serve(delay: Duration) -> (String, Seen) {
        let seen: Seen = Arc::default();
        let record = seen.clone();
        let app = axum::Router::new()
            .route(
                "/v1/rerank",
                post(move |headers: HeaderMap, body: String| async move {
                    let auth = headers
                        .get("authorization")
                        .map(|v| v.to_str().unwrap().to_string());
                    *record.lock().unwrap() = Some((auth, serde_json::from_str(&body).unwrap()));
                    tokio::time::sleep(delay).await;
                    axum::Json(serde_json::json!({ "results": [
                        { "index": 0, "relevance_score": 0.2 },
                        { "index": 1, "relevance_score": 0.8 }
                    ]}))
                }),
            )
            .route(
                "/v1/models",
                get(|headers: HeaderMap| async move {
                    if headers.get("authorization").is_none() {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    Ok(axum::Json(serde_json::json!({ "data": [
                        { "id": "rr", "meta": { "capabilities": ["rerank"] } }
                    ]})))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn the_request_carries_the_key_and_the_cut_documents() {
        let (base, seen) = serve(Duration::ZERO).await;
        let long = "a".repeat(4_500);
        // A trailing `/v1` is normalized away, not doubled.
        let got = rerank_run(
            format!("{base}/v1/"),
            Some("sk-test".into()),
            "rr".into(),
            "loopback".into(),
            vec!["short".into(), long],
            None,
        )
        .await
        .unwrap();
        assert_eq!(got.order, vec![score(1, 0.8), score(0, 0.2)]);

        let (auth, body) = seen.lock().unwrap().take().unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer sk-test"));
        assert_eq!(body["model"], "rr");
        assert_eq!(body["query"], "loopback");
        assert_eq!(body["documents"][0], "short");
        assert_eq!(body["documents"][1].as_str().unwrap().len(), 4_000);
    }

    #[tokio::test]
    async fn no_key_sends_no_header() {
        let (base, seen) = serve(Duration::ZERO).await;
        rerank_run(
            base,
            Some("  ".into()),
            "rr".into(),
            "q".into(),
            vec![],
            None,
        )
        .await
        .unwrap();
        assert_eq!(seen.lock().unwrap().take().unwrap().0, None);
    }

    #[tokio::test]
    async fn a_slow_server_times_out() {
        let (base, _) = serve(Duration::from_secs(5)).await;
        // 10 ms is clamped up to the 1 s floor, still well under the delay.
        let started = std::time::Instant::now();
        let err = rerank_run(base, None, "rr".into(), "q".into(), vec![], Some(10))
            .await
            .unwrap_err();
        assert!(err.starts_with("Rerank request to"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[tokio::test]
    async fn the_model_list_sends_the_key() {
        let (base, _) = serve(Duration::ZERO).await;
        let got = server_models_list(base.clone(), Some("k".into()))
            .await
            .unwrap();
        assert_eq!(got[0].capabilities, Some(vec!["rerank".to_string()]));
        let refused = server_models_list(base, None).await.unwrap_err();
        assert!(refused.contains("HTTP 401"), "{refused}");
    }
}
