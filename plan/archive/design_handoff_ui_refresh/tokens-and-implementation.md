# Haruspex refresh — implementation notes

The whole app inherits from the tokens + shared primitives in `src/routes/+layout.svelte`.
Change them there once and every screen (Chat, Jobs, Shell, Settings, modals) picks up the
new look. Then apply the two structural changes (job editor → collapsible sections, settings →
carded groups). Accent: **teal**.

## 1. Color tokens (`:root` blocks in `+layout.svelte`)

Warmer neutrals + teal accent. Replace the current values:

### Dark (both the `@media (prefers-color-scheme: dark)` and `[data-theme='dark']` blocks)

| token             | current   | new       |
| ----------------- | --------- | --------- |
| `--bg-primary`    | `#111111` | `#100f0d` |
| `--bg-secondary`  | `#1a1a1a` | `#16140f` |
| `--bg-chat`       | `#111111` | `#100f0d` |
| `--text-primary`  | `#e5e5e5` | `#ece7dd` |
| `--text-secondary`| `#9ca3af` | `#a39d92` |
| `--accent`        | `#60a5fa` | `#4fb0a5` |
| `--border`        | `#2e2e2e` | `#2a2621` |
| `--code-bg`       | `#0d0d0d` | `#0c0b0a` |
| `--user-bubble`   | `#1e293b` | `color-mix(in srgb, #4fb0a5 8%, #100f0d)` |

New tokens to add (used by the switch, segmented control, and card headers):

```css
--bg-raised: #1e1c18;   /* cards / raised surfaces */
--bg-input:  #1b1914;   /* inputs, textareas, selects */
--border-strong: #3a352d;
--accent-contrast: #06201c;  /* text/knob on a filled teal control */
--accent-soft: color-mix(in srgb, var(--accent) 14%, transparent);
```

### Finalized full token set (dark + light) — as shipped in the `Haruspex Refreshed` mock

The mock uses short token names; map them onto the app's existing `--bg-*` / `--text-*` names
(or just adopt these names). **Light mode inverts the surface relationship** — the main area is
white and side panels/cards are the tint, the reverse of dark. The accent darkens to `#2f8f84`
in light for AA contrast on white; on filled teal controls the ink flips to white.

| mock token       | app token (suggested)   | dark      | light     | used for                              |
| ---------------- | ----------------------- | --------- | --------- | ------------------------------------- |
| `--bg`           | `--bg-primary`          | `#100f0d` | `#ffffff` | app background, main content, segmented track |
| `--surface`      | `--bg-secondary`        | `#16140f` | `#f4f1ea` | sidebars, panels, cards               |
| `--raised`       | `--bg-raised` (new)     | `#1e1c18` | `#ffffff` | inner buttons, list rows, chips       |
| `--input`        | `--bg-input` (new)      | `#1b1914` | `#ffffff` | inputs, selects, textareas            |
| `--border`       | `--border`              | `#2a2621` | `#e5e0d7` | default hairline border               |
| `--border2`      | `--border-mid` (new)    | `#322e28` | `#ece7dd` | segmented-control frame               |
| `--border3`      | `--border-strong`       | `#3a352d` | `#d6cfc3` | input borders, secondary buttons      |
| `--off`          | `--toggle-off` (new)    | `#2e2a24` | `#e2ddd3` | switch off-track fill                 |
| `--t1`           | `--text-primary`        | `#ece7dd` | `#1f1c17` | primary text                          |
| `--t2`           | `--text-secondary`      | `#a39d92` | `#5f594f` | secondary text                        |
| `--t3`           | `--text-muted` (new)    | `#8f887c` | `#867f74` | labels, hints, muted UI               |
| `--t4`           | `--text-faint` (new)    | `#6f6a61` | `#a29c91` | placeholder text, faint captions      |
| `--accent`       | `--accent`              | `#4fb0a5` | `#2f8f84` | accent (teal)                         |
| `--accent-ink`   | `--accent-contrast`     | `#06201c` | `#ffffff` | text/knob on filled teal              |

