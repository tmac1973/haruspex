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

use crate::proxy::{apply_proxy, routes_through_proxy, ProxyConfig};
use crate::sync_util::LockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;
use tauri::http::{header, HeaderMap, Method, Request, Response, StatusCode};

/// Hard cap on a single fetched response. Generous enough for typical
/// API responses, small enough to bound runaway downloads.
const MAX_FETCH_BYTES: usize = 50 * 1_048_576; // 50 MB
const SANDBOX_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Redirects followed per request, each one checked like the first.
const MAX_REDIRECTS: usize = 5;

/// What model-written Python may reach (Settings → Agent).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum SandboxNetAccess {
    /// Public addresses only.
    Internet,
    /// Public and private-network addresses; nothing on this machine.
    #[default]
    Lan,
    /// Anything, this machine's own services included.
    All,
}

/// The sandbox's network settings, held here so the `haruspexfetch:` scheme
/// handler, which gets no arguments from the webview, applies the same ones
/// as `sandbox_fetch`. The worker manager pushes them before every run.
#[derive(Clone, Debug, Default)]
pub struct NetPolicy {
    pub proxy: Option<ProxyConfig>,
    pub access: SandboxNetAccess,
}

#[derive(Default)]
pub struct SandboxNet(Mutex<NetPolicy>);

impl SandboxNet {
    pub fn current(&self) -> NetPolicy {
        self.0.lock_or_recover().clone()
    }
}

#[tauri::command]
pub fn sandbox_set_network(
    state: tauri::State<'_, SandboxNet>,
    proxy: Option<ProxyConfig>,
    access: SandboxNetAccess,
) {
    *state.0.lock_or_recover() = NetPolicy { proxy, access };
}

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
    state: tauri::State<'_, SandboxNet>,
    url: String,
    init: Option<SandboxFetchInit>,
) -> Result<SandboxFetchResponse, String> {
    let init = init.unwrap_or_default();
    let net = state.current();
    perform_fetch(
        &url,
        init.method.as_deref().unwrap_or("GET"),
        init.headers,
        init.body,
        &net,
    )
    .await
}

/// Where an address leads, for [`SandboxNetAccess`].
#[derive(Debug, PartialEq, Eq)]
enum Reach {
    /// This machine: loopback, or the unspecified address that connects here.
    Local,
    /// A private, link-local or shared (CGNAT) network.
    Lan,
    Public,
}

fn reach(ip: IpAddr) -> Reach {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            if v4.is_loopback() || v4.is_unspecified() {
                Reach::Local
            } else if v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || (a == 100 && (64..128).contains(&b))
            {
                Reach::Lan
            } else {
                Reach::Public
            }
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return reach(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            if v6.is_loopback() || v6.is_unspecified() {
                Reach::Local
            } else if (seg0 & 0xfe00) == 0xfc00 || (seg0 & 0xffc0) == 0xfe80 {
                Reach::Lan
            } else {
                Reach::Public
            }
        }
    }
}

fn allowed(access: SandboxNetAccess, ip: IpAddr) -> bool {
    match (access, reach(ip)) {
        (SandboxNetAccess::All, _) => true,
        (SandboxNetAccess::Lan, Reach::Local) => false,
        (SandboxNetAccess::Lan, _) => true,
        (SandboxNetAccess::Internet, r) => r == Reach::Public,
    }
}

fn refusal(access: SandboxNetAccess, host: &str) -> String {
    let what = match access {
        SandboxNetAccess::Internet => "addresses on this machine or the local network",
        _ => "addresses on this machine",
    };
    format!(
        "Blocked: {host} is one of the {what}, which the Python sandbox may not reach \
         (Settings → Agent)."
    )
}

