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
    let method_str = init.method.as_deref().unwrap_or("GET").to_uppercase();
    let method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {}", method_str, e))?;

    let client = apply_proxy(
        reqwest::Client::builder().timeout(SANDBOX_FETCH_TIMEOUT),
        proxy.as_ref(),
    )?
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut req = client.request(method, &url);
    if let Some(headers) = init.headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    if let Some(body) = init.body {
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
