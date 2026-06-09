//! Tauri command backing the Python sandbox's `pyodide.http.pyfetch`
//! override. Routes outbound HTTP from inside Python code through the
//! same reqwest+proxy plumbing the `web_search` / `fetch_url` tools
//! already use, so the model's `await pyodide.http.pyfetch(url)` calls
//! honor the user's app-level proxy config instead of going direct
//! through the WebView's fetch (which doesn't see app proxy settings).
//!
//! Returns full status / headers / body bytes — the worker side wraps
//! this in a Python class that mimics pyodide.http.FetchResponse so
//! existing pyfetch usage patterns (.text(), .json(), .bytes(), etc.)
//! keep working.

use crate::proxy::{apply_proxy, ProxyConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::http::{header, HeaderMap, Method, Request, Response, StatusCode};

/// Hard cap on a single fetched response. Generous enough for typical
/// API responses, small enough to bound runaway downloads.
const MAX_FETCH_BYTES: usize = 50 * 1_048_576; // 50 MB
const SANDBOX_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default, Deserialize)]
pub struct SandboxFetchInit {
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<Vec<u8>>,
}

#[derive(Serialize)]
pub struct SandboxFetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    pub url: String,
}

#[tauri::command]
pub async fn sandbox_fetch(
    url: String,
    init: Option<SandboxFetchInit>,
    proxy: Option<ProxyConfig>,
) -> Result<SandboxFetchResponse, String> {
    let init = init.unwrap_or_default();
    perform_fetch(
        &url,
        init.method.as_deref().unwrap_or("GET"),
        init.headers,
        init.body,
        proxy.as_ref(),
    )
    .await
}

/// Core reqwest fetch shared by the `sandbox_fetch` command (async pyfetch
/// path) and the `haruspexfetch:` URI-scheme handler (sync requests/urllib
/// path). Runs through the same reqwest+proxy plumbing as `web_search`.
async fn perform_fetch(
    url: &str,
    method_str: &str,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    proxy: Option<&ProxyConfig>,
) -> Result<SandboxFetchResponse, String> {
    let method = reqwest::Method::from_bytes(method_str.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {}", method_str, e))?;

    let client = apply_proxy(
        reqwest::Client::builder().timeout(SANDBOX_FETCH_TIMEOUT),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut req = client.request(method, url);
    if let Some(headers) = headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    if let Some(body) = body {
        req = req.body(body);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();
    let headers: HashMap<String, String> = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
        .collect();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    if bytes.len() > MAX_FETCH_BYTES {
        return Err(format!(
            "Response too large ({} bytes); maximum is {} bytes",
            bytes.len(),
            MAX_FETCH_BYTES
        ));
    }

    Ok(SandboxFetchResponse {
        status,
        headers,
        body: bytes.to_vec(),
        url: final_url,
    })
}

// ----------------------------------------------------------------------
// `haruspexfetch:` custom URI-scheme handler.
//
// The Python sandbox's SYNCHRONOUS HTTP (requests / urllib / httpx, which
// pyodide-http routes through a synchronous XMLHttpRequest) can't reach the
// async pyfetch->Rust bridge — and a sync XHR straight to a cross-origin URL
// is CORS-blocked by the WebView. There's no SharedArrayBuffer on WebKitGTK
// to bridge sync<->async, so instead the worker rewrites each cross-origin
// XHR to `…/?u=<encoded target>` on this scheme. We do the real fetch here
// via reqwest (no browser CORS) and return it with permissive CORS + CORP
// headers so the sync XHR accepts the reply.
// ----------------------------------------------------------------------

/// Async handler registered via `register_asynchronous_uri_scheme_protocol`.
pub async fn handle_fetch_scheme(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // A non-simple cross-origin XHR (POST, JSON content-type, …) is preceded
    // by an OPTIONS preflight that must be answered with the CORS headers.
    if request.method() == Method::OPTIONS {
        return cors_response(StatusCode::NO_CONTENT, None, Vec::new());
    }

    let target = request.uri().query().and_then(extract_target_url);
    let Some(target) = target else {
        return cors_response(
            StatusCode::BAD_REQUEST,
            Some("text/plain"),
            b"haruspexfetch: missing ?u= target".to_vec(),
        );
    };

    let body = if request.body().is_empty() {
        None
    } else {
        Some(request.body().clone())
    };

    match perform_fetch(
        &target,
        request.method().as_str(),
        Some(forward_headers(request.headers())),
        body,
        None,
    )
    .await
    {
        Ok(r) => {
            let content_type = r
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.clone());
            let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::BAD_GATEWAY);
            cors_response(status, content_type.as_deref(), r.body)
        }
        Err(e) => cors_response(StatusCode::BAD_GATEWAY, Some("text/plain"), e.into_bytes()),
    }
}

/// Pull the percent-encoded target URL out of the `u=` query parameter.
fn extract_target_url(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        pair.strip_prefix("u=")
            .and_then(|v| urlencoding::decode(v).ok())
            .map(|c| c.into_owned())
    })
}

/// Headers to replay to the upstream target. Drop browser/hop-by-hop headers
/// that would leak the sandbox origin or confuse reqwest's own framing.
fn forward_headers(headers: &HeaderMap) -> HashMap<String, String> {
    const SKIP: &[&str] = &[
        "host",
        "origin",
        "referer",
        "connection",
        "content-length",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-fetch-dest",
    ];
    headers
        .iter()
        .filter_map(|(k, v)| {
            let name = k.as_str().to_ascii_lowercase();
            if SKIP.contains(&name.as_str()) {
                return None;
            }
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_string(), s.to_string()))
        })
        .collect()
}

/// Build a response with permissive CORS + CORP headers so the worker's
/// cross-origin (and COEP-`credentialless`) sync XHR accepts it.
fn cors_response(
    status: StatusCode,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin");
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