/// Check where `url` leads and return the address to pin the connection to.
///
/// Resolved here, and the connection then pinned to the address checked, so a
/// name cannot pass the check and then resolve somewhere else for the real
/// request. Through a proxy the proxy resolves the name, so only a literal
/// address or a `localhost` name can be judged.
async fn vet(url: &reqwest::Url, net: &NetPolicy) -> Result<Option<SocketAddr>, String> {
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    if net.access == SandboxNetAccess::All {
        return Ok(None);
    }
    let named_local =
        host.eq_ignore_ascii_case("localhost") || host.to_lowercase().ends_with(".localhost");
    if named_local {
        return Err(refusal(net.access, &host));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if allowed(net.access, ip) {
            Ok(Some(SocketAddr::new(ip, port)))
        } else {
            Err(refusal(net.access, &host))
        };
    }
    if routes_through_proxy(net.proxy.as_ref(), url) {
        return Ok(None);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("Could not resolve {host}: {e}"))?
        .collect();
    // Every address, not just the first: a name that answers with a public
    // address and a loopback one would otherwise be a coin toss.
    if addrs.is_empty() || addrs.iter().any(|a| !allowed(net.access, a.ip())) {
        return Err(refusal(net.access, &host));
    }
    Ok(addrs.first().copied())
}

/// Core reqwest fetch shared by the `sandbox_fetch` command (async pyfetch
/// path) and the `haruspexfetch:` URI-scheme handler (sync requests/urllib
/// path). Uses the network proxy, and follows redirects itself so that every
/// hop is checked against the sandbox's network access, not just the first.
async fn perform_fetch(
    url: &str,
    method_str: &str,
    headers: Option<HashMap<String, String>>,
    body: Option<Vec<u8>>,
    net: &NetPolicy,
) -> Result<SandboxFetchResponse, String> {
    let mut method = reqwest::Method::from_bytes(method_str.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {}", method_str, e))?;
    let mut target = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL '{url}': {e}"))?;
    let mut body = body;

    for _ in 0..=MAX_REDIRECTS {
        let pinned = vet(&target, net).await?;
        let mut builder = reqwest::Client::builder()
            .timeout(SANDBOX_FETCH_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none());
        if let (Some(addr), Some(host)) = (pinned, target.host_str()) {
            builder = builder.resolve(host, addr);
        }
        let client = apply_proxy(builder, net.proxy.as_ref())?
            .build()
            .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

        let mut req = client.request(method.clone(), target.clone());
        if let Some(headers) = &headers {
            for (k, v) in headers {
                req = req.header(k, v);
            }
        }
        if let Some(body) = &body {
            req = req.body(body.clone());
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("HTTP request failed: {}", e))?;

        if resp.status().is_redirection() {
            if let Some(next) = resp
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| target.join(loc).ok())
            {
                // 303, and 301/302 after a POST, become a GET without a body,
                // as browsers and reqwest's own policy do. 307/308 keep both.
                let status = resp.status().as_u16();
                if status == 303
                    || ((status == 301 || status == 302) && method == reqwest::Method::POST)
                {
                    method = reqwest::Method::GET;
                    body = None;
                }
                target = next;
                continue;
            }
        }

        let final_url = resp.url().to_string();
        let status = resp.status().as_u16();
        let headers: HashMap<String, String> = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
            .collect();
        let body = read_capped(resp, MAX_FETCH_BYTES).await?;
        return Ok(SandboxFetchResponse {
            status,
            headers,
            body,
            url: final_url,
        });
    }
    Err(format!("Too many redirects (more than {MAX_REDIRECTS})"))
}

