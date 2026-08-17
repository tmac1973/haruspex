# Phase 03 — A Thinking Panel That Stays Open and Shows Live Reasoning

Independent of phases 01 and 02. Fixes the three separate reasons the panel
collapses or shows nothing, without touching the agent loop.

## What's actually wrong

Three causes, and only the first is the obvious one:

1. **`{@html}` destroys the widget on every delta.** `ChatMessage.svelte:34`
   re-derives the whole HTML string, line 59 injects it, and the
   `<details class="thinking-block">` from `markdown.ts:394` carries no `open`
   attribute — so each update recreates it collapsed. This is the one that
   matches "collapses every time the model updates the thinking text".
2. **In-progress reasoning renders as nothing.** `convertThinkingBlocks`
   (`markdown.ts:382`) matches only *closed* `<think>…</think>` pairs, and
   `stripThinkBlocks` erases an unclosed one. Even a panel held open shows
   nothing until the block closes.
3. **The job view's panel has a derived open state.**
   `open={isLiveStep(step) && !hasStreamingAnswer(step.streaming)}`
   (`JobRunView.svelte:200`). `step.streaming` is replaced with each call's
   buffer, and guided planning also writes plain status text into it
   (`pipeline.ts:768`), so the expression flips repeatedly and every flip
   overrides the user.

## Steps

### 1. A real component instead of an HTML string

`ThinkingPanel.svelte` owns its own disclosure state:

```svelte
let { text, defaultOpen = false, stats = null } = $props();
// Seeded once. After the user touches it, it is theirs — nothing derived may
// write to it again, which is the entire bug in JobRunView:200.
let open = $state(defaultOpen);
```

Because it is a component with a stable identity, a text update re-renders its
*body* and leaves the disclosure alone. That is the structural fix for cause 1;
an `open` attribute on the generated HTML would only paper over it, since the
element is still destroyed and rebuilt on every delta.

### 2. Split reasoning out of the markdown pipeline in `ChatMessage`

`splitThinkChannels` already exists (`markdown.ts:311`) and is what
`reportCall` uses. `ChatMessage` should use it too: render the reasoning
through `ThinkingPanel` and the answer through `renderMarkdown` as today.

`convertThinkingBlocks` then stops being the renderer for assistant messages,
but keep its "thinking-only" promotion — when a message is *entirely* a think
block (Qwen sometimes wraps its whole answer and emits EOS), the thinking IS
the answer and must render as prose. Losing that would turn those messages
into an empty bubble with a disclosure.

**This touches every surface that renders an assistant message** — chat, shell
and jobs all use `ChatMessage`. That breadth is why it gets its own phase and
its own tests rather than riding along with the accounting work.

### 3. Render the in-progress block

A helper beside its siblings in `think-stream.ts`:

```ts
/**
 * The text of an unclosed `<think>` block at the end of a streaming buffer, or
 * null when there isn't one. `hasStreamingAnswer` answers "is there an answer
 * yet"; this answers "is there a thought in progress", which is what a live
 * panel needs and what `stripThinkBlocks` deliberately throws away.
 */
export function liveThinkTail(buf: string): string | null;
```

`ChatMessage` passes closed-block reasoning and the live tail into the same
panel, so a thought being written and one already finished look the same and
don't jump between two widgets mid-stream.

### 4. Fix the job view's panel

Replace the derived `open` (`JobRunView.svelte:200`) with
`defaultOpen={isLiveStep(step) && !hasStreamingAnswer(step.streaming)}` — same
opinion about the initial state, no longer imposed forever. Keep the existing
summary line, including `thinkingSummary` (`:77`), which phase 01 leaves
working unchanged.

Feed it `step.reasoning` plus the live tail of `step.streaming` when there is
one. On a guided-planning turn there won't be — see below — and the panel just
keeps updating per model call with the user's open state intact.

### 5. Say what the panel can't do

On tool-driven turns there is nothing to stream: only the final synthesis
calls `chatCompletionStream` (`iteration.ts:602`), and every tool-driven
iteration uses the non-streaming completion (`iteration.ts:645`). Guided
planning is tool-driven end to end, so its reasoning arrives one whole model
call at a time no matter what this phase does.

That is a decided non-goal (see the overview), but the UI shouldn't pretend
otherwise: while a step is live with reasoning present and no live tail, the
panel's summary should read as thoughts landing per call rather than showing a
streaming caret that never moves.

### 6. Tests

- `liveThinkTail`: returns the tail for an unclosed block, `null` for a closed
  one, `null` for a buffer with no think tags, and handles a buffer that is
  *only* `<think>` with no content yet.
- `ChatMessage`: a message with reasoning renders both the panel and the
  answer; a thinking-only message renders the thinking as prose with no empty
  bubble; a message with no reasoning renders no panel at all.
- `ThinkingPanel`: the open state survives a text update — the regression this
  phase exists for, and the one a manual check would keep re-finding.

## Verification

- Watch a research job (which does reach the streaming synthesis): reasoning
  appears as it is generated, and the panel does not collapse when the answer
  starts.
- Watch a guided-planning phase-file write: the panel stays open across the
  writes and gains a thought per call.
- Open the panel manually mid-step and confirm nothing closes it — the
  original complaint.
- Check chat and shell for regressions: reasoning renders, thinking-only
  messages still read as prose, and no assistant message renders empty.
