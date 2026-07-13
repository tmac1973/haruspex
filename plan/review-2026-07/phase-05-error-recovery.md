# Phase 05 — Error recovery & feedback

**Commit scope:** `feat(chat)` / `fix(ui)` · **Language:** TS/Svelte · **Depends on:** phase 03 (toasts)

Turn dead-end failures into recoverable ones: Retry on failed turns,
queue-and-auto-send during sidecar startup (decision locked), full-width
error surfacing, and an interactive status badge.

---

## 1. Retry for failed chat turns

Today the error banner (`ChatView.svelte:411-430`) offers only "Copy debug
log"; non-`ApiError` failures collapse to a generic message
(`chat.svelte.ts:900`).

**In `chat.svelte.ts`:**
- Split `sendMessage` (`:1017`) into its two halves: *append the user
  message* and *run the turn against existing history* (`runCurrentTurn()`,
  module-internal).
- On `handleTurnError` (`:896`), record `lastTurnFailed = true` (the user
  message is already in history — nothing else to stash).
- Export `retryLastTurn()`: clears the error state and calls
  `runCurrentTurn()` again. **No duplicate user bubble.**

**In `ChatView.svelte`:** add a primary `Retry` button to the error banner
next to "Copy debug log", calling `retryLastTurn()`. Disabled while
`isGenerating`.

## 2. Queue-and-auto-send while the server is starting

Today send isn't gated on `serverReady` (`ChatView.svelte:510-518`, textarea
`:474`), so a send during sidecar startup runs against a down server and
produces a generic error.

Locked behavior — in `sendMessage`, branch on
`getServerState().status` **before** running the turn (after appending the
user message):

- **`'ready'` / `'remote'`** — run immediately (today's path).
- **`'starting'`** — set `queuedForStartup = true`; show
  `Waiting for the model to start…` in the notice slot ChatView already uses
  for `isWaitingForSlot` (`:370-399`). A `$effect` in the chat store watches
  server status: on `'ready'` → clear flag, `runCurrentTurn()`; on `'error'`
  → clear flag, surface the server's error via the standard banner **with the
  Retry button from §1**.
- **`'stopped'` / `'error'` at send time** — don't append silently-doomed
  work: `showToast('The model isn\'t running. Check Settings → Inference backend.', { kind: 'error' })`
  and leave the composer text intact.
- **Cancelling a queued send:** the existing Stop button (and Esc) while
  queued clears `queuedForStartup` and shows the standard error banner with
  message `Cancelled before the model started.` + Retry. The user message
  stays in history.

Composer stays enabled throughout; update the placeholder copy at `:471` to
`Model is starting — messages will send when it's ready` for the `'starting'`
state.

## 3. Voice/whisper errors → toasts

`MicButton.svelte:71-73` clips errors at 200px/nowrap, truncating messages
like "Download whisper model first" (`voiceCapture.svelte.ts:46,63,93`).
Remove the inline `mic-error` span entirely; route every voiceCapture error
through `showToast(message, { kind: 'error' })`.

## 4. Silent `console.*` failures → toasts

| Site | Toast (kind `error` unless noted) |
| --- | --- |
| `ChatView.svelte:59` — image attach failure | `Couldn't attach image: <reason>` |
| `ChatView.svelte:305-306` — `restartOnGpu` failure | `GPU restart failed: <reason>` + action `View logs` |
| `+layout.svelte:124` — `open_url` failure | `Couldn't open link in your browser` |
| `InferenceSection.svelte:72-73`, `:102-103`, `:120-121` — server stop/start failures | `Couldn't <start/stop> the inference server: <reason>` + action `View logs` |

Keep the existing `logDebug` calls — toasts are in addition to the Log
Viewer trail, not a replacement (maintenance.md §10).

## 5. Interactive server status badge

`ServerStatusBadge.svelte:7-22` is a passive div; error text truncates at
300px (`:67-70`) with nowhere to go.

- Render the badge as a `<button>`; clicking it opens the Log Viewer. Wire
  via an `onOpenLogs` prop from `+layout.svelte`, reusing the same handler as
  the header logs icon.
- Error state: keep the truncated inline message, append a `View logs`
  visual affordance (it's the whole-button click target).
- Wrap the status text in `aria-live="polite"` so state transitions
  (starting → ready / error) are announced.

---

## Tests & acceptance

- Store tests: `retryLastTurn` re-runs without duplicating the user message;
  queued send fires exactly once on `starting → ready`; `starting → error`
  produces the banner; cancel-while-queued path.
- Component test: error banner renders Retry and it invokes the store.
- Manual: launch the app and immediately send a message → it waits, then
  sends when the model is ready. Kill llama-server mid-generation → banner +
  Retry recovers. Trigger a mic error with no whisper model → readable toast.
