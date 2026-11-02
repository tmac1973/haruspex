# Phase 03 — The `ask_specialist` tool

**Depends on:** 01, 02 · **Enables:** 04 (the UI makes the tool reachable), 06 (the GLB kind runs through it).

## Goal
Register one tool, `ask_specialist`, offered only in the Code tab and only when the session has at least one specialist on. Its schema is built per turn from the session's specialists and their kinds' params; its execute validates the call and hands it to the kind. With no UI yet, no user can define a specialist, so the tool is never offered in practice. Labelled `no-docs`.

## Files touched
- `src/lib/agent/tools/ask-specialist.ts` — new: schema, `liveSchema`, `execute`, `displayLabel`; imports `#lib/specialists/kinds/index.ts` for its side effect so every kind is registered before the tool's first schema.
- `src/lib/agent/tools/index.ts` — import the module.
- `src/lib/agent/tools/types.ts` — add `'specialist'` to the `category` union; add `codeSpecialists?: string[] | null` to `ToolContext`; widen `liveSchema` to `(schema: ToolDefinition, opts: ToolSchemaOpts) => ToolDefinition | null`.
- `src/lib/agent/tools/registry.ts` — add `codeSpecialists?: string[] | null` to `ToolSchemaOpts` (`undefined` outside the Code tab, the session's stored list inside it); pass `opts` as the second argument where `liveSchema` is called (today `reg.liveSchema(reg.schema)`); add `ToolFilterOpts.specialists: boolean`, computed in `offeredSchemas` as `opts.codeSpecialists !== undefined && sessionSpecialists(opts.codeSpecialists).length > 0`; include `ask_specialist` in `shouldIncludeCodeTool` only when `isCodeTab()` and that flag is true; add `ask_specialist` to `subtaskExcludes()`. Existing `liveSchema` implementations keep working because they ignore the new argument.
- `src/lib/agent/tools/codeTabProfile.ts` — add `ask_specialist` to `CODE_TAB_ONLY`.
- `src/lib/agent/tools/families.ts` — add `ask_specialist` to `CODE_CORE`, so it is never deferred once the user has turned a specialist on for the session.
- `src/lib/code/runCodeTurn.ts` — take `specialists: string[] | null` in its options (from the session object in `src/lib/stores/code.svelte.ts`, which passes `session.specialists`) and forward it as `codeSpecialists` to the agent loop.
- `src/lib/agent/loop/context.ts` — add `codeSpecialists?: string[] | null` to the loop options and copy it into the `ToolContext` it builds.
- `src/lib/agent/loop/turnTools.ts` — copy `options.codeSpecialists` into the `ToolSchemaOpts` it builds.
- Tests: `src/lib/agent/tools/ask-specialist.test.ts`, additions to `registry.test.ts`, `codeTabProfile.test.ts` and `src/lib/code/runCodeTurn.test.ts`.

## Steps
1. Base schema: `{ name: string, request: string }`, both described for the model. `request` is "what to make or answer, in plain English; keep it short and specific".
2. `liveSchema(schema, opts)` for the turn:
   - Let `offered = sessionSpecialists(opts.codeSpecialists ?? null)`. In a read-only session (`opts.codeReadOnly`) drop entries whose kind has `writes: true`. Return `null` (tool hidden) when nothing is left.
   - `name` becomes an enum of the offered names. The tool description lists each as `- <name>: <effectiveDescription(entry)>`.
   - Merge the `params` of every offered entry's kind into `properties` (phase 01's registry guarantees a shared name has one schema). A kind param is never in the schema's top-level `required`; its description starts with "(<kind label> only)", or "(<label A>, <label B> only)" when several offered kinds declare it. `request` is in `required` only when every offered kind has `requestRequired: true`.
3. `execute(args, ctx)`:
   - Resolve `name` against `sessionSpecialists(ctx.codeSpecialists ?? null)`; unknown → `toolError` listing the valid names.
   - A param belongs to every kind that declares it. Refuse any argument other than `name` and `request` that the named entry's kind does not declare: "`<param>` doesn't apply to <name>."
   - Check the named kind's required params and `request` (when `requestRequired`), each with a one-line `toolError`.
   - A `writes: true` kind in a read-only session → `toolError('This session is read-only.')`. For a write kind, take the writer lease through `ctx.codeWriteGuard.acquire()` for the length of the run and release it in `finally` (the central lease in `executeTool` is name-based and `ask_specialist` is not in `isCodeWriteTool`, because the `text` kind does not write).
   - Call `kind.run({ entry, request, args, ctx })` and return its output. An `AbortError` rethrows; any other error becomes `toolError("<name> failed: <message>")`.
4. `displayLabel(args)`: the named kind's `callLabel(entry, args)` when it exists and returns a string; otherwise `"<name>: <first 60 chars of request>"`.
5. Set `usesModel: false` (the specialist runs on its own lane or through `ctx.runInSlot`, as phase 01's `callSpecialist` decides) and `category: 'specialist'`.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- Registry: offered in the Code tab with one session specialist; not offered in Chat, Shell (code mode included), jobs, subtasks, or a Code session with none on; not deferred when offered; existing `liveSchema` tools (the image tools) unchanged.
- `liveSchema` with two fake kinds registered in the test: enum and description list the session's names; kind params merged and marked with their kind labels; read-only drops write kinds; `request` required only when all kinds require it.
- `execute` with the fake kinds: unknown name; a param the named kind doesn't declare; missing required param; read-only refusal for a write kind; the lease is taken and released (also when `run` throws); errors wrapped, `AbortError` rethrown; `displayLabel` uses `callLabel` and falls back.
- With the real `text` kind and a mocked call: the answer comes back as the tool result.
- `runCodeTurn.test.ts`: the session's list reaches both `ToolContext.codeSpecialists` and `ToolSchemaOpts.codeSpecialists`.

## Commit
`feat(code): ask_specialist tool for the Code tab`

## Rollback
Revert the commit. Phases 01–02 stand on their own; without this tool nothing calls a specialist. The widened `liveSchema` signature reverts with it.
