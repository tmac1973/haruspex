# Phase 05 — Results (2026-11-01)

A dev build of `main` after phase 04, driven through the Remote control API
by a script (one new chat or Code session per run, memory off). Models: Qwen
3.5 9B (IQ4_NL) on the bundled llama-server, and Qwen3.8-Flash on vLLM at
compute:3000. Chat had a working folder with a test episode (`ep012`, two
clips of 12 s and 20 s); the Code tab a small project folder. Approvals were
answered by the script: read-only GitHub calls allowed, everything else
denied. A question from `ask_user_question` ended the run as a miss.

Not tested: email, calendar and contacts (no test accounts), screen capture,
video generation, OpenRouter, the 680M.

## Index wording, the 9B

"What clips are in ep012? List them with their lengths.", setting on.

| Index                                                          | Right answer        | Loaded first |
| -------------------------------------------------------------- | ------------------- | ------------ |
| Phase 04 line (`video — edit the episodes … Kdenlive`)         | 18/20, plus 1 asked | 0/20         |
| A: the line in the user's words (`video — the episodes and …`) | 8/10                | 3/10         |
| B: phase 04 line, plus "call load_tools first, even for a …"   | 8/10                | 0/10         |
| Setting off                                                    | 10/10               | —            |

The spike's 0 of 15 does not hold in the app: with the whole prompt, the 9B
reaches the video tools in nearly every run. It gets there late. It lists
the folder three times first (FILESYSTEM ACCESS says to use `fs_list_dir`
first), or loads the `cut-video` skill, whose text names the tools. A keeps
the answer rate and loads first more often, so A is kept. B adds nothing.

Misses, setting on: two empty final answers, one run that asked the user,
and one that made up the lengths. That one called `use_tool` with a wrong
name (`video-probe`), then `video_probe` before loading; the fallback sent
the schemas without running the tool, and the model answered without
calling again. Three other runs also passed made-up or hyphenated names to
`use_tool` (`video-probe-duration`, `video-gen`).

## The prompt set

Setting on: two runs each (one for music and the picture); off: one. "Right"
means the answer does what was asked.

| Prompt                          | Family    | 9B on | 9B off | Flash on | Flash off |
| ------------------------------- | --------- | ----- | ------ | -------- | --------- |
| What clips are in ep012?        | video     | 26/30 | 10/10  | 10/10    | 3/3       |
| Cut b 2–10 s, then a, 1 s fade  | video     | 1/2   | 0/1    | 7/7      | 6/6       |
| Short PDF, no search            | documents | 2/2   | 1/1    | 2/2      | 1/1       |
| Research, then a one-page PDF   | documents | 0/2   | 1/1    | 2/2      | 1/1       |
| Three recent GitHub issues      | mcp       | 2/2   | 1/1    | 2/2      | 1/1       |
| 32px stone texture (Code)       | assets    | 2/2   | 0/1    | 2/2      | 1/1       |
| Read text aloud to hello.wav    | speech    | 0/2   | 1/1    | 2/2      | 1/1       |
| A short song about rain         | music     | 0/1   | 0/1    | 1/1      | 1/1       |
| A red fox in the snow           | images    | 1/1   | 1/1    | 1/1      | 1/1       |
| Explain a heat pump             | none      | 2/2   | 1/1    | 2/2      | 1/1       |
| 17% of 2,340                    | none      | 2/2   | 1/1    | 2/2      | 1/1       |
| What does the README say (Code) | none      | 2/2   | 1/1    | 2/2      | 1/1       |

- **Flash** used the right family in every run that needed one (29 of 29),
  and loaded nothing in the 6 runs that needed none.
- **Flash's arguments through `use_tool`** were right: all 6 `video_cut`
  calls with the setting on put b.mp4 2–10 s first, a.mp4 second and the
  1 s crossfade on the join, as did the 8 with it off. The spike's
  misplaced crossfade did not come back with the real prompt.
- **The 9B** with the setting on failed on the research PDF (two empty
  answers), on speech (a tool call written out as text, and a question to
  the user) and on one cut (it stopped after loading the skill). With the
  setting off it failed the cut, the texture (a tool call written as text)
  and the song as well. Both settings fail the song: it loads the
  `write-song` skill and stops.
- No run of either model loaded a family it did not need.

## Cost

| Model | Setting | First request, Chat | First request, Code | Median requests per turn |
| ----- | ------- | ------------------- | ------------------- | ------------------------ |
| 9B    | on      | 7,176 tokens        | 8,001               | 6                        |
| 9B    | off     | 27,178              | 28,180              | 2                        |
| Flash | on      | 7,212               | 8,031               | 4                        |
| Flash | off     | 27,243              | 28,233              | 4                        |

The setting cuts the prompt a turn starts with by about 20k tokens (73%).
The 9B makes more requests with it on, because it explores before it
loads; Flash about the same. On llama-server, 175 of the 204 requests of
the first 9B session processed under 500 new tokens: a load costs the tail.

One Flash research turn took far longer with the setting on (188 s and
167 s against 43 s), because it researched more and wrote a second PDF,
not because of loading (the documents family was preloaded). Two runs are
too few to call it.

## Decisions

- **Default (phase 06):** Auto as planned: on above 12B or when the size is
  unknown, off at 12B and below. Flash passes (29 of 29, no needless
  loads). The 9B does not reach 90% with the setting on (26 of 30 on the
  implicit video request, worse on the research PDF and speech), so Auto
  keeps it off. Its id gives no size for Flash, which therefore defers.
- **Index:** the video line becomes A, `video — the episodes and clips in
the working folder: what's in them, cutting, captions, render`.
- **Follow-ups, not blocking phase 06:**
  - `use_tool` with a name that is a hyphenated form of a deferred tool
    (`video-probe`) could resolve to it.
  - After the fallback sends a family's schemas, the 9B sometimes answers
    without calling again. Running the call when its arguments validate
    against the schema would remove that step.
  - FILESYSTEM ACCESS ("Use fs_list_dir first") sends both models to list
    the folder before loading, three calls on the 9B.
