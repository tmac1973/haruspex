# Phase 04 — Update in place: stage, swap, commit, roll back

**Depends on:** Phase 02 (the manifest and its `package_files`) · **Enables:**
Phase 05 (the UI drives these commands)

## Goal

Rust commands that install the current pin next to a running server, swap it in
while keeping every piece of user state in the folder, and undo the swap if
needed. The frontend owns the sequence (stage, stop, swap, setup steps,
handshake, commit or roll back) because the setup steps and the handshake
already run from there.

## Files touched

- `src-tauri/src/integrations/mcp/install.rs` — `McpInstaller::stage_update`,
  `swap_update`, `commit_update`, `rollback_update`, `recover_interrupted`;
  `PREVIOUS_SUFFIX = ".previous"`; `uninstall` also removes `<id>.previous`.
- `src-tauri/src/integrations/mcp/process.rs` — a per-server in-flight call
  counter in `McpSupervisor::call_tool` (:242), decremented on every exit
  path, and `McpSupervisor::calls_in_flight(id)`.
- `src-tauri/src/integrations/mcp/commands.rs` — commands
  `mcp_update_stage(entry_id, server_id, proxy)`,
  `mcp_update_swap(server_id)`, `mcp_update_commit(server_id)`,
  `mcp_calls_in_flight(server_id) -> u32`,
  `mcp_update_rollback(server_id)`, `mcp_update_recover() -> Vec<String>`
  (ids rolled back), `mcp_existing_dirs(paths: Vec<String>) -> Vec<String>`.
- `src-tauri/src/lib.rs` — register them.
- `src/lib/ipc/gen/*` — regenerated if any type changes.

## Steps

1. User state = every top-level name in a server folder that is not in its
   manifest's `package_files`.
2. In-flight counter: `McpSupervisor::call_tool` increments the server's
   count on entry and decrements it through a guard type, so an error, an
   early return or a panic still decrements. Today the only caller of
   `McpSupervisor::call_tool` outside tests is the `mcp_call_tool` command
   (check with `grep -rn '\.call_tool(' src-tauri/src`), and every frontend
   path — chat turns, jobs, Remote control — reaches tools through that
   command, so all of them are counted.
3. `stage_update(app, entry, server_id, proxy)`: the server folder must exist.
   Install into `<id>.installing` exactly as `install()` does (same progress
   events, same cancellation) and write the new manifest into it. The running
   server is not touched.
4. `swap_update(server_id)`: refuse if staging is missing. The caller has
   checked the in-flight count and stopped the server (Phase 05, step 4c).
   a. move each user-state entry of `<id>` (by the *old* manifest) into
      staging; on failure, move the moved ones back and return the error;
   b. remove a stale `<id>.previous`, then rename `<id>` to `<id>.previous`;
      on failure, move all user state back into `<id>` and return the error;
   c. rename staging to `<id>`; on failure, rename `<id>.previous` back to
      `<id>`, move the user state back into it, and return the error.
   On any failure the staging folder is left for the caller to clear with
   `rollback_update`, which removes it.
5. `commit_update(server_id)`: remove `<id>.previous`.
6. `rollback_update(server_id)`: if `<id>.previous` exists, move every
   user-state entry of `<id>` (by the *new* manifest) into `<id>.previous`,
   remove `<id>`, rename `<id>.previous` to `<id>`. Always remove
   `<id>.installing`. User state created during the update (for example a newly
   downloaded Playwright browser) moves back too.
7. `recover_interrupted()`: for each `<id>.previous` in `servers_root`, run
   `rollback_update`; remove every stale `<id>.installing`. Return the rolled
   back ids.
8. `mcp_existing_dirs` returns the given paths that are existing directories.
9. Log each step with `info!`, ids only.

## Build gate

`cargo fmt -- --check`, `cargo clippy`, `cargo test`; IPC drift check if
anything was exported.

## Test plan

Rust, in temp dirs. The swap logic takes folder paths, so it is tested without
npm, using fake package trees and manifests:

- Swap keeps `gcp-oauth.keys.json`, a token file and a browser folder, and
  replaces `node_modules` and the manifest.
- A binary install whose archive had a `lib/` folder: `lib/` is package-owned
  and is replaced, not carried over.
- Rollback after a swap restores the old package, manifest and user state.
- A failure injected at each of a, b and c leaves `<id>` exactly as it was.
- The in-flight counter is above zero during a slow call and returns to zero
  after a failing call.
- `recover_interrupted` rolls back a leftover `.previous` and clears a stale
  `.installing`. `uninstall` removes `.previous` too.

## Commit

`feat(mcp): stage, swap and roll back a catalog server update`

## Rollback

Revert the commit. Nothing calls these commands until Phase 05, so it is safe
on its own. Label the PR `no-docs`.
