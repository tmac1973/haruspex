# Model Lineup Refresh and Reasoning Effort

Locked 2026-08-17.

## Problem

Three complaints from running real work through the app, plus one latent
landmine that has now bitten three times.

**1. The 9B tier has a hole between 5.4 GB and 13 GB.** The lineup offers
`Qwen3.5-9B-IQ4_NL` (5.37 GB) and then jumps straight to
`Qwen3.5-9B-UD-Q8_K_XL` (12.97 GB) (`models.rs:135`, `:151`). The VRAM tier
table hands everything from 8 GB to 16 GB the IQ4_NL quant
(`hardware.rs:36`), so a 12 GB card — 3060 12GB, 4070, 5070, the largest
single slice of the desktop market — loads a 5.4 GB model and leaves about
5 GB of VRAM unused. Unsloth publishes exactly the quant that fits:
`UD-Q6_K_XL` at 8.76 GB.

**2. The dense 27B is a version behind, and the newer one can go faster.**
`Qwen3.6-27B-IQ4_NL` (`models.rs:182`) is superseded by Qwen 3.8 27B, which
is the same architecture at a near-identical footprint — 16.34 GB vs 16.07 GB,
same `qwen35` arch, 64 layers, 16 full-attention layers, 4 KV heads,
head_dim 256. It also ships something no other model in the lineup has: a
multi-token-prediction head bundled into the weights file, which llama.cpp
b9565 (our pin) can use as a self-speculative draft for a decode speedup.

**3. There is no way to ask a model to think less.** Guided-planning jobs run
against Qwen 3.8 27B and burn enormous reasoning budgets. The cause is not a
bug — it is an absence. That model's chat template reads a `reasoning_effort`
variable and **defaults it to `xhigh`** when nothing is sent:

```jinja
{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
    {{- raise_exception('Unexpected reasoning effort ...') }}
```

The app sends nothing, so every turn gets the model's most expensive mode by
default. `ReasoningMode` (`descriptor.ts:43`) models reasoning as either a
boolean chat-template kwarg or an OpenRouter effort string; there is no
variant for "a chat-template kwarg that takes a level", which is what this
model actually wants. The probe layer already *knows* about the mechanism —
`ReasoningCaps.toggle` is documented as possibly being `"reasoning_effort"`
(`inference.rs:106-108`) — and the client's response to seeing it is to send
nothing at all and note that it can't drive it (`descriptor.ts:268-276`).

**4. Latent: model identity is matched by substring in three places, and a
new version silently misses all three.** This is the same failure that
produced #195's postmortem, and shipping a `qwen3.8` id re-arms it:

- `kv_bytes_per_token` (`models.rs:343`) matches `Qwen3.6-27B`. A 3.8 id
  returns `None`, so `recommended_context_for` collapses to `MIN_CONTEXT`
  (8192) and `context_ceiling_for` returns `None`, making the Settings
  context cap fail open.
- `modelFamilyFromId` (`descriptor.ts:95`) matches `qwen3.5` / `qwen3.6`
  only. A `qwen3.8` id yields `qwenTuning: false` and — for remote and
  per-job overrides — `reasoningMode: {kind:'none'}`, i.e. no reasoning
  control reaches the model at all. This is verbatim the #195 bug.
- The sampling family is literally named `qwen3.6-27b` (`settings.ts:899`),
  so the correct profile for a dense 27B is keyed to a version string.

## What was verified, and how

Recorded so nobody re-derives it. All checks against the live HuggingFace
API and llama.cpp at our pinned tag `b9565` (`LLAMA_CPP_VERSION`).

**Quant sizes and hashes** — from the HF tree API (`/api/models/{repo}/tree/
main?recursive=true`); the LFS `oid` of a file *is* its sha256, which is how
the existing registry constants were derived.

| File | Bytes | sha256 |
|---|---|---|
| `Qwen3.5-9B-UD-Q6_K_XL.gguf` | 8_756_929_760 | `33b0050fb9c19abcf815647a78464dad959a06dadaecb0b96af798669f9074d4` |
| `Qwen3.8-27B-IQ4_NL.gguf` | 16_337_628_128 | `466c6714b0eca21c032690c801391a3c1e8f464ef01bbf420b70840027590c38` |
| `Qwen3.8-27B` `mmproj-F16.gguf` | 927_607_488 | `cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e` |

