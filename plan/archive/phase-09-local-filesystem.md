# Phase 9: Local Filesystem & Vision

## Goal

Enable Haruspex to work with local files in a user-selected working directory: read files in many formats (including PDFs, docx, xlsx, and images), create and edit text/markdown/csv/bash/docx/xlsx files, and use the model's vision capability to understand image content. The user opts in by selecting a working directory — with no working directory selected, filesystem tools are unavailable and the app behaves exactly as before.

## Prerequisites

- Phase 5 (agent loop / tool calls) complete
- Phase 6 (web search tools) complete
- Qwen 3.5 9B model already downloaded (it is a vision-language model; we just haven't been using the vision half)

## Deliverables

- **User-testable**: Select a working directory containing PDFs, click the working dir button, ask "summarize these PDFs into a report.md". The model reads the PDFs, generates a markdown report, and writes it to the working directory.
- **User-testable**: Select a directory with images. Ask "describe each image and save descriptions to captions.csv". Model uses vision to analyze images and writes the csv.
- **User-testable**: Ask "read data.csv and create a bash script that extracts the third column". Model reads csv, writes an executable bash script. User reviews and runs it manually.

---

## Design Decisions

These were decided during planning:

| Decision | Choice |
|---|---|
| Vision model | Download `mmproj-F16.gguf` from the same unsloth repo alongside the main weights. Pass `--mmproj` to llama-server. No new model needed. |
| Write formats | Text formats (txt, md, csv, json, bash/sh), plus docx and xlsx via Rust libraries |
| Script execution | **Create only.** Never execute scripts from the model. User runs manually. |
| Working dir scope | **Per-conversation, not persisted.** Each conversation picks its own working dir, reset on new conversation. |
| Destructive ops | **Create and edit only.** Model cannot delete files. User manually deletes what they don't want. |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Frontend (SvelteKit)                                        │
│  • Working dir state (per-conversation, in chat store)      │
│  • Working dir selector button in input area                │
│  • FS tools registered conditionally based on working dir   │
│  • System prompt augmented with working dir path when set   │
└─────────────────────────────────────────────────────────────┘
                            │ invoke('fs_*')
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Rust Backend (Tauri commands)                               │
│  • Path sandboxing (canonicalize + prefix check)            │
│  • Format dispatch (txt/md/csv/pdf/docx/xlsx/image)         │
│  • Size limits, binary rejection                            │
└─────────────────────────────────────────────────────────────┘
                            │
         ┌──────────────────┼──────────────────┐
         ▼                  ▼                  ▼
    tokio::fs          Format libs        Image passthrough
    (read/write)       (pdf, docx...)     (to vision endpoint)
```

---

## Vision Support

### Download & server setup

- Extend the model registry so each model can optionally reference a projector file
- `Qwen3.5-9B-Q4_K_M` and all other Qwen3.5-9B quants get `mmproj: Some("mmproj-F16.gguf")`
- Download flow: after main .gguf finishes, download mmproj into the same models dir
- `server.rs` `start_server`: if model has an mmproj file, pass `--mmproj <path>` to llama-server
- mmproj is ~876 MB — show as a separate progress step in the download wizard

### Sending images to the model

- llama-server's multimodal support uses the OpenAI-compatible message content array format:
  ```json
  {
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
    ]
  }
  ```
- Need to extend `ChatMessage` type in `src/lib/api.ts` to support content arrays
- The `fs_read_image` tool returns a base64 data URL; the agent loop injects this into the next user message content array

---

## Filesystem Tools (Rust / Tauri commands)

All path arguments are resolved relative to the conversation's working directory. Every command canonicalizes the path and verifies it's a descendant of the working dir before any I/O. Symlinks are followed but checked post-resolution.

### Read tools

| Command | Description |
|---|---|
| `fs_list_dir(rel_path)` | List entries in a directory. Returns `[{name, is_dir, size, modified}]`. Default path is working dir root. |
| `fs_read_text(rel_path)` | Read txt/md/csv/json/sh/log/yml/toml/etc. as UTF-8 text. Rejects binary. 1 MB soft limit. |
| `fs_read_pdf(rel_path, pages?)` | Extract text from a PDF. Optional page range (e.g., "1-10"). Returns plain text. Uses `pdf-extract` or `lopdf`. |
| `fs_read_docx(rel_path)` | Extract text from a .docx file. Uses `docx-rs` or similar. |
| `fs_read_xlsx(rel_path, sheet?)` | Extract data from a .xlsx file. Returns CSV-formatted text for simplicity. Uses `calamine` (lightweight, read-only). |
| `fs_read_image(rel_path)` | Return base64 data URL for vision. Supports png/jpg/webp. Size limit to avoid context blow-up (e.g., 4 MB). |

### Write tools

| Command | Description |
|---|---|
| `fs_write_text(rel_path, content, overwrite?)` | Create or overwrite a text file. `overwrite: false` fails if file exists. Parent dirs created automatically. |
| `fs_edit_text(rel_path, old_str, new_str)` | Find & replace in a text file. `old_str` must appear exactly once (otherwise error — prevents ambiguous edits). Mirrors the common LLM file-edit pattern. |
| `fs_write_docx(rel_path, content)` | Create a .docx from simple markdown-ish content (headings, paragraphs, lists, bold/italic). Uses `docx-rs`. |
| `fs_write_xlsx(rel_path, data)` | Create a .xlsx from tabular data `{sheets: [{name, rows: [[cell, ...]]}]}`. Uses `rust_xlsxwriter`. |

### Utility

| Command | Description |
|---|---|
| `fs_file_info(rel_path)` | Get size, modified time, mime type guess. Useful for "does this file exist" checks without reading it. |

### Path sandboxing (critical)

```rust
fn resolve_in_workdir(workdir: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = workdir.join(rel);
    let canonical = candidate.canonicalize()
        .or_else(|_| {
            // For write ops, the file may not exist yet — canonicalize parent + append filename
            let parent = candidate.parent().ok_or("invalid path")?;
            let file = candidate.file_name().ok_or("invalid path")?;
            Ok::<_, String>(parent.canonicalize().map_err(|e| e.to_string())?.join(file))
        })?;
    let workdir_canonical = workdir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&workdir_canonical) {
        return Err("path escapes working directory".into());
    }
    Ok(canonical)
}
```

All FS commands use this helper. No exceptions.

### Size / safety limits

- Text reads: 1 MB max (return error suggesting the model read in chunks if needed)
- PDF reads: 50 MB max file size, 500 pages max extracted
- Image reads: 4 MB max (resized/downscaled for the vision model if larger)
- Write operations: content must be ≤ 10 MB
- Listing: max 500 entries per directory (truncate with notice)

---

## Rust Dependencies

Add to `src-tauri/Cargo.toml`:

| Crate | Purpose |
|---|---|
| `pdf-extract` | PDF text extraction (pure Rust, no external tools) |
| `calamine` | xlsx reading (read-only, lightweight) |
| `docx-rs` (or `docx-rust`) | docx read/write |
| `rust_xlsxwriter` | xlsx writing |
| `base64` (likely already present) | Image encoding for vision |
| `mime_guess` | File type detection for fs_file_info |

All of these are pure Rust — no external tool dependencies that would complicate the sidecar bundling.

---

## Frontend Changes

### Chat store — working directory state

In `src/lib/stores/chat.svelte.ts`:

```typescript
interface Conversation {
  // ... existing fields
  workingDir: string | null;  // NOT persisted to DB for this phase
}
```

- Add `setWorkingDir(path)` and `getWorkingDir()` exports
- When a new conversation is created, `workingDir: null`
- When active conversation changes, UI reflects its working dir

### Agent tools — conditional registration

In `src/lib/agent/tools.ts`:

```typescript
export function getAgentTools(hasWorkingDir: boolean): ToolDefinition[] {
  const tools = [WEB_SEARCH_TOOL, FETCH_URL_TOOL];
  if (hasWorkingDir) {
    tools.push(...FS_TOOLS);
  }
  return tools;
}
```

The agent loop calls `getAgentTools(!!workingDir)` per request. With no working dir, the model is literally unable to call any fs tool because they don't exist in the tool schema.

### Tool execution dispatch

In `src/lib/agent/search.ts` (or a new `src/lib/agent/fs.ts`):

```typescript
export async function executeTool(name: string, args: unknown, signal?: AbortSignal) {
  // existing cases: web_search, fetch_url
  // new cases: fs_list_dir, fs_read_text, fs_read_pdf, ...
  switch (name) {
    case 'fs_read_text':
      return invoke('fs_read_text', { workdir, relPath: args.path });
    // ...
  }
}
```

### Working directory selector UI

New component `src/lib/components/WorkingDirButton.svelte`:
- Button placement: leftmost in the input row (order: WorkingDir → DeepResearch → Mic → Send)
- Icon: folder icon (filled when set, outlined when unset)
- Label: shows last path segment of working dir when set, or "No folder" when unset
- Click: opens Tauri dialog plugin's `open({ directory: true })` to pick a folder
- Clear button: small × next to the path when set, unsets the working dir
- Tooltip explains what working dir does

Uses `@tauri-apps/plugin-dialog` (already a dependency).

### System prompt augmentation

When a working dir is set, prepend a section to the system prompt:

```
FILESYSTEM ACCESS:
- A working directory is active: {path}
- You have filesystem tools to read and write files in this directory.
- Use fs_list_dir first to see what files are available.
- Use the appropriate read tool for each format (fs_read_pdf for PDFs, fs_read_docx for Word docs, etc.)
- Only use filesystem tools when the user asks you to work with files. Do not proactively read files.
- You can create text files, markdown, csv, json, bash scripts, docx, and xlsx files.
- You cannot delete or move files. Ask the user to do that manually.
- When creating bash scripts, include a shebang and note to the user that they must make it executable and run it themselves.
```

When no working dir is set, no filesystem mention in the prompt at all — the model doesn't know the feature exists.

---

## File Structure Changes

### New files

```
src-tauri/src/
├── fs_tools.rs          # NEW: all fs_* Tauri commands
├── fs_formats/          # NEW: format-specific read/write
│   ├── mod.rs
│   ├── pdf.rs
│   ├── docx.rs
│   └── xlsx.rs

