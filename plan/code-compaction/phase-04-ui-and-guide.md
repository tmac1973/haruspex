# Phase 4 — UI, `/compact`, guide

**Depends on:** 3 · **Guide:** `code-sessions`, `shortcuts` if a slash list lives there, `chat` if `/compact` is shared

## Transcript (`CodeTranscript.svelte`)

- Put a divider before `messages[compaction.at]`: "Earlier turns summarised".
  Clicking it opens the summary, read-only, as a collapsible block in the
  `ThinkingPanel` style. The full text goes in the `title`.
- Messages above the divider look as they do now. They stay forkable, because
  the fork drops the cut.
- Pagination (`windowStart` / `TURNS_PER_PAGE`) is unchanged. The divider is
  one more row.

## Header and sidebar

- `'compacting'` reads "Summarising…" in `CodeSessionHeader` and on the sidebar
  status dot.
- The context gauge resets after a compaction (`usage = null`) and fills again
  from the next reply.

## `/compact`

- A new built-in in `src/lib/slash/slash.ts`, offered in the Code tab only.
  Check whether `builtin` entries can be limited to one tab. If not, add the
  limit the way `needsCodeMode` works.
- It runs `CodeSession.compactNow()`. This is the phase 3 step without the
  threshold and without a turn after it, and it ignores the 75% check. If
  there is nothing to summarise (`chooseCut` is null), show a toast: "Nothing
  to summarise yet." It is refused while a turn runs.
- Optional extra text (`/compact keep the API design notes`) is added to the
  summary prompt as "the user asks you to keep: …".

## Guide

- `code-sessions.md`: a "When a session gets long" section, in one or two
  short paragraphs:
  - what happens automatically;
  - that the transcript stays whole;
  - `/compact`;
  - what it doesn't do: file contents aren't kept, so the assistant reads
    files again.
- `code.md` is at 5,999 bytes against the 6 KB limit. Don't add to it; point
  at `code-sessions` instead.
- `models.md` line 44: it already says history is summarised. Make it name
  both Chat and Code.
- Don't run Prettier on the guide (it breaks tables and the size limit).

## Tests

- `CodeTranscript.test.ts`: the divider shows at `compaction.at` and opens the
  summary.
- `slash.test.ts` / `CodeComposer.test.ts`: `/compact` is offered in Code
  only and calls `compactNow`. Extra text reaches the prompt.
- Hand test with a long session on the 9B model at 32K, then 256K:
  - watch the "prompt processing" time before and after a compaction in the
    llama-server log; the cache should be reused between compactions;
  - check that the answers still know what was decided earlier.
