# Phase 1 — Session storage

**Depends on:** — · **Guide:** none (no user-visible change; label `no-docs`)

## Goal

A `code_sessions` table and the Tauri commands to list, create, load, save,
rename, delete and fork sessions. Nothing reads it yet.

## Schema (`src-tauri/src/db/mod.rs` migrate, new `db/code_sessions.rs`)

```sql
CREATE TABLE IF NOT EXISTS code_sessions (
    id TEXT PRIMARY KEY,              -- uuid
    title TEXT NOT NULL,              -- '' until the first turn names it
    root TEXT NOT NULL,               -- project folder, fixed for life
    backend TEXT,                     -- JSON BackendOverride, NULL = global
    reasoning_effort TEXT,            -- NULL = global
    thread TEXT NOT NULL,             -- CodeSessionSnapshot JSON
    forked_from TEXT,                 -- source session id (no FK: source may be deleted)
    forked_at INTEGER,                -- message index in the source
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_sessions_root ON code_sessions(root, updated_at);
```

The thread stays a JSON blob rather than message rows: the snapshot carries
index-keyed sidecars (steps, stats, stops) that the `messages` table can't hold,
and nothing queries inside a thread. Fork copies a prefix in Rust.

`shell_code_sessions` is left alone here; phase 8 drops it.

## Commands (`db/commands.rs`, registered in `lib.rs`)

| Command | Notes |
|---|---|
| `code_session_list` | Summaries only (`id, title, root, updated_at, forked_from`) — never the thread |
| `code_session_create { root, backend?, effort? }` | Canonicalizes `root`, errors if not a directory |
| `code_session_load { id }` | Full row |
| `code_session_save { id, thread, title? }` | Bumps `updated_at` |
| `code_session_update_meta { id, patch }` | Header edits without rewriting the thread. `patch` fields: absent = unchanged, `null` = back to global, value = set (Tauri can't tell an absent arg from `null`, hence the object). Doesn't bump `updated_at`. |
| `code_session_delete { id }` | |
| `code_session_fork { id, at }` | New row; thread truncated to messages `[0, at)` with sidecars filtered to those indices; title `"<title> (fork)"` |

Fork lives in Rust so the truncation and sidecar filtering are unit-tested in
one place; it parses the snapshot just enough to slice it (version check,
`messages` + the four index-keyed maps).

## TS

- Move `src/lib/shell/codeSession.ts` → `src/lib/code/session.ts` (keep a
  re-export until phase 8 removes the shell use). Bump nothing; the shape is
  unchanged.
- `#[ts(export)]` the summary + row structs; run `./scripts/export-ipc-types.sh`.
- `src/lib/code/db.ts`: thin typed wrappers.

## Tests

- Rust: create/list/load/save/delete roundtrip; fork at 0, mid, end; fork of a
  snapshot with sidecars at indices past `at` drops them; bad version → error.
- TS: wrapper arg shapes (mocked `invoke`).

## Done when

Commands exist, are typed, tested, and unused.

## As built (9c3fa72)

- `code/db.ts` wrappers throw instead of logging and returning a fallback, so the
  store can tell when a save failed.
- Create writes a valid empty snapshot. A fork at 0 yields empty `messages`,
  which `decodeCodeSession` reads as `null` — see phase 4.
- Ids are v4 UUIDs from `ring`; list order is `updated_at DESC`.
- Root uses plain `canonicalize` (`\\?\` on Windows) — revisit in phase 10.
