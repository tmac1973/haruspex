# Phase 02 — A readable outline approval

Depends on: — / Enables: —

## Goal

The guided-planning outline checkpoint should read like a list of phases,
not a wall of bold text.

**Why it reads badly today:**
- The whole question, outline included, goes into the modal's `<h2>`
  (`UserQuestionModal.svelte:117`), so every line is heading-size and bold.
- `renderOutline` (`guided-planning/pipeline.ts:1314`) writes each phase as
  one line, "Phase 01 — title: summary", with no break between phases.

**The fix:** questions get an optional markdown `body`, shown at normal
weight below a short heading. The outline is rendered for reading in that
body. The other checkpoints already ask one-sentence questions; any future
checkpoint that shows long content uses the same field.

## Files touched

- `src/lib/stores/userQuestion.svelte.ts`: `UserQuestionRequest.body`.
- `src/lib/components/UserQuestionModal.svelte`: render the body.
- `src/lib/agent/jobs/types/guided-planning/pipeline.ts`: move
  `renderOutline` and the `NormalizedPhase` type (now a closure and a local
  type around :1272-1314) to module level and export them; add
  `renderOutlineForReview`; use it at the outline checkpoint (around
  :1732).
- `src/lib/agent/tools/user-question.ts`: the `ask_user_question` tool may
  pass `body`.
- Tests: new `src/lib/components/UserQuestionModal.test.ts`;
  `src/lib/stores/userQuestion.test.ts`; `guided-planning/pipeline.test.ts`.

## Steps

1. **`UserQuestionRequest` gains `body?: string`**, markdown.
   - `question` stays the heading and should be one short sentence.
   - The store passes `body` through unchanged.
2. **The modal shows the body under the `<h2>`**, inside the existing
   scroll region.
   - Render it with `renderMarkdown` (`src/lib/markdown.ts:702`), the
     sanitising renderer chat uses.
   - Normal weight, the body font size, paragraph spacing; headings inside
     the body cap at the size of the modal's `<h2>`.
   - No body means no change.
3. **`renderOutlineForReview(phases)`**, an exported module-level function,
   separate from `renderOutline`.
   `renderOutline` keeps its exact format, because it is also the outline
   handed to every phase-writing prompt. Per phase, the review version emits:
   - a bold line, "**Phase 01 — Title**", with " · depends on 01, 03" appended
     when there are dependencies;
   - the summary as a paragraph below it;
   - a blank line before the next phase.
4. **The outline checkpoint** asks with:
   - `question`: "Here's the plan outline — N phases, in dependency order."
   - `body`: `renderOutlineForReview(outline)`.
   - The approve/revise instruction becomes the option descriptions, which
     already say what Approve does.
5. **Only the outline checkpoint changes.** The overview checkpoint (around
   :1689-1700) and the final approval (around :1916) already ask one-sentence
   questions.
6. **The `ask_user_question` tool schema** gains an optional `body`, with the
   description "Longer context shown under the question, in markdown — keep
   the question itself one sentence". The tool forwards it.

## Build gate

The overview's gate.

## Test plan

- **Unit:**
  - `renderOutlineForReview` puts a blank line between phases and bolds each
    title line;
  - `renderOutline`'s output is unchanged (a snapshot of an existing case);
  - the outline checkpoint passes a one-line question and a body.
- **Component:**
  - with a body, the `<h2>` contains only the question;
  - the body renders as markdown, with the bold line as `<strong>`;
  - a script tag in the body is not rendered.
- **Manual:** run guided planning to the outline checkpoint on a plan with
  6+ phases. The heading is one line, the phases are visually separate, and
  the Approve button stays visible without scrolling the page.

## Commit

`feat(planning): show the outline as a readable list under a short question`

## Rollback

Revert the commit. `body` is optional everywhere, so callers that never set it
are unaffected either way.
