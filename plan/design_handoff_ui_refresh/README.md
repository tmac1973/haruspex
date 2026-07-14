# Handoff: Haruspex UI refresh (warm-neutral dark + teal)

## Overview
A visual refresh of the Haruspex desktop app that **keeps the existing layout and information
architecture** (3 tabs, sidebars, composer positions, settings rail) and changes the *finish*:
warmer neutral dark palette, an on-brand **teal** accent (a nod to the bronze-liver namesake,
chosen over the current generic blue), tighter grouping, and two structural cleanups —
the **job editor** becomes collapsible sections and **settings** becomes carded groups.
A **light theme** is included. No features are removed.

## About the design files
The files in this bundle are **design references created in HTML** (Design Components), not
production code to copy. They are prototypes showing intended look and behavior. The task is to
**recreate this styling in the real Haruspex codebase** — SvelteKit 5 + Svelte 5 runes, Tauri 2,
per the repo's existing patterns — by editing the existing components, **not** by importing this
HTML. The single biggest lever is `src/routes/+layout.svelte`, which defines the CSS custom
properties and shared primitives every screen already inherits.

- `Haruspex Refreshed.dc.html` — the full app in the new system (all screens + states). Primary reference.
- `Haruspex UI Polish.dc.html` — the earlier exploration board (bronze/teal/indigo options, before/after). Context only.
- `tokens-and-implementation.md` — **the implementation spec**: exact token values (dark + light), token→component mapping, the new primitives, and the two structural changes. Read this first.
- `support.js` — runtime needed only so the `.dc.html` files open in a browser. Not for the app.

To view a reference: open `Haruspex Refreshed.dc.html` in a browser. Header controls: the
sun/moon toggles light/dark; the gear opens Settings; the logs icon opens the Log Viewer.
Bottom-left pills open the **first-run wizard** and the **dialog gallery**. In the Jobs tab,
a job's ▶ button opens the running-job view.

## Fidelity
**High-fidelity.** Final colors, spacing, typography, and interaction structure. Recreate
pixel-close using the codebase's existing components/patterns. Font is the app's current system
stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`); monospace is
`ui-monospace, 'SF Mono', Menlo, Consolas, monospace`. No font change.

## The core idea (do this first)
Everything reads from CSS variables in `+layout.svelte`. Update the token blocks there and most
of the app re-skins automatically. Then add three shared primitives and apply the two structural
changes. Full values and the token→app-name mapping are in `tokens-and-implementation.md §1`.

Summary of tokens (see the md for the complete dark+light table):
- Dark: bg `#100f0d`, surface `#16140f`, raised `#1e1c18`, input `#1b1914`, border `#2a2621`,
  border-strong `#3a352d`, text `#ece7dd` / `#a39d92` / `#8f887c` / `#6f6a61`,
  accent `#4fb0a5`, accent-contrast `#06201c`.
- Light: bg `#ffffff`, surface `#f4f1ea`, raised `#ffffff`, input `#ffffff`, border `#e5e0d7`,
  border-strong `#d6cfc3`, text `#1f1c17` / `#5f594f` / `#867f74` / `#a29c91`,
  accent `#2f8f84`, accent-contrast `#ffffff`. (Surface relationship inverts vs dark.)
- Status (both themes): success `#6fae6a`, danger `#dd6b60`, danger-border `#47201d`, warning `#d7a13f`.
- Radius: 6–7px controls, 8px inner buttons, 9–10px cards, 12px modals. Card padding 15–16px.
- **Always-dark surfaces:** terminals, code blocks/previews, Log Viewer body stay dark in both themes.

## New / updated shared primitives
1. **Switch** — 34×20 pill; accent when on (knob = accent-contrast), `--toggle-off`+border-strong when off (16px knob). Replaces bare checkboxes in settings toggle rows.
2. **Segmented control** — flex track (bg inside a border-mid frame, 3px pad, radius 8), equal-flex buttons, active = accent bg + accent-contrast text. **Restyle `ModeSelector.svelte`** — this replaces stacked radio cards everywhere (job model source, settings response-format, inference backend, proxy).
3. **Card + section header** — surface bg, 1px border, radius 10, pad 15–16; heading 0.9rem/600 with a 6px teal dot. Used by `.settings-section` and the job-editor groups.

Buttons (`.btn` family, already centralized): primary uses accent bg + accent-contrast text (not white).

## Screens / views (all in `Haruspex Refreshed.dc.html`)

### App chrome
- **Header** (`+layout.svelte`): logo + "Haruspex" + version; right side: server-status pill (dot + label), context counter, theme toggle (new), logs, help, settings icons. 9px/16px padding, 1px bottom border.
- **Tab bar** (`TabBar.svelte`): Chat / Jobs / Shell; active tab = text-primary + 2px accent bottom-border; Jobs shows a small accent count badge.

### Chat tab (`ChatView.svelte`, `ConversationSidebar.svelte`)
- 250px conversation rail (surface): "+ New Chat", list rows, active row has a 2px accent left-border, "Clear all" footer.
- Messages: user block (subtle accent-tinted bg), search-steps chip (rounded, search icon), assistant block with markdown, inline citations in accent, source chips (rounded pills).
- Composer: bordered textarea (accent focus ring), working-dir (folder) button, circular deep-research toggle (accent when on), circular mic, accent Send.

