# Phase 08 — Dead surface pruning & constants guard

**Commit scope:** `chore(ipc)` / `chore(email)` · **Language:** Rust + TS + one script · **Depends on:** nothing

---

## 1. Remove five dead IPC commands

Verified: these are registered in `lib.rs` and present in the generated
`src/lib/ipc/commands.ts` name map, but invoked nowhere in the frontend:

| Command | `lib.rs` registration |
| --- | --- |
| `get_llama_crash_log_path` | `:107` |
| `is_recording` | `:135` |
| `stop_whisper` | `:139` |
| `tts_list_voices` | `:148` |
| `shell_get_last_command` | `:235` |

For each: remove from `generate_handler!`; if the underlying `fn` has no
other Rust callers, delete it and its `#[tauri::command]` attribute; if it
does (e.g. an internal helper path), keep the fn and drop only the attribute
+ registration. Then regenerate/update `src/lib/ipc/commands.ts` and confirm
`node scripts/check-ipc.mjs` passes — the guard is the reason this cleanup is
safe.

`shell_get_last_command` appears in maintenance.md §11b's command table —
update that table in the same PR.

## 2. Hide the email `sendEnabled` toggle

SMTP send is a deliberate Phase-10.1 stub (`smtp_client.rs:76` returns
"not available" unconditionally; `send_email` is not even registered in
`lib.rs`), but `EmailAccountAuth.sendEnabled` (`auth.rs:52`) is exposed as a
form toggle that drives nothing.

- Remove the toggle from `EmailAccountForm.svelte`. Keep the settings field
  and the Rust struct field for forward-compat (existing settings blobs may
  contain it).
- Add a one-line comment at the field referencing the stub, so the toggle
  returns in the PR that ships SMTP.

## 3. Ports drift-check script

`src/lib/ports.ts` documents that `PORTS`/`LOOPBACK` are hand-synced with
`src-tauri/src/sidecar_utils.rs` ("no codegen across the IPC boundary").
Guard it the same way command names are guarded:

- New `scripts/check-constants.mjs`: regex-parse `PORTS.{llama,whisper,tts}`
  + `LOOPBACK` from `src/lib/ports.ts` and the `ports` module constants +
  loopback const from `src-tauri/src/sidecar_utils.rs`; exit non-zero with a
  clear diff message on mismatch.
- Wire it wherever `check-ipc.mjs` runs (same npm script and the same CI
  step) so drift fails CI, not a user.

**Scope note (verified, do not expand):** context-size is *not* a hand-sync —
`server/mod.rs:53` documents that the user-facing default lives in TS
(`settings.ts:408`) and the Rust side requires the param. No check needed.

---

## Tests & acceptance

- `cargo clippy --all-targets -- -D warnings` (this is exactly where dead-fn
  warnings would appear) + `cargo test`.
- `node scripts/check-ipc.mjs` and `node scripts/check-constants.mjs` pass;
  temporarily editing a port makes check-constants fail (verify once, revert).
- `npm run check` proves no TS references to the removed command names.
- Manual: email account form no longer shows a send toggle; voice input,
  TTS, and shell "submit to LLM" all still work (they never used the removed
  commands — this confirms it).
