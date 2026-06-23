# Haruspex Code Tab — Implementation Plan (single PR)

A new **Code** tab: the most capable coding harness in Haruspex, running code
**on the host** (not Pyodide), with a deliberately lean toolset tuned to keep
context small enough that a local model still has room to work.

This plan is **ordered for implementation in one PR**. Each step ends in a
state that compiles and passes tests, and never depends on anything built in a
later step. The order is: harden existing backend commands → add new backend
commands → tool-layer plumbing → the new tools → the tab → verification. The
backend comes first because every tool invokes a Tauri command.

The guiding principle is **composition**: Haruspex already has the agent loop,
a mode-filtered tool registry, file read/write/edit, web research, context
compaction, a shell-risk classifier, and output truncation. This adds one mode,
three tools, four backend commands (two new, two new for search) plus hardening
of two existing ones, and a tab.

---

## 1. Final toolset

The Code tab exposes **8 tools** — Pi's core (read / write / edit / bash plus
ls / grep / find) plus web research:

| Tool | Status | Category | Purpose |
|---|---|---|---|
| `fs_read_text` | reuse + harden | fs | Read a file (gains offset/limit + truncation) |
| `fs_list_dir` | reuse as-is | fs | List a directory |
| `fs_edit_text` | reuse + harden | fs | Targeted edit (gains fuzzy match + LF norm + diff) |
| `fs_write_text` | reuse as-is | fs | Create / overwrite a file |
| `code_grep` | new | fs | Content search across files |
| `code_glob` | new | fs | Find files by glob pattern |
| `run_command` | new | exec | One-shot host command execution |
| `web_search` + `research_url` | reuse as-is | web | Web research |

**Excluded from Code mode:** the Pyodide sandbox (`run_python` /
`install_package` / `reset_python`), all document writers
(`fs_write_docx/pptx/xlsx/odt/ods/odp/pdf`), non-text readers, `image_search`,
and email. Hiding these is the single biggest context lever (§7).

---

## STEP 1 — Harden existing backend commands (Rust + their current callers)

These two commands already exist and are used by the Chat and Shell tabs. The
hardening improves those tabs too. Done first because the new tools and the
Code tab will rely on the improved behavior. **Self-contained:** the edit
return-type change updates its existing TS callers in this same step, so the
tree compiles at the end.

### 1a. `fs_edit_text` / `fs_edit_text_absolute` (`src-tauri/src/fs_tools/`)

Today: exact substring match, counts occurrences, errors on 0 / >1, else
`replacen(.., 1)`, returns `Result<(), String>`. Good unique-match enforcement,
good guards (binary, oversized, must-exist). Three gaps vs Pi's `edit.ts` /
`edit-diff.ts`:

