# Phase 02 — `ask_user_question` tool (chat + all jobs)

**Depends on:** Phase 01 · **Enables:** Q&A in Phases 06/07; clarifying
questions in normal chat.

## Goal

Register an `ask_user_question` agent tool that any agent (chat or job) can call
to ask the user a multiple-choice question and receive the answer as the tool
result. Exposed everywhere in v1. In interactive contexts it drives the Phase 01
modal; in a non-interactive context it fails safe (a clear error result) — the
full pause-to-needs-input upgrade lands in Phase 05, which is where job-run
state exists to support it.

## Files touched

- **NEW** `src/lib/agent/tools/user-question.ts` — tool registration.
- **EDIT** `src/lib/agent/tools/index.ts` — side-effect import to register it.
- **EDIT** `src/lib/agent/tools/types.ts` — add an optional
  `interactive?: boolean` to `ToolContext` (defaults falsy; set true by chat and
  by interactive job runs in Phase 05).

## Implementation

### Tool schema

```ts
schema: {
  type: 'function',
  function: {
    name: 'ask_user_question',
    description:
      'Ask the user a single multiple-choice question and wait for their answer. ' +
      'Use ONE question at a time. The user can always type a free-text answer ' +
      'instead of picking an option. Use this to resolve genuine decisions you ' +
      'cannot make confidently from context — not for trivia or confirmation.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
              recommended: { type: 'boolean' }
            },
            required: ['label']
          }
        },
        allow_multiple: { type: 'boolean' }
      },
      required: ['question', 'options']
    }
  }
},
category: 'web' | (new category) // see note below
```

> **Category:** add a new tool category `'interaction'` to the `ToolContext`
> category union in `types.ts` rather than overloading an existing one, so the
> allowlist logic in Phase 05 can reference it cleanly.

### Execute

```ts
execute: async (args, ctx) => {
  if (!ctx.interactive) {
    // Phase 05 replaces this branch with a pause-to-needs-input signal.
    return toolResult('No interactive user is available to answer this question.');
  }
  const { askUserQuestion } = await import('$lib/stores/userQuestion.svelte');
  const answer = await askUserQuestion({
    question: args.question,
    options: args.options,
    allowMultiple: args.allow_multiple
  });
  const text = answer.kind === 'freeText'
    ? `User wrote: ${answer.text}`
    : `User selected: ${answer.labels.join(', ')}`;
  return toolResult(text);
}
```

`displayLabel` → `"ask: <question truncated>"`.

### Loop integration

No loop change needed — `executeToolCalls` in
`src/lib/agent/loop/iteration.ts` already `await`s the tool's Promise, exactly
like `fs_write_text` awaiting `askFileConflict`. The loop pauses on the await and
continues when the answer resolves.

### Chat exposure

Chat runs are interactive; set `ctx.interactive = true` on the chat agent-loop
context (find where chat builds its `ToolContext`). Ensure `ask_user_question`
is in the default chat toolset (it registers globally; confirm it isn't filtered
out by `deepResearch`/allowlist gating).

## Build gate

`npm run check && npm run lint && npm run test`

## Test plan

1. **In normal chat:** ask "Help me choose a logging library — ask me a
   multiple-choice question." The modal appears; answering returns the choice to
   the model, which continues. This is the first end-to-end validation of the
   whole primitive.
2. Free-text answer flows back as `User wrote: …`.
3. Multi-select (`allow_multiple`) returns several labels.
4. Simulate non-interactive (`ctx.interactive` false): tool returns the safe
   error string, loop continues, no hang.

## Commit

```
feat(tools): ask_user_question tool (interactive HITL)

Registers a globally-available tool that asks the user a multiple-choice
question via the Phase 01 modal and returns the answer to the agent.
Non-interactive contexts fail safe with an error result (full
needs-input pause arrives in Phase 05).
```

## Roll-back rule

Revert the tool file + index registration. The chat agent loses the ability to
ask questions; nothing else regresses.