### Jobs tab (`JobsTab.svelte`, `JobList.svelte`, `JobEditor.svelte`, `JobRunView.svelte`, `JobRunHistory.svelte`)
- Left 230px job list (badges: research/audit/plan; ▶ run button). Right 230px run history (status pills). Center = editor or run view.
- **Editor — collapsible sections** (structural change): *Basics* (name/type/description), *Where & when* (working dir + schedule), *Model* (segmented Settings/Remote/OpenRouter, fields reveal inline), and the type-specific section (*Steps* / *Audit setup* / *Guided planning* / *Autonomous coding*). Closed sections show a one-line summary. Docked footer: Delete / Cancel / Save. **All existing fields per job type are preserved** — see `tokens-and-implementation.md §3` and the mock's "Job type gallery" (option 2e in the Polish board).
- **Running-job view**: job name + status pill + Cancel; step cards with per-step status pills (Done/Running/Pending), deep-research badge, prompt, "prior output prepended" note, live spinner + streaming caret.

### Shell tab (`ShellWorkspace.svelte`, `ShellTabStrip.svelte`, `Terminal.svelte`, `ChatSidebar.svelte`)
- Tab strip (rounded top tabs, active/detach/close/+), dark terminal (stays dark both themes), and the assistant sidebar: header with capture badge + **Code** / **Think** toggles + New chat + collapse; message area with Paste/Run code cards (risky chip in danger); composer with textarea + submit-recent-commands button + mic + Send.

### Settings overlay (`SettingsPanel.svelte` + all `*Section.svelte`)
- Header (Back + title), grouped icon rail (Core / Capabilities / About) with active teal pill, pane with title + one-line subtitle. Every section carded with dotted headers.
- **All sections represented** (this mock is a complete checklist): General (theme, response format), Inference (backend segmented, API keys list+add, models list with active/legacy + download, all 5 context sizes, server status/port + Restart/Stop), Agent (behavior switches, custom prompt, Python sandbox + approval/timeout), Audio (TTS voice, read-tables, output/input devices + Refresh), Search (provider, recency, Brave key, network proxy), Integrations (email account form + add), Shell (binary, capture count, max bytes, Code-mode group: default/execution/timeout/max-steps/danger auto-approve), Feedback (Open issue / Save diagnostics).

### Modals & flows
- **Log Viewer** (`LogViewer.svelte`): tabbed (App/LLM/TTS/Whisper/Crashes/Debug/Tools/Stats), dark log body, Stats engine table, Clear/Copy/close.
- **First-run wizard** (`routes/setup/+page.svelte`): Welcome (download vs remote) → Hardware → Download progress → Test → Done, plus the Remote path.
- **Dialogs** (`Modal.svelte` + `ModalButton.svelte`): ConfirmDialog, FileConflictModal, SandboxApprovalModal, CommandApprovalModal — stacked title/subtitle buttons, danger/subtle variants, code previews. Restyling `Modal`/`ModalButton` covers all.

## Interactions & behavior
Behavior is **unchanged** from the current app — this is a restyle. Preserve all existing handlers,
stores, keyboard shortcuts (F1–F4, Ctrl/Cmd+N, etc.), focus management/traps in `Modal`, and the
deferred server-restart logic. New interaction patterns are limited to: collapsible job-editor
sections (local open/closed state per section, remember is optional) and the segmented control
replacing radio cards (same underlying value binding as `ModeSelector`).

## State management
No new app state. The mock's toggles (tab, settings category, section open/closed, theme, model
source) map to existing Svelte state/stores. Theme already flows through the `data-theme`
attribute + settings store; the header toggle drives it.

## Assets
No new image assets. Icons are inline feather-style SVGs matching the app's existing icon style
(stroke, currentColor) — reuse the codebase's existing icons; the mock's SVG paths are provided
as reference only. No Anthropic brand assets are used.

## Files in this bundle
- `Haruspex Refreshed.dc.html` — full app reference (open in a browser).
- `Haruspex UI Polish.dc.html` — exploration/options board (context).
- `tokens-and-implementation.md` — implementation spec (read first).
- `support.js` — runtime for opening the .dc.html files only.

## Target files in the Haruspex repo (where to apply changes)
- `src/routes/+layout.svelte` — tokens + shared primitives (start here).
- `src/lib/components/ModeSelector.svelte` — segmented control.
- `src/lib/components/ToggleField.svelte` + settings toggle rows — switch.
- `src/lib/components/jobs/JobEditor.svelte` + `types/*/Editor.svelte` — collapsible sections.
- `src/lib/components/settings/SettingsPanel.svelte` + `*Section.svelte` — carded groups + grouped rail.
- `src/lib/components/shell/ShellTabStrip.svelte` — replace hardcoded `#1e1e1e`/`#181818` with tokens.
- Spot-check: `ChatView`, `ConversationSidebar`, `Modal`, `ModalButton`, `LogViewer`, `routes/setup/+page.svelte`.
