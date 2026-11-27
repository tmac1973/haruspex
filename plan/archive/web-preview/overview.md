# Code web preview — Project Overview

## Problem
When a Code session builds a web mockup (an HTML page with its CSS, JS and
images), the only way to look at it is to find the file and open it in a
browser by hand, then reload it after every change the agent makes. The app has
no place to show a page the agent is working on, and the model's only way to
see one is the optional Playwright MCP server, which can't open the app's
custom schemes.

## Goals
- A Code session can show a static web mockup from its folder in a separate
  preview window.
- The window reloads by itself when files in the folder change, whoever
  changed them (agent tools, shell commands, the user's editor).
- The agent opens it with a `show_preview` tool; the user opens it with a
  Preview button beside `.html` file links and diff cards in the transcript.
- The page is served over loopback HTTP, so the Playwright MCP server (when
  installed) can open the same URL without an approval prompt and the model
  can screenshot it.
- The tool can be switched off in Settings → Code → Helpers → Web preview.

## Non-goals
- Dev servers (Vite, Next, `npm run dev`): no pointing the window at another
  server's URL.
- Any capture path of our own: the model sees the page only through Playwright.
- A console or error panel in the window.
- Serving the preview to the remote web client; remote turns open the window
  on the desktop.
- Chat tab support: Code sessions only.
- Build steps, bundling, or transforming files: files are served as they are.

## Users & primary flow
1. The user asks a Code session for a mockup; the agent writes
   `mockup/index.html` and its assets.
2. The agent calls `show_preview` with that path. The session's preview window
   opens (or, if already open, navigates to the file) and the tool returns the
   page's URL.
3. The agent edits `mockup/style.css`; the watcher sees it and the window
   reloads.
4. With Playwright installed, the agent calls `browser_navigate` on the
   returned URL (no prompt) and `browser_take_screenshot` to check its work.
5. Later, the user clicks Preview beside a `.html` link in the transcript to
   reopen it.
6. Closing the window stops that session's server and watcher.

## Constraints
- Tauri 2 + SvelteKit 5; extra windows go through `app_window_open`
  (`src-tauri/src/app_windows.rs`) so Windows' WebView2 gets the main window's
  browser arguments.
- Linux (WebKitGTK), Windows (WebView2) and macOS (WKWebView) all supported.
- The served page is model-written and untrusted: it must never reach IPC or
  the app's origin, and the server must expose nothing outside the session
  folder (no `..`, no symlinks out, Windows `\\?\` and drive-letter paths
  handled).
- The server listens on 127.0.0.1 only, on a random port, behind a random
  per-server token in the path, and checks the Host header against DNS
  rebinding.
- axum, notify and urlencoding are already dependencies; no new crates (MIME
  types come from the web client server's table).
- UI copy: one short sentence per section, details in `title` tooltips,
  Settings paths named in full. The `docs/guide/` pages change in the same PR.
- `show_preview` only reads, so it works in both Read-only and Full access
  sessions.

## Success criteria
- `show_preview mockup/index.html` opens a window showing the page with its
  relative CSS, JS and images loaded.
- Editing any served file reloads the window within about half a second.
- A second `show_preview` in the same session reuses the window.
- Requests for `../`, absolute paths, symlinks out of the folder, a wrong
  token or a foreign Host header are refused (Rust tests cover each).
- The page can't call Tauri IPC (verified by hand: `window.__TAURI__` and
  `ipc.localhost` unreachable).
- Playwright's `browser_navigate` to the returned URL runs without asking.
- With Settings → Code → Helpers → Web preview off, the tool isn't offered
  and the Preview buttons are hidden.
- The guide's `helpers` and `code` pages describe it.

## Decisions
- **What the window shows** → static files from the session folder; no dev servers.
- **Model seeing the page** → no capture path of our own; Playwright already
  does it when installed.
- **How files are served** → loopback HTTP server (127.0.0.1, random port,
  token in path, Host check), so the window and Playwright share one URL.
- **Live reload trigger** → a notify watcher on the folder, debounced.
- **How it opens** → `show_preview` tool plus Preview buttons beside `.html`
  file links and diff cards.
- **Served root** → the whole session folder, nothing outside it.
- **Window UI** → slim toolbar: path, Reload, width presets
  (Phone 390 / Tablet 820 / Full), Open in browser.
- **Window reuse** → one preview window per session; server and watcher stop
  when it closes.
- **Remote web client** → the window opens on the desktop; the remote client
  gets a note saying so.
- **Setting** → a helper toggle, Settings → Code → Helpers → Web preview.
- **Helper default** → on by default, through a new `defaultOn` field on
  `HelperDef` (every other helper stays off).
- **What the watcher follows** → only the files the server served for that
  session's window, through a second `EditorWatches` instance.
- **Listener** → one shared loopback listener with a token per session,
  started on the first preview and stopped when the last preview closes.
- **Landing** → one branch, a commit per phase, one PR.
- **Sessions on another computer, WSL folders** → not supported in this
  plan; the tool refuses and the buttons are hidden (planner's default,
  listed in the follow-up issue).
