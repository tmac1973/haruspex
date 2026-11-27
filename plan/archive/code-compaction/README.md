# Code Tab Compaction — Implementation Plan

Long Code sessions summarise their older turns, like Chat does, instead of
relying only on the per-request context fit. The summary is part of the saved
session. The transcript the user scrolls through stays whole.

See [`overview.md`](./overview.md) for the problem, the design, the decisions
and the invariants.

**Status:** Planned and built 2026-10-10: phases 1–4 merged (#469, #471,
#472, #473). The bug found while reviewing this (a turn losing its own tool
calls after the fit dropped old turns) was fixed separately in #468.

**Tested 2026-10-11** in the running app over Remote control (local 9B, 256K
window): it compacted near 75%, the next prompt went from 166K to 6K tokens,
the cache was reused after it, and a planted decision survived. The test
found:
- #485: the final-answer call dropped the tools and lost the prompt cache;
- answers inside an unclosed `<think>` were left out of the summary (fixed
  with this note);
- #486: the remote API and web client don't show the compaction.

## Phase map (dependency-ordered, one PR per phase)

| # | File | Phase | Depends on |
|---|---|---|---|
| 1 | `phase-01-stable-fit.md` | The fit drops turns with headroom and a fixed note, so the prefix changes once, not on every call | — |
| 2 | `phase-02-compaction-core.md` | `code/compaction.ts`: pick the cut, summarise in chunks, the saved `compaction` field, Rust fork | — |
| 3 | `phase-03-session-integration.md` | `CodeSession` compacts before a turn when the thread is near the window | 2 |
| 4 | `phase-04-ui-and-guide.md` | Transcript divider, header status, `/compact`, guide | 3 |

Phases 1 and 2 are independent.
