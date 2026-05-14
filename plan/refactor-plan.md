# Haruspex Refactor Plan — 2026-05-14

Derived from:
- [`audits/code-duplication-2026-05-14.md`](../audits/code-duplication-2026-05-14.md)
- [`audits/code-complexity-2026-05-14.md`](../audits/code-complexity-2026-05-14.md)
- [`audits/design-patterns-2026-05-14.md`](../audits/design-patterns-2026-05-14.md)

12 phases. Each phase is intended to land as one PR, take ≤1 dev day, and pass the test plan in its own file before the next phase begins.

---

## Ordering rationale

Highest impact first, but ordered so that **foundation extractions land before consumers**. Phase 1 creates `sidecar_utils.rs`; Phase 2 splits `fs_tools.rs`; Phase 3 then refactors functions inside the freshly-split modules. Risky behavioural refactors (runAgentLoop, sendMessage) are scheduled mid-plan after mechanical wins build confidence in the test plan.

| # | Phase | Severity | Primary audit refs | Effort | Risk |
| --- | --- | --- | --- | --- | --- |
| [1](./phase-01-sidecar-utils.md) | `sidecar_utils.rs` foundation | 9 | Dup R-1/R-2/R-3/R-5/R-6/R-7, Pattern P-4 | ~3 h | Low |
| [2](./phase-02-fs-tools-split.md) | `fs_tools.rs` → module tree | 10 | Complexity C-2 | ~1 day | Medium |
| [3](./phase-03-modal-component.md) | Shared `Modal.svelte` component | 9 | Dup T-1/T-7 | ~2 h | Low |
| [4](./phase-04-fs-write-and-helpers.md) | `fs-write` cleanup + tool helpers | 8 | Dup T-2/T-3/T-4/T-6, Pattern M-3/M-4 | ~4 h | Low |
| [5](./phase-05-build-pdf-pptx.md) | `build_pdf` + `build_pptx` decomposition | 8 | Complexity C-7/C-8 | ~4 h | Medium |
| [6](./phase-06-proxy-split-and-strategy.md) | `proxy.rs` split + `SearchBackend` trait | 7 | Complexity C-9, Pattern P-1 | ~1 day | Medium |
| [7](./phase-07-runagentloop.md) | `runAgentLoop` decomposition | 10 | Complexity C-1, Pattern P-2 | ~1 day | **High** |
| [8](./phase-08-sendmessage.md) | `sendMessage` decomposition | 9 | Complexity C-3, Pattern P-3 | ~4 h | Medium |
| [9](./phase-09-settings-page-split.md) | `settings/+page.svelte` split | 8 | Complexity C-5 | ~4 h | Low |
| [10](./phase-10-main-page-split.md) | `routes/+page.svelte` split | 7 | Complexity C-10 | ~4 h | Low |
| [11](./phase-11-server-impl-split.md) | `impl LlamaServer` decomposition | 6 | Complexity C-4/C-12 | ~3 h | Medium |
| [12](./phase-12-polish.md) | Polish + ESLint guardrails | 3 | Dup R-8/T-10/T-12, Complexity C-13, Pattern P-7/P-8 | ~3 h | Low |

**Total:** ~8 dev days. Top 5 phases (~3 days) deliver ~70% of the win.

---

## Cross-cutting conventions

- **One PR per phase.** Use Conventional Commits (per the `feedback_conventional_commits.md` memory) — `refactor:` prefix is appropriate for almost every phase.
- **Build gate before testing:** every phase must pass `cargo check`, `cargo clippy`, `npm run check`, `npm run lint` before the interactive test plan starts.
- **Test plan format:** each phase file has three test layers — (a) **smoke** (does it launch?), (b) **targeted** (specific to the touched code), (c) **agent prompts** to paste into chat where relevant. The agent prompts are written so they exercise the code path under test without requiring you to know what changed.
- **Rollback rule:** if a phase regresses something not on the test plan, revert and split into smaller commits. Refuse the temptation to "fix it in the next commit."
- **Working tree:** each phase assumes a clean working tree at start. Stash or commit any unrelated changes first.

---

## Dependency graph

```
Phase 1 (sidecar_utils)
  ├─→ Phase 11 (impl LlamaServer split)            [needs SidecarStatus + helpers]
  └─→ Phase 6 (proxy split)                        [reuses http_client helper]

Phase 2 (fs_tools split)
  └─→ Phase 5 (build_pdf/pptx)                     [refactors live in new modules]

Phase 3 (Modal component)                          [independent]

Phase 4 (fs-write helpers)
  └─→ Phase 7 (runAgentLoop)                       [tool sites stable before loop changes]

Phase 6 (proxy split)
  └─→ Phase 7 (runAgentLoop)                       [research_url stable]

Phase 7 (runAgentLoop)
  └─→ Phase 8 (sendMessage)                        [loop signature stable before caller refactor]

Phase 8 (sendMessage)                              [no downstream phase]
Phase 9 (settings page)                            [independent]
Phase 10 (main page)                               [independent]
Phase 11 (impl LlamaServer)                        [after Phase 1]
Phase 12 (polish)                                  [last; adds lint rules]
```

Phases 3, 9, 10, 12 are **freely reorderable** — they touch independent code. Run them whenever you need a low-risk win after a heavier phase.

---

## How to use this plan

1. Read the per-phase file before starting.
2. Apply the changes (Claude Code can do this with the phase file pasted in as context, or section by section).
3. Run the build gate: `cargo check && cargo clippy && npm run check && npm run lint`.
4. Run the targeted tests in that phase's file.
5. Run the agent prompts in the actual app (`GDK_BACKEND=x11 npm run tauri dev`).
6. Commit with the conventional message suggested in the phase file.
7. Move to the next phase.

If any agent prompt produces a worse result than before — different output format, missing feature, slower response — flag it, revert, narrow the change, retry.
