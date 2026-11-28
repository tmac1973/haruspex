---
paths:
  - "src-tauri/src/**"
  - "src/lib/ipc/**"
---

The TypeScript <-> Rust boundary is generated and CI-enforced.

After changing any `#[tauri::command]` registered in `generate_handler![...]`
(`src-tauri/src/lib.rs`) or any `#[ts(export)]` struct, run
`scripts/export-ipc-types.sh` and commit the regenerated files. Never hand-edit
`src/lib/ipc/gen/` or `src/lib/ipc/commands.ts` - they are overwritten. New
`invoke()` call sites must take the command name from the `IPC` constant in
`commands.ts`; `node scripts/check-ipc.mjs` fails CI on a literal name that is
not registered in Rust.
