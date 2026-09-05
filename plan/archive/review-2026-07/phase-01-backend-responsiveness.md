# Phase 01 — Backend responsiveness

**Commit scope:** `perf(db)` / `perf(tts)` · **Language:** Rust + 2-line Svelte deletion · **Depends on:** nothing

Three independent fixes bundled because they're all "stop doing work on the
wrong thread / at the wrong time."

---

## 1. Make every DB command async via `spawn_blocking`

**Problem.** All ~40 handlers in `src-tauri/src/db/commands.rs` are sync
`pub fn #[tauri::command]`s — in Tauri 2.x these run on the main thread and
stall WebKitGTK (the project's documented gotcha, previously hit with
arboard). Worst case: `db_get_conversation` (`commands.rs:11` →
`conversations.rs:29`) deserializes the full `steps` column (base64 images,
HTML plot bodies — schema comment `db/mod.rs:52-56`) inline on the UI thread.
`db_save_message` (`commands.rs:28`) runs three statements per committed turn.

**Fix.** `Database` is `Clone` (shared `Arc<Mutex<Connection>>`,
`db/mod.rs:248-249`), so:

1. Add one helper at the top of `db/commands.rs`:

   ```rust
   async fn on_pool<T, F>(db: Database, f: F) -> Result<T, String>
   where
       T: Send + 'static,
       F: FnOnce(Database) -> Result<T, String> + Send + 'static,
   {
       tauri::async_runtime::spawn_blocking(move || f(db))
           .await
           .map_err(|e| format!("db task panicked: {e}"))?
   }
   ```

2. Convert **every** handler in the file mechanically:

   ```rust
   // before
   pub fn db_get_conversation(state: State<'_, Database>, id: String) -> Result<..., String> {
       state.get_conversation(&id)
   }
   // after
   pub async fn db_get_conversation(state: State<'_, Database>, id: String) -> Result<..., String> {
       let db = state.inner().clone();
       on_pool(db, move |db| db.get_conversation(&id)).await
   }
   ```

   Clone the handle **before** the await (no `State` borrow across await
   points). All handlers already return `Result<_, String>`, which async
   commands with `State` require — no signature surprises.

3. Scope is `db/commands.rs` only. Do not touch the `Database` method bodies
   in `conversations.rs`/`jobs.rs`/etc. — they stay sync and run inside the
   blocking task. No frontend changes: `invoke()` is already promise-based.

## 2. `PRAGMA synchronous=NORMAL`

Add to the existing pragma batch at `db/mod.rs:266-270` (currently WAL +
foreign_keys + busy_timeout). Under WAL, NORMAL is crash-safe and cuts fsyncs
on the per-turn `save_message` path.

## 3. Stop eagerly spawning the koko TTS sidecar at launch

`src/routes/+layout.svelte` calls `invoke('tts_initialize')` unconditionally
on mount in **both** startup branches (remote-mode branch ~line 151, local
branch ~line 169 — the two `// Eagerly start TTS` / `// TTS is still local`
call sites). Meanwhile `src/lib/audio/ttsControl.svelte.ts:39-43` already
lazy-initializes (`tts_is_initialized` → `tts_initialize`) on first playback.

**Fix:** delete both eager `invoke('tts_initialize')` lines. Nothing else.
The SpeakerButton and F3 hotkey both route through `toggleTts`, which hits
the lazy path. First-playback latency grows by the koko boot time — accepted;
the tradeoff is no koko process + voice-data RAM for users who never use TTS.

---

## Tests & acceptance

- `cargo test` + clippy `--all-targets -D warnings` green.
- Existing `db/` unit tests unchanged (they test `Database` methods, not the
  command wrappers).
- Manual: open a conversation containing plot/image artifacts — UI stays
  responsive while it loads. Send a chat turn — no main-thread jank at commit.
- Manual: launch app, `pgrep -f koko` → empty. Press F3 on a reply → koko
  spawns, speech plays. Toggle inference backend Remote→Local → still no koko
  until first TTS use.
