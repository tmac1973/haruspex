# Phase 13 — Sidecars die with the app

Depends on: — / Enables: —

## As built — notes

- **One spawner thread.** `PR_SET_PDEATHSIG` fires when the parent *thread*
  exits, not the process. Every sidecar is therefore spawned from one
  dedicated thread that lives as long as the app (`sidecar_process.rs`); a
  tokio worker that retired would have killed a healthy sidecar.
- **The plugin still builds the command.** It resolves the path and carries
  the env, and is converted with its own `From<Command> for
  std::process::Command`. Events are the plugin's `CommandEvent`, split by
  `tauri::utils::io::read_line`, so the log readers didn't change. Only
  `CommandChild` became `SidecarChild`. stdin stays an open pipe, as before.
- **The sweep kills with SIGKILL,** the existing `orphans::kill_pid`, rather
  than SIGTERM then SIGKILL. The kernel frees the VRAM either way.
- **The registry moved** from `integrations/mcp/orphans.rs` to `src/orphans.rs`,
  keyed by kind (`mcp`, `sidecars`). `deregister_pid` stops a late exit from
  forgetting a restarted process.
- **"Ours" for a port holder** means its command line contains the app
  executable's directory, or the registry recorded that pid with a matching
  program. The registry case covers AppImage, which mounts at a new path
  every launch.
- **The MCP leak** was rmcp's `Drop`, which only *schedules* the kill on a
  detached task. That task never ran when the runtime ended (every test), so
  the timeout path now kills the pid synchronously.
- **Windows** (the Job Object) is compiled only by CI's Windows job, which
  runs on a PR labelled `windows-ci`.

## Goal

No sidecar outlives the app, however the app ends: a clean quit, a crash,
SIGKILL, or a `tauri dev` rebuild. On 2026-10-03 a Qwen `sd-server` from a job
ran ~6 h after the app that started it had restarted, holding 9 GB of VRAM; a
game ran badly until it was killed by hand. `koko` was 2 days old against a
14-minute-old app.

**Why it happens:**
- **The Exit-handler stop only runs on a clean quit.**
- **Each sidecar frees its port only when it next starts**
  (`kill_process_on_port`, called from `server/mod.rs:327`, `whisper.rs:40`,
  `tts.rs:92` and `image_engine.rs:242`). The image engine starts only on
  demand, so an orphan sits on the GPU until the user next generates an
  image.
- **`kill_process_on_port` kills whatever holds the port, by port alone.**
  It doesn't check that the holder is ours.
- **MCP already has the right pattern** (`integrations/mcp/orphans.rs`): a
  registry of spawned pids, swept at launch with a program-identity check.
  The four port sidecars don't use it.
- **A test leaks its children.** `a_server_that_never_speaks_mcp_is_killed_at_the_deadline`
  (`integrations/mcp/process.rs:846`) leaves a `mcp-echo-server.js hang`
  process behind on every run; 14 were found. The test's name says the child
  is killed at the deadline, so the start-timeout path most likely leaks the
  child in the product too.

## Files touched

- `src-tauri/src/sidecar_utils.rs`: `spawn_sidecar`, an identity check in
  `kill_process_on_port`, the sidecar registry and sweep.
- `src-tauri/src/integrations/mcp/orphans.rs`: generalise its registry
  helpers so sidecars can share them, or move them into a shared module.
- `src-tauri/src/server/mod.rs`, `whisper.rs`, `tts.rs`, `image_engine.rs`:
  spawn through `spawn_sidecar`.
- `src-tauri/src/integrations/mcp/process.rs`: kill and deregister the child
  on the start-deadline path.
- `src-tauri/src/lib.rs`: sweep sidecars at launch, beside the MCP sweep
  (:104).
- `src-tauri/Cargo.toml`: the `libc` crate on unix (if not already a
  dependency); a Job Object crate or `windows-sys` features on Windows.

## Steps

1. **A shared registry.**
   - Move `RunningServer`, `register`, `deregister` and `sweep`, with its
     `command_matches` identity check, from `mcp/orphans.rs` into a module
     both can use.
   - Sidecars record to `<app_data>/sidecars/running.json`, MCP keeps
     `<app_data>/mcp/running.json`. Same code, two files.
   - A record is `{ id: "llama-server" | "whisper-server" | "koko" |
     "sd-server", pid, started_at, program }`.
