# Phase 04 — camera_snapshot and camera_listen tools, approval, indicator

**Depends on:** 02, 03 · **Enables:** 06 (`camera_look` reuses the gating and
approval), 08 (`camera_log` reuses them)

## Goal

The model can look and listen in chat and jobs: two tools, gated to local or
trusted models, with per-camera Ask/Allow approval, Allow-only in jobs, and a
visible "camera in use" indicator.

## Files touched

- `src/lib/agent/tools/camera.ts` — new: registers `camera_list`,
  `camera_snapshot`, `camera_listen`.
- `src/lib/agent/tools/camera.test.ts` — new.
- `src/lib/agent/tools/_cameraGate.ts` — new: shared `cameraRefusal(ctx,
  camera)` and `resolveCamera(name)` used by every camera tool.
- `src/lib/agent/tools/types.ts` — add `'camera'` to the category union.
- `src/lib/agent/tools/registry.ts` — `ToolFilterOpts.cameras`; include in
  `shouldIncludeChatTool`; excluded in `shouldIncludeCodeTool` and
  `shouldIncludeShellTool`; opts built in `getToolSchemas`; hard re-check in
  `executeTool`.
- `src/lib/agent/tools/index.ts` — import `camera.ts`.
- `src/lib/agent/tools/_families.ts` — `camera` family `byCategory('camera')`.
- `src/lib/stores/cameraApproval.svelte.ts` — new, modelled on
  `screenCaptureApproval.svelte.ts`.
- `src/lib/components/CameraApprovalModal.svelte` — new; mounted in
  `src/routes/+layout.svelte` beside `ScreenCaptureApprovalModal`.
- `src/lib/engine/prompts.svelte.ts` — expose the camera prompt to the remote
  page like the screen one.
- `src/lib/stores/cameraActivity.svelte.ts` — new: active-use registry.
- `src/lib/components/CameraIndicator.svelte` — new; mounted next to
  `ServerStatusBadge` in `src/routes/+layout.svelte`.
- `docs/guide/cameras.md` — "Let the assistant look and listen" section.
  (`docs/guide/tool-loading.md` doesn't list families, so it is unchanged.)

## Steps

1. Gate (`cameraRefusal`), checked in this order, each returning a refusal
   string the model sees:
   - no cameras configured → "No cameras are set up. Add one in Settings →
     Cameras."
   - `!cameraDataAllowed(resolveBackendDescriptor(ctx.backend))` (the turn's
     own backend, so a job on a different model is judged by that model) → "Cameras only work
     with a model on this computer or a server trusted in Settings → Cameras."
   - unknown camera name → list the configured names.
   - `!ctx.interactive && camera.permission === 'ask'` → "This camera is set
     to Ask, so jobs can't use it. Set it to Allow in Settings → Cameras."
   - `ctx.interactive && permission === 'ask'` → `onApprovalWait(true)`,
     `askCameraUse({cameras: [name], action})` where `action` is
     `'look' | 'listen' | 'move' | 'read_log'` (all four defined now, so later
     tools reuse the modal unchanged), `onApprovalWait(false)`; deny → refusal.
   Jobs reach this with `approvalOverride` active; the camera gate ignores the
   override, so an Ask camera is still refused.
2. Registry: add `backend?: BackendOverride | null` to `ToolSchemaOpts` and
   pass it from the chat and job-runner callers of `getToolSchemas`; include
   `'camera'` tools in chat when `opts.cameras` (true when
   `settings.cameras.length > 0` and
   `cameraDataAllowed(resolveBackendDescriptor(opts.backend))`, not tied to
   `interactive`); never in Code or Shell. Job turns only see tools named in
   their `toolAllowlist` (`offeredSchemas`), so no job gets camera tools
   until a job type lists them. `executeTool` re-runs the gate.
3. `camera_list` — no args; returns names, kind, has_audio, can_aim, and
   permission. Not gated by Ask (no capture).
4. `camera_snapshot({camera})` — `requiresVision: true`; invokes
   `camera_snapshot`; pushes to `ctx.pendingImages` with label
   `camera:<name> <timestamp>` and returns `thumbDataUrl`.
5. `camera_listen({camera, seconds = 10, max 30})` — invokes `camera_listen`;
   returns the transcript and level; an empty transcript at < −50 dB returns
   "Silence (level N dB)".
6. `cameraActivity`: `begin(cameraId, kind)` / `end(...)` around each command;
   `CameraIndicator` shows a camera icon with the camera name(s) while
   anything is active; tooltip lists them. The registry keys entries by
   `(cameraId, kind)` so other kinds of activity can be added later.
7. Approval modal: "Let the assistant <look through | listen on | move |
   read the log of> <name, name…>?" with Allow / Deny; aborted turn = deny.
8. Guide section: tool names, Ask vs Allow, jobs need Allow, local-only rule.

## Build gate

- `npm run check`, `npm run lint`, `npm run test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan

- Unit: each gate branch returns the right refusal; Ask in a job is refused
  even with `approvalOverride`; Allow skips the prompt; deny refuses.
- Unit: schemas include camera tools in chat only when cameras exist and the
  backend is allowed; never in Code/Shell; `executeTool` refuses when the
  model calls one it wasn't offered.
- Unit: the modal renders each of the four actions and a multi-camera list.
- Unit: `camera_snapshot` pushes exactly one pending image; dropped when
  `visionSupported` is false.
- Manual (local Qwen 3.5 9B): "what's on the counter?" uses the D1 and
  answers correctly; "what's being said?" returns your speech; switching the
  model to OpenRouter removes the tools.
- Manual: indicator appears during each capture and clears after.

## Commit

`feat(camera): let the assistant look and listen through cameras`

## Rollback

Revert: tools and modal disappear; settings and the core module stay. No
data written.
