# Bundled ComfyUI workflows

These four API-format graphs were authored for Haruspex and carry the same
licence as the rest of this repository. `index.ts` records that per template,
and a test asserts it — a ComfyUI API graph has to parse as strict JSON, and
JSON has no comments, so the provenance cannot live in the files themselves.

| File                      | Reference | Seamless | For                               |
| ------------------------- | --------- | -------- | --------------------------------- |
| `txt2img.json`            | —         | —        | Plain generation                  |
| `reference.json`          | yes       | —        | Conditioned on the style anchor   |
| `seamless.json`           | —         | yes      | Edge-wrapping terrain             |
| `seamless_reference.json` | yes       | yes      | Terrain conditioned on the anchor |

The fourth is not redundant. A terrain entry is generated seamless _and_
conditioned on the anchor, so a three-template set would make selection pick
one and drop the other — while `capabilities()` still reported reference
conditioning, so nothing would record a degradation and the texture half of
every set would quietly lose its style.

## Shape

Every graph descends from `txt2img.json` and keeps its node ids, which is what
lets `index.ts` share one set of bindings:

| Node     | Class                            | Bound to                            |
| -------- | -------------------------------- | ----------------------------------- |
| `1`      | `CheckpointLoaderSimple`         | `model`                             |
| `2`, `3` | `LoraLoader`                     | LoRA slots 0 and 1                  |
| `4`, `5` | `CLIPTextEncode`                 | `prompt`, `negativePrompt`          |
| `6`      | `EmptyLatentImage` / `LoadImage` | size, or the uploaded reference     |
| `7`      | `KSampler`                       | `seed`, sampler settings, `denoise` |
| `8`      | `VAEDecode`                      | —                                   |
| `9`      | `SaveImage`                      | the output node                     |
| `10`     | `VAEEncode`                      | reference graphs only               |
| `11`     | `SeamlessTile`                   | seamless graphs only                |

Unused LoRA slots have both strengths set to 0 on every request, so a template
never applies a LoRA the caller did not ask for.

## Editing one

Change a graph and you must change `index.ts` with it. `validateFieldMap` runs
over every bundled pair in the test suite precisely to catch a template edited
out of sync with its map — a binding that names a missing node or input is an
error, because the alternative is a perfectly good picture generated with
default parameters, which looks exactly like success.

## Using your own instead

Set **Settings → Image → Custom workflow** to an API-format export plus a field
map in the same shape as `index.ts`'s. Both or neither: one without the other
fails the probe. A custom workflow replaces all four, and its declared
`supports` decides what `capabilities()` reports — a graph with no LoRA slots
reports `loras: false`, and the asset job degrades rather than silently
dropping them.

## `SeamlessTile`

The seamless graphs use a `SeamlessTile` node to switch the model's convolution
padding to circular. It is not part of core ComfyUI; a server without it will
reject the prompt, which surfaces as `ImageBackendError` with `kind: 'rejected'`
and the server's own message. Seamless generation is a declared capability, so
a backend that cannot do it degrades per entry with the reason recorded.
