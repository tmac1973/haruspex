# Phase 02 — Writable-path limit for a turn

**Depends on:** phase 01 · **Enables:** phase 03 (a subtask profile that
writes only named files) and phase 05 (the 3D delegate's three files).

## Goal

Give a turn a list of the only files it may write, enforced by the tools, not
the prompt. A `ToolContext.writablePaths` list, when set, makes
`fs_write_text`, `fs_edit_text` and `check_3d` refuse a path that is not on it.
With the list unset, nothing changes. Nothing user-visible ships here. The 3D
delegate uses this list so it can write into the session's folder directly, with
no worktree.

## Files touched

- `src/lib/agent/tools/types.ts` — add `writablePaths?: string[]` to
  `ToolContext`: paths relative to the working folder, normalised.
- `src/lib/agent/loop.ts`, `src/lib/agent/loop/context.ts`,
  `src/lib/agent/runTurn.ts` — carry a `writablePaths` loop option into the
  tool context.
- `src/lib/agent/tools/_helpers.ts` — add `writeOutsideLimit(ctx, relPath):
  string | null`, which returns the refusal text or null.
- `src/lib/agent/tools/fs-write.ts` — call it in `fs_write_text` and
  `fs_edit_text` before any write or dry run.
- `src/lib/agent/tools/check-3d.ts` — `appHost(ctx).write` refuses a path
  outside the limit, with the same text.
- `src/lib/agent/tools/_helpers.test.ts`, `fs-write.test.ts`,
  `check-3d.test.ts` — new cases.

## Steps

1. Normalise with the same function the fs tools use to resolve a relative
   path against `ctx.workingDir` (forward slashes, no `./`, `..` resolved,
   case kept). A path that resolves outside the folder is already refused by
   the fs layer. `writeOutsideLimit` compares normalised strings for an exact
   match.
2. Refusal text: `You may write only: <list>. Write <path>'s content into one
   of those instead.`, returned as a tool error.
3. `fs_write_text` and `fs_edit_text`: check before the write-guard
   acquisition, so a refused call takes no lease.
4. `check_3d`: the host's `write` is the only place the helper writes (the
   GLB, or the normalised copy). Refuse there, so `check_3d` still builds and
   reports when given a bad `out`, but writes nothing. Its result says the
   GLB was not written and why. Export `appHost` from `check-3d.ts` as
   `check3dHost(ctx)`, so other code can build a host from a `ToolContext`
   with its own `writablePaths` (phase 05 passes
   `{ ...ctx, writablePaths: [glb], pendingImages: [] }`).
5. Leave every other writing tool alone. The 3D delegate gets a tool
   allowlist (phase 03) that does not offer them.

## Build gate

```bash
npm run check
npm run lint
npm run format:check
npm run test
```

## Test plan

- `writeOutsideLimit`: unset list → null; exact match → null; `./a/b.js` and
  `a/b.js` match; a sibling file, a parent folder and a different extension
  are refused.
- `fs_write_text` and `fs_edit_text` with a limit: an allowed path writes; a
  refused path returns the refusal and never calls the write guard.
- `check_3d` with a limit that leaves out the `.glb`: the report comes back,
  the GLB is not written, and the result says so.

## Commit

`feat(agent): limit a turn's writes to named files (ToolContext.writablePaths)`

## Rollback

Revert the commit. Nothing sets `writablePaths` until phase 03, so reverting
is safe on its own once phase 03 is not merged.
