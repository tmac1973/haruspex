# Phase 26 — ComfyUI through Rust

**Depends on:** 18 · **Enables:** 28.

## Goal

A stock ComfyUI, started as `python main.py`, works with Haruspex. No
`--enable-cors-header`, no restart instructions.

## Why

`comfyui/client.ts` calls ComfyUI with `fetch` and `WebSocket` from the
webview, which sends an `Origin`. ComfyUI's origin-only middleware rejects a
loopback request whose `Origin` host differs from `Host`, and a remote server
answers without CORS headers, so the webview sees "Load failed" either way.
Today the user has to start ComfyUI with `--enable-cors-header
http://localhost:1420` (in a packaged build, the app's own origin). It failed
in practice on 2026-10-01: a ComfyUI restarted without the flag broke a run
whose requests from a script still worked.

A request made by Rust carries no `Origin`. It also lets the progress socket
send the API key as a header, which a browser `WebSocket` cannot — today the
socket goes without it and falls back to polling on a server that requires it.

## Files touched

- `src-tauri/src/comfy.rs` (new) — `comfy_request` and the socket.
- `src-tauri/src/lib.rs` — registration.
- `src/lib/image/comfyui/client.ts` — `request()` and `subscribe()` call Rust;
  everything above them is unchanged.
- `./scripts/export-ipc-types.sh`.

## Steps

1. **`comfy_request(base_url, api_key, method, path, body, timeout_ms)`.**
   `body` is JSON or absent. Returns `{ status, json | text }`; `/view`
   returns bytes. One `reqwest::Client`, no proxy (the webview's `fetch` used
   none, and a ComfyUI on the LAN should not go out through one). The same
   error kinds as today: `unreachable`, `timeout`, `rejected` with status and
   the first 200 characters of the body.
2. **Cancellation.** A request carries an id; `comfy_cancel(id)` aborts it.
   `client.ts` calls it from the `AbortSignal`, so `cancelled` still means
   cancelled. Generation itself is stopped by `/interrupt`, as now.
3. **Progress socket.** `comfy_subscribe(base_url, api_key, client_id,
   channel)` opens the socket with `tokio-tungstenite`, sends the key as an
   `Authorization` header, and forwards `progress`, `execution_start` and
   `status` messages on a Tauri `Channel`. `comfy_unsubscribe(id)` closes it.
   The idle timeout and the fall-back to polling stay in `client.ts`.
4. **Delete `uploadImage`** if nothing calls it (the reference templates that
   did are gone).
5. **Docs.** Remove `--enable-cors-header` from `docs/image-generation.md`
   and Settings copy.

## Test plan

- Rust: against a local `axum` stub — JSON, text and bytes; a 4xx surfaces
  status and body; a slow handler times out; `comfy_cancel` aborts; the
  socket forwards a `progress` message and sends the header.
- TS: `client.test.ts` mocks `invoke` instead of `fetch`; the existing cases
  keep their meaning.
- Live: ComfyUI started as plain `python main.py`; Probe, then a generation
  with progress.

## Commit

```
feat(image): talk to ComfyUI from Rust, so a stock server needs no CORS flag
```