/// Read a response body, failing as soon as it passes `max` bytes. Chunk by
/// chunk, so a runaway download is cut off at the cap instead of being held
/// in memory whole and only then rejected.
async fn read_capped(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    let too_large = || format!("Response too large; maximum is {max} bytes");
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?
    {
        if body.len() + chunk.len() > max {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
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
pub async fn handle_fetch_scheme(request: Request<Vec<u8>>, net: NetPolicy) -> Response<Vec<u8>> {
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
        &net,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-shot HTTP server on loopback: answers the first request with
    /// `response` and hands back the raw request it read.
    async fn serve_once(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            let _ = sock.write_all(&response).await;
            let _ = sock.shutdown().await;
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (url, handle)
    }

    /// The tests' servers are on loopback, so most run with everything open.
    fn open_net() -> NetPolicy {
        NetPolicy {
            proxy: None,
            access: SandboxNetAccess::All,
        }
    }

    fn net(access: SandboxNetAccess) -> NetPolicy {
        NetPolicy {
            proxy: None,
            access,
        }
    }

    fn http_ok(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn the_target_comes_from_the_u_parameter_decoded() {
        assert_eq!(
            extract_target_url("x=1&u=https%3A%2F%2Fexample.com%2Fa%3Fb%3D2").as_deref(),
            Some("https://example.com/a?b=2")
        );
        assert_eq!(extract_target_url("x=1"), None);
        assert_eq!(extract_target_url(""), None);
    }

    #[test]
    fn browser_headers_that_reveal_the_sandbox_are_not_forwarded() {
        let mut h = HeaderMap::new();
        for (k, v) in [
            ("Host", "tauri.localhost"),
            ("Origin", "http://tauri.localhost"),
            ("Referer", "http://tauri.localhost/"),
            ("Connection", "keep-alive"),
            ("Content-Length", "3"),
            ("Sec-Fetch-Mode", "cors"),
            ("Sec-Fetch-Site", "cross-site"),
            ("Sec-Fetch-Dest", "empty"),
            ("Accept", "application/json"),
            ("X-Api-Key", "k"),
        ] {
            h.insert(
                header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        let mut kept: Vec<String> = forward_headers(&h).into_keys().collect();
        kept.sort();
        assert_eq!(kept, ["accept", "x-api-key"]);
    }

    #[test]
    fn every_reply_carries_the_cors_and_corp_headers() {
        let r = cors_response(StatusCode::OK, Some("text/plain"), b"hi".to_vec());
        let h = r.headers();
        assert_eq!(h["access-control-allow-origin"], "*");
        assert_eq!(h["cross-origin-resource-policy"], "cross-origin");
        assert_eq!(h[header::CONTENT_TYPE], "text/plain");
    }

    #[tokio::test]
    async fn a_preflight_is_answered_without_fetching_anything() {
        let req = Request::builder()
            .method(Method::OPTIONS)
            .uri("haruspexfetch://localhost/?u=http%3A%2F%2F127.0.0.1%3A1%2F")
            .body(Vec::new())
            .unwrap();
        let r = handle_fetch_scheme(req, open_net()).await;
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn a_request_without_a_target_is_a_400() {
        let req = Request::builder()
            .uri("haruspexfetch://localhost/?x=1")
            .body(Vec::new())
            .unwrap();
        let r = handle_fetch_scheme(req, open_net()).await;
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_unreachable_target_is_a_502_with_cors() {
        // Port 1 on loopback: nothing listens, the connect is refused.
        let req = Request::builder()
            .uri("haruspexfetch://localhost/?u=http%3A%2F%2F127.0.0.1%3A1%2F")
            .body(Vec::new())
            .unwrap();
        let r = handle_fetch_scheme(req, open_net()).await;
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
    }

    #[tokio::test]
    async fn the_scheme_relays_status_content_type_and_body() {
        let (url, server) = serve_once(http_ok("pong")).await;
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!(
                "haruspexfetch://localhost/?u={}",
                urlencoding::encode(&url)
            ))
            .header("Origin", "http://tauri.localhost")
            .header("X-Test", "1")
            .body(b"ping".to_vec())
            .unwrap();
        let r = handle_fetch_scheme(req, open_net()).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::CONTENT_TYPE], "text/plain");
        assert_eq!(r.body(), b"pong");

        let seen = server.await.unwrap().to_ascii_lowercase();
        assert!(seen.starts_with("post / "), "{seen}");
        assert!(seen.contains("x-test: 1"), "{seen}");
        assert!(!seen.contains("origin:"), "{seen}");
        assert!(seen.ends_with("ping"), "{seen}");
    }

    #[tokio::test]
    async fn an_invalid_method_is_refused_before_any_request() {
        let Err(err) =
            perform_fetch("http://127.0.0.1:1/", "BAD METHOD", None, None, &open_net()).await
        else {
            panic!("an invalid method was accepted");
        };
        assert!(err.contains("Invalid HTTP method"), "{err}");
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_refused() {
        // Declared length over the cap: refused before reading.
        let (url, _server) = serve_once(http_ok("0123456789")).await;
        let resp = reqwest::get(&url).await.unwrap();
        let err = read_capped(resp, 4).await.unwrap_err();
        assert!(err.contains("too large"), "{err}");

        // No declared length: refused while streaming.
        let (url, _server) =
            serve_once(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n0123456789".to_vec()).await;
        let resp = reqwest::get(&url).await.unwrap();
        let err = read_capped(resp, 4).await.unwrap_err();
        assert!(err.contains("too large"), "{err}");

        // At the cap: fine.
        let (url, _server) = serve_once(http_ok("0123")).await;
        let resp = reqwest::get(&url).await.unwrap();
        assert_eq!(read_capped(resp, 4).await.unwrap(), b"0123");
    }

    #[test]
    fn addresses_sort_into_this_machine_lan_and_public() {
        for ip in [
            "127.0.0.1",
            "127.8.9.1",
            "0.0.0.0",
            "::1",
            "::",
            "::ffff:127.0.0.1",
        ] {
            assert_eq!(reach(ip.parse().unwrap()), Reach::Local, "{ip}");
        }
        for ip in [
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.1",
        ] {
            assert_eq!(reach(ip.parse().unwrap()), Reach::Lan, "{ip}");
        }
        for ip in ["8.8.8.8", "100.128.0.1", "2606:4700::1111"] {
            assert_eq!(reach(ip.parse().unwrap()), Reach::Public, "{ip}");
        }
    }

    #[test]
    fn each_access_level_allows_what_it_says() {
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        let lan: IpAddr = "192.168.1.1".parse().unwrap();
        let public: IpAddr = "8.8.8.8".parse().unwrap();
        use SandboxNetAccess::*;
        assert!(allowed(All, local) && allowed(All, lan) && allowed(All, public));
        assert!(!allowed(Lan, local) && allowed(Lan, lan) && allowed(Lan, public));
        assert!(!allowed(Internet, local) && !allowed(Internet, lan) && allowed(Internet, public));
    }

    #[tokio::test]
    async fn this_machine_is_refused_by_default_by_address_or_name() {
        let default = net(SandboxNetAccess::default());
        for url in [
            "http://127.0.0.1:8765/v1/models",
            "http://localhost:8765/",
            "http://api.localhost/",
            "http://[::1]:3001/",
            "http://0.0.0.0:8765/",
        ] {
            let Err(err) = perform_fetch(url, "GET", None, None, &default).await else {
                panic!("{url} was fetched");
            };
            assert!(err.starts_with("Blocked:"), "{url}: {err}");
        }
    }

    #[tokio::test]
    async fn internet_only_refuses_the_lan() {
        let Err(err) = perform_fetch(
            "http://192.168.1.1/",
            "GET",
            None,
            None,
            &net(SandboxNetAccess::Internet),
        )
        .await
        else {
            panic!("a LAN address was fetched");
        };
        assert!(err.contains("local network"), "{err}");
    }

    #[tokio::test]
    async fn every_redirect_hop_is_vetted_not_just_the_first() {
        // The test server has to be on loopback, so the first hop runs under
        // `All`. A hop to a scheme no level allows shows the redirect target
        // went through the same check.
        let (url, _server) = serve_once(
            b"HTTP/1.1 302 Found\r\nLocation: file:///etc/passwd\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
        )
        .await;
        let Err(err) = perform_fetch(&url, "GET", None, None, &open_net()).await else {
            panic!("the redirect to file: was followed");
        };
        assert!(err.contains("Unsupported URL scheme: file"), "{err}");
    }

    #[tokio::test]
    async fn redirects_are_followed_and_a_303_becomes_a_get() {
        let (second, server2) = serve_once(http_ok("landed")).await;
        let (first, server1) = serve_once(
            format!("HTTP/1.1 303 See Other\r\nLocation: {second}\r\nContent-Length: 0\r\n\r\n")
                .into_bytes(),
        )
        .await;
        let r = perform_fetch(&first, "POST", None, Some(b"x".to_vec()), &open_net())
            .await
            .unwrap();
        assert_eq!(r.body, b"landed");
        assert!(server1.await.unwrap().starts_with("POST "));
        assert!(server2.await.unwrap().starts_with("GET "));
    }
}
