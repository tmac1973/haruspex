# Phase 05 — Live evaluation

**Depends on:** phase 04 · **Enables:** phase 06 (the default)

## Goal

Measure whether models load the right family when they need it, and whether
they still answer well. Set the default and fix the index lines from the
result. The main risk of this design is tools used less, not tools used
wrongly, so the test looks for missed loads.

## Method

Drive a dev build through the Remote control API, as in the release-test
skill, with settings written to `webview-store.json`. Run every prompt with
the setting Off and On, on two models:

- Qwen 3.5 9B (the default), bundled llama-server
- the larger model on compute:3000 (ThinkingCap-3.8-27B, or whatever it
  serves that day; the spike had Qwen3.8-Flash)

Phase 01 found the 9B loads a family only when the request names it (0 of 15
for "What clips are in ep012?", 15 of 15 for "Use the video tools…"). Before
the full run, try for the 9B:

- an index line that names the user's words, not the tools' ("video — the
  episodes and clips in the working folder: …");
- one rule above the index: "If a request is about one of these, call
  load_tools first, even for a simple question."

Keep whichever gets the implicit prompt to 8 of 10 or more. If neither
does, the 9B stays Off under Auto.

The spike script is not in the repo. It drives llama-server and vLLM
directly with the real schemas, and is easy to rebuild from phase 01's
method.

Everything is on: email (a test account), calendar, contacts, two image
models, music, video editing with a test episode folder, screen capture.

## Prompts

At least two per family, plus controls:

- **Needs a family:** "Cut ep012 down to the two best clips", "What's on my
  calendar Thursday?", "Make me a slide deck on …", "Write a short song about
  …", "Draft a reply to the last email from …", "Make a 32px stone texture"
  (Code tab).
- **Mixed:** "Research X and make a PDF of it" (core then documents).
- **Needs no family:** "Explain how a heat pump works", "What is 17% of 2,340?"
  These must not trigger a load.

## Measure

For each run:

- Did it load the right family (or call a deferred tool and recover)?
- Did it load a family it did not need?
- Did it finish the task as well as with the setting Off? Judge the pairs side
  by side.
- Request size and total time for the turn, and `prompt_n` on the next turn.

## Pass

- The larger model: the right family in at least 95% of the "needs a family"
  runs, and no loads in the "needs no family" runs.
- The larger model's arguments through `use_tool` as correct as with the
  setting Off. Phase 01 saw it follow a schema given as text less closely
  (crossfade on the wrong clip in 5–7 of 10); check that on several tools.
- The 9B: record the rate. At 90% or more, the default becomes On for every
  size. Below that, Auto keeps the 9B on Off.
- An index line that leads to missed loads gets rewritten and the prompts run
  again.

## Output

A comment on the tracking issue with the table of results, and the default
set in phase 06.
