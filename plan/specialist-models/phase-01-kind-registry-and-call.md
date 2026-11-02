# Phase 01 — Kind registry, specialist entries and the call

**Depends on:** nothing · **Enables:** every later phase: the tool (03) dispatches to kinds, the settings editor (04) is driven by the registry, the GLB kind (06) registers here.

## Goal
Lay down the core that every specialist shares, with no UI and no tool yet: the `SpecialistKind` contract, a registry kinds add themselves to, the `SpecialistEntry` record stored in `AppSettings.specialists`, and one function that sends a request to a specialist endpoint with its prompt and sampling, through the inference queue, with streamed progress. Ships the `text` kind as the registry's first member. Nothing is visible to users, so the PR is labelled `no-docs`.

## Files touched
- `src/lib/specialists/types.ts` — new: `SpecialistKind`, `SpecialistEntry`, `SpecialistSampling`, `SpecialistRun`, `SpecialistParam`.
- `src/lib/specialists/kinds.ts` — new: `registerSpecialistKind`, `specialistKind(id)`, `specialistKinds()`.
- `src/lib/specialists/kinds/index.ts` — new: side-effect imports of every kind module (only `./text.ts` in this phase).
- `src/lib/specialists/kinds/text.ts` — new: the `text` kind.
- `src/lib/specialists/entries.ts` — new: `specialistEntries()`, `specialistById(id)`, `effectiveSampling(entry)`, `effectiveSystemPrompt(entry)`, `effectiveDescription(entry)`, `entryBackend(entry)`, `newSpecialistEntry(kindId)`.
- `src/lib/specialists/call.ts` — new: `callSpecialist(entry, request, opts)`.
- `src/lib/stores/settings.ts` — add `specialists: SpecialistEntry[]` to `AppSettings` (default `[]`), load-merge it, and add `setSpecialistEntries(list)` that snapshots with `structuredClone` like `setMcpServers`.
- `src/lib/specialists/kinds.test.ts`, `entries.test.ts`, `call.test.ts`, `kinds/text.test.ts` — new tests.

