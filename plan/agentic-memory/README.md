# Agentic Memory — Implementation Plan

Phased, dependency-ordered plan for cross-session memory: extract stable
facts from conversations, store them locally with embeddings, and recall
relevant ones into future chats — fully on-device, with a global toggle and
per-chat incognito. See [`overview.md`](./overview.md) for the problem
statement, architecture, the library-survey rationale for building bespoke,
and the Decisions appendix (D1–D5).

## Build status

Planning only — nothing implemented.

## Phases

| Phase | Deliverable | Rust | TS/Svelte |
|---|---|---|---|
| [01](./phase-01-rust-memory-core.md) | `memories` schema + columns, fastembed embedder, `db/memories.rs`, IPC commands | ●●● | ○ |
| [02](./phase-02-settings-and-model-consent.md) | Global toggle, Memory settings category, model-download consent | ● | ●● |
| [03](./phase-03-extraction-pipeline.md) | Idle/chat-switch triggers, `submit_memories` ephemeral turn, dedupe, watermark | ○ | ●●● |
| [04](./phase-04-recall-and-injection.md) | Per-send retrieval, system-prompt MEMORY section, token budget, steps record | ○ | ●● |
| [05](./phase-05-incognito-and-manager-ui.md) | Incognito pill, memories manager, in-chat recall visibility | ● | ●●● |

Each phase leaves the app fully working and `make check` green. Phases 01–02
are pure infrastructure (no behaviour change); memory starts *recording* in
03 and *acting* in 04; 05 completes the trust surface. The feature ships
default-off and requires an explicit one-time embedding-model download.
