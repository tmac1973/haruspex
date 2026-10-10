# Futures

Running list of things to address. Status annotations added 2026-07-19.

## Open

- **Remote API: the web client as a phone app** (`plan/misc_futures/remote-api-mobile.md`, deferred 2026-10-09). An installable PWA of the phase-4 web client (manifest, service worker, HTTPS via `tailscale serve`), a phone layout pass, reconnect after sleep, and maybe notifications. Desktop browsers come first.

- **Phase 15 — image generation on other servers** (`plan/misc_futures/phase-15-remote-image-servers.md`, deferred 2026-10-06). The bundled sd-server run on another machine, and a generic OpenAI-images-API backend (vLLM-Omni, Lemonade, LocalAI). Remote ComfyUI already works and is documented (`docs/comfyui-server-setup.md`), which covers the main need.

- **Phase 16 parts B–F — faster coding runs** (`plan/misc_futures/phase-16-faster-coding-runs.md`, deferred 2026-10-06). Part A's benchmark is in `measurements-phase-16.md`. In priority order, from those numbers:
  - **F, a frame smoke test for graphical projects:** dark_times_5 passed 10 phases and opened to a black window.
  - **C, builds that don't time out:** a 600 s job-turn command timeout, phase gates scoped to one crate or package, and Bevy dev settings.
  - **E, a short preflight for chained runs.**
  - **D, a run-time estimate and MVP-first at the outline approval.**
  - **B, adaptive reasoning:** lowest, now that model choice is known to matter more.
  - Also seen in run 105 (Bevy): a phase build turn can end twice without writing code ("NO WORK"). Whether the turn stopped on plain text or a cut-off is unknown; the step's turn stats would say.

- **Phase 14 part 3 — the nightly suite against real backends.** Needs repository secrets from the user.

- **Mac UI tests** (phase 14). Blocked on an Apple developer account.

- **Owed manual checks, before calling them verified:** phase 10 (an email password stored in and read from the system keychain, and the fallback on a session without one) and phase 11 (compose, review, edit and send to a real account).

- **Owed: Windows and macOS pass for inline chat images.** All seven phases shipped
  2026-08-30 and were verified on Linux against both Qwen 3.6 35B and the default
  9B, but never off Linux. The specific risk is the custom URI scheme, which
  resolves differently on Windows and which no unit test covers. Plan:
  `plan/archive/inline-chat-images/`.

- **Code-drawn textures, next steps** (phase 17's "not in this phase"):
  - transition tiles where two materials meet, as an autotile set drawn from two recipes and a mask;
  - animated water from `waves` variants;
  - a way to turn an existing spec's object textures into sprites. The kind rule only reaches asset lists written after it, and dark_times_5's seven were changed by hand.

- **Shell tab: which session the assistant restores is confusing** (added 2026-10-06). Turn on code mode in the home directory and its previous session is restored. `cd` into a project directory that has its own previous session, and the assistant keeps the home directory's session. If you then choose not to keep that one, it shows the project's session. The session should follow the directory you are working in, and the choice of which to keep should be clear before anything is restored.

- **Shell tab: the agent writes bash in a fish shell** (added 2026-10-06). With fish as the login shell, the agent keeps running bash syntax. It fails, and the turn seems to hang. The likely cause is that a fish parse error isn't reported back like a failed command (exit code and stderr), so the agent never learns why. Switching the terminal to bash by hand and repeating the request works. Options:
  - make shell parse errors come back to the agent as failures it can read;
  - tell the agent which shell the session runs, firmly;
  - run the agent's commands through `bash -c`;
  - force bash in shell sessions. The user isn't keen on this one.

- **Asset generation is locked to one tile size** (added 2026-10-06). A chain's asset job gets its size from what guided planning infers, so today the size has to be written into the planning prompt and hoped for. Two parts:
  - **Tile size as a guided-planning setting,** passed along the chain to the asset job, rather than inferred from prose.
  - **Assets of other sizes and shapes:** splash screens, title art, UI panels, portraits, or a graphical adventure game whose scenes are all different sizes. The spec already has a per-entry `size` override, but planning doesn't use it, and the pipeline assumes square tiles of one size (sheets, the anchor, normalization to `target_size`). A chain should be able to ask for these, and the asset job should make them at their own dimensions.

## Partially done

- **Move API keys to the OS keychain** (added 2026-10-03). Phase 10 built the `secrets` store and moved email passwords onto it. The rest are still plain text in the settings blob: stored API keys, the remote inference key, the Brave key and the image backend key.

## Done

- **misc_futures, phases 01–13 and 17, and 14 parts 1–2** (`plan/misc_futures/`, closed 2026-10-06). From this list:
  - the readable outline approval (02);
  - browsing the jobs tab while a run is live, with chained stages going first in the queue (03);
  - a boundary for unattended coding runs, so they can't reach Haruspex's data or services (04);
  - chain naming, and a model per chained stage (01);
  - catching a small object cut out with a sprite (06);
  - cancelling only our own ComfyUI prompt (05);
  - image generation in Chat (07) and in the Shell assistant (08);
  - the email review, cheaper reads, and compose-and-send after review (09, 11);
  - sidecars dying with the app (13);
  - the context audit across job types and verification lite (12): nothing crosses at 256K (`measurements-phase-12.md`).

- ~~The model and context indicator shows the global model while a job runs on its own model.~~
  - **Done** (`plan/archive/job-observability/`, phase 02): job turns report usage
    through `onUsageUpdate`, and `ContextIndicator` follows the live run.

- ~~I've had a few issues where during a guided planning job one of the plan files that had been written in step 3 and then was going through verification in step 4 seeming got corrupted. When read the plan file in question started with step 9, and everything that presumably had existing in the file before step 9 was gone. No idea how this happened, whether it was a fault of the llm or something else entirely, but lets audit the job and tooling to make sure it wasn't because of some truncation or something that was caused by our code.~~
  - **Fixed in PR #187** — and yes, it was our code, in three independent places.
    1. A generation cut off by the 8192-token ceiling left truncated JSON in the tool
       call. The parser silently discarded it and fell through to regex salvage, which
       rebuilt a plausible-looking call out of a fragment — duplicate `<parameter=>`
       keys overwrote each other (lost the prefix) and the unclosed-tag match ran to
       end of string (lost the suffix).
    2. A second write to the same path in one turn silently replaced the first and
       still reported success, so a chunked write kept only the last chunk.
    3. Writes were a bare `fs::write` (truncate-then-write), so a failed write
       destroyed the previously-good file.
  - Plan and full rationale: `plan/archive/write-path-integrity/`.
