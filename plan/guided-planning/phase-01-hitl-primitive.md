# Phase 01 — Reusable human-in-the-loop question primitive

**Depends on:** nothing · **Enables:** Phase 02 (the tool), checkpoints in 06/07.

## Goal

Build the reusable "ask the user a question and await their answer" mechanism —
a Svelte store plus a global modal — mirroring the existing
`fileConflict.svelte.ts` / `FileConflictModal.svelte` pattern, but supporting
the full question shape (single/multi-select, per-option descriptions, a
recommended highlight, and an always-present free-text answer). No tool and no
job wiring yet; this is pure UI infrastructure, exercised via a temporary dev
trigger.

## Files touched

- **NEW** `src/lib/stores/userQuestion.svelte.ts` — the store.
- **NEW** `src/lib/components/UserQuestionModal.svelte` — the modal.
- **EDIT** root layout (`src/routes/+layout.svelte` or wherever
  `FileConflictModal` is mounted) — mount `UserQuestionModal` once.

## Implementation

### Store (`userQuestion.svelte.ts`)

Mirror `fileConflict.svelte.ts` exactly in shape:

```ts
export interface UserQuestionOption { label: string; description?: string; recommended?: boolean }
export interface UserQuestionRequest {
	question: string;
	options: UserQuestionOption[];
	allowMultiple?: boolean; // free-text is always allowed
}
export type UserAnswer =
	| { kind: 'selected'; labels: string[] }   // one entry unless allowMultiple
	| { kind: 'freeText'; text: string };

// Single pending question at a time (same constraint as askFileConflict).
export function askUserQuestion(req: UserQuestionRequest): Promise<UserAnswer>;
export function getPendingQuestion(): (UserQuestionRequest & { resolve: (a: UserAnswer) => void }) | null;
export function resolveUserQuestion(answer: UserAnswer): void;
```

`askUserQuestion` rejects if a question is already pending (callers serialize —
the runner only ever asks one at a time anyway).

### Modal (`UserQuestionModal.svelte`)

Subscribe to `getPendingQuestion()`; render when non-null. Layout:

- The question text.
- Options as a list — radio-style when `!allowMultiple`, checkbox-style when
  `allowMultiple`; show each `description`; badge the `recommended` one.
- An always-present **"Write your own answer"** affordance (text input). Its
  presence is unconditional — it is *not* a member of `options`.
- Submit resolves `{ kind: 'selected', labels }` or `{ kind: 'freeText', text }`.

Keyboard: Enter submits, Esc is intentionally **not** a cancel (a question must
be answered — cancellation is the runner's concern via job-cancel, not the
modal). Match the visual style of `FileConflictModal` / `CommandApprovalModal`.

> **No degradation logic here.** The "no interactive user → pause" behavior is a
> *run-context* concern handled in Phase 05, because it requires job-run state
> that doesn't exist yet. This primitive always assumes a surface is mounted —
> which is true for chat and any foreground run.

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. Add a temporary dev button (e.g. in a debug menu) that calls
   `askUserQuestion({ question: 'Pick one', options: [...] })` and logs the
   resolved answer. Remove before merge or guard behind a debug flag.
2. Single-select: modal renders, selecting + submit resolves `selected` with one
   label.
3. Multi-select (`allowMultiple: true`): multiple checks resolve `selected` with
   several labels.
4. Free-text: typing a custom answer + submit resolves `freeText`.
5. Recommended badge + descriptions render.
6. Asking while one is pending rejects.

## Commit

```
feat(ui): reusable user-question store + modal primitive

Adds askUserQuestion()/UserQuestionModal mirroring the file-conflict
modal-await pattern: single/multi-select, option descriptions, a
recommended highlight, and an always-present free-text answer. No tool
or job wiring yet.
```

## Roll-back rule

Self-contained UI; if it regresses, revert the three files. Nothing depends on
it until Phase 02.