Note the mmproj is a **different file** from the 3.6-27B projector despite
being within 128 bytes of the same size (927_607_360 vs 927_607_488). Reusing
the existing constant would fail the sha check on download.

**Qwen 3.8 27B architecture** — from `config.json`: `full_attention_interval:
4`, 64 layers of which 16 are full attention, `num_key_value_heads: 4`,
`head_dim: 256`. Identical to the 3.6 dense 27B, so the existing per-token KV
figure of 34,816 bytes carries over unchanged
(`16 × 2 × 4 × 256 × 34/32`).

**Sampling** — the Unsloth card publishes thinking `temperature=1.0,
top_p=0.95, top_k=20, min_p=0.0, presence_penalty=0.0` and the same
non-thinking profile as the rest of the lineup. That is *exactly* the
existing `qwen3.6-27b` profile (`settings.ts:899`), so the swap needs a
rename, not new numbers.

**Reasoning effort** — the 3.8 27B chat template accepts exactly three
values, `low` / `medium` / `xhigh`, defaults to `xhigh`, and calls
`raise_exception` on anything else. The Qwen 3.5 and 3.6 templates have no
`reasoning_effort` variable at all — only `enable_thinking`. Effort is gated
*inside* the `enable_thinking` branch, so it is a second axis, not a
replacement for the on/off toggle, and there is no `none` level.

**Multi-token prediction** — I parsed the GGUF headers directly (HTTP range
read of the first 64 MB, which covers the full metadata block) for every
model in the lineup:

| GGUF | arch | blocks | `nextn` tensors |
|---|---|---|---|
| `Qwen3.8-27B-IQ4_NL` | qwen35 | **65** | **4** (`blk.64.nextn.*`) |
| `Qwen3.6-27B-IQ4_NL` | qwen35 | 64 | 0 |
| `Qwen3.6-35B-A3B-UD-IQ4_NL` | qwen35moe | 40 | 0 |
| `Qwen3.5-9B-IQ4_NL` | qwen35 | 32 | 0 |
| `Qwen3.5-9B-UD-Q6_K_XL` | qwen35 | 32 | 0 |

So **only the 3.8 27B ships an MTP head**, even though the 3.5 9B and 3.6 27B
HF configs both declare `mtp_num_hidden_layers: 1` — Unsloth's conversions
strip it for those. MTP must therefore be a per-model registry flag, never a
blanket server argument. `convert_hf_to_gguf.py:121-126` confirms the bundled
head is the converter's default and `--no-mtp` the opt-out.

**MTP is drivable from a single flag on our pin.** `--spec-type draft-mtp`
(`arg.cpp:3647`; the type name is `draft-mtp`, not `mtp`, per the name map in
`speculative.cpp:23-33`) is accepted by the server example. With no separate
draft model given, `server-context.cpp:961-970` creates the MTP draft context
against the *target* model — which is what makes a bundled head usable
without a second file.

## Goals

- A 12 GB card gets a model sized for it, not a 5.4 GB one.
- The dense 27B pick is Qwen 3.8, and the 3.6 27B keeps working for anyone
  who already downloaded 16 GB of it.
- Model identity is matched in one place with an explicit table, so the next
  version bump cannot silently disable the KV math, the sampling profile, and
  the reasoning control at once.
- Reasoning effort is selectable for chat, for shell, and per job, wherever
  the active model actually supports it — local, self-hosted remote, and
  OpenRouter alike — and the app never sends a level the model would reject.
- The default is **the model's own default**: with nothing chosen, the app
  sends no effort at all and behaves exactly as it does today. Upgrading
  changes no existing job's behavior.
- MTP is on for the model that has the head, off everywhere else, and
  switchable without editing config when a Vulkan bug makes it misbehave.

## Non-goals

- **Interrupting reasoning mid-thought.** llama.cpp offers both a hard token
  budget (`thinking_budget_tokens`, `server-common.cpp:1129`) and a live
  "stop thinking now" control endpoint (`POST /v1/chat/completions/control`
  with `{action:"reasoning_end"}`, `server.cpp:191`). Both were considered
  and **rejected by decision**: they force the think block closed at an
  arbitrary point, and a chain of thought spends much of its time entertaining
  candidates it is about to reject, so truncation disproportionately catches
  the model mid-wrong-idea and then forces it to answer from there. Effort
  tells the model up front and lets it plan a short chain that finishes
  properly. Revisit only if effort proves insufficient in practice.
