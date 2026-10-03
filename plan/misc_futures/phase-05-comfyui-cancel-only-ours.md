# Phase 05 — Cancel only our own ComfyUI prompt

Depends on: — / Enables: — (07's cancel on ComfyUI benefits from it)

## Goal

Cancelling a generation stops our prompt and nothing else.

Today the ComfyUI backend's cancel calls `POST /interrupt`
(`comfyui/backend.ts:284`, `client.ts:261`). That stops whatever the server
is running, including another client's job on a shared ComfyUI, and it
leaves our prompt in the queue if it hadn't started yet.

## Files touched

- `src/lib/image/comfyui/client.ts`: `queueState`, `deletePending`,
  `cancelPrompt`; `interrupt` stops being exported.
- `src/lib/image/comfyui/backend.ts`: the cancel path in `generate`.
- `src/lib/image/comfyui/client.test.ts`, `backend.test.ts`.
- `src-tauri/src/comfy.rs`: nothing new. `/queue` and `/interrupt` go
  through the existing `comfy_json`. Add a test route to its fake server
  only if `client.test.ts` can't cover it.

## Steps

1. **`queueState(cfg)`** does `GET /queue` and returns
   `{ running: string[], pending: string[] }`, the prompt ids from
   `queue_running` and `queue_pending`.
   - In each entry the prompt id is element 1 of the array; parse
     defensively.
   - On any failure it returns null, never throws.
2. **`deletePending(cfg, ids)`** does `POST /queue` with `{ delete: ids }`.
3. **`cancelPrompt(cfg, promptId)`**, best-effort, never throws:
   - read the queue;
   - if `promptId` is pending, delete it;
   - if it is running, `POST /interrupt` with body `{ prompt_id: promptId }`.
     Newer ComfyUI interrupts only that prompt; older servers ignore the body.
   - If the queue can't be read, do nothing. Say why in the code: an
     unconditional interrupt is the bug this phase removes.
4. **The backend's cancel path calls `cancelPrompt` with the id `submit`
   returned.** Today `submit` receives the abort signal
   (`comfyui/backend.ts:248`, `client.ts:206-211`), so an abort during submit
   loses the id even if ComfyUI already queued the prompt.
   - Stop passing the signal to `submit`. It is one short POST, bounded by
     its own timeout.
   - When the abort arrives during submit, let submit finish, then
     `cancelPrompt` the returned id.
   - Generation still settles as `cancelled` immediately; the clean-up runs
     in the background.
5. **Nothing else interrupts.** Grep `src/lib/image` for other uses of
   `interrupt`. Anything left goes through `cancelPrompt`.

## Build gate

The overview's gate.

## Test plan

- **Unit, `client.test.ts`** (fake `requestJson`):
  - a pending id causes a `/queue` delete and no `/interrupt`;
  - a running id causes an `/interrupt` whose body carries the id;
  - an id in neither causes no calls after `/queue`;
  - a `/queue` failure causes no calls.
- **Unit, backend:**
  - an abort after submit cancels exactly that id;
  - an abort during submit cancels the id once submit resolves;
  - `generate` rejects with `cancelled` in both.
- **Manual,** against a ComfyUI with two clients: queue a long job from the
  ComfyUI web UI, start a generation from Haruspex Settings → Image → Test,
  and cancel it. The web UI's job keeps running, and Haruspex's prompt
  disappears from the queue.

## Commit

`fix(image): cancelling removes our own ComfyUI prompt instead of interrupting the server`

## Rollback

Revert the commit.
