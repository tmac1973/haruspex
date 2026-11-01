# Phase 03 — `load_tools` and the split tool list

**Depends on:** phases 01 and 02 · **Enables:** phase 04

## Goal

When deferred loading is on for a turn, send the core schemas and
`load_tools`, and deliver a family's schemas when the model loads it, with the
option phase 01 chose. The setting is a plain JSON field with no UI yet, and
it is off by default, so nothing a user sees changes.

## Files touched

- `src/lib/stores/settings.ts`: `deferTools: 'auto' | 'on' | 'off'`, default
  `'off'` for this phase (phase 06 changes it to `'auto'`).
- `src/lib/agent/tools/load-tools.ts` (new): the `load_tools` tool, category
  `tools-load`.
- `src/lib/agent/tools/index.ts`: import it.
- `src/lib/agent/tools/deferred.ts` (new): `splitTurnTools`,
  `loadedFamilies`, and the loaded-marker format.
- `src/lib/agent/loop/context.ts`: build `ctx.tools` from the split, and keep
  the full offered set on the context as `ctx.offeredTools`.
- `src/lib/agent/loop/toolCalls.ts`: after a `load_tools` result, apply the
  delivery option. Answer a call to an offered tool that is not loaded.
- `src/lib/agent/summaryMessage.ts` / `compaction.ts`: carry the loaded
  families into the summary.
- Tests next to each.

## Steps

1. **When it applies.** `deferOn(opts)` is true when the setting resolves to
   on (`'auto'` reads `parseParamsB` of the active model: on above 12B or when
   unknown), and the turn is interactive Chat or the Code tab. It is false for
   Shell, a `toolAllowlist`, a subtask and a lean turn.
2. **Split.** `splitTurnTools(offered, messages, codeTab)` returns:
   - `sent`: core schemas in registry order, then the schemas of each loaded
     family, in the order the families were loaded;
   - `deferred`: the families of this turn that have at least one offered tool,
     with their offered schemas.

   `offered` is `offeredSchemas(...)` from phase 02, so a family can only hold
   tools this turn may use. A family with no offered tool is not listed.

3. **Loaded state.** A loaded family is recorded in the `load_tools` result
   as `<tools_loaded family="video">`. `loadedFamilies(messages)` reads the
   markers back, as `loadedSkillNames` does. The order of first appearance is
   the load order, so the `tools` array is the same on every later turn.
4. **`load_tools`.** Parameters: `family`, an enum of this turn's deferred
   family ids, set by `liveSchema` as `withSkillEnum` does for skills. Its
   result:
   - a family that is offered: the marker, plus per option:
     A and C: "Loaded: video_probe, video_cut, …"; B: the schemas as JSON;
   - a family that is not offered this turn: an error that names what to turn
     on, for example "Video editing is off. The user can turn it on in
     Settings → Video editing." Nothing loads.
5. **Delivery.**
   - _A._ In `toolCalls.ts`, after a `load_tools` call, set `ctx.tools` again
     from `splitTurnTools`. The next `modelCall` sends the longer array.
   - _B._ `ctx.tools` does not change. A call to a name in
     `ctx.offeredTools` is resolved as usual: `resolveToolCalls` gets
     `ctx.offeredTools`, not `ctx.tools`.
   - _C._ `ctx.tools` holds `use_tool`. In the parser, unwrap
     `use_tool({ name, arguments })` into a call to `name`, so steps, labels,
     approvals and `parallelTools` see the real tool. Keep the history in the
     form phase 01 found the backend accepts.
6. **A call before a load.** A call to a tool that is in `ctx.offeredTools`
   but not loaded runs `load_tools` for its family first. Then it returns the
   schema and "Call video_probe again with these parameters." It does not run
   the tool, because the arguments were a guess. A name that is not offered at
   all goes to `runTool` as today, and its hard gates and "Unknown tool" answer
   apply.
7. **Compaction.** When a summary replaces old messages, put the loaded
   markers in the summary message, so `loadedFamilies` still finds them.
8. **Tests.**
   - For each profile in the audit (Chat without a folder, with a folder,
     everything on, and the Code tab with and without everything), the core
     tools plus every deferred family equal `offeredSchemas` with the setting
     off.
   - `load_tools` for a family that is not offered loads nothing.
   - Turn N's `tools` names are a prefix of turn N+1's, across a load and
     across a compaction.
   - A call to a deferred tool before a load returns its schema and does not
     run it.
   - With the setting off, `buildLoopContext` returns the same `tools` as
     before, by snapshot.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Test plan

- Automated: step 8.
- Live: set `"deferTools": "on"` in the dev build's `webview-store.json`, turn
  on video editing, ask Chat to probe a clip. In the debug log, check that the
  first request has no `video_*` tools, that `load_tools` runs, and that the
  next request has them (A) or that the call resolves (B, C). Check
  `prompt_n` on the turn after.

## Commit

`feat(tools): load tool families when the model asks for them`

PR label `no-docs`: the setting has no UI yet.

## Rollback

Revert the commit. A leftover `deferTools` key is ignored. Conversations with
`<tools_loaded>` markers read as ordinary tool results.
