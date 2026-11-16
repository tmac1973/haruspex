# Phase 08 — A view interface for the Code pane

**Depends on:** nothing (refactor) · **Enables:** 09 (a remote session
implements it)

## Goal

`CodePane`, `CodeTranscript`, `CodeComposer`, `CodeSessionHeader`,
`CodeSteps`, `BackgroundChip`, `SessionUsageChip`, `CodeModelPicker`,
`CodeTabStrip` and `CodeWorkspace` take the concrete `CodeSession` class.
Introduce a `CodeSessionView` interface holding exactly what they read and
call, plus a `capabilities` object saying which controls apply, and type the
components against it. `CodeSession` implements it with every capability on.
The local Code tab behaves exactly as before.

## Files touched

- `src/lib/code/sessionView.ts` — new: `CodeSessionView`,
  `CodeSessionCapabilities`.
- `src/lib/stores/code.svelte.ts` — `CodeSession implements CodeSessionView`;
  `capabilities` getter. `getOpenSessions()` keeps returning local
  `CodeSession[]` only: its callers include the owner API engine
  (`src/lib/engine/dispatch.ts`, `sessions.ts`, `watch.svelte.ts`), Home
  cards, `TasksChip` and `lean/busy.ts`, and a remote view reaching the
  engine would relay one computer's sessions to another (a non-goal). New:
  `getOpenViews(): CodeSessionView[]` (local, then remote),
  `getActiveView()`, `registerOpenView(view)` / `unregisterOpenView(id)`;
  `setActiveSession(id)` accepts either kind of id. Only `CodeTabStrip`,
  `CodeWorkspace` and `CodeSidebar` move to `getOpenViews()` /
  `getActiveView()`.
- `src/lib/components/code/{CodePane,CodeTranscript,CodeComposer,CodeSessionHeader,CodeSteps,BackgroundChip,SessionUsageChip,CodeModelPicker,CodeTabStrip,CodeWorkspace,CodeBranchControl,ExtrasMenu,FolderMissingBanner,SubtaskCard}.svelte`
  — prop types to `CodeSessionView`; controls guarded by `capabilities`.
- `src/lib/code/windows.ts`, `src/lib/code/paths.ts`,
  `src/lib/code/openEditor.ts` — accept a view where they take a session.

## Steps

1. Build the interface from what the components use today (from a grep of
   `session.*` in `src/lib/components/code/`): identity and state (`id`,
   `title`, `root`, `wslDistro`, `status`, `busy`, `active`, `messages`,
   `messageSteps`, `messageStats`, `messageStops`, `searchSteps`,
   `streamingContent`, `roundText`, `steering`, `steeringDelivered`,
   `returnedSteering`, `returnedImages`, `prefill`, `pendingToolCalls`,
   `lastError`, `saveError`, `folderMissing`, `compaction`, `compacting`,
   `contextNotice`, `usage`, `totals`, `background`, `shellWait`, `effort`,
   `backend`, `readOnly`, `projectRoot`, `fileNotes`, `grouped`, `ticket`,
   `ts`), and actions (`send`, `stop`, `continueTurn`, `compactNow`,
   `cancelShellWait`, `stopSubtask`, `setEffort`, `setBackend`,
   `takePrefill`, `takeReturnedSteering`, `takeReturnedImages`,
   `setDraftReader`, `open`, `refreshBackground`). Members only some
   capabilities need (`git`, `refreshGit`, `helpers`, `specialists`,
   `setSessionHelpers`, `setSessionSpecialists`, `agentsMd`, `moveTo`,
   `goToShell`, `checkFolder`, `fork(index, mode)`, `newBeside()`) are
   optional on the interface.
2. `CodeSessionCapabilities { git: boolean; helpers: boolean; specialists:
   boolean; detachWindow: boolean; openInShell: boolean; openInEditor:
   boolean; localFiles: boolean }`. `localFiles` gates folder pickers, the
   file tree's write actions and drag-and-drop of local paths.
3. Each component hides a control whose capability is off, rather than
   disabling it (no dead buttons). With `CodeSession` every capability is
   `true`, so nothing disappears locally.
4. `forkFromMessage` and `newSessionBeside` take the view and call
   `view.fork?.(index, mode)` / `view.newBeside?.()` when present; local
   behaviour stays in `CodeSession`.
5. No behaviour change; the existing Code component and store tests stay
   green.

## Build gate

- `npm run check && npm run lint && npm run test`

## Test plan

- Existing Code component and store tests pass.
- New `sessionView.test.ts`: a minimal fake view with every capability off
  renders `CodePane` without git, helpers, specialists, detach or Shell
  controls, and without throwing on missing optional members.
- Hand: `npm run drive -- run --prompt "..."` against the fake LLM; Code tab
  works as before.

## Commit

`refactor(code): type the Code pane against a CodeSessionView interface`

## Rollback

Revert; types only plus guards that are always true locally.