src/lib/
├── agent/
│   └── fs.ts            # NEW: executeTool dispatch for fs_*
├── components/
│   └── WorkingDirButton.svelte   # NEW

plan/
└── phase-09-local-filesystem.md  # this file
```

### Modified files

- `src-tauri/src/lib.rs` — register new fs_* commands
- `src-tauri/src/models.rs` — add mmproj field to ModelInfo, download mmproj alongside main weights
- `src-tauri/src/server.rs` — pass `--mmproj` flag when model has a projector
- `src-tauri/Cargo.toml` — add pdf-extract, calamine, docx-rs, rust_xlsxwriter, mime_guess
- `src/lib/api.ts` — extend ChatMessage to support content arrays (text + image)
- `src/lib/agent/tools.ts` — conditional tool registration via getAgentTools()
- `src/lib/agent/loop.ts` — pass working dir to tool execution, handle image content in messages
- `src/lib/agent/search.ts` — route fs_* tool calls to the new dispatcher
- `src/lib/stores/chat.svelte.ts` — working dir per conversation, system prompt augmentation
- `src/routes/+page.svelte` — add WorkingDirButton to input row

---

## Implementation Order

Build and test in small increments so each step is verifiable:

1. **Step 1 — mmproj download & server flag**
   - Add `mmproj: Option<String>` to ModelInfo
   - Download mmproj alongside main weights
   - Pass `--mmproj` to llama-server
   - Test: verify llama-server logs show multimodal capability loaded
   - No frontend changes yet

2. **Step 2 — Image passing via API**
   - Extend ChatMessage type for content arrays
   - Build a test harness: manually add an image to a message and verify the model can describe it
   - No UI yet

3. **Step 3 — Working directory state & UI**
   - Add workingDir to Conversation
   - Create WorkingDirButton with folder picker
   - Wire up the button to set/clear working dir
   - No tools yet — just the UI state
   - Test: picking a folder shows the last segment in the button

4. **Step 4 — Path sandboxing helper**
   - Implement `resolve_in_workdir` in Rust
   - Unit tests for escape attempts (../, absolute paths, symlinks)
   - No tools wired yet

5. **Step 5 — Basic text read/write tools**
   - fs_list_dir, fs_read_text, fs_write_text, fs_edit_text
   - Register conditionally based on working dir
   - Update agent loop to dispatch fs_* calls
   - Update system prompt
   - Test: "create hello.md with 'Hello world'", "read it back", "change 'world' to 'there'"

6. **Step 6 — PDF reading**
   - Add pdf-extract dependency
   - fs_read_pdf with page range support
   - Test: drop a PDF in the working dir, ask for a summary

7. **Step 7 — docx / xlsx read**
   - fs_read_docx via docx-rs
   - fs_read_xlsx via calamine (returns CSV text)
   - Test: read a Word doc and a spreadsheet, summarize

8. **Step 8 — Image read + vision**
   - fs_read_image returns base64 data URL
   - Agent loop injects image into next user message as image_url content
   - Test: "describe image.jpg", "what's in these photos", etc.

9. **Step 9 — docx / xlsx write**
   - fs_write_docx (simple markdown → docx)
   - fs_write_xlsx (rows → spreadsheet)
   - Test: "create a report.docx with sections X, Y, Z", "make a spreadsheet with this data"

10. **Step 10 — Polish**
    - Progress indicators when reading large files
    - Better error messages for size limits
    - File listing in the chat UI when working dir is selected (optional nice-to-have)
    - System prompt tuning based on test runs

---

## Security Considerations

1. **Path escape** — every path canonicalized and prefix-checked against working dir
2. **Symlinks** — followed then checked; a symlink pointing outside the working dir is rejected
3. **Binary writes** — write tools only accept UTF-8 strings or structured data, not raw bytes
4. **No execution** — explicitly no tool to run scripts or commands
5. **No delete** — explicitly no tool to remove files
6. **Size limits** — prevent the model from reading huge files into context and blowing it up
7. **Working dir opt-in** — user must actively pick a directory; default is no filesystem access at all
8. **Tool gating** — fs tools are literally absent from the tool schema when no working dir is set, not just gated by a flag the model could try to bypass

---

## Open Questions / Things to Watch

- **PDF extraction quality**: `pdf-extract` handles common PDFs well but may struggle with scanned PDFs (no text layer). Should we fall back to treating pages as images and using vision? Yes.
- **Docx writing library choice**: `docx-rs` vs `docx-rust` — use docx-rs
- **Image resizing**: if a user drops a 20 MB photo, we should downscale it before sending to the vision model (context budget). Use the `image` crate. yes let's do that. 
- **Vision accuracy**: Qwen3.5 vision performance on document images (screenshots, charts, diagrams) needs testing — may need specific prompting guidance.
- **Multi-image requests**: Can the model handle multiple images in one message? llama-server supports it but may have a practical limit.

---

## Verification

1. `cargo test` — all existing tests pass, new tests for `resolve_in_workdir` path escape handling
2. `cargo clippy` — zero warnings
3. `npm run check` — TypeScript/Svelte checks pass
4. Manual test matrix:
   - [ ] Download Qwen3.5-9B model → verify mmproj downloads too
   - [ ] Start app with no working dir → verify no fs tools offered, no system prompt mention
   - [ ] Pick a working dir → verify tools appear and system prompt updates
   - [ ] Create hello.md → read back → edit → verify persistence on disk
   - [ ] Drop a PDF → ask for summary → verify it reads
   - [ ] Drop a docx → ask for summary → verify it reads
   - [ ] Drop an xlsx → ask for data analysis → verify it reads
   - [ ] Drop images → ask to describe each → verify vision works
   - [ ] Ask to create a docx report → verify valid output
   - [ ] Ask to create an xlsx spreadsheet → verify valid output
   - [ ] Ask to create a bash script → verify file is created (not executed)
   - [ ] Path escape attempt: tell the model "read ../secret.txt" → verify rejection
   - [ ] Switch conversations → verify working dir resets per conversation
   - [ ] No working dir + ask to read a file → verify model says it can't without a working dir