1. **Add LF normalization before matching.** Normalize both file content and
   `old_str` to `\n` line endings (Pi's `normalizeToLF`). Eliminates silent
   "not found" on CRLF files when the model emits `\n`.
2. **Add a fuzzy fallback** (Pi's `normalizeForFuzzyMatch`). Try exact match
   first; on miss, retry against a normalized view: strip trailing whitespace
   per line, NFKC-normalize, smart quotes → ASCII, Unicode dashes → ASCII
   hyphen, exotic Unicode spaces → regular space. Re-apply the replacement to
   the original using a normalized-line alignment so unique-match semantics are
   preserved. **This is the highest-leverage fix in the whole PR** — it removes
   the most common cause of failed edits (and thus wasted round-trips) on weak
   models.
3. **Return what changed.** Change the signature to
   `Result<EditResult, String>` where `EditResult` carries at least
   `{ first_changed_line: usize, replaced_line_before: String, replaced_line_after: String, used_fuzzy: bool }`.
   Keep it small — this feeds a *compact* confirmation, not a full diff (§7).

Keep the existing 0 / >1 occurrence errors verbatim (they already coach the
model well). The fuzzy pass must also enforce uniqueness on the normalized view.

**Update callers in the same step** (`fs-write.ts`, `shellAwareEditText` +
the chat executor): consume `EditResult` and return a compact confirmation
string, e.g. `Edited {path} (line {n}){fuzzyNote}{pyLintDiag}`. Preserve the
existing `lintPythonIfApplicable` append.

**Tests:** CRLF file + `\n` old_str now succeeds; trailing-whitespace and
smart-quote mismatches now succeed via fuzzy; fuzzy still rejects a non-unique
normalized match; exact match still preferred when available; `EditResult`
fields correct.

### 1b. `fs_read_text` / `fs_read_text_absolute` (`src-tauri/src/fs_tools/`)

Today: errors entirely if the file exceeds `MAX_TEXT_READ_BYTES`; otherwise
returns the whole file. No ranges, no cap, no line numbers. Three changes:

1. **Add optional `offset` (1-indexed start line) and `limit` (max lines)**,
   matching Pi's `read.ts`. Backward compatible — existing callers omit them.
   This is the mechanism that lets the model read a *window* (pairs with
   `code_grep`'s `file:line`).
2. **Truncate instead of erroring on large files.** Replace the hard
   `File too large` error with head-truncation (Pi's `truncateHead` / your
   `truncateCapturedOutput`): return the first N lines/bytes and a
   `… (truncated; M more lines — use offset/limit to read further)` marker.
   The model should always get *something*. (Note: this also changes Chat/Shell
   read behavior from "error" to "truncate" — an intentional global
   improvement.)
3. **Line numbers: deliberately optional, default OFF.** Prepending `cat -n`
   style numbers helps the model reason about location, but risks the model
   copying the `12␉` prefix into a later `old_str` and failing the edit. If
   added, gate behind a param and add a system-prompt note that prefixes are
   not file content. Recommendation: skip for this PR; ranges + truncation
   carry the value.

**Tests:** offset/limit windowing; truncation marker on oversized file (no more
error); backward-compatible read with neither param.

**End of Step 1:** Chat and Shell tabs still work, now with more robust edits
and readable large files. Tree compiles, tests green.

---

## STEP 2 — New backend commands (Rust)

All read-only/exec commands the Code tab needs, built before any TS that calls
them. Register each in the Tauri `invoke_handler`, add the string to
`ipc/commands.ts`, and generate the type under `ipc/gen/`.

### 2a. `run_command_capture`

```
run_command_capture({ command, cwd, timeout_secs })
  -> { stdout, stderr, exit_code, killed, duration_ms }
```

One-shot: spawn a fresh process with `cwd`, capture both streams, enforce the
timeout with a **process-tree kill** (orphaned `npm`/`cargo` children
otherwise linger), respect a cancellation token. No retained state between
calls. (Matches Pi/Codex/Claude Code/OpenCode; the model chains
`cd x && cmd` when it needs directory state.)

### 2b. `code_grep`

Content search rooted at `cwd`. **Not** routed through `run_command` (it must
not trip the risk/approval gate). Use the Rust `grep`/`ignore` crates
(ripgrep's engine) for speed and gitignore handling. Params: `pattern`,
optional `path`, optional `glob`, optional `ignore_case`. Returns matches as
`file:line: <line>`; **caps server-side** at ~50 matches, ~200 chars/line, with
an overflow count. Returning *locations not bodies* is the entire point.

### 2c. `code_glob`

Find files by glob, rooted at `cwd`, gitignore-aware (`ignore` crate). Returns
paths only; caps at ~100, deterministic ordering, overflow count.

**Tests (Rust):** timeout → kill; abort → process-tree kill; exit-code
passthrough; grep cap + overflow + gitignore honored; glob cap + ordering +
gitignore honored.

**End of Step 2:** four backend commands exist and are registered (Step 1's two
hardened, these three new). Nothing in TS calls 2a–2c yet — they compile as
registered-but-unused commands.

---

## STEP 3 — Tool-layer plumbing for Code mode (TS)

Adds the mode and filtering so the registry can expose a Code profile. Must
precede tool registration (the new tools use the `'exec'` category and the
allowlist). **Self-contained:** updates every `ToolContext` construction site
in this step so the tree compiles.

1. **`ToolContext`** (`tools/types.ts`): add required
   `codeMode: boolean` and `codeAutoApprove: boolean` (follows the existing
   required-`shellMode` convention). Update **all** construction sites in the
   same step — `runTurn.ts`, `runEphemeralTurn.ts`, `shell/runShellTurn.ts`,
   `jobs/runner.svelte.ts` — defaulting both to `false`.
2. **Category union**: `'web' | 'fs' | 'email' | 'sandbox' | 'exec'`.
3. **`ToolFilterOpts` + `getToolSchemas` opts**: add `codeMode`,
   `codeAutoApprove` (default `false`).
4. **Allowlist + filter** (`registry.ts`), mirroring the `SHELL_FS_*` idiom:

   ```ts
   const CODE_TOOLS = new Set([
     'fs_read_text', 'fs_list_dir', 'fs_edit_text', 'fs_write_text',
     'code_grep', 'code_glob', 'run_command',
     'web_search', 'research_url',
   ]);
   const shouldIncludeCodeTool = (reg) => CODE_TOOLS.has(reg.schema.function.name);

   function shouldIncludeTool(reg, opts) {
     if (opts.shellMode) return shouldIncludeShellTool(reg, opts);
     if (opts.codeMode)  return shouldIncludeCodeTool(reg);
     return shouldIncludeChatTool(reg, opts);
   }
   ```
5. **Close the leak:** `shouldIncludeChatTool` ends in `return true`, so the new
   `'exec'` category would default *into* Chat mode. Add
   `if (reg.category === 'exec') return false;` to **both**
   `shouldIncludeChatTool` and `shouldIncludeShellTool`.

**Tests:** `codeMode` exposes exactly `CODE_TOOLS`; `'exec'` never appears in
Chat or Shell schemas; existing Chat/Shell schema sets unchanged.

**End of Step 3:** registry understands Code mode. The allowlist references
`code_grep` / `code_glob` / `run_command` by name, which is fine — names in a
`Set` don't need the tools registered yet.

---

## STEP 4 — The three new tools (TS)

Each wraps a Step-2 command and registers via side-effect import in
`tools/index.ts`. The `'exec'` category and allowlist from Step 3 exist; the
backend commands from Step 2 exist.

### 4a. `run_command` (category `'exec'`)
- Params: `command`, optional `timeout_secs`.
- Flow: `classifyShellRisk(command)` → if risky **and** not `codeAutoApprove`,
  surface an approval request and block until resolved (reuse
  `runWithAutoApprove`). On approval/safe, call `run_command_capture` with the
  working dir as `cwd`.
- Output: `truncateCapturedOutput` (last N lines/KB); on truncation write full
  output to a temp file and tell the model the path. Always lead with the
  **exit code** (highest signal, lowest tokens).
- Honor `ctx.signal` for cancellation.

### 4b. `code_grep` (category `'fs'`)
Thin wrapper over the `code_grep` command; pass `ctx.workingDir` as root.
Server already caps; the tool just formats and forwards the overflow note.

### 4c. `code_glob` (category `'fs'`)
Thin wrapper over the `code_glob` command; paths + overflow note.

**Tests:** risk-gate matrix (risky/safe × auto-approve on/off); truncation +
temp-file overflow; abort kills the run; grep/glob formatting and overflow
surfaced; unknown-arg coercion via existing `coerceArgsToSchema`.

**End of Step 4:** all 8 Code tools resolve. They're registered but no tab
sets `codeMode` yet, so they're inert in Chat/Shell (verified by Step 3 tests).

---

## STEP 5 — Code tab: UI, system prompt, settings (TS / Svelte)

Now the mode and tools exist, wire the surface that turns them on.

1. **Route** `src/routes/code/` (follow `shell/[id]`; persist conversations via
   the existing `ConversationWithMessages` IPC).
2. **Working-dir picker** — mandatory; the tab refuses tool calls until a
   project root is set (reuse the dialog plugin). All fs/exec tools resolve
   against it and reject paths escaping it.
3. **`buildCodeSystemPrompt(workingDir)`** — short and code-focused (Pi spirit),
   not the document-oriented chat prompt. Include the **scratchpad convention**:
   encourage writing findings to `NOTES.md`/`PLAN.md` and re-reading slices via
   the existing `fs_write_text`/`fs_read_text` to keep state off the context
   window.
4. **Loop wiring**: construct the turn with `codeMode: true` and the user's
   `codeAutoApprove` setting; reuse the Chat step/tool-card components.
5. **`run_command` approval affordance** in its tool card: approve / deny /
   "approve all this session"; visibly flag that it runs on the host.
6. **Settings → Code**: `codeAutoApprove` (default **off**), default working
   dir, default `run_command` timeout.
7. **Sanity-check context constants**: confirm `PRESERVE_RECENT_TOOL_MESSAGES`
   and `PROTECTED_TURNS` (`context-budget.ts`) and `compactIfNeeded` behave well
   over longer coding turns. The Code tab inherits `fitMessagesToBudget` +
   compaction automatically through the shared loop — no new code.

**End of Step 5:** the Code tab is fully functional end to end.

---

## STEP 6 — Verification

- Full vitest suite green (per-step tests above).
- Manual smoke on a real repo, run **twice** — once with a small local model,
  once with a remote model via llama-toolchest — exercising: grep → ranged read
  → fuzzy edit → `run_command` test cycle, plus an approval prompt on a risky
  command and a truncated-output-to-temp-file read-back.
- Confirm `'exec'` absent from Chat/Shell; confirm large-file read no longer
  errors anywhere.

---

## 7. Keeping context minimal (why the above is shaped this way)

Highest leverage first:

1. **Schema budget** — Code mode exposes **8** tools, not ~28. Every exposed
   tool's JSON schema ships in *every* request; the `CODE_TOOLS` allowlist is
   the biggest single saving, before any work tokens.
2. **Output discipline** — grep returns `file:line` locations, not bodies;
   glob returns paths; reads are windowed (`offset`/`limit`) and truncated;
   `run_command` truncates with temp-file overflow and leads with the exit code.
3. **Compact edit confirmation** — return the changed line / occurrence, *not*
   a full diff. Enough to verify, not enough to bloat.
4. **Fewer failed round-trips** — the edit fuzzy-match fallback (Step 1a) is a
   context optimization as much as a reliability one: every avoided "old_str not
   found" is an avoided extra turn.
5. **Inherited backstops (free)** — `fitMessagesToBudget` + `compactIfNeeded`
   via the shared loop.
6. **Scratchpad convention** — externalize state to disk, re-read slices;
   disproportionately helps small models and stays user-inspectable.

---

## 8. Reuse map

| Need | Existing module |
|---|---|
| Agent loop / iteration | `agent/loop.ts`, `agent/loop/iteration.ts`, `agent/runTurn.ts` |
| Tool registry + filtering | `agent/tools/registry.ts` |
| Tool context / types | `agent/tools/types.ts` |
| File read/write/edit/list | `agent/tools/fs-read.ts`, `fs-write.ts`; Rust `src-tauri/src/fs_tools/` |
| Web research | `agent/tools/web.ts` |
| Context guards | `agent/context-budget.ts`, `agent/compaction.ts` |
| Output truncation | `shell/truncate.ts` (`truncateCapturedOutput`) |
| Shell-risk classifier | `shell/risky-commands.ts` (`classifyShellRisk`) |
| Auto-approve plumbing | `runWithAutoApprove` |
| Arg coercion / fuzzy tool-name recovery | `agent/tools/coerce.ts`, `registry.ts` |
| Python lint-on-edit (keep) | `lintPythonIfApplicable` in `fs-write.ts` |

**Net new:** 1 mode (`codeMode`); 3 tools (`code_grep`, `code_glob`,
`run_command`); 3 Rust commands (`run_command_capture`, `code_grep`,
`code_glob`); hardening of 2 Rust commands (`fs_edit_text`, `fs_read_text`);
1 route; 1 system prompt; settings; tests.

---

## 9. Out of scope (documented future phases — NOT in this PR)

- **Lean checker grounding.** A thin convention or small `check` helper that
  runs the project's own type-checker/linter via `run_command` —
  `tsc --noEmit`, `cargo check`, `ruff`, `mypy`, `go vet` — and feeds back
  deduplicated, top-N, `file:line: message` diagnostics (truncated like
  everything else). Buys ~80% of an LSP's static-error value using only the
  `run_command` tool already built: whole-project, includes dead branches, no
  execution, language-agnostic, synchronous. Misses the navigation half
  (go-to-definition / find-references). The existing `lintPythonIfApplicable`
  edit hook is a working seed of this idea for Python.
- **Full LSP.** Per-language servers as managed child processes over JSON-RPC,
  document sync coupled to the edit tool, async `publishDiagnostics`,
  `lsp_restart`-style supervision. Adds the navigation half and faster
  incremental diagnostics at the cost of heavy sync/lifecycle/per-language/
  resource machinery. Start with one language if pursued.
- **Background jobs** (dev servers): a Crush-style start/poll/kill layer via the
  existing `agent/jobs/runner` + `scheduler`.
- **Research subagent** via `runEphemeralTurn` to keep voluminous fetch output
  off the main thread (context-laundering; same-model in a single-model
  session, so a hygiene win rather than a capability one).

---

## Appendix A — Step 1a signatures: the fuzzy edit

New Cargo dependency: `unicode-normalization` (for NFKC). New module
`src-tauri/src/fs_tools/fuzzy.rs`.

### A.1 Normalization (port these char sets verbatim from Pi)

```rust
/// CRLF / CR → LF. Detect the original ending separately so the write
/// can restore it (return true if any "\r\n" was present).
pub fn normalize_to_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Strip a leading UTF-8 BOM; return (had_bom, rest) so it can be re-prepended.
pub fn strip_bom(s: &str) -> (bool, &str) {
    match s.strip_prefix('\u{FEFF}') { Some(r) => (true, r), None => (false, s) }
}

/// Mirror of Pi's normalizeForFuzzyMatch. Order matters: NFKC first, then
/// per-line trailing-whitespace strip, then the 1:1 char folds.
pub fn normalize_for_fuzzy(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfkc: String = s.nfkc().collect();
    nfkc.split('\n')
        .map(|line| line.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .map(|c| match c {
            // smart single quotes → '
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // smart double quotes → "
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // dashes / minus → -
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            // special spaces → space
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}
```

### A.2 Result type and new command signatures

```rust
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../src/lib/ipc/gen/")]
pub struct EditResult {
    pub first_changed_line: usize, // 1-indexed
    pub line_before: String,       // first original line of the matched region
    pub line_after: String,        // first line of new_str (for the compact confirmation)
    pub used_fuzzy: bool,
}

// signature changes only — body per A.3
pub async fn fs_edit_text(
    workdir: String, rel_path: String, old_str: String, new_str: String,
) -> Result<EditResult, String>;

pub async fn fs_edit_text_absolute(
    path: String, old_str: String, new_str: String,
) -> Result<EditResult, String>;
```

### A.3 Match-and-apply algorithm (non-destructive)

Two passes. The exact pass is byte-precise (handles partial-line edits); the
fuzzy pass is line-windowed (handles whitespace/quote/dash drift, which is
inherently per-line) and **preserves untouched original lines** like Pi.

1. Read file. `(had_bom, body) = strip_bom(&raw)`. Record
   `was_crlf = body.contains("\r\n")`. `content = normalize_to_lf(body)`,
   `old = normalize_to_lf(&old_str)`, `new = normalize_to_lf(&new_str)`.
   Reject empty `old`.
2. **Exact pass:** `n = content.matches(&old).count()`.
   - `n > 1` → existing "appears N times … include more context" error.
   - `n == 1` → replace that one byte range. `used_fuzzy = false`.
   - `n == 0` → fall through to fuzzy.
3. **Fuzzy pass** (only when exact `n == 0`): split `content` and `old` into
   line vectors. Build normalized copies with `normalize_for_fuzzy` applied
   **per line** (so indices align 1:1 with the original line vectors). Slide a
   window of `old_norm.len()` lines over `content_norm`; collect every start
   index where the window equals `old_norm`.
   - 0 → existing "old_str not found" error.
   - `> 1` → "appears N times" error (uniqueness still enforced).
   - exactly 1 at line index `i` → build the new file by concatenating
     `original_lines[0..i]` + `new.lines()` + `original_lines[i + old.len()..]`.
     **Untouched lines are the original bytes**, never the normalized form —
     this is the line-preserving write-back. `used_fuzzy = true`,
     `first_changed_line = i + 1`.
4. If the result equals the input, return Pi's "no changes / identical content"
   error (catches a no-op replacement).
5. `restore_line_endings`: if `was_crlf`, `result.replace('\n', "\r\n")`.
   Re-prepend BOM if `had_bom`. Write. Return `EditResult`.

> Known limitation (acceptable): the fuzzy path matches at line boundaries, so
> a *partial-line* `old_str` that needs fuzzy correction won't match — the
> model retries with line-complete context. The exact path already covers
> precise partial-line edits, so this only affects partial-line + drift, which
> is rare.

The TS callers (`fs-write.ts`) consume `EditResult` and return, e.g.:
`Edited ${path} (line ${first_changed_line})${used_fuzzy ? ' [fuzzy]' : ''}` plus
the existing Python-lint append.

---

## Appendix B — Step 2 command signatures

New Cargo dependencies: `grep` (or `grep-regex` + `grep-searcher`), `ignore`,
`globset` — ripgrep's own crates, so gitignore semantics match `rg`.

### B.1 `run_command_capture`

```rust
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../src/lib/ipc/gen/")]
pub struct RunCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>, // None when killed by signal
    pub killed: bool,           // true on timeout or cancellation
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn run_command_capture(
    command: String,
    cwd: String,
    timeout_secs: Option<u64>,
    command_id: String,         // for cancellation, see note
) -> Result<RunCommandResult, String>;
```

Spawn a fresh shell (`sh -c <command>` / `cmd /C` on Windows) with `cwd`,
capture stdout+stderr, enforce `timeout_secs` with a **process-tree kill**.
**Cancellation:** register the child's PID under `command_id` in a global map
(mirror the existing `shell_kill` PID-tracking prior art), and add a companion
`run_command_cancel(command_id)` command that the tool calls from its
`ctx.signal` abort handler to kill the tree.

### B.2 `code_grep`

```rust
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../src/lib/ipc/gen/")]
pub struct GrepMatch { pub path: String, pub line: u32, pub text: String }

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../src/lib/ipc/gen/")]
pub struct GrepResult { pub matches: Vec<GrepMatch>, pub truncated: bool }

#[tauri::command]
pub async fn code_grep(
    root: String,                 // working dir
    pattern: String,
    path: Option<String>,         // optional subdir scope
    glob: Option<String>,         // optional file filter, e.g. "*.rs"
    ignore_case: Option<bool>,
    max_matches: Option<usize>,   // server cap, default 50
) -> Result<GrepResult, String>;
```

Use `ignore::WalkBuilder` (gitignore-aware by default) + `grep_regex` +
`grep_searcher`. Cap total matches at `max_matches`, clamp each `text` to ~200
chars, set `truncated` when the cap is hit. Never read whole files into the
result.

### B.3 `code_glob`

```rust
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../src/lib/ipc/gen/")]
pub struct GlobResult { pub paths: Vec<String>, pub truncated: bool }

#[tauri::command]
pub async fn code_glob(
    root: String,
    pattern: String,              // e.g. "src/**/*.ts", "**/Cargo.toml"
    max_results: Option<usize>,   // default 100
) -> Result<GlobResult, String>;
```

`ignore::WalkBuilder` for the gitignore-aware walk + `globset::Glob` to filter.
Deterministic ordering (sort paths), `truncated` when capped.

### B.4 Model-facing tool schemas (Step 4 wrappers)

```ts
// run_command
{ name: 'run_command',
  description: 'Run a shell command on the host in the project directory; returns combined output and exit code. One-shot — cwd/env do not persist between calls, so chain with && when needed. Output is truncated; if so, the full output path is given.',
  parameters: { type: 'object', required: ['command'], properties: {
    command: { type: 'string', description: 'The shell command to run.' },
    timeout_secs: { type: 'number', description: 'Optional timeout in seconds.' } } } }

// code_grep
{ name: 'code_grep',
  description: 'Search file CONTENTS across the project. Returns file:line: matched-line locations, not file bodies. Find where something is defined or used, then fs_read_text those lines.',
  parameters: { type: 'object', required: ['pattern'], properties: {
    pattern: { type: 'string', description: 'Text or regular expression.' },
    path: { type: 'string', description: 'Optional subdirectory to limit the search.' },
    glob: { type: 'string', description: 'Optional file filter, e.g. "*.rs".' },
    ignore_case: { type: 'boolean', description: 'Case-insensitive when true.' } } } }

// code_glob
{ name: 'code_glob',
  description: 'Find files by path glob across the project (gitignore-aware). Returns file paths only.',
  parameters: { type: 'object', required: ['pattern'], properties: {
    pattern: { type: 'string', description: 'Glob, e.g. "src/**/*.ts" or "**/Cargo.toml".' } } } }
```
