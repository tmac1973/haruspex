# Phase 02 — Reasoning Effort as a First-Class Capability

Adds a reasoning-effort selector to Settings → Agent and to the job editor,
driven by what the active model actually advertises, for local, self-hosted
remote, and OpenRouter backends alike. Independent of phases 01 and 03 — it
can land first if the lineup work stalls, and it already helps the Qwen 3.8
27B reached through a per-job llama-toolchest override today.

## The shape of the problem

Reasoning has two independent axes, and the code currently models only one of
each kind:

| Axis | Wire form | Modeled today |
|---|---|---|
| On / off | `enable_thinking` kwarg, or OpenRouter `effort: 'none'` | Yes — `thinkingEnabled` + `ReasoningMode` |
| How hard | `reasoning_effort` kwarg, or OpenRouter `effort: <level>` | OpenRouter only |

Qwen 3.8 27B needs **both at once**, in the same `chat_template_kwargs`
object: its template gates effort *inside* the `enable_thinking` branch. So
effort is an addition to the existing kwarg payload, not a replacement for it,
and there is no `none` level to express "off" with.

The vocabulary is per-model and non-negotiable: `low` / `medium` / `xhigh`
here, `none` / `low` / `medium` / `high` on most OpenRouter models. The Qwen
template calls `raise_exception` on anything outside its three, which
llama-server surfaces as a 500 for the whole request. **An effort value that
isn't in the model's advertised list must never reach the wire.** That
single rule drives most of the design below.

## Steps

### 1. Descriptor: carry the vocabulary

New capability type in `descriptor.ts`, exported for the UI:

```ts
export interface EffortCaps {
	/** How the level travels: chat-template kwarg, or OpenRouter's param. */
	transport: 'template-kwarg' | 'openrouter';
	/** Kwarg name for `template-kwarg` transport; null for OpenRouter. */
	kwarg: string | null;
	/** Exactly the levels this model accepts, in display order. */
	levels: string[];
	/** What the model does when no level is sent — labels the default option. */
	modelDefault: string | null;
	/** OpenRouter only: model always reasons, rejects `none`, effort locked. */
	mandatory: boolean;
}
```

`BackendDescriptor` gains `reasoningEffort: EffortCaps | null`, where `null`
means "no effort control — hide the selector". The existing `ReasoningMode`
union is unchanged: it stays the on/off transport, and for OpenRouter its
`effort` field continues to carry the *resolved* value. `EffortCaps` carries
the *vocabulary*. Keeping them separate avoids a second place that decides
what to send.

Resolution per backend, all inside the resolver (nothing else may sniff):

- **Local** (`resolveLocalDescriptor:193`) — from the `MODEL_TRAITS` table
  phase 01 introduces, keyed on the active GGUF filename. Qwen 3.8 27B is the
  only lineup entry with an entry; everything else is `null`.
- **Remote, llama-toolchest** (`resolveRemoteDescriptor:212`) — from the probe
  caps (step 3). If the server reports `toggle: "reasoning_effort"` but
  enumerates no levels, fall back to the traits table on the model id; if that
  misses too, `null`. Never guess a vocabulary.
- **Remote, other backends** — traits table on `remoteModelId`, same as the
  sampling family already does.
- **OpenRouter** — from the catalog entry already in hand at
  `descriptor.ts:228`: `supported_efforts` → `levels`, `default_effort` →
  `modelDefault`, `mandatory` → `mandatory`.
- **Per-job override** (`resolveOverrideDescriptor:297`) — the override's own
  persisted probe caps first, then the traits table on its model id. Mirrors
  `overrideReasoning` (`descriptor.ts:278`) exactly, and for the same reason:
  a job pointed at server X must not inherit server Y's capabilities.

The traits-table fallback is what makes this useful **today**, before any
server-side work: the overnight jobs reach Qwen 3.8 27B through a toolchest
override whose model id contains `Qwen3.8-27B`, which the table matches.

