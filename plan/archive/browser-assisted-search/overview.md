# Browser-Assisted Search

Locked 2026-08-17.

## Problem

The plain-HTTP rotation keeps eroding. Bing and Qwant went dark in April 2026,
Startpage and Mojeek followed by August, and each time the app lost an engine
it could not get back — the wall is JavaScript execution, and there is no
header combination that fakes it. The rotation is down to four engines
(yahoo, brave_html, duckduckgo, and Bing, which came back), all of them one
policy change away from the same fate.

A locally-installed browser answers this permanently. Verified on 2026-08-17,
driving Chrome 151 and Chromium 151 headless over CDP:

- **Startpage** — plain HTTP gets an Anubis proof-of-work interstitial. The
  browser solves it in ~2s and renders 10 `div.result` / 10
  `a[data-testid=gl-title-link]` — exactly what the (deleted) Startpage parser
  reads. Cookies it earns even transfer to plain HTTP, though they expire in
  ~6 minutes.
- **Bing** renders 10 `li.b_algo` in the browser as well as over plain HTTP.
- **Mojeek** is blocked in the browser too — a hard 403, *"your network appears
  to be sending automated queries"*. That is IP reputation, not a challenge,
  and nothing client-side fixes it.

So the browser buys back exactly one engine today. Its real value is as an
**independent path**: when the next engine gains a wall, browser mode keeps
working without a code change, because it is a browser.

## Shape of the feature

A **separate search provider**, not a mode of `auto`. Selecting it sends every
search through the browser, so it is a hedge that can be tested and trusted on
its own rather than a hidden branch inside the default path that only fires on
failure. `auto` is untouched and keeps its plain-HTTP behavior.

That also makes the dependency honest: the entry needs Chrome or Chromium
installed, and the Settings row says so, including when none was found.

## Verified mechanics

Each of these cost a wrong turn during investigation and belongs in the
implementation notes rather than being rediscovered:

- **`--user-agent` is mandatory.** Without it Chrome sends a
  `HeadlessChrome/...` UA and Startpage silently bounces to its homepage —
  0 results, no error. With a normal Chrome UA the same URL renders 10.
- **`--remote-allow-origins=*` is mandatory** on Chrome ≥111, or the CDP
  WebSocket handshake is rejected with a 403.
- **`/json` lists extension targets first.** Attaching to the first entry gets
  a background page whose DOM is 77 bytes. Select `type == "page"`.
- **`/json/new` requires a PUT** in Chrome 151; create tabs with
  `Target.createTarget` over the browser-level WebSocket instead.
- **A throwaway `--user-data-dir` is required**, never the user's profile:
  Chrome refuses to open a profile already in use, and inheriting their
  cookies would leak session state to every scraped site.
- **Flatpak browsers do not work.** `flatpak run com.brave.Browser
  --headless=new ... --dump-dom` hung until killed. Detection must not offer
  them.

## Cost, measured

| | |
|---|---|
| cold browser start (spawn → CDP ready) | 0.19s |
| first navigation + settle | ~1.5s |
| subsequent navigations on a warm browser | 0.5–0.7s |
| resident memory, browser + tabs | ~1.2 GB peak during probing |

Today's plain-HTTP searches average 0.66–0.87s per engine. So browser mode is
roughly 2x slower per search on a warm browser, plus a one-off 0.19s to start
it. That is an acceptable trade for a provider the user explicitly selects,
and it is the reason the browser is **not** left resident: it starts fast
enough to launch on demand and quit when idle.

## Goals

- A `Browser` entry in the search provider dropdown that works whenever Chrome
  or Chromium is installed, on Linux, macOS and Windows.
- Every search in that mode renders in the browser and is parsed by the
  *existing* engine parsers, so a wall appearing on any engine costs nothing.
- Startpage is back, browser-only.
- Honest UI when no browser is found: which paths were searched, and a manual
  override.
- A search never dies because the browser is missing or crashed — it falls
  back to the plain rotation and says so.
- Browser and plain attempts stay separable in the stats, because mixing two
  populations with different success rates is what would blind the next
  diagnosis.

## Non-goals

- **Bundling a browser.** 150–300 MB and a patch cadence, to reach users who
  mostly already have one. Detection covers the realistic cases; the rest get
  the plain rotation.
- **Browser-assisted page fetching.** Measured separately across 18 real pages:
  one clear win (StackOverflow, which 403s plain HTTP), the rest either
  server-rendered already or blocked in the browser too (Reddit, Bloomberg, X,
  Medium, NYT, Quora). Not worth a toggle yet; revisit if the 403 class grows.
- **Qwant.** It renders *something* under a browser — 20 elements carrying
  `data-testid` — but nothing the existing selectors match, so it needs a
  parser written from scratch against its DOM. Out of scope; revisit if the
  rotation thins again.
- **Mojeek.** IP-blocked; a browser cannot help.
- **Defeating fingerprinting walls.** Turnstile and DataDome specifically
  profile headless browsers with fresh profiles. If an engine deploys those,
  browser mode loses it too, and that is accepted rather than fought.

## Shape

| Phase | Theme | Touches |
|---|---|---|
| [01](phase-01-browser-runtime.md) | Detection + headless lifecycle + a minimal CDP client | new `proxy/browser/`, `Cargo.toml` |
| [02](phase-02-browser-search.md) | Browser search path, Startpage restored, stats separation, fallback | `proxy/search.rs`, `proxy/config.rs`, `proxy/stats.rs` |
| [03](phase-03-settings.md) | Provider dropdown entry, detection status, manual override | `settings.ts`, `SearchSection.svelte`, IPC command |

## Decisions taken

- **A separate provider, not a fallback inside `auto`.** A hedge you cannot
  select is a hedge you cannot test. It also keeps the browser dependency
  visible instead of surprising someone mid-search.
- **Render every search rather than harvesting cookies.** Cookie harvest is
  cheaper — one solve serves ~6 minutes of plain HTTP — but it only works for
  challenges that mint a cookie, and it inherits every future wall the plain
  path hits. Rendering is the thing that keeps working, which is the entire
  point of the mode.
- **Reuse the existing parsers on the rendered DOM.** `outerHTML` from a
  settled page is just HTML; feeding it to the same `parse_*_html` functions
  means one parser per engine rather than two that drift.
- **Launch on demand, idle-quit.** ~1.2 GB resident next to a 5–18 GB model is
  not a background cost to impose, and a 0.19s start does not justify it.
- **Stats keys are suffixed (`startpage/browser`).** The per-engine stats table
  is what diagnosed every problem in this area so far; merging two populations
  with different success rates into one row would have hidden all of it.
- **Fall back to the plain rotation on any browser failure.** An unattended
  3am job must not fail because the user uninstalled Chrome.
- **Conservative pacing, deliberately.** Mojeek's IP block is what 150
  first-choice attempts a day earns. Browser mode is more capable and
  therefore more able to get the user's address blocked; it inherits the
  existing per-engine rate limits and cooldowns rather than bypassing them.
