# Phase 04 — Destructive-action confirmations

**Commit scope:** `feat(ui)` or `fix(ui)` · **Language:** TS/Svelte · **Depends on:** phase 03 (ConfirmDialog)

Make every destructive action go through `ConfirmDialog`. Decision locked:
modal confirms everywhere — no native `confirm()`, no undo toasts.

**Pattern at each site:** one `ConfirmDialog` instance per component + a
local `$state` holding the pending target
(`let pendingDelete = $state<Conversation | null>(null)`); the row button
sets it, `onconfirm` performs the action and clears it, `oncancel` clears it.

---

## New confirmations (currently instant deletes)

| # | Site | Dialog copy (locked) |
| --- | --- | --- |
| 1 | Per-conversation delete — `ConversationSidebar.svelte:90-99` | title `Delete conversation?` · message `"<conv.title>" will be permanently deleted.` · confirm `Delete` |
| 2 | Model delete — `settings/ModelsSection.svelte:91-98` (button `:145-153`) | title `Delete model?` · message `<filename> (<size>) will be removed from disk. You'll have to download it again to use it.` — when it's the **active** model append `The inference server will be stopped first.` · confirm `Delete model` |
| 3 | API key delete — `settings/ApiKeysSection.svelte:26-28` (button `:70`) | title `Remove API key?` · message `The <provider> key will be removed. You can add it again later.` · confirm `Remove` |
| 4 | Email account delete — `EmailAccountForm.svelte:124` / `EmailSection.svelte:69-72` | title `Remove email account?` · message `<address> and its app password will be removed from Haruspex.` · confirm `Remove account` |

## Migrations from native `confirm()` (verified call sites)

| # | Site | Notes |
| --- | --- | --- |
| 5 | `ConversationSidebar.svelte:108` — clear all | title `Delete all conversations?` · message `All chat history will be permanently deleted.` · confirm `Delete all` |
| 6 | `LogViewer.svelte:281` — reset lifetime search stats | keep existing wording as the message; confirm `Reset` |
| 7 | `jobs/JobRunHistory.svelte:49` and `:58` — delete run / clear history | keep existing wording; confirm `Delete` |
| 8 | `jobs/JobEditor.svelte:443` — delete job | keep existing wording; confirm `Delete job` |
| 9 | `jobs/PromptCatalog.svelte:37` — replace current prompt | **not destructive-destructive** but migrates for consistency; `destructive={false}`, confirm `Replace` |

After this phase, `grep -rn "confirm(" src --include='*.svelte'` (excluding
tests) must return zero hits — add that as a review checklist item in the PR
description.

---

## Tests & acceptance

- Component tests for sites 1 and 2 (the data-loss-critical ones): clicking
  delete opens the dialog and does **not** call the store action; confirm
  calls it with the right id; cancel/Esc leaves state untouched.
- Existing jobs-UI tests updated where they stubbed `window.confirm`.
- Manual sweep: each of the 9 sites once, plus keyboard-only operation of
  site 1 (Tab to ×, Enter, Tab to Confirm — verifying phase 03's focus trap
  makes this flow work).