### 2. Settings: one shared `reasoningEffort`

```ts
/**
 * Reasoning effort level, or null for "let the model decide" (send nothing).
 * Validated against the active model's advertised levels at request time —
 * a level left over from a different model is dropped, never sent.
 */
reasoningEffort: string | null;
```

Default `null` — **the decided default**. With nothing chosen the app sends no
effort kwarg and behaves exactly as it does today, so upgrading changes no
existing job's behavior.

`openrouterReasoningEffort` (`settings.ts:176`, default at `:432`) migrates
into it: on settings load, if `reasoningEffort` is absent and
`openrouterReasoningEffort` is set, adopt the latter. Keep reading the old key
for one release, then delete. One shared setting means switching from a local
Qwen to an OpenRouter model can leave a level the new model doesn't know —
which the validation rule in step 4 turns into a silent, safe fallback to the
model default rather than a 500.

### 3. Probe: let a server enumerate its levels

`ReasoningCaps` (`inference.rs:111`) gains two optional fields:

```rust
/// Levels this model's template accepts, when the server enumerates them.
/// `None` means the server named a mechanism without saying what it takes —
/// the client must not guess, because an unknown value is a hard template
/// error, not a degraded response.
pub effort_levels: Option<Vec<String>>,
/// What the model does when no effort is sent.
pub default_effort: Option<String>,
```

Parsed tolerantly in `parse_capabilities` (`inference.rs:554`) in the style of
its neighbours — accept `effort_levels` or `levels`, `default_effort` or
`effort_default`, and drop non-string array members.

These types are hand-mirrored rather than generated (`ReasoningCaps` derives
`Serialize` only, no `ts_rs`), so update `RemoteReasoningCaps`
(`settings.ts:89`) and the defensive parser `parseReasoningCaps`
(`modelAdvanced.ts:159`) to match. The parser must keep degrading to a valid
object on garbage — it reads JSON out of user databases during unattended
runs.

llama-toolchest doesn't report these yet; that's a server-side follow-up, and
until it lands the traits-table fallback covers the models we care about.

### 4. Request path: one resolver, two asymmetric consumers

A single validation helper, alongside `resolveThinking` (`settings.ts:991`):

```ts
/**
 * The effort level to send, or null for "send nothing / model default".
 * A stored level that isn't in `caps.levels` resolves to null: vocabularies
 * are per-model, and Qwen 3.8's template raises on an unknown value, which
 * llama-server returns as a 500 for the whole turn. Dropping an unusable
 * level costs one setting; sending it costs the request.
 */
function resolveEffort(caps: EffortCaps | null, override?: string | null): string | null
```

`getChatTemplateKwargs` (`settings.ts:795`) adds the effort kwarg next to the
thinking kwarg when the descriptor has `template-kwarg` caps and the value
resolves, producing `{enable_thinking: true, reasoning_effort: 'medium'}` in
one object. When it resolves to null the key is simply absent and the model's
own default applies.

`getOpenRouterReasoningParam` (`settings.ts:818`) keeps today's behavior on
the null path: it continues to send the catalog's `default_effort` rather than
omitting `reasoning` entirely. **This asymmetry is deliberate** — omitting the
kwarg for llama.cpp and sending the catalog default for OpenRouter are both
"what happens today with no selection", and changing OpenRouter's wire shape
would be an unrelated behavior change riding along in this phase. The
`mandatory` and thinking-off rules there are untouched.

### 5. Per-job override

`ReasoningOverride` (`modelAdvanced.ts:37`) grows a second dimension:

```ts
export interface ReasoningOverride {
	/** 'inherit' = use the global thinkingEnabled setting. */
	mode: 'inherit' | 'on' | 'off';
	/** null = inherit the global effort selection. */
	effort: string | null;
}
```

