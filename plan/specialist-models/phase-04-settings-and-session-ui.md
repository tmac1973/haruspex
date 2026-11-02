# Phase 04 — Settings → Code → Specialists, the session menu, and the guide

**Depends on:** 01, 02, 03 · **Enables:** users can define and use `text` specialists end to end; 06 adds the GLB kind to the same editor with no UI change.

## Goal
Make specialists reachable: an editor in Settings → Code → Specialists that is driven entirely by the kind registry, a Specialists menu in the Code session header with one checkbox per specialist, and a guide page. After this phase a user can point a `text` specialist at any OpenAI-compatible model and the Code tab's model can ask it questions. First user-visible PR: the body names `docs/guide/specialists.md` and `docs/guide/code.md`.

## Files touched
- `src/lib/components/settings/SpecialistsSection.svelte` — new: the list and Add menu.
- `src/lib/components/settings/SpecialistEntryEditor.svelte` — new: one entry's form.
- `src/lib/specialists/call.ts` — add `listSpecialistModels(entry)` for the Fetch button.
- `src/lib/components/settings/CodeSection.svelte` — render `SpecialistsSection` as a "Specialists" subsection.
- `src/lib/components/code/SpecialistsMenu.svelte` — new: the header menu.
- `src/lib/components/code/CodeSessionHeader.svelte` — place `SpecialistsMenu` next to the model and effort controls.
- `docs/guide/specialists.md` — new guide page.
- `docs/guide/code.md` — one paragraph pointing at the `specialists` page.
- Tests: `SpecialistsSection.test.ts`, `SpecialistEntryEditor.test.ts`, `SpecialistsMenu.test.ts`.

## Steps
1. `SpecialistsSection.svelte`: one-sentence intro ("Small models the Code tab's model can hand a narrow job to."), a row per entry (name, kind label, model, an "On by default" checkbox, Edit, Delete with confirm), and an **Add** button whose menu lists `specialistKinds()` by `label` with `summary` as each item's `title`. Adding calls `newSpecialistEntry(kind.id)` and opens the editor. Row actions (On by default, Delete) save at once; the editor saves only on its **Save** button. Every save goes through `setSpecialistEntries` with a plain copy of the list (never a `$state` proxy). The section imports `#lib/specialists/kinds/index.ts` for its side effect (as does `SpecialistsMenu.svelte`).
2. `SpecialistEntryEditor.svelte` edits a draft copy of the entry and has **Save** and **Cancel** buttons; Cancel (and closing the editor) drops the draft, and a new entry that was never saved is not added. All fields are generic, nothing per kind:
   - Name: a duplicate of another entry's name (case-insensitive) or an empty name shows an inline error under the field and blocks saving; nothing is renamed silently (`uniqueName` is used only for a new entry's starting name), endpoint with `ServerAddress.svelte`, API key with `ApiKeyPicker.svelte`, model: a text field plus a **Fetch** button that fills a datalist from `listSpecialistModels(entry)` (below).
   - Description for the model: a textarea showing the kind's `defaultDescription` as placeholder; empty saves `null`.
   - System prompt: a textarea prefilled with the effective prompt. On Save, an empty textarea stores `null` (back to the default; only the checkbox below means "no system message"), text identical to the kind's `defaultSystemPrompt` stores `null` (so a later change to the kind's default reaches the entry); any other text stores the string. A **Reset** button sets `null` and refills the default. A "Send no system prompt" checkbox stores `''` and disables the textarea (tooltip: "For servers that set the prompt themselves.").
   - Sampling: number fields for temperature, top-p, top-k, min-p and max tokens with the kind's defaults as placeholders; empty fields are left out of `sampling`; all empty saves `null`.
   - An **Accepts images** checkbox (tooltip: "Turn on when the server has this model's vision projector loaded.").
   - A **Test** button that sends `"Reply with OK."` through `callSpecialist(entry, …, { maxTokens: 64 })` with no turn options, so it queues on the specialist's own lane, and shows the first line of the answer or the error.
3. Add `listSpecialistModels(entry): Promise<string[]>` to `src/lib/specialists/call.ts`: a webview `fetch` of `GET <entryBackend(entry).baseUrl>/v1/models` (the same path and CORS behaviour as the chat calls), with `Authorization: Bearer <getApiKeyValue(entry.keyId)>` when a key is set and a 10 s `AbortSignal.timeout`; returns `data[].id`, and throws with the status on a non-2xx answer (the editor shows it under the field).
4. `SpecialistsMenu.svelte`: hidden when `specialistEntries()` is empty. Shows "Specialists" with a count of the ones on; opens a list of checkboxes, one per entry, checked from `sessionSpecialists(session.specialists)`. Toggling calls `setSessionSpecialists` (from `src/lib/stores/code.svelte.ts`) with the full id list. A "Use defaults" item stores `null`. Entries of `writes: true` kinds are disabled with the tooltip "This session is read-only." in a read-only session. Changes take effect from the next turn.
5. `docs/guide/specialists.md` (frontmatter `title`, `description`; under 6 KB), with these sections: what a specialist is; "Add a specialist" (Settings → Code → Specialists → Add, the fields, Accepts images, Test); "Send a reference image" (with Accepts images on, the agent can pass up to three images from the project with a request); "Turn specialists on for a session" (the header's Specialists menu, On by default); "Kinds" (Text, with a line saying more kinds come with the app, not from settings); "What it doesn't do" (no Chat, Shell or jobs; the app never downloads or runs the model; you run the server).
6. `docs/guide/code.md`: a short "Specialist models" paragraph that points at the `specialists` page.

## Build gate
`npm run check`, `npm run lint`, `npm run format:check`, `npm run test`; the `Guide` check passes (guide files touched).

## Test plan
- Section: Add lists registered kinds; a new entry gets a unique name; delete removes it; On by default saves; the saved list is plain JSON (`structuredClone` of settings does not throw).
- Editor: Accepts images saves; Cancel drops the draft and a never-saved new entry; an empty or duplicate name shows the error and disables Save; an emptied prompt saves `null`; empty overrides save `null`; an unedited prompt saves `null` and an edited one saves the text; Reset restores `null`; "Send no system prompt" saves `''`; Test shows the answer and an error (mocked call).
- `call.test.ts`: `listSpecialistModels` sends the key when set, returns ids, throws on a non-2xx answer.
- Menu: hidden with no entries; checkboxes reflect `null` as the defaults; toggling saves the full id list; "Use defaults" saves `null`; write kinds disabled in read-only sessions.
- Hand test (dev build): add a `text` specialist pointing at `http://compute:3000` with model `tcclaviger/Qwen3.8-Flash-Next-MXFP4-FP8-GPTQ`, press Test, turn it on in a Code session, and ask the agent to "ask the specialist for a regex that matches ISO dates". The tool card shows the call and the answer reaches the agent.

## Commit
`feat(code): Specialists settings and per-session menu`

## Rollback
Revert the commit. Stored entries stay in settings and are harmless; the tool from phase 03 is again unreachable.