Status colors are theme-independent (soft `color-mix(..., transparent)` tints work on both):
`--success #6fae6a`, `--danger #dd6b60`, `--danger-border #47201d`, `--warning #d7a13f`.

**In the app's `+layout.svelte`:** put the dark set on `:root` (default) and the light set under
`:root[data-theme='light']` (mirroring the existing `[data-theme='dark']` block), plus the
`@media (prefers-color-scheme)` variants the app already uses. The existing header theme toggle
(system / light / dark) already drives `data-theme` — no new toggle needed.

> A CSS `a` / `a:hover` rule already isn't defined app-wide — set link color to `var(--accent)`
> in the global reset so user-added links don't render browser-blue.

### Always-dark surfaces (do NOT theme these)
Terminals, code blocks/previews, and the Log Viewer body stay dark in **both** themes (standard
for those surfaces). Keep `#0c0b0a` bg with `#d4d4d4` text and syntax colors (`#4ec9b0` etc.)
literal — don't wire them to the light tokens.

## 2. Shared primitives to add / update (global `:global(...)` styles in `+layout.svelte`)

These are the pieces the mockup relies on. Adding them here means they work everywhere.

### Switch (replaces bare checkboxes in settings toggles)
A 34×20 pill; `--accent` when on, `--bg-raised`+`--border-strong` when off; knob 16px.
Use for `ToggleField` / settings `.toggle-row`. (Checkboxes stay fine for inline/list use.)

### Segmented control (replaces stacked radio cards — `ModeSelector`)
`display:flex` track (`--bg-primary` inside a `--border` frame, 3px padding, radius 8) with
equal-flex buttons; active button = `--accent` bg + `--accent-contrast` text. This is the single
biggest space win: the job editor's 3 model-source cards and the Settings response-format /
inference-backend pickers all collapse to one row. `ModeSelector.svelte` is used in several places,
so restyling it once propagates.

### Cards & section headers
`--bg-raised` + `1px solid --border`, radius 10, padding 15–16. Heading = 0.9rem/600 with a 6px
teal dot before it. Use for `.settings-section` (swap the hairline-divider chrome for cards) and
the job editor's grouped sections.

### Buttons (`.btn` family) — already centralized; just inherit new tokens
Primary uses `--accent` bg + `--accent-contrast` text (not white — white on teal is low-contrast).

## 3. Structural changes

- **Job editor** (`JobEditor.svelte`): wrap the fields in collapsible sections — **Basics**
  (name/type/description), **Where & when** (working dir + `JobScheduleField`), **Model**
  (the segmented `ModeSelector` + probe fields), and the type-specific section (`TypeEditor`)
  as **Steps / Audit setup / Plan / etc.**. Each closed section shows a one-line summary. Docked
  action footer (Delete / Cancel / Save). No fields removed — every type's inputs stay
  (research steps + deep-research + PromptCatalog, audit runs/turns/output/read-only/advanced,
  guided-planning idea + output dir, coding plan-dir/verify/signing/attempts).
- **Settings** (`SettingsPanel.svelte` + each `*Section.svelte`): group each section into cards
  with dotted headers; add icons + a grouped rail (Core / Capabilities / About) and an active
  teal pill; a one-line subtitle under each pane title.

## 4. Where each token shows up (so nothing gets missed)

Chat bubbles, `ThinkingIndicator`, `SearchStep`, `SourceChip`, `ContextIndicator`,
`ServerStatusBadge`, all modals (`Modal`, `ConfirmDialog`, approval modals), `LogViewer`,
`Toasts`, the Shell `Terminal` + `ChatSidebar` + tab strip, and the status pills all read the
same CSS variables — so updating `+layout.svelte` restyles them automatically. Spot-check the
Shell tab strip (`ShellTabStrip.svelte`) which hardcodes a few `#1e1e1e`/`#181818` values — swap
those for `--bg-secondary` / `--code-bg`.
