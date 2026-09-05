# Phase 07 — Onboarding & polish

**Commit scope:** `fix(ui)` / `docs` · **Language:** Svelte · **Depends on:** nothing

Three small user-facing fixes with locked copy.

---

## 1. Visible rename affordance for conversations

`ConversationSidebar.svelte:73-76` — rename is double-click-only,
undiscoverable.

- Add a pencil button (`✎`) between the title and the delete `×`, visible on
  row hover **and** `:focus-within` (keyboard users can reach it), with
  `aria-label="Rename conversation"` and `title="Rename"`.
- Clicking it enters the exact same inline-edit state the dblclick handler
  sets today. Keep the dblclick path.
- Same visual treatment as the existing `.delete-btn` (opacity-on-hover
  pattern already in the component).

## 2. "Choose a different model" during setup download

`setup/+page.svelte:263-295` — once downloading, the only exits are Cancel
and (on error) Retry; there's no path back to pick a smaller model.

- Add a link-style button `Choose a different model` on the download step,
  shown both **during** download and on the **error** state.
- Behavior: invoke the same download-cancel command the Cancel button uses,
  then return to the hardware/model-selection step **preserving** the
  already-detected hardware results (no re-probe).
- The partial download stays on disk (the existing resume logic makes this
  free if they pick the same model again).

## 3. Fix the privacy claim on the welcome step

`setup/+page.svelte:135` says "Nothing you ask ever leaves your device",
which conflicts with web research and the OpenRouter cloud backend
(`InferenceSection.svelte:210` correctly warns prompts leave the device).

Locked replacement copy:

> **Your conversations and AI responses stay on your device.** Web research
> sends search queries to the web, and the optional cloud backend
> (OpenRouter) is off by default and clearly labeled.

Also grep for the same absolute claim elsewhere (`grep -rn "leaves your
device\|never leave" src README.md`) and align any other occurrence with the
qualified wording. README.md's Goals section already qualifies correctly —
leave it.

---

## Tests & acceptance

- Component test: sidebar pencil enters edit mode and commits a rename.
- Manual: run setup with a slow connection, click *Choose a different
  model* mid-download → back on the picker with hardware results intact;
  pick the 4B model → download starts cleanly.
- Manual: welcome step shows the new copy; no other absolute privacy claims
  in the app UI.
