/**
 * `toolName` of the step that records a recall on a turn. Not a real tool —
 * it reuses the step machinery so the injected set persists with the message
 * and the UI can show it (and, in Phase 05, offer per-memory delete).
 *
 * Its own module, free of imports, so the step UI (SearchStep) can know it
 * without loading memory; `recall.ts` re-exports it.
 */
export const MEMORY_RECALL_STEP = 'memory_recall';
