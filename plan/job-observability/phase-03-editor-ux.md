# Phase 03 — Job Editor Clarity

Three independent UX fixes to the job editors. Independent of phases 1 and 2 —
could land in any order.

## Steps

### 1. A Tooltip component, and delete the duplicated prose

Every field in `autonomous-coding/Editor.svelte` carries a `title` attribute
*and* a `.hint` span saying much the same thing at greater length — nine hints
there, seven in `audit/Editor.svelte`, four in `JobEditor.svelte`, three in
guided-planning, two in research. The information is already duplicated; the
job is to keep one copy and give it a consistent home.

Add `src/lib/components/Tooltip.svelte`:

- A ⓘ affordance rendered beside the field label, so it is discoverable —
  native `title` gives no sign that help exists, which is half the problem.
- Opens on hover **and** keyboard focus; dismissible with Escape;
  `aria-describedby` wiring so the text is announced rather than merely
  hoverable.
- Positioned so a long paragraph is readable — the current `title` strings run
  to 250+ characters (`Editor.svelte:122`) and native tooltips render them as
  one unbroken line.
- Must not sit inside a `<label>` without care: the editor already documents
  this trap at `autonomous-coding/Editor.svelte:95` — a `<summary>` nested in a
  label activates the label and steals focus to the input on every toggle. The
  same applies to a clickable tooltip trigger. Either render it outside the
  label, or `preventDefault` on the trigger.

Then, per field: the descriptive prose moves into the tooltip and the `.hint`
span is deleted. **Kept inline** — because they are decisions, not
descriptions, and they are what makes preflight work:

- "**Not sure? Leave it blank.**" on both command fields
  (`Editor.svelte:72`, `:90`).
- The `.unattended-note` block (`:174`) — it sets expectations for the whole
  job type, not one field.
- The `(recommended — keeps the loop's work off your current branch)` inline
  hint on the branch checkbox (`:170`), which is a one-line recommendation, not
  a paragraph.

The `<details class="verify-examples">` block (`:97-118`) is superseded by the
verification dropdown in step 3 and should go with it, not into a tooltip.

### 2. Plan directory becomes a picker

`plan_dir` is required and typed by hand (`Editor.svelte:41`), with a
`<datalist>` of other guided-planning jobs' output dirs as the only help.

`JobEditor` already has the pattern — `open({ directory: true })` from
`@tauri-apps/plugin-dialog` (`JobEditor.svelte:193`), with a "Browse…" button at
`:640`; `WorkingDirButton.svelte:22` is a second instance. Copy it, with two
constraints specific to this field:

- **`plan_dir` is relative to the working dir**, and the pipeline treats it that
  way (`normalizePlanDir` in `config.ts`, and `tryParsePlanDir` passes it to
  `fs_list_dir` as `relPath`). So the dialog opens with `defaultPath` set to the
  job's working dir, and the chosen absolute path is converted back to a
  relative one on return.
- **A pick outside the working dir must be rejected** with a clear message
  rather than silently stored — `fs_list_dir` would fail at run time, hours
  later, in preflight. Fail in the editor where it can be fixed.

Keep the text input editable next to the button: the working dir may not be set
yet when the field is filled in, and the existing datalist suggestions stay
useful.

### 3. Phase verification becomes a command picker

The field takes a shell command the runner executes directly (`runCheckCommand`,
`pipeline.ts:1080`, with the longer `VERIFY_TIMEOUT_SECS` because it may be a
real suite). Nothing in the control says so.

Replace the bare text input with a `<select>` of suggestions plus a free-text
box (the select writes into the box; the box stays authoritative and editable —
bespoke commands must remain possible). Label it as a shell command, and use
the same treatment for the step-check field, which has the identical ambiguity.

Suggestions come from three tiers, each labeled by where it came from so the
user can see *why* something is offered:

1. **From the plan.** The guided-planning template declares a
   `## Verification command` section per phase — `VERIFICATION_COMMAND_HEADING`
   at `planParse.ts:33`, parsed by `extractDecisionCommand`, with
   `STEP_CHECK_HEADING` alongside it for the step-check field. The editor reads
   the configured `plan_dir` and offers whatever the plan already declares.
   Highest signal by a distance: it is literally what the run will do, and it
   works for a repo with no files in it yet, which is the greenfield case.
2. **From the working dir.** `package.json` scripts (offer `npm test`, `npm run
   <script>` for test-ish names), `Cargo.toml` → `cargo test`, `pyproject.toml` /
   `requirements.txt` → `pytest`, `go.mod` → `go test ./...`, a `Makefile`
   `test` target → `make test`. `IGNORE_BY_MARKER` (`pipeline.ts:1125`) is the
   existing precedent for marker-file-driven stack detection — mirror its shape,
   deliberately narrow.
3. **From the catalog, filtered by the plan's stack.** When 1 and 2 are both
   empty — a new repo whose plan declares no command — scan the plan markdown
   for stack markers (TypeScript/SvelteKit, Rust/Cargo, Python/pytest, Go, …)
   and show those languages' conventional commands first, the rest below. A
   greenfield plan names its stack; that is what a plan is for. No markers
   found → the whole catalog, grouped by language.

Plus, always: an explicit **"Leave blank — preflight will propose one and test
it"** entry. Blank is a supported, well-trodden path, not an omission
(`pipeline.ts` settles the contract in preflight, and `Editor.svelte:90` already
tells the user so) — the dropdown should make that visible rather than implying
something must be chosen.

Both fields' suggestion lists refresh when `plan_dir` or the working dir
changes.

## Verification

- `Tooltip.test.ts`: opens on hover and on focus, closes on Escape, wires
  `aria-describedby`, and — the specific trap — a tooltip inside a field's
  label does not move focus into that field when toggled.
- A suggestion-builder unit test (pure function, given plan files + marker
  presence → ordered labeled suggestions): plan-declared command wins; working
  dir markers next; empty repo + stack-naming plan yields that stack first;
  nothing at all still yields the blank entry.
- Plan-dir picker: relative conversion, and a pick outside the working dir is
  rejected with a message.
- `npm run check` and `npm run lint` — the editors are the files most likely to
  drift on a11y and unused-CSS warnings after this much deletion.
- Manual: open each of the four job editors and confirm no orphaned `.hint`
  styles, no doubled help text, and that every remaining paragraph is one of the
  three deliberate keeps.
