# Bundled ComfyUI workflows

These API-format graphs were authored for Haruspex and carry the same licence
as the rest of this repository. `index.ts` records that per template, and a
test asserts it — a ComfyUI API graph has to parse as strict JSON, and JSON has
no comments, so the provenance cannot live in the files themselves.

They are grouped by **model family**, read from the configured model's
filename (`../families.ts`): a graph that loads an SD checkpoint cannot load a
DiT that ships its text encoder and VAE as separate files.

| File                     | Family         | Transparent | Seamless | For                             |
| ------------------------ | -------------- | ----------- | -------- | ------------------------------- |
| `txt2img.json`           | SD             | —           | —        | Plain generation                |
| `seamless.json`          | SD             | —           | yes      | Edge-wrapping terrain           |
| `ming_t2i.json`          | Ming-Image     | —           | —        | Plain generation                |
| `ming_t2i_rgba.json`     | Ming-Image     | yes         | —        | Sprites with real alpha         |
| `ming_t2i_seamless.json` | Ming-Image     | —           | yes      | Textures, by offset and inpaint |
| `qwen21_t2i.json`        | Qwen-Image-2.1 | by prompt   | —        | Both; alpha is a prompt wrapper |

Reference conditioning (IP-Adapter) is gone. It is UNet-only, neither DiT family
can use it, and phase 17 measured a Ming reference image as making sets less
consistent, not more (`plan/local-image-generation/measurements-phase-17.md`).

## Ming-Image makes alpha from a transparent start

Ming-Image-0.1-Design ignores its documented RGBA prompt prefixes — 0 of 20
prompts in ComfyUI, 0 of 3 in the public demo, and the same reported against the
vendor's own code (inclusionAI/Ming-Image#5). Its VAE round-trips alpha
exactly, so decoding is not the problem; the model simply does not steer to a
transparent latent from text.

It does when sampling starts from the latent of a transparent canvas **and**
the prompt carries one of the RGBA phrases — neither alone works (the start
without the phrase: 0 of 4 at seeds that gave 4 of 4 with it).
`ming_t2i_rgba.json` builds that canvas inside the graph — `EmptyImage` joined
with a `SolidMask` of 1.0, which `JoinImageWithAlpha` turns into alpha 0 —
encodes it, and denoises at 0.9. Measured: 10 of 10 sheets and 48 of 48 single
sprites transparent; 0.95 and 1.0 stay opaque. Building the canvas in the graph
was measured byte-identical to uploading a transparent PNG, and needs no upload.

Both Ming graphs pin `ModelSamplingFlux` at `max_shift` 1.35 with a 1024
reference size — the vendor's own flow shift from 1024 up. At 2048 ComfyUI's
stock extrapolated shift gives no alpha at all.

Both DiT families run their text encoder on the CPU (`CLIPLoader`
`device: cpu`). On a 16 GB card the encoder and the DiT cannot both stay
resident, and Qwen-Image-2.1's RGBA VAE then runs out of memory at decode. The
cost is about a minute per distinct prompt; sampling is unaffected.

## SD graphs: shape

Both SD graphs descend from `txt2img.json` and keep its node ids, which is what
lets `index.ts` share one set of bindings:

| Node     | Class                    | Bound to                   |
| -------- | ------------------------ | -------------------------- |
| `1`      | `CheckpointLoaderSimple` | `model`                    |
| `2`, `3` | `LoraLoader`             | LoRA slots 0 and 1         |
| `4`, `5` | `CLIPTextEncode`         | `prompt`, `negativePrompt` |
| `6`      | `EmptyLatentImage`       | size                       |
| `7`      | `KSampler`               | `seed`, sampler settings   |
| `8`      | `VAEDecode`              | —                          |
| `9`      | `SaveImage`              | the output node            |
| `11`     | `SeamlessTile`           | seamless graph only        |

Unused LoRA slots are **removed** from the graph and the chain spliced back to
node `1`. Zeroing their strength is not enough: ComfyUI validates `lora_name`
against the LoRAs actually installed, so a loader left behind with an empty
name is refused and takes the whole prompt down with it. On a server with no
LoRAs — which is most of them — that made every generation fail. Unit tests
passed on the zeroing version; the first real server rejected everything.

## Seamless tiling needs a node pack, and needs BOTH halves

`seamless.json` requires
[`ComfyUI-seamless-tiling`](https://github.com/spinagon/ComfyUI-seamless-tiling).
A server without it rejects the prompt with `kind: 'rejected'` and the node's
name in the message; seamless tiling is a declared capability precisely so that
degrades per entry rather than failing a run.

Two nodes, not one, and the second is the one that is easy to miss:

- `SeamlessTile` switches the model's convolutions to circular padding.
- `CircularVAEDecode` replaces `VAEDecode` and does the same for the decode.

A graph with only the first **validates, runs, and produces an image that does
not tile** — a silent quality failure rather than an error. Measured on a
cobblestone texture, comparing the wrap edges against two adjacent interior
columns of the same image:

|           | wrap L\|R | wrap T\|B | interior baseline |
| --------- | --------- | --------- | ----------------- |
| no tiling | 43.5      | 36.4      | 20.1 / 21.5       |
| seamless  | 16.2      | 23.5      | 21.1 / 20.6       |

An image tiles when its wrap error is no worse than its own interior — the
control is twice as discontinuous at the edges as it is anywhere else, and the
tiled versions are at or below baseline. That comparison is the test to re-run
if this ever regresses; a visual check at tile scale is not sensitive enough.

## Editing one

Change a graph and you must change `index.ts` with it. `validateFieldMap` runs
over every bundled pair in the test suite precisely to catch a template edited
out of sync with its map — a binding that names a missing node or input is an
error, because the alternative is a perfectly good picture generated with
default parameters, which looks exactly like success.

## Using your own instead

Set **Settings → Image → Custom workflow** to an API-format export plus a field
map in the same shape as `index.ts`'s. Both or neither: one without the other
fails the probe. A custom workflow replaces all the bundled ones, never claims
transparency (there is no way to ask a graph how it would make alpha), and its declared
`supports` decides what `capabilities()` reports — a graph with no LoRA slots
reports `loras: false`, and the asset job degrades rather than silently
dropping them.

## `SeamlessTile`

The seamless graphs use a `SeamlessTile` node to switch the model's convolution
padding to circular. It is not part of core ComfyUI; a server without it will
reject the prompt, which surfaces as `ImageBackendError` with `kind: 'rejected'`
and the server's own message. Seamless generation is a declared capability, so
a backend that cannot do it degrades per entry with the reason recorded.

## Ming-Image tiles by offset and inpaint

Circular padding is a UNet trick and does nothing for a DiT. `ming_t2i_seamless.json`
generates as `ming_t2i.json` does, then, in the same graph:

1. rolls the image by half in both axes (four `ImageCrop` quadrants pasted back
   diagonally opposite), so the wrap seams cross in the middle and the new
   edges — the old middle — wrap by construction;
2. repaints a cross a quarter of the size wide over the seams, at denoise 1.0,
   with `DifferentialDiffusion` and a mask built at an eighth of the size,
   blurred and scaled up, so the repaint fades into what is kept;
3. pastes the repaint back through the same mask and saves that.

A border Ming draws round a texture ends up in the cross and is repainted away.
Measured in phase 23 against a hard-edged band (the repaint showed as a stripe
of a different tone), a 0.9 denoise (the old border survived) and an eighth-wide
band (lane markings broke): `plan/local-image-generation/measurements-phase-23.md`.
It costs a second sampling pass.