## Steps
1. In `types.ts` define:
   - `SpecialistSampling { temperature?: number; top_p?: number; top_k?: number; min_p?: number; max_tokens: number }`.
   - `SpecialistParam { schema: Record<string, unknown>; required: boolean }` — a JSON-schema property a kind adds to the tool.
   - `SpecialistEntry { id: string; name: string; kind: string; url: string; keyId: string | null; model: string; description: string | null; systemPrompt: string | null; sampling: Partial<SpecialistSampling> | null; onByDefault: boolean }`. `null` in `description`, `systemPrompt` or `sampling` means "the kind's default"; an empty string `systemPrompt` means "send no system message" (for servers that hold the prompt themselves, as asmodean's toolchest does).
   - `SpecialistRun { entry: SpecialistEntry; request: string; args: Record<string, unknown>; ctx: ToolContext }`.
   - `SpecialistKind { id: string; label: string; summary: string; defaultDescription: string; defaultSystemPrompt: string; defaultSampling: SpecialistSampling; writes: boolean; params: Record<string, SpecialistParam>; requestRequired: boolean; callLabel?(entry: SpecialistEntry, args: Record<string, unknown>): string | null; run(run: SpecialistRun): Promise<ToolExecOutput> }`. `label` and `summary` are for the settings editor; `defaultDescription` tells the main model when to use it; `writes` says the kind writes into the session folder; `requestRequired` is false only for kinds that have a mode without a request; `callLabel` lets a kind name a call on its tool card (returning `null` keeps the tool's default label).
2. In `kinds.ts` keep a `Map<string, SpecialistKind>`. `registerSpecialistKind` throws on a duplicate id, on a param named `name` or `request` (the tool's own fields), and on a param whose name another registered kind already uses with a different schema (the tool merges kind params into one schema, so a name must mean one thing). Two param schemas are the same when they are equal after removing `description` at every level, compared as JSON with sorted keys; descriptions may differ, and the tool shows the first registered kind's. `specialistKinds()` returns kinds in registration order.
3. `kinds/text.ts` registers `{ id: 'text', label: 'Text', summary: 'Returns the model\'s answer as text.', defaultDescription: 'Answers a question or writes a short piece of text.', defaultSystemPrompt: '', defaultSampling: { temperature: 0.7, max_tokens: 4096 }, writes: false, params: {}, requestRequired: true }`. Its `run` calls `callSpecialist`, strips think blocks (`stripThinkBlocks`), caps the answer at 24,000 characters with a trailing "(answer cut at 24,000 characters)" note, and returns `toolResult(answer)`.
4. `entries.ts`:
   - `specialistEntries()` returns `getSettings().specialists` filtered to entries whose `kind` is registered (an entry of an unknown kind, e.g. after a downgrade, is kept in settings but never offered).
   - `effectiveSampling(entry)` = `{ ...kind.defaultSampling, ...entry.sampling }`; `effectiveSystemPrompt` and `effectiveDescription` return the entry's value when non-null, else the kind's default.
   - `entryBackend(entry)` returns a `BackendOverride { baseUrl: entry.url (trailing slash and /v1 stripped), apiKeyId: entry.keyId ?? undefined, modelId: entry.model }`.
   - `newSpecialistEntry(kindId)` makes an entry with a `crypto.randomUUID()` id, the kind's label as name (made unique against existing names with `uniqueName` from `src/lib/generation/entry.ts`), empty url and model, null overrides, `onByDefault: false`.
5. `call.ts` — `callSpecialist(entry, request, opts: SpecialistCallOptions)` where `SpecialistCallOptions = { signal?: AbortSignal; onProgress?: (status: string) => void; turnBackend?: BackendOverride | null; runInSlot?: SlotLender; maxTokens?: number }`. A kind passes its `ToolContext` straight through: `{ signal: ctx.signal, onProgress: ctx.onProgress, turnBackend: ctx.backend, runInSlot: ctx.runInSlot }` (`ctx.onProgress` already drives the tool card's status line). Add the helper `callOptionsFrom(ctx: ToolContext): SpecialistCallOptions` to `call.ts` so every kind does it the same way.
   - Builds `messages`: a system message with `effectiveSystemPrompt(entry)` when it is non-empty, then the user `request`.
   - Sends with `chatCompletionStream` from `src/lib/api.ts`, `backend: entryBackend(entry)`, the effective sampling spread in (`opts.maxTokens`, when given, replaces `max_tokens`), and no `chat_template_kwargs` (the server's own thinking default stands; the spike's model reasons and that is wanted).
   - Queueing: the turn's base URL is `resolveBackendDescriptor(opts.turnBackend ?? undefined).baseUrl`. When `opts.runInSlot` is given and that URL equals `entryBackend(entry).baseUrl`, run inside `opts.runInSlot` so the call uses the turn's slot and cannot deadlock a one-slot server. In every other case (including callers with no turn, like the settings Test button) wrap in `withInferenceSlot({ consumer: 'subagent', backend: entryBackend(entry), signal }, …)` so it gets its own `remote:<baseUrl>` lane, which admits one request at a time unless the server advertises more slots.
   - Accumulates content and reasoning; every 500 ms calls `onProgress` with `"<name>: N tokens"` (content plus reasoning chunks counted).
   - Returns `{ content, reasoning, finishReason, completionTokens }`. A `finishReason` of `length` is returned, not thrown; kinds decide what it means.
   - Aborts propagate as `AbortError`. HTTP errors surface as `Error` with the server's status and the first 300 characters of its body; `api.ts`'s existing 5xx retries stay in force (they cover the HTTP 500 that toolchest gave the spike under concurrency).
6. In `settings.ts` add the field, default, merge and `setSpecialistEntries`.
7. Import order, with no cycle: `kinds.ts` (the registry) imports no kind; `entries.ts` and `call.ts` import only `kinds.ts`; each kind module imports `kinds.ts` and `call.ts`; `kinds/index.ts` imports the kind modules. Only top-level consumers import `#lib/specialists/kinds/index.ts` for its side effect: in this phase the tests; `ask-specialist.ts` from phase 03; `SpecialistsSection.svelte` and `SpecialistsMenu.svelte` from phase 04.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`.

## Test plan
- `kinds.test.ts`: registering two kinds lists them in order; a duplicate id throws; a param named `name` or `request` throws.
- `entries.test.ts`: overrides beat kind defaults and `null` falls back; empty `systemPrompt` survives as "no system message"; unknown-kind entries are filtered out; `entryBackend` strips `/v1` and trailing slashes; `newSpecialistEntry` names are unique.
- `call.test.ts` (mock `chatCompletionStream`, `withInferenceSlot`): system message present/absent; sampling reaches the request and `maxTokens` overrides it; a same-URL backend with `runInSlot` uses it, a different URL or no `runInSlot` uses `withInferenceSlot` with the specialist's backend; `callOptionsFrom` maps the context fields; progress fires with token counts; abort rejects with `AbortError`; `length` finish is returned.
- `kinds/text.test.ts`: think blocks stripped; the 24,000-character cap and its note.

## Commit
`feat(specialists): kind registry, specialist entries and the specialist call`

## Rollback
Revert the commit. Nothing reads `specialists` yet, and an `AppSettings` field left in a user's stored JSON is ignored by older builds, so a partial revert is safe.
