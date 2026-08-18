# Phase 02 — Searching Through the Browser

Wires phase 01's `render()` into the search layer as its own provider, restores
Startpage, and keeps the two populations apart in the stats. Depends on
phase 01.

## Steps

### 1. Restore Startpage

Deleted in #201 when it went dark; recoverable from git history
(`git show 8e9559a^:src-tauri/src/proxy/search.rs`). Bring back
`parse_startpage_html` and `text_skipping_style` — the Emotion CSS-in-JS
handling is still needed, since Startpage still injects `<style>` tags inside
its result anchors.

Verified against the rendered DOM on 2026-08-17: `div.result` × 10 and
`a[data-testid=gl-title-link]` × 10, which is exactly what that parser reads.
It needs no changes; only its *transport* was broken.

There is no `search_startpage` HTTP function to restore — in browser mode the
fetch is `render()`, so engines contribute a URL builder and a parser, nothing
more.

### 2. An engine table for browser mode

Browser mode does not reuse `AUTO_ENGINES`: its membership rules are different
(Startpage belongs here and nowhere else), and it must not inherit a future
removal made for plain-HTTP reasons.

```rust
/// Engines browser mode rotates through, with the URL builder and parser each
/// one needs. Verified rendering under Chrome 151 on 2026-08-17.
/// Mojeek is absent by evidence, not oversight: it answers a headless browser
/// with a hard 403 naming the *network*, so no client-side change reaches it.
/// Qwant is absent because nothing the existing selectors match appears in its
/// rendered DOM; it would need a parser of its own.
pub(super) const BROWSER_ENGINES: &[BrowserEngine] = &[ /* startpage, bing, brave_html, duckduckgo, yahoo */ ];
```

Startpage leads: it is the one engine unavailable to the plain rotation, so
when both modes work, browser mode should be returning something `auto` cannot.

### 3. The search path

`search_via_browser(query, recency, …)` mirrors `search_auto`'s structure —
rotation cursor, per-engine rate limits, cooldowns — but swaps the transport:

```rust
let html = browser.render(&url, &|html| parse(html).map(|r| !r.is_empty()).unwrap_or(false), RENDER_TIMEOUT).await?;
let results = parse(&html)?;
```

The `ready` closure being "the parser found results" is what makes a
proof-of-work interstitial work without special-casing: the page is not ready
until it renders results, so the ~2s Anubis solve is just a slower load. When
the deadline passes with nothing parsed, the same `looks_like_bot_challenge`
check applies and the engine cools down as it would over HTTP.

**Reuse the existing rate limits and cooldowns.** Browser mode is more capable
than plain HTTP and therefore more capable of getting the user's IP blocked —
which is what 150 first-choice attempts a day earned Mojeek. Faster paths do
not deserve looser pacing.

### 4. Falling back

If the browser cannot be found, cannot launch, or dies mid-search, browser mode
**falls back to the plain `search_auto` rotation** and records that it did. An
unattended 3am job must not fail because Chrome was uninstalled last week.

**The fallback is loud.** A mode that has quietly been using the standard
rotation for a week must not look healthy, so it announces itself at three
levels:

1. **Log** — `warn!` with the concrete reason (no browser found / launch
   failed / crashed mid-search) and the paths searched, so a support question
   is answerable from the log alone.
2. **Event + toast** — Rust emits `browser-search-fallback` carrying the
   reason, mirroring how `gpu-fallback-active` already drives the CPU-fallback
   banner. The frontend shows a toast, but **only on transition into the
   fallback state**, not per search: a research turn issues dozens of searches
   and dozens of identical toasts is how people learn to ignore them.
3. **Persistent card** — a banner in Settings → Search that stays until browser
   mode works again (phase 03). The toast is missable; the card is the thing
   that is still there tomorrow.

A global counter (`GlobalCounter::BrowserFallback`) records occurrences so the
stats can show it too.

Recovery is silent by contrast: once a browser is found again, the state clears
and the card disappears without another notification.

### 5. Keep the stats populations apart

Stats keys in browser mode are suffixed: `startpage/browser`, `bing/browser`.

This matters more than it looks. The per-engine stats table is what diagnosed
every problem in this area — Mojeek's 55 dead days, Startpage's cooldowns, the
150 wasted first-choice attempts. Merging browser and plain attempts for the
same engine into one row would average two populations with different success
rates and hide exactly that signal. The suffix keeps `bing` and `bing/browser`
independently readable.

`record_engine_result` already takes the engine name as a string, so this is a
naming decision rather than a schema change.

### 6. Tests

- Engine table: every entry's parser is exercised against captured markup, so a
  rotation entry can never lack a working parser.
- Startpage parser: restore the deleted tests (Emotion `<style>` stripping, the
  `gl-title-link` anchor, empty input) — they were removed with the engine.
- `ready` closure semantics: returns false for a challenge page, true once
  results parse. This is the mechanism the whole mode rests on.
- Fallback: a browser that fails to launch produces plain-rotation results and
  the note, not an error.
- Stats: a browser attempt records under the suffixed key and leaves the plain
  key untouched.

## Verification

- Select browser mode and search; confirm results come back and that
  `startpage/browser` appears in the stats with successes.
- Compare result quality against `auto` for a handful of queries — Startpage is
  Google's index, so it should be visibly better on hard queries.
- Uninstall/rename the browser and confirm search still works via fallback,
  with the notice shown.
- Watch timing: expect roughly 2x the plain-HTTP latency per search, plus 0.19s
  when the browser is cold.
