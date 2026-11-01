# Phase 01 — Spike: how a loaded schema reaches the model

**Depends on:** nothing · **Enables:** phase 03 (picks option A, B or C)

## Goal

Answer three questions with measurements, and record the answers in
`overview.md` under Decisions. No product code. The spike script and its
output stay out of the repo.

1. **Template order.** In the default model's chat template (Qwen 3.5 9B), does
   the tool block come before or after the system text? Does a change in the
   system text, or in `tools`, invalidate the cache for everything after it?
2. **Calls to a tool not in `tools`.** Can the model call a tool whose schema
   it has only seen in a tool result? Check each backend we support for Chat:
   - llama-server (the bundled one, `--jinja`)
   - vLLM on compute:3000
   - OpenRouter, with one hosted model
3. **Cost of a change to `tools`.** On the 680M and on the desktop GPU, how long
   does llama-server take to process a 20k-token conversation again after a
   change to `tools`?

## Method

Drive llama-server directly with `curl` or a small Node script in the
scratchpad. Use the real schemas: dump them from a vitest that registers all
tools (`src/lib/agent/tools/index.ts`) and calls `getToolSchemas`. That is the
same method as the 2026-11-01 audit.

1. **Template.** Render the default model's template with `/apply-template`,
   using one system message and two tools. Note the order. Then send the same
   20k-token conversation twice. The second time, change one character in
   (a) the system text, (b) the last tool description and (c) the last user
   message. Record `timings.prompt_n` for each. Only (c) should be small.
2. **Unlisted calls.**
   - Send `tools: [load_tools]` and a history in which `load_tools` returned
     the `video_probe` schema as text. Ask a question that needs `video_probe`.
     Record whether the response has a `video_probe` tool call, a refused or
     garbled call, or a call to `load_tools` again.
   - On llama-server, also read the request log for a grammar or a
     "tool_call" trigger, to see whether names are limited to `tools`.
   - Repeat with a history that already holds a `video_probe` call and its
     result, to see whether the backend accepts a past call to a tool not in
     `tools`. OpenAI-compatible APIs sometimes reject this.
3. **Proxy.** Send `tools: [load_tools, use_tool]`, where `use_tool` has
   `name: string` and `arguments: object`. Ask for the same task. Record
   whether the arguments are complete and correct for the 9B and for one
   larger model (ThinkingCap-3.8-27B on compute:3000).
4. **Cost.** For question 3, time the request after the `tools` change, at 20k
   tokens, on both machines.

## How to decide

- If B works on llama-server and vLLM (the call is made and a past call is
  accepted), choose **B**. Use A as the fallback for a backend that refuses.
- Otherwise, if C's arguments are correct in at least 9 of 10 runs on the 9B,
  choose **C**.
- Otherwise choose **A**, and record the cost from step 4 in the overview so
  that phase 05 can weigh it.

A backend can need a different option than the default one. Phase 03 then
takes the option from the backend descriptor (`resolveBackendDescriptor`).

## Output

- A dated entry under Decisions in `overview.md`: the option chosen, and one
  line per backend with what was observed.
- If question 1 shows the memory section invalidates the cache, a comment on
  the memory issue named in "Related" with the `prompt_n` numbers.

## Commit

`docs(plan): record the deferred-tools delivery spike`

PR label `no-docs`.
