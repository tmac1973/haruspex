# Phase 05 — Atomic Writes in the Rust Filesystem Layer

**Depends on:** nothing in this project (independent of Phases 01-04) ·
**Enables:** nothing downstream; establishes the durability floor

## Goal

Every write in `src-tauri/src/fs_tools/` is a bare `fs::write`, which is
`File::create` (`O_WRONLY|O_CREAT|O_TRUNC`) followed by `write_all`. The target
file is truncated to zero the instant the write begins, **before** any new bytes
land — so a write that fails partway destroys the previously-good file and leaves
a prefix or an empty file in its place. This phase makes writes atomic via a
sibling temp file and a rename, so a failed write leaves the original untouched.
`write_bytes_to_workdir` is shared by every writer in the module (text, pdf,
docx, xlsx, odt, pptx, odp), so one change covers them all.

Numbered after Phases 01-04 by value ordering, not dependency: it has no
prerequisites and could be implemented first if preferred.

## Files touched

- `src-tauri/src/fs_tools/path.rs` — make `write_bytes_to_workdir` (line 349)
  atomic; make `edit_text_at`'s write-back (line 323) use the same helper.
- `src-tauri/src/fs_tools/absolute.rs` — make `fs_write_text_absolute` (line 177)
  atomic.
- `src-tauri/src/fs_tools/path.rs` tests (existing `mod tests`, line 506) — new
  atomicity cases.
- `src-tauri/src/fs_tools/absolute.rs` tests (existing `mod tests`, line 206).
- **Conditionally** — the directory-listing site backing `fs_list_dir`, only if
  Step 9's check shows a transient temp file is visible to it. Expected to need
  no change; listed so the inventory is complete if it does.

## Steps

1. In `path.rs`, add a private helper next to `write_bytes_to_workdir`:
   ```rust
   /// Write `bytes` to `target` atomically: stage in a sibling temp file, then
   /// rename over the target. A failed or interrupted write leaves `target`
   /// untouched rather than truncated.
   async fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), String> { … }
   ```
   Stage the temp file in the **same directory** as the target so the rename is
   within one filesystem and therefore atomic — a temp file in `/tmp` would make
   the rename a cross-device copy and lose the guarantee.
2. Name the temp file so it cannot collide and cannot be mistaken for user
   content: prefix with a dot, include the target's file name, and append a
   counter — e.g. `.haruspex-<filename>-<n>.tmp`. The target filename is what
   actually prevents collisions between concurrent writes to *different* targets,
   which is the case the tests exercise; the counter guards the narrower case of
   two writes racing on the same target within one process. Use a
   `static AtomicU64` with `fetch_add(1, Ordering::Relaxed)`. Do not claim
   determinism from it — `cargo test` runs tests in parallel threads, so the
   counter value depends on scheduling. Tests must assert that no `.tmp` file
   *remains*, never that a specific temp name was used.
3. Clean up the temp file if the write fails. On any error from
   `fs::write`/`fs::rename`, attempt `fs::remove_file(&tmp)` and ignore its
   result, then return the original error — the caller must see the real failure,
   not a cleanup failure.
4. Do **not** `fsync`. The threat model is a failed write destroying a good file,
   not power loss; `sync_all` on the temp plus the parent directory costs a
   syscall round-trip per write and an agent run writes many files. Record this
   as a deliberate decision in the helper's doc comment so it is not "fixed"
   later by mistake.
5. Change `write_bytes_to_workdir` (line 349) to keep its existing
   `create_dir_all` for the parent, then delegate to `write_atomic`. Its
   signature and error strings stay the same, so no caller changes — this is what
   makes the fix reach every writer in the module at once.
6. Change `edit_text_at` (line 323) to write back through the same helper.
   `fs_edit_text` reads the whole file and rewrites it, so an interrupted write
   there destroys the original just as badly.
7. Change `fs_write_text_absolute` (`absolute.rs:177`) to use the helper.
   Confirm the helper is reachable from that module — either widen it to
   `pub(super)` in `path.rs` or move it to a shared location; prefer
   `pub(super)` in `path.rs`, matching how `write_bytes_to_workdir` is already
   exposed.
8. Check the 10 MB size cap (`path.rs:193`, enforced at `text.rs:46-52`) still
   applies before staging, so an oversized write is rejected without creating a
   temp file at all.
9. Confirm no code elsewhere globs the target directory in a way that would now
   see a transient `.tmp` file. In particular check `fs_list_dir` and the
   guided-planning `ensureWritten` check, which lists and reads the plan
   directory — a `.tmp` file appearing mid-write must not be mistaken for a phase
   file. If either does surface it, filter at the listing site: skip entries
   whose file name starts with `.haruspex-` and ends with `.tmp`. Do not rename
   the temp file to dodge the filter, and do not make the listing skip all
   dotfiles — that would hide legitimate user files the tool is expected to
   report.

## Build gate

```bash
cd src-tauri
cargo test
cargo clippy
cargo fmt -- --check
```

Plus the frontend gates, since nothing in TypeScript changes but CI runs them:

```bash
npm run check
npm run test
```

## Test plan

Automated (Rust, in the existing `mod tests` blocks):

- Writing to a **new** path creates it with exactly the given bytes.
- Writing to an **existing** path replaces it with exactly the new bytes.
- **The atomicity property:** a write that fails leaves the original file
  byte-identical. Force the failure by making the rename target un-writable (e.g.
  a read-only parent directory), then assert the original content is intact —
  this is the test that fails against current `main`, where `fs::write` has
  already truncated.
- No `.tmp` file remains in the directory after either a successful or a failed
  write.
- Two concurrent writes to *different* paths in the same directory both succeed
  and do not collide on temp names.
- The existing `path.rs` and `absolute.rs` test suites pass unmodified.

Manual:

- Run a guided-planning job and confirm plan files are written normally and no
  `.tmp` files linger in the plan directory.
- Confirm a binary writer still works end to end (ask the app to write a PDF),
  since `write_bytes_to_workdir` is shared.

## Commit

```
fix(fs): write files atomically via temp file and rename

Every write in fs_tools was a bare fs::write — File::create with O_TRUNC
followed by write_all — so the target was truncated to zero before any new
bytes landed. A write that failed partway destroyed the previously-good
file and left a prefix or an empty file behind.

Stage writes in a sibling temp file and rename over the target, so a failed
write leaves the original untouched. write_bytes_to_workdir is shared by
every writer in the module, so text, pdf, docx, xlsx, odt, pptx and odp all
inherit the fix. No fsync: the threat is a failed write, not power loss.
```

## Rollback

Revert the commit. Contained entirely within the Rust fs layer with no signature
or error-string changes, so nothing in TypeScript is affected either way. Safe to
leave partially applied — converting `write_bytes_to_workdir` alone already
covers every workdir writer, with `edit_text_at` and the absolute path following
independently.