2. **`spawn_sidecar(app, name, args, env)`**, in `sidecar_utils.rs`. It
   returns the same child handle and stdout/stderr streams the callers use
   today.
   - **Resolve the binary path** the way `runtimes.rs` does (next to the
     executable). For `sd-server`, that's `binaries/sd-libs/`, as today.
   - **Spawn with `tokio::process::Command`** rather than the shell plugin,
     because the plugin offers no hook for the next two steps.
   - **Linux:** `pre_exec` runs `prctl(PR_SET_PDEATHSIG, SIGTERM)`, so the
     kernel signals the child when the app dies for any reason. Re-check
     `getppid()` after `prctl`, and exit if the parent is already gone.
   - **Windows:** assign the child to a Job Object created once per process
     with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The job handle is held for
     the app's lifetime, so the OS kills the children when the app's process
     ends.
   - **macOS:** no equivalent. Rely on the launch sweep (step 4).
   - **Every platform:** register the pid and program after spawn, and
     deregister on a clean stop.
3. **Move the four sidecars onto `spawn_sidecar`:** llama-server, whisper,
   koko and sd-server. Keep their arguments, environment (sd-server's
   `GGML_VK_VISIBLE_DEVICES`, `LD_LIBRARY_PATH`) and log readers exactly as
   they are. Only the spawn call and the child type change.
4. **Sweep at launch.** Next to `mcp::orphans::sweep` (`lib.rs:104`), sweep
   the sidecar registry. A recorded pid that is alive and still running the
   recorded program is sent SIGTERM, and SIGKILL after 3 s. Then the file is
   cleared. This frees an orphaned image engine at startup instead of at the
   next image request.
5. **`kill_process_on_port` checks identity.**
   - Before killing, read the holder's executable: `/proc/<pid>/exe` on
     Linux, `ps -o comm=` on macOS, `Get-Process` on Windows.
   - Kill only when it is the expected sidecar binary from our install, or
     one recorded in the registry.
   - Otherwise log "port <n> is held by <program>, not ours — not killing
     it", and let the sidecar's start fail with that sentence in its status,
     so Settings shows it.
6. **MCP start deadline.** On the `start_within` timeout path in
   `mcp/process.rs`, kill the child, wait for it to exit (with a 2 s cap),
   and deregister it before returning the error. The hang test then asserts
   that the fixture's pid is no longer alive when it returns.

## Build gate

The overview's gate. On Linux also run the new opt-in test from the test
plan.

## Test plan

- **Rust, registry:**
  - register then deregister leaves the file empty;
  - the sweep kills a recorded live process whose program matches, and
    skips one whose pid was reused by another program (spawn `sleep`, record
    it under a different program path, and check it survives).
- **Rust, identity:** `kill_process_on_port` with a non-sidecar listener on a
  free port (a `TcpListener` in the test process) does not kill it, and
  returns the "not ours" outcome.
- **Rust, MCP:** the hang test asserts the child pid is gone after the
  deadline. Count `mcp-echo-server.js hang` processes before and after a
  full `cargo test` run: the count doesn't rise.
- **Rust, opt-in (Linux):** spawn `sleep 60` through `spawn_sidecar`'s
  `pre_exec` path from a child test process, kill that process with SIGKILL,
  and check that `sleep` is gone within 1 s.
- **Manual:**
  - start the bundled image engine, then kill the app with `kill -9`: the
    engine is gone within a second (Linux) and `nvtop`/`radeontop` shows the
    VRAM freed;
  - on macOS, after the same kill, the next launch's sweep removes it;
  - on Windows, end the app in Task Manager and check sd-server goes with it;
  - start a `tauri dev` session, generate an image, edit a Rust file to force
    a rebuild, and check `ss -ltnp` shows no second sd-server.

## Commit

`fix(sidecars): sidecars die with the app, a stale one is swept at launch, and a port is only freed from our own process`

## Rollback

Revert the commit. The old spawn path returns. The registry file is left on
disk unused and is safe to delete.