`parseReasoning` (`modelAdvanced.ts:117`) must accept **both** the legacy bare
string (`"on"` / `"off"` / `"inherit"`) and the new object — jobs configured
before this phase are on disk, and a shape change that degrades them to
`inherit` would silently turn reasoning back on for a job whose owner turned
it off. Update the `isDefault` check in `serializeModelAdvanced` so an
untouched job still stores `NULL`.

`runner.svelte.ts:74` maps `mode` to `thinkingEnabled` as it does now, and
passes `effort` alongside. Thread it exactly where `thinkingEnabled` already
goes: `EphemeralTurnOptions` (`runEphemeralTurn.ts:53`) → `AgentLoopOptions`
(`loop.ts:243`) → `IterationContext` (`iteration.ts:106`, set at `:182`) →
the `getChatTemplateKwargs` calls at `iteration.ts:523`, `:747`, `:1329` and
the `getOpenRouterReasoningParam` calls at `:524`, `:590`, `:748`.

Chat and shell pass nothing and pick up the global setting inside the
resolver, the same way they do for thinking today.

### 6. UI

**Settings → Agent** (`AgentSection.svelte`): a select below the existing
"Reasoning mode" toggle, gated on `descriptor.reasoningEffort !== null` and
snapshotted at mount like `reasoningSupported` (`AgentSection.svelte:19`).
Options are `Model default (xhigh)` followed by the advertised levels.
Disabled while reasoning is off, with a hint saying so — the levels are
meaningless when the think block is skipped entirely.

**OpenRouter form** (`OpenRouterForm.svelte:217`): the existing dropdown now
reads and writes the shared setting, and gains the same "Model default"
option. `autoModelFields` (`:87`) currently force-sets the effort on every
model pick; it should instead **clear to null** when the newly picked model
doesn't advertise the currently-selected level, which is the same validation
rule expressed at pick time so the UI never displays a level the model will
refuse.

**Job editor** (`JobEditor.svelte:955`): an effort select beside the existing
Reasoning select, options `Inherit` + the job descriptor's levels, shown only
when the job's resolved caps are non-null. Extend `reasoningCapsNote`
(`:322`) with the new failure it can now describe: *"This server reports a
`reasoning_effort` control but doesn't say which levels it accepts, so effort
can't be set from here."* That is a real, distinct state from "no reasoning
mode" and "a toggle we can't drive".

### 7. Tests

- `descriptor.test.ts` — `reasoningEffort` for each backend kind: local 3.8
  27B, remote toolchest with enumerated levels, remote toolchest reporting
  `reasoning_effort` with **no** levels (falls back to the id table, then
  null), plain remote by model id, OpenRouter from catalog, and a per-job
  override resolving from its own persisted caps.
- `settings.test.ts` — `getChatTemplateKwargs` emits both keys in one object;
  a stored level absent from `caps.levels` is dropped; `null` emits no effort
  key at all; the OpenRouter null path still sends `default_effort`; thinking
  off still wins over any effort selection.
- `modelAdvanced.test.ts` — a legacy bare-string `reasoning` value parses to
  the equivalent object; an unknown shape degrades to
  `{mode:'inherit', effort:null}`; round-tripping an untouched config still
  serializes to `null`.
- Rust — `parse_capabilities` reads `effort_levels`/`default_effort` in both
  accepted spellings and tolerates non-string members.

## Verification

- Local Qwen 3.8 27B, same prompt at each level: capture reasoning-token
  counts from the per-step stats that #196 added. Expect a clear monotonic
  drop; if `low` and `xhigh` produce the same counts the kwarg isn't landing.
- Confirm with llama-server's request log that `chat_template_kwargs` carries
  both keys, and that switching to a Qwen 3.5 model sends `enable_thinking`
  alone with no effort key.
- Deliberately store an invalid level (e.g. set `high`, then switch to the
  Qwen model) and confirm the turn succeeds with no effort sent — **not** a
  500. This is the one that matters; it is the failure this design exists to
  prevent.
- A guided-planning job at `medium`, compared against its own history, is the
  end-to-end check that prompted the work.