- **Per-shell-session effort.** The shell has a per-session reasoning toggle
  (`shell.svelte.ts:165`) with no effort equivalent. Sessions inherit the
  global setting for now; per-context model selection is already tracked as
  futures item #2.
- **Re-tuning the sampling profiles.** Phase 01 renames a family and adds id
  patterns; the published numbers do not change.
- **Retiring the 3.6 35B-A3B or changing the 24 GB+ recommendation.** The
  sparse MoE stays the auto-recommendation; the dense 27B stays opt-in, as it
  is today.
- **Adding UD-Q5_K_XL (6.74 GB).** Considered for 10 GB cards; that
  population is small enough that a fourth 9B entry costs more in menu
  clutter than it returns.

## Shape

Three phases, three PRs. Phase 01 is a prerequisite for 03 (the MTP flag has
nowhere to live until the 3.8 entry exists). Phase 02 is independent of both
and is the one that addresses the actual token burn, so it can be pulled
forward if the lineup work stalls.

| Phase | Theme | Touches |
|---|---|---|
| [01](phase-01-lineup.md) | Add UD-Q6_K_XL, swap 3.6→3.8 27B, kill substring matching | `models.rs`, `hardware.rs`, `descriptor.ts`, `settings.ts` |
| [02](phase-02-reasoning-effort.md) | Effort as a first-class descriptor capability; Settings + per-job selectors | `descriptor.ts`, `settings.ts`, `inference.rs`, `modelAdvanced.ts`, `AgentSection`, `JobEditor`, `OpenRouterForm`, loop plumbing |
| [03](phase-03-mtp.md) | Per-model MTP flag, server arg, Settings toggle, VRAM allowance | `models.rs`, `server/mod.rs`, `server.svelte.ts`, `ModelsSection` |

## Decisions taken

Each closed off a plausible alternative; recorded so they aren't relitigated.

- **Effort only — no budget, no interrupt.** See non-goals. The acceptable
  form of "budget" — telling the model up front — *is* effort; this model's
  template exposes no numeric-budget variable, so effort is the whole of what
  ahead-of-time control can be here.
- **Default is the model's default (send nothing).** A stored `null` means no
  kwarg is sent. Defaulting to `medium` would fix the planning-job burn on day
  one but would silently change the behavior of every existing job on upgrade,
  which is a worse trade than one deliberate setting change.
- **Never send an unvalidated level.** Every effort value is checked against
  the active model's advertised levels before it goes on the wire, and dropped
  when it doesn't match. This is a correctness requirement, not politeness:
  Qwen 3.8's template raises on an unknown value, so a stale `high` left over
  from an OpenRouter model would 500 the whole turn rather than degrade.
- **One shared `reasoningEffort` setting, not one per backend kind.**
  OpenRouter's existing `openrouterReasoningEffort` (`settings.ts:176`)
  migrates into it. The cost is that switching between models with different
  vocabularies falls back to the model default; the validation rule above makes
  that safe, and one control beats two that mean the same thing.
- **The dense-27B sampling family is renamed, not duplicated.** Qwen 3.8's
  published profile is identical to Qwen 3.6's, so `qwen3.6-27b` becomes
  `qwen-dense-27b` and covers both.
- **3.6 27B is retired to `legacy_registry()`, not deleted.** It stays
  listed when on disk, switchable, and re-downloadable — the existing
  retirement contract (`models.rs:198-201`). Nobody loses a 16 GB download.
- **MTP is a per-model registry flag plus a user toggle, default on.** The
  GGUF survey above proves a blanket flag would be wrong. The toggle exists
  because Vulkan MTP is new: llama.cpp #26827 (`fix(mtp): serialize
  multi-ubatch decode`) is open, and #27237 reports Qwen3.5-27B producing
  garbage on Vulkan at batch 512. A bad interaction there looks like model
  corruption, and the user needs an escape hatch that isn't a JSON edit.
- **Model identity gets an explicit table.** Rather than adding a third
  `qwen3.8` substring arm to each matcher, phase 01 moves the per-model facts
  (KV bytes per token, sampling family, effort levels, MTP) to declared data.
  Three silent-failure sites is enough evidence.
