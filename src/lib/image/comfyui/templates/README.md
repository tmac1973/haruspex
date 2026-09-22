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

| Node     | Class                            | Bound to                             |
| -------- | -------------------------------- | ------------------------------------ |
| `1`      | `CheckpointLoaderSimple`         | `model`                              |
| `2`, `3` | `LoraLoader`                     | LoRA slots 0 and 1                   |
| `4`, `5` | `CLIPTextEncode`                 | `prompt`, `negativePrompt`           |
| `6`      | `EmptyLatentImage` / `LoadImage` | size, or the uploaded reference      |
| `7`      | `KSampler`                       | `seed`, sampler settings, `denoise`  |
| `8`      | `VAEDecode`                      | —                                    |
| `9`      | `SaveImage`                      | the output node                      |
| `10`     | `EmptyLatentImage`               | size, reference graphs only          |
| `11`     | `SeamlessTile`                   | seamless graphs only                 |
| `12`     | `IPAdapterUnifiedLoader`         | reference graphs only                |
| `13`     | `IPAdapterAdvanced`              | `referenceStrength` (adapter weight) |

Unused LoRA slots are **removed** from the graph and the chain spliced back to
node `1`. Zeroing their strength is not enough: ComfyUI validates `lora_name`
against the LoRAs actually installed, so a loader left behind with an empty
name is refused and takes the whole prompt down with it. On a server with no
LoRAs — which is most of them — that made every generation fail. Unit tests
passed on the zeroing version; the first real server rejected everything.

## Reference conditioning is IP-Adapter, not img2img

The reference graphs need
[`ComfyUI_IPAdapter_plus`](https://github.com/cubiq/ComfyUI_IPAdapter_plus)
plus a CLIP-vision encoder in `models/clip_vision/` and an adapter in
`models/ipadapter/`. That is one custom node pack and ~2.5GB of weights, and it
is not optional.

The obvious cheaper implementation is img2img: feed the reference in as the
latent, denoise partway. It was tried against a real server and it does exactly
what img2img does — it hands back the REFERENCE. Asked for "a green pear"
conditioned on a photo of an apple, at `denoise: 0.6`, it produced the apple.
There is no denoise value that gives a different subject in the same style:
raise it and the style goes, lower it and the subject comes back.

IP-Adapter injects the reference into the model's attention with
`weight_type: "style transfer"` and leaves composition entirely to the prompt,
so the graphs sample a fresh empty latent at `denoise: 1.0`. Measured on SD1.5:
`weight` 0.6 shifts the palette clearly while leaving the subject alone, 0.9 is
strong, and past that the reference's own forms start appearing in the output.

It transfers palette and feel more than fine rendering detail, which is why the
pipeline also quantizes to a shared palette and snaps to a pixel grid
afterwards. The adapter gets an image into the neighbourhood; the mechanical
pass is what makes a set uniform.

## `SeamlessTile` is not a core node

Neither `seamless.json` nor `seamless_reference.json` will run on a stock
ComfyUI: `SeamlessTile` comes from a custom node pack, and a server without it
rejects the prompt with `kind: 'rejected'` and the node's name in the message.
Seamless tiling is a declared capability precisely so this degrades per entry
rather than failing a run.

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
