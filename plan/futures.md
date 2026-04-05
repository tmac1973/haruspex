# Future Ideas

A parking lot for features and improvements to consider in future phases,
after phase 9 (local filesystem & vision) is merged. Nothing here is
committed — treat as brainstorming to revisit during planning sessions.

---

## Filesystem & documents

### ~~PDF generation (`fs_write_pdf`)~~ — DONE
Added late in phase 9 using printpdf 0.9. US Letter, markdown-style
headings, word wrap, pagination. See commit `5294efa`.

### Richer PDF generation
The initial `fs_write_pdf` handles text, headings, and pagination but
does not support:
- Tables (needed for structured reports — invoices, comparisons)
- Bullet/numbered lists with indentation
- Embedded images (logos, charts, photos)
- Custom fonts beyond Helvetica built-in
- Footers / page numbers
- Links and table of contents
Would require extending `build_pdf` with a real layout engine. Consider
if users start asking for invoices, letterheads, or multi-column layouts.

### File deletion and moving
Phase 9 is create + edit only. If real use cases come up where the model
needs to clean up intermediate files or reorganize a working dir:
- `fs_delete_file(path)` with per-call confirmation dialog
- `fs_move_file(from, to)` — same sandbox, no confirmation needed
- Keep them gated behind a setting that users opt into per conversation

### Script execution
Currently the model creates bash scripts but never runs them. A controlled
execution tool:
- `fs_run_script(path)` with a confirmation dialog showing the full script
- Sandbox via working dir + resource limits (cpu time, memory, no network)
- Capture stdout/stderr/exit code as the tool result
- Risk is real — opt-in per conversation, warn loudly

### PDF annotation / form filling
With PDFium already integrated for reading, it supports writing too:
- Fill AcroForm fields in place
- Add annotations, highlights, comments
- Save as a new file (never overwrite the source)
- Useful for tax forms, applications, legal docs

### Dictation into files
"Dictate notes.md" would combine the existing whisper sidecar with the
filesystem tools:
- Voice recording → whisper transcription → fs_write_text or append
- New tool `fs_append_text` would be needed (phase 9 only has write/edit)
- Could also support live transcription with auto-save

### Per-turn image budget display
Users can't currently see how close they are to the image context limit
for vision requests. A small indicator next to the context usage badge
showing "3/6 images this turn" would help them understand when
`fs_read_pdf_pages` will reject additional calls.

---

## Model & inference

### Image generation
A new sidecar for text-to-image (Stable Diffusion, Flux, etc.):
- Another `stable-diffusion.cpp` style sidecar
- New tool `generate_image(prompt)` with output written to working dir
- Would need GPU memory accounting — can't run alongside the LLM on
  most cards without evicting the LLM from VRAM
- Probably warrants its own phase given the complexity (model management,
  samplers, lora support, etc.)

### Model hot-swap
Currently switching models requires restarting the server. Would be nice to:
- Swap between Q4 and Q6 variants without a full restart
- Swap between text-only and VL variants mid-conversation
- Keep the KV cache warm between swaps where possible
- Surface as a dropdown in the toolbar

### Multiple model sessions
Run two models simultaneously for specialized tasks:
- One small/fast model for tool calls, one large/capable for final answers
- Or: one VL model for image tasks, one text model for everything else
- Routing logic decides which model handles each request
- Would need careful VRAM budgeting

### Grammar-constrained output
llama-server supports GBNF grammars for structured output. Could use this
for reliable JSON tool-call extraction on models that struggle with it,
or for things like "extract all invoice line items as JSON".

---

## UI & UX

### Tool permissions panel
Per-conversation toggle for individual tools:
- Disable web_search when you only want local answers
- Disable specific fs_write_* tools for read-only sessions
- Show disabled tools greyed out in the agent's schema so the model
  knows they exist but can't call them
- Remember per-conversation settings

### Working directory persistence option
Phase 9 chose session-only per-conversation. An opt-in setting could
persist the working dir across app restarts per conversation, stored
in SQLite alongside the conversation. Tradeoff: security vs convenience.

### Conversation export
Export a conversation as:
- Markdown (transcript with think blocks collapsed)
- JSON (full structured data including tool calls)
- PDF (once `fs_write_pdf` exists)
- HTML (for sharing)
Useful for bug reports and record-keeping.

### Search within conversations
Full-text search across all saved conversations using SQLite FTS5.
Currently the sidebar just shows conversation titles.

### Pinned conversations
Pin important conversations to the top of the sidebar instead of the
chronological ordering.

### Message reactions / marking
Mark individual assistant messages as "good" / "bad" / "reference".
Could feed into future fine-tuning datasets or just help users find
answers they liked.

---

## Infrastructure

### Auto-update
Tauri has a built-in updater that checks a manifest URL and applies
incremental updates. Currently users have to manually download new
releases. Adding the updater:
- Generate update manifests in the release workflow
- Sign with a private key (public key shipped in the app)
- Check at startup with a "update available" notification
- User confirms before downloading/installing

### Telemetry opt-in
Anonymous crash reports (with the App log tab output) sent to a public
endpoint. Strictly opt-in, default off, clear "what we collect" dialog.
Helps triage real-world crashes without asking users to manually paste logs.

### Model registry beyond Qwen
Support for:
- Llama 3.x variants
- Mistral / Mixtral
- Gemma
- Phi
- Custom GGUF URLs (for users who want to bring their own)
Each model would need its own prompt template / thinking config quirks.

### Sidecar health dashboard
A dedicated page (like settings) showing real-time sidecar status:
- LLM: status, current model, context usage, tokens/sec, last error
- TTS: status, queue depth
- Whisper: status, last transcription time
- Disk usage for models and conversations
Useful when something goes wrong.

---

## Security & privacy

### Working directory allowlist
Instead of per-conversation dir selection, maintain a global allowlist
of directories the model is ever allowed to touch. Prevents accidental
selection of `~` or `/`.

### Network isolation mode
A setting that blocks all outbound network for a conversation except
the model server itself. Disables web_search and fetch_url. Useful
for sensitive work.

### Redacted log export
The Copy-all button in the log viewer already helps with bug reports,
but it copies everything as-is. A "copy redacted" option that strips
file paths, usernames, API keys, and IPs before copying would be
safer for public bug reports.

---

## Testing & quality

### Integration tests
Currently we have Rust unit tests (58) and frontend unit tests (60),
but no end-to-end tests that exercise the agent loop + tools + real
model. A small test suite that:
- Starts the app with a tiny model
- Creates a test working dir with fixture files
- Sends fixed prompts and asserts on tool calls / final content
- Runs in CI against a cached small model
Would catch regressions in the agent loop that unit tests miss.

### Benchmark suite
Track model performance over time on a small set of tasks:
- PDF form reading accuracy (our W-2 test case)
- Web search quality (did it find a good source?)
- Tool call success rate
- Response latency
Compare across model variants and quant levels to inform recommendations.
