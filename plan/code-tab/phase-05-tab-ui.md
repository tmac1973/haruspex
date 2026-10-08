# Phase 5 — The Code tab

**Depends on:** 4 · **Guide:** new `docs/guide/code.md`; `settings.md`
(Settings → Code); `shortcuts.md` if a key is added; `shell.md` (settings moved)

## Goal

The tab users see: a session sidebar, sub-tabs, a coding-agent transcript, and
Settings → Code.

## Layout (`src/lib/components/code/`)

```
┌ TabBar: Chat · Jobs · Shell · Code ───────────────────────────┐
│ Sidebar        │ [session A] [session B ●] [+]          ⧉     │
│ ▾ haruspex     │ header: folder · model ▾ · effort ▾ · AGENTS │
│   Fix lint…    │         · context gauge · running: 1 ▸       │
│   Code tab…    │ ─────────────────────────────────────────────│
│ ▾ blog         │ transcript                                   │
│   …            │   user / assistant messages                  │
│ [New session]  │   tool cards (command, diff, grep, read…)    │
│                │ ─────────────────────────────────────────────│
│                │ input (steering while running) · mic · stop  │
└────────────────┴──────────────────────────────────────────────┘
```

- `CodeWorkspace.svelte` — sidebar + strip + active pane. Mounted lazily like
  the Shell (`+page.svelte` `shellEverOpened` pattern) so sessions survive tab
  switches.
- `CodeSidebar.svelte` — `code_session_list` grouped by `root` (basename,
  full path in `title`), newest first; rename / delete on right-click; click
  opens as a sub-tab. Collapsible, width saved like `shellSidebarWidth`.
- `CodeTabStrip.svelte` — modelled on `ShellTabStrip`; status dot per tab
  (running / queued / waiting on shell). Detach button is wired in phase 7.
- `NewSessionDialog` — folder picker (`WorkingDirButton` pattern), defaulting to
  the last root used (`codeLastRoot` setting).
- `CodeSessionHeader.svelte` — folder (opens file manager), backend picker
  (configured backends: local + remote/OpenRouter models), effort selector
  (reuse the model-lineup effort control), `AgentsMdBadge`, `ContextGauge`,
  background-process chip with a popover listing each process
  (command, uptime, Output → `code_bg_tail` in a modal, Stop).
- `CodeTranscript.svelte` — reuses `ChatMessage` + `SearchStep`; tool steps get
  code-specific cards:
  - **Command card:** command, exit code, duration, collapsible output
    (ANSI stripped). Buttons: Copy, *Open in Shell* (wired in phase 6).
  - **Diff card:** for `fs_edit_text`, a unified diff built from the call's
    `old_str` / `new_str` args plus `first_changed_line` from `EditResult`;
    for `fs_write_text`, the tool reads the previous content first (if any) and
    attaches a line diff to the step (new file → all added). Collapsed past
    40 lines. Diff with the `diff` npm package if it's already a dependency,
    else a small LCS in `src/lib/code/diff.ts`.
- Input: while a turn runs, Enter queues a steering message (shown as a pending
  bubble, marked delivered on `onSteering`); Stop restores undelivered ones to
  the box. Slash menu + mic as in Chat.

## Settings → Code (`components/settings/CodeSection.svelte`)

Move from Settings → Shell's "Code mode" block: command timeout, auto-approve,
max iterations. New: background log size cap. Keep the setting keys (no
migration); only their section moves. Shell keeps what Full access needs
(phase 8 trims the rest).

## Platform gate

Hide the Code entry in the TabBar on Windows (`navigator.userAgent` check or a
`platform()` call, whichever the app already uses) until phase 10.

## Shortcuts

Add the tab to whatever switches main tabs today, in `src/lib/shortcuts.ts`,
and the `shortcuts` guide page (the test holds them together).

## Tests

Component tests for sidebar grouping, strip status dots, steering queue UI,
diff builder (edit + write + new file), command card truncation.

## Done when

A user can open the Code tab, start a session in a folder, have the agent edit
files and run commands with diffs and command cards shown, steer it, switch
model/effort, close and reopen the session from the sidebar, and quit and
relaunch to find it intact.
