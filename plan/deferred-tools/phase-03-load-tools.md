# Phase 03 — `load_tools` and the split tool list

**Depends on:** phases 01 and 02 · **Enables:** phase 04

## Goal

When deferred loading is on for a turn, send the core schemas, `load_tools`
and `use_tool`. The `load_tools` result gives a family's schemas as text, and
the model calls them through `use_tool` (option C, chosen in phase 01). The
`tools` array and the system text never change during a conversation, so a
load costs no cache miss. The setting is a plain JSON field with no UI yet,
and it is off by default, so nothing a user sees changes.

## Files touched

- `src/lib/stores/settings.ts`: `deferTools: 'auto' | 'on' | 'off'`, default
  `'off'` for this phase (phase 06 changes it to `'auto'`).
- `src/lib/agent/tools/load-tools.ts` (new): the `load_tools` and `use_tool`
  tools, category `tools-load`.
- `src/lib/agent/tools/index.ts`: import it.
- `src/lib/agent/tools/deferred.ts` (new): `splitTurnTools`,
  `loadedFamilies`, and the loaded-marker format.
- `src/lib/agent/loop/context.ts`: build `ctx.tools` from the split, and keep
  the full offered set on the context as `ctx.offeredTools`.
- `src/lib/agent/parser.ts`: unwrap a `use_tool` call into a call to the
  real tool.
- `src/lib/agent/loop/toolCalls.ts`: answer a call to a tool that is offered
  but not loaded.
- `src/lib/agent/summaryMessage.ts` / `compaction.ts`: carry the loaded
  families into the summary.
- Tests next to each.

## Steps

1. **When it applies.** `deferOn(opts)` is true when the setting resolves to
   on (`'auto'` reads `parseParamsB` of the active model: on above 12B or when
   unknown), and the turn is interactive Chat or the Code tab. It is false for
   Shell, a `toolAllowlist`, a subtask and a lean turn.
2. **Split.** `splitTurnTools(offered, codeTab)` returns:
   - `sent`: the core schemas in registry order, then `load_tools` and
     `use_tool`. This array is the same on every turn of the conversation;
   - `deferred`: the families of this turn that have at least one offered tool,
     with their offered schemas.

   `offered` is `offeredSchemas(...)` from phase 02, so a family can only hold
   tools this turn may use. A family with no offered tool is not listed.

3. **Loaded state.** A loaded family is recorded in the `load_tools` result
   as `<tools_loaded family="video">`. `loadedFamilies(messages)` reads the
   markers back, as `loadedSkillNames` does. Loaded state decides only which
   `use_tool` calls run (step 6). It never changes `tools` or the prompt.
4. **`load_tools`.** Parameters: `family`, an enum of this turn's deferred
   family ids, set by `liveSchema` as `withSkillEnum` does for skills. Its
   result:
   - a family that is offered: the marker, "Call these tools through
     use_tool, with name and arguments:", and the family's offered schemas as
     JSON (the `function` objects). The phase 04 prompt text that moves out of
     the system prompt goes here too;
   - a family that is not offered this turn: an error that names what to turn
     on, for example "Video editing is off. The user can turn it on in
     Settings → Video editing." Nothing loads.
5. **`use_tool`.** Parameters: `name` (string) and `arguments` (object). In
   `resolveToolCalls`, unwrap `use_tool({ name, arguments })` into a call to
   `name`, before anything else sees it, so steps, display labels, approvals,
   `parallelTools` and `coerceArgsToSchema` all see the real tool. Accept
   `arguments` sent as a JSON string as well. The history keeps the
   `use_tool` call as the model made it, because that is what the backend
   saw.

   A backend without a tool grammar (vLLM) lets the model call a loaded tool
   by its own name. In phase 01 Qwen3.8-Flash did this in 2 of 10 runs.
   `resolveToolCalls` gets `ctx.offeredTools`, so such a call resolves too.

6. **A call to a tool that is not loaded.** A `use_tool` call, or a direct
   call, naming a tool that is in `ctx.offeredTools` but whose family is not
   loaded: load the family (add the marker), return its schemas and "Call
   video_probe again with these parameters." It does not run the tool,
   because the arguments were a guess. A name that is not offered at all goes
   to `runTool` as today, and its hard gates and "Unknown tool" answer apply.
7. **Compaction.** When a summary replaces old messages, put the loaded
   markers in the summary message, so `loadedFamilies` still finds them.
8. **Tests.**
   - For each profile in the audit (Chat without a folder, with a folder,
     everything on, and the Code tab with and without everything), the core
     tools plus every deferred family equal `offeredSchemas` with the setting
     off.
   - `load_tools` for a family that is not offered loads nothing.
   - `tools` is byte-for-byte the same on every turn, across a load.
   - The loaded families survive a compaction.
   - A `use_tool` call is unwrapped: the step, label and executed tool are the
     real tool's, and `arguments` as a JSON string works.
   - A call to a deferred tool before a load returns its schema and does not
     run it.
   - `use_tool` naming a tool that is not offered this turn goes through
     `runTool`'s gates, for example a switched-off MCP tool is refused.
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
  `use_tool` call runs `video_probe`. The request after the load must have a
  small `prompt_n` (the new tail only), as must the next turn.

## Commit

`feat(tools): load tool families when the model asks for them`

PR label `no-docs`: the setting has no UI yet.

## Rollback

Revert the commit. A leftover `deferTools` key is ignored. Conversations with
`<tools_loaded>` markers read as ordinary tool results.
