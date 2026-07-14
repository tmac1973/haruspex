# Review Remediation 2026-07 — Overview

**Status:** Planning locked 2026-07-13 — all decisions resolved, zero deferred.
**Source:** Features/usability/efficiency review of 2026-07-13 (post-#177 `main`).
**Shape:** 9 phases, one PR each, Conventional Commits per phase (scope suggested in each file).

---

## Decisions locked (do not re-litigate during implementation)

| Decision | Resolution |
| --- | --- |
| Destructive-action guard pattern | **Modal-based ConfirmDialog** built on `Modal.svelte` + `ModalButton.svelte`. No native `confirm()`, no undo-toast soft deletes. Existing native `confirm()` sites migrate too. |
| Send while llama-server is starting | **Queue and auto-send.** Message is accepted, shown with a waiting state, and runs automatically when the sidecar reports Ready. Startup failure converts it to an error with Retry. |
| Inference provider seam | **Full `BackendDescriptor` refactor** (phase 09). One resolved descriptor per backend; request-path code stops branching on mode strings. |
| Async DB strategy | `spawn_blocking` with a cloned `Database` handle (it is `Clone` over `Arc<Mutex<Connection>>` — verified `db/mod.rs:248-249`). |
| Reduced-motion strategy | One global `prefers-reduced-motion` override in `+layout.svelte`, not per-component keyframe guards. |
| Constants drift guard | New `scripts/check-constants.mjs` for sidecar ports/loopback only. Context-size is **not** hand-synced — `server/mod.rs:53` documents TS owns the default and Rust requires the param (verified non-issue). |

## Explicitly out of scope (decided 2026-07-13, do not add back)

- **Chat list virtualization** — variable-height markdown windowing isn't worth
  the complexity yet; phases 01/02 remove the felt sluggishness.
- **`chat.svelte.ts` god-store split** — stays tracked in `maintenance.md` §15
  with its fan-in trigger.
- **Legacy job-schema column cleanup** — `type_config` (#174) is days old;
  migration risk exceeds the cosmetic win.

## Phase order and dependencies

```
01 backend-responsiveness   (Rust; independent)
02 streaming-micro-perf     (TS; independent)
03 ui-feedback-primitives   (ConfirmDialog + focus trap + toasts)
04 destructive-confirms     (depends on 03)
05 error-recovery           (depends on 03)
06 accessibility            (independent; after 05 to avoid MicButton churn)
07 onboarding-polish        (independent)
08 dead-surface-constants   (independent)
09 provider-descriptor      (largest blast radius; nothing depends on it → last)
```

Nothing earlier consumes the output of a later phase. 04 and 05 both consume
phase 03's components; 06 touches `MicButton.svelte` after 05 has already
rerouted its error display, so run them in numeric order.

## Build gates (every phase)

`npm run format && npm run check && npm run lint && npm run test && npm run build`,
plus for Rust-touching phases:
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml`.
CI treats clippy warnings and ESLint errors as blocking; don't add new ESLint
complexity warnings to previously-clean files (maintenance.md §14).
