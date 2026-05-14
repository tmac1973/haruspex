# Phase 06 — `proxy.rs` split + `SearchBackend` trait

**Severity addressed:** 7 · **Effort:** ~1 day · **Risk:** Medium

Resolves complexity-audit C-9 (2 145 LOC monolith) and design-pattern P-1 (search dispatch by match-on-string).

**Prerequisite:** Phase 01 complete (we'll reuse `sidecar_utils::http_client`).

## Goal

Split `proxy.rs` into a module tree mirroring its concerns, then introduce a `SearchBackend` trait so adding a 7th search backend is one new file + one `match` arm.

## Files touched

- **DELETE** `src-tauri/src/proxy.rs`
- **NEW** `src-tauri/src/proxy/mod.rs` — `ProxyState`, `ProxyConfig`, public `proxy_*` Tauri commands
- **NEW** `src-tauri/src/proxy/bypass.rs` — `parse_bypass_list`, `should_bypass`, `is_private_ip`
- **NEW** `src-tauri/src/proxy/extract.rs` — `extract_text`, `extract_body_text`, `try_select_text`, `strip_html_tags`, `fetch_and_extract`
- **NEW** `src-tauri/src/proxy/paywall.rs` — `detect_paywall_signal`, `HARUSPEX_PAYWALL_SIGNAL`
- **NEW** `src-tauri/src/proxy/search/mod.rs` — `SearchBackend` trait, `SearchResult`, dispatcher
- **NEW** `src-tauri/src/proxy/search/ddg.rs` — DuckDuckGo backend
- **NEW** `src-tauri/src/proxy/search/mojeek.rs` — Mojeek backend
- **NEW** `src-tauri/src/proxy/search/brave.rs` — Brave (HTML + API) backends
- **NEW** `src-tauri/src/proxy/search/searxng.rs` — SearXNG backend
- **NEW** `src-tauri/src/proxy/search/auto.rs` — Auto backend (cycling fallback)
- **NEW** `src-tauri/src/proxy/images/mod.rs` — `proxy_image_search`, `proxy_fetch_url_images`
- **NEW** `src-tauri/src/proxy/images/page.rs` — `extract_page_images`
- **NEW** `src-tauri/src/proxy/images/commons.rs` — `parse_commons_imageinfo`, `commons_extmetadata_string`

## Implementation

### Step 1 — module tree, leaves first

Same loop as Phase 02. Extract files in this order so dependencies satisfy themselves:

1. `bypass.rs` (no internal deps)
2. `extract.rs` (no internal deps)
3. `paywall.rs` (no internal deps)
4. `search/mod.rs` — define `SearchResult` and the **trait** (see Step 2)
5. `search/{ddg, mojeek, brave, searxng}.rs`
6. `search/auto.rs` (uses other search backends + ProxyState's cooldown table)
7. `images/page.rs`
8. `images/commons.rs`
9. `images/mod.rs`
10. `proxy/mod.rs` — pulls everything together

### Step 2 — `SearchBackend` trait

```rust
// src-tauri/src/proxy/search/mod.rs
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
}

#[async_trait]
pub trait SearchBackend: Send + Sync {
    fn name(&self) -> &'static str;
    async fn search(
        &self,
        state: &crate::proxy::ProxyState,
        query: &str,
        recency: &str,
        proxy: Option<&crate::proxy::ProxyConfig>,
    ) -> Result<Vec<SearchResult>, String>;
}

mod auto;
mod brave;
mod ddg;
mod mojeek;
mod searxng;

pub use auto::AutoBackend;
pub use brave::{BraveApiBackend, BraveHtmlBackend};
pub use ddg::DuckDuckGoBackend;
pub use mojeek::MojeekBackend;
pub use searxng::SearxngBackend;
```

Each backend file ends up looking like:

```rust
// proxy/search/ddg.rs
pub struct DuckDuckGoBackend;

#[async_trait]
impl SearchBackend for DuckDuckGoBackend {
    fn name(&self) -> &'static str { "duckduckgo" }

    async fn search(
        &self,
        state: &ProxyState,
        query: &str,
        recency: &str,
        proxy: Option<&ProxyConfig>,
    ) -> Result<Vec<SearchResult>, String> {
        state.rate_limit_engine("duckduckgo", RATE_LIMIT_INTERVAL);
        let html = fetch_search_html("https://duckduckgo.com/html/", query, recency, proxy).await?;
        parse_ddg_html(&html)
    }
}

fn parse_ddg_html(html: &str) -> Result<Vec<SearchResult>, String> { /* current body */ }
```

### Step 3 — dispatcher in `proxy/mod.rs`

```rust
// src-tauri/src/proxy/mod.rs
pub async fn proxy_search(
    state: State<'_, ProxyState>,
    query: String,
    provider: Option<String>,
    api_key: Option<String>,
    instance_url: Option<String>,
    recency: Option<String>,
    deep_research: Option<bool>,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<SearchResult>, String> {
    // existing cache check stays here
    if let Some(cached) = state.get_cached_search(&query, provider.as_deref()) {
        return Ok(cached);
    }

    let recency = recency.as_deref().unwrap_or("any").to_string();
    let deep_research = deep_research.unwrap_or(false);
    let proxy_ref = proxy.as_ref();

    let backend: Box<dyn SearchBackend> = match provider.as_deref() {
        Some("brave") => {
            let key = api_key.unwrap_or_default();
            if key.is_empty() { return Err("Brave Search API key not configured".into()); }
            Box::new(BraveApiBackend::new(key))
        }
        Some("searxng") => {
            Box::new(SearxngBackend::new(instance_url.unwrap_or_else(|| "http://localhost:8080".into())))
        }
        Some("auto") => Box::new(AutoBackend::new(deep_research)),
        _ => Box::new(DuckDuckGoBackend),
    };

    info!("Searching {} for: {} (recency: {})", backend.name(), query, recency);
    let results = backend.search(&state, &query, &recency, proxy_ref).await?;
    // existing cache write stays here
    state.put_cached_search(query, provider, results.clone());
    Ok(results)
}
```

### Step 4 — Cargo.toml

Add `async-trait` to `[dependencies]` if not already present:

```toml
async-trait = "0.1"
```

(If we want to avoid the extra crate, we can use `impl Future` returns with associated types, but `async-trait` keeps the trait simple and is widely used in the Tauri ecosystem.)

## Build gate

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Test plan

### Smoke

1. App launches.

### Targeted — every search provider

Open **Settings → Search**. Test each provider in turn.

2. **DuckDuckGo** (default): in chat: *"Search the web for recent news about Rust 2025 edition."*
   - Verify search results appear; the agent uses one or more.
3. **Brave (API)** — if you have a key configured: same prompt.
4. **Brave HTML** (engines list for auto): tested via `auto` below.
5. **Mojeek**: switch provider; same prompt.
6. **SearXNG**: switch to SearXNG with a valid instance URL; same prompt.
7. **Auto**: switch to auto; same prompt. Confirm the search-step UI shows fallback behaviour if the first engine fails (kill your network briefly during the call to simulate, optional).

### Targeted — fetch + paywall + image search

8. *"Fetch https://example.com/index.html and tell me what's on it."* — `proxy_fetch` happy path.
9. *"Find an image of a red apple on the web."* — `proxy_image_search` happy path.
10. *"Get the images from https://en.wikipedia.org/wiki/Apple (the page)."* — `proxy_fetch_url_images` happy path.
11. *"Fetch https://www.wsj.com/<any-article>"* — paywall signal should fire; the agent receives the paywall sentinel and reports it cannot read the article rather than treating the placeholder as real content.

If 2–11 pass, commit:

```
refactor: split proxy.rs and introduce SearchBackend trait (#TBD)

2145 LOC monolith split into src-tauri/src/proxy/{bypass,
extract, paywall, search, images}/. Six search backends now
implement a shared SearchBackend trait dispatched from a single
match in proxy_search(). Adding a new backend = one new file +
one match arm. No behavioural change.

Resolves audits/code-complexity-2026-05-14.md C-9 and
design-patterns-2026-05-14.md P-1.
```

## Roll-back rule

If a backend regresses (e.g. results shape changes, paywall sentinel disappears), revert and split into two PRs: first the file move only, then the trait extraction.
