# Phase 6: Web Search & URL Fetching

## Goal

Replace the mock tool implementations from Phase 5 with real web search (DuckDuckGo HTML) and URL fetching via Rust proxy commands. After this phase, Haruspex can answer questions about current events using live web data.

## Prerequisites

- Phase 5 complete (agent loop works with mock tools)

## Deliverables

- **User-testable**: Ask "What happened in the news today?" → Haruspex searches DDG, fetches 2-3 result pages, and synthesizes an answer with source citations. Also: optionally configure Tavily API key in settings for higher-quality results.

---

## Tasks

### 6.1 HTTP proxy — search command (`src-tauri/src/proxy.rs`)

Implement a Tauri command that fetches and parses DuckDuckGo HTML results:

```rust
#[derive(Serialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[tauri::command]
pub async fn proxy_search(query: String, provider: Option<String>, api_key: Option<String>) -> Result<Vec<SearchResult>, String> {
    match provider.as_deref().unwrap_or("duckduckgo") {
        "duckduckgo" => search_duckduckgo(&query).await,
        "tavily" => search_tavily(&query, api_key.as_deref().unwrap_or("")).await,
        _ => Err("Unknown search provider".into()),
    }
}
```

**DuckDuckGo implementation:**

- GET `https://html.duckduckgo.com/html/?q={url_encoded_query}`
- Set a browser-like `User-Agent` header.
- Parse the HTML response to extract result entries (title, URL, snippet).
- Use the `scraper` crate (HTML parser with CSS selector support) — avoid regex for HTML.
- Return top 5-8 results.
- Handle rate limiting gracefully (429 → wait and retry once).

**Tavily implementation (optional provider):**

- POST `https://api.tavily.com/search` with API key.
- Parse JSON response.
- Return top 5 results with titles, URLs, and content snippets.

### 6.2 HTTP proxy — fetch command (`src-tauri/src/proxy.rs`)

```rust
#[tauri::command]
pub async fn proxy_fetch(url: String) -> Result<String, String> {
    // 1. Fetch the URL with a browser-like User-Agent
    // 2. Extract text content (strip HTML tags, scripts, styles)
    // 3. Truncate to ~4000 characters to fit context window
    // 4. Return clean text
}
```

**Implementation details:**

- Use `reqwest` with a 10-second timeout.
- Set `User-Agent` to a standard browser string.
- Use `scraper` to parse HTML:
  - Remove `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<aside>` elements.
  - Extract text from `<article>`, `<main>`, or `<body>` (prefer `<article>` or `<main>` if present).
  - Collapse whitespace, trim empty lines.
- Truncate to a configurable max length (default 4000 chars) to avoid blowing up the context window.
- Handle non-HTML responses (PDF, images) → return "Content type not supported" rather than crashing.
- Handle redirects (follow up to 5).
- Reject non-HTTP(S) URLs.
- Reject private/local IPs (127.x, 10.x, 192.168.x, etc.) to prevent SSRF.

### 6.3 Wire tools to proxy commands (`src/lib/agent/search.ts`)

Replace mock implementations with real Tauri invoke calls:

```typescript
import { invoke } from '@tauri-apps/api/core';

export async function executeWebSearch(query: string, signal?: AbortSignal): Promise<string> {
  const settings = getSearchSettings();
  const results = await invoke<SearchResult[]>('proxy_search', {
    query,
    provider: settings.provider,
    apiKey: settings.apiKey,
  });
  return JSON.stringify(results);
}

export async function executeFetchUrl(url: string, signal?: AbortSignal): Promise<string> {
  const text = await invoke<string>('proxy_fetch', { url });
  return text;
}
```

### 6.4 Search settings store

Add search provider configuration to the settings store:

```typescript
interface SearchSettings {
  provider: 'duckduckgo' | 'tavily';
  tavilyApiKey?: string;
}
```

Default to DuckDuckGo (zero-config). Persist to Tauri's app data dir.

### 6.5 Tauri security permissions

Update `tauri.conf.json` (or the Tauri 2.x permissions system) to allow:

- HTTP requests to `https://html.duckduckgo.com/*`
- HTTP requests to `https://api.tavily.com/*`
- HTTP requests to any URL (for `proxy_fetch`) — but only from the Rust side, not the webview

Use Tauri 2.x's scope-based permission system to restrict the webview's direct network access while allowing Rust commands to make arbitrary HTTP requests.

### 6.6 Response formatting

Update the system prompt to instruct the model on how to use search results:

```
When you use web_search, you will receive a list of search results with titles, URLs, and snippets.
If you need more detail, use fetch_url on the most relevant 2-3 results.
Always cite your sources by mentioning the website name.
Never fabricate URLs or sources.
```

### 6.7 Rate limiting and caching

- **Rate limiting**: Limit DDG searches to max 1 request per 2 seconds to avoid being blocked.
- **Cache**: In-memory cache (Rust `HashMap` with TTL) for search results — same query within 5 minutes returns cached results. Cache fetch results for 10 minutes.
- Cache is not persisted to disk — it resets on app restart.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| DDG parser | Extracts titles, URLs, snippets from real DDG HTML (use saved fixture) | cargo test |
| DDG parser | Handles empty results page | cargo test |
| DDG parser | Handles malformed HTML without panicking | cargo test |
| Tavily client | Correct request format with API key | cargo test (mock HTTP) |
| Tavily client | Handles error responses (invalid key, rate limit) | cargo test |
| URL fetcher | Extracts article text from standard HTML page | cargo test (fixture) |
| URL fetcher | Strips scripts, styles, nav elements | cargo test |
| URL fetcher | Truncates to max length | cargo test |
| URL fetcher | Rejects non-HTTP URLs | cargo test |
| URL fetcher | Rejects private IPs (SSRF protection) | cargo test |
| URL fetcher | Handles timeout gracefully | cargo test |
| URL fetcher | Returns error for non-HTML content types | cargo test |
| Rate limiter | Enforces minimum interval between requests | cargo test |
| Cache | Returns cached result for same query within TTL | cargo test |
| Cache | Evicts expired entries | cargo test |
| Search adapter | TypeScript `executeWebSearch` calls correct invoke command | Vitest |
| Search adapter | TypeScript `executeFetchUrl` calls correct invoke command | Vitest |
| Integration | Search → fetch → answer flow with real DDG (use VCR/recorded responses) | cargo test |

### Fixture strategy

Save real DuckDuckGo HTML responses as test fixtures in `src-tauri/tests/fixtures/`. This avoids hitting DDG in CI and provides deterministic test data.

---

## Definition of Done

- [ ] Ask a question about current events → Haruspex searches DDG and answers with citations
- [ ] Search results are visible in the SearchStep UI component
- [ ] Source chips link to the actual URLs and open in the system browser
- [ ] `proxy_fetch` extracts readable text from news articles, Wikipedia, etc.
- [ ] Tavily API key can be configured and used as an alternative search provider
- [ ] Private/local URLs are rejected by `proxy_fetch`
- [ ] Rate limiting prevents rapid-fire DDG requests
- [ ] App works correctly when offline (search fails gracefully, model still responds)
- [ ] All unit tests pass, including HTML parsing fixtures
