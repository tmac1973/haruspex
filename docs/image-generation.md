# Image generation

Haruspex generates game art from a short description, through a diffusion
model running on your own machine. Nothing is sent anywhere and nothing starts
until you opt in.

## Choosing a backend

Settings → Image offers two, and they are genuinely different trades.

**ComfyUI** talks to a server you run. Pick it if you already have ComfyUI, or
want custom workflows, IP-Adapter and node packs the bundled engine does not
have. It is the only backend that currently provides all three coherence
layers (see below).

One caveat, and it bites immediately: ComfyUI rejects any request carrying an
`Origin` header with a flat 403, and a webview always sends one. Start it with
`--enable-cors-header` or Haruspex cannot reach it. A narrow origin is safer
than the default `*`, which lets any page you visit drive your ComfyUI.

**Bundled engine** is stable-diffusion.cpp, shipped with Haruspex. Pick it if
you want image generation with nothing to install. It starts on demand, stops
when you say, and reports honestly that it cannot do reference conditioning —
the job degrades around that rather than pretending.

**None** is the default. No process, no download, no startup cost.

## The asset job

Create a job of type **Asset generation**, point it at a project directory,
and either write a spec or describe what you want and let the run write one.

### The spec

One JSON file in your project, and the contract between you, guided planning
and the job. A minimal one:

```json
{
  "version": 1,
  "style": {
    "prompt": "16-bit pixel art, flat shading, bold dark outline, muted palette",
    "negativePrompt": "photo, 3d render, gradient shading"
  },
  "anchor": {
    "image": "assets/haruspex-anchor.png",
    "recipe": "assets/haruspex-anchor.json"
  },
  "normalize": { "target_size": 32, "upscale": 32, "palette_size": 32 },
  "entries": [
    { "id": "iron_sword", "kind": "sprite", "prompt": "an iron sword",
      "out": "assets/generated/sprite/iron_sword.png" },
    { "id": "cobblestone", "kind": "texture", "prompt": "grey cobblestone floor",
      "out": "assets/generated/texture/cobblestone.png", "seamless": true }
  ]
}
```

`style.prompt` is appended to every entry and is what makes the set cohere.
`kind` decides how the image is treated: a `sprite` or `icon` is isolated on a
flat background which is then keyed out, a `texture` is meant to fill its
frame and is neither cropped nor outlined. `id` is what your code will load
the asset by, so it is validated rather than invented — a run refuses an id it
cannot use instead of quietly tidying it into one your code does not name.

`upscale` must suit the model: generation happens at `target_size * upscale`,
and SD1.5 degrades above 512 while SDXL produces artefacts below 1024. A 32px
target wants 16 on SD1.5 and 32 on SDXL.

### The style anchor, and why it is committed

The first thing a run produces is one reference sheet showing several of the
spec's own subjects, in the spec's style. Every asset is then generated
conditioned on it, and the palette is extracted from it.

Both the image and the recipe that made it are written into your project and
should be committed. That is the point: the style becomes a versioned artifact
rather than something reconstructed from a recipe against model weights and
node versions that will have moved. Adding ten sprites next month matches the
hundred already shipped because it is literally the same reference image.

A run reuses a committed anchor and does not regenerate it. To change the
style deliberately, delete `haruspex-anchor.png`.

### Adding assets later

Add entries to the spec and run the job again. Entries whose output file
already exists are skipped, so only the new ones are generated — and they are
conditioned on the same committed anchor, so they match.

To regenerate a few, delete exactly those files and re-run.

## The three coherence layers

A set looks like a set because of three independent mechanisms, not one:

1. **Reference conditioning** — each asset is generated conditioned on the
   anchor. Needs IP-Adapter; the bundled engine reports this as unavailable.
2. **A shared palette** — every asset is quantized to colours extracted from
   the anchor. Mechanical, and works on any backend.
3. **A shared pixel grid** — every asset is downscaled to the same target size
   by the same modal downscale. Also mechanical.

Layers 2 and 3 do not depend on the model behaving, which is why a backend
missing layer 1 still produces a usable set. When a layer is unavailable the
report says which, per asset, rather than silently producing worse art.

## Reading a report

Each run writes `REPORT-assets.md` and `contact-sheet.png` beside the spec.

- **Degraded** names each coherence layer the backend could not provide and
  which assets it cost. Those assets were still made; they may match less
  closely.
- **Not produced** names each asset that never passed its checks, with the
  reason and the closest attempt. **Nothing is written for these** — a
  half-good PNG on disk would be skipped by the next run and never retried, so
  re-running retries exactly them.
- **Licensing** states the base model's licence, and lists any LoRA as licence
  unknown. See below.
- **The contact sheet** is the artifact to actually look at. Whether the set
  reads as one game is the criterion the whole feature exists for, and it is
  the one thing no check can answer.

## Licensing

Both catalogue models permit commercial use. The trap is not the base model.

`style.loras` lets a spec name LoRAs, and most published pixel-art LoRAs carry
their own terms — many were trained on art their author did not own. A LoRA
can therefore contaminate output whose base model is perfectly clean.

Haruspex cannot classify a file you supply, so it does not pretend to: the
report names every LoRA as **licence unknown**, and a checkpoint Haruspex did
not provide is reported as unknown too rather than given the benefit of the
doubt. Generated images are generally not copyrightable in their own right,
and some storefronts require AI-generated content to be disclosed.

## The manual checklist

Two of this feature's success criteria cannot be tested, and are checked by
hand. `endToEnd.test.ts` records which and why.

1. **Does the contact sheet read as one game?** Open it. If not, name the
   layer that failed — reference conditioning, palette, or grid.
2. **Delete ten outputs and re-run: do the ten that come back match?** The
   mechanical half is tested (reuse makes no backend call, exactly the missing
   files regenerate, the palette is restored). Whether they MATCH is a
   judgement.

Live end-to-end checks are opt-in so CI never reaches for a GPU:

```bash
HARUSPEX_IMAGE_E2E=1 HARUSPEX_IMAGE_BACKEND_URL=http://127.0.0.1:8188 \
  npx vitest run endToEnd
```

## The bundled sd-server binary

Reference material for maintainers below; nothing here is needed to use the
feature.

| | |
| --- | --- |
| Upstream | [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) |
| Pinned version | `master-890-74988b2` |
| Acquired by | `./scripts/fetch-sdcpp.sh` (a download, not a build) |
| Lands at | `src-tauri/binaries/sd-server-<triple>` |
| Its libraries | `src-tauri/binaries/sd-libs/` |
| Reserved port | 8767 |

Upstream publishes no semver tags — releases are named `master-<n>-<sha>` — so
the pin is one of those. It is recorded in exactly two places, the
`SDCPP_VERSION` line at the top of `scripts/fetch-sdcpp.sh` and the table
above, and `scripts/check-constants.mjs` fails the build if they disagree.

### Why it is downloaded rather than built

`llama-server` and `whisper-server` are compiled from source because upstream
did not publish binaries covering our triples when they were added. sd-server
does: every release ships a Vulkan build for Linux x86_64 and Windows x64 and a
Metal build for macOS arm64, each containing `sd-server` itself. Downloading a
release asset pins the exact bytes, matches how `pdfium`, `ruff`, `uv` and
`node` are already fetched, and saves every developer and CI run a multi-minute
Vulkan shader compile.

### Why its libraries live in their own directory

`sd-libs/` is not tidiness. The release ships its own ggml family —
`libggml-base.so`, `.so.0` and `.so.0.19.0` — and `binaries/libs/` already
holds llama.cpp's, whose unversioned and `.so.0` names are **identical** while
the version behind them is not (0.22.0). Putting them in the same directory
would overwrite the soname `llama-server` resolves at load time with an older
ggml, and break the LLM sidecar in a way that looks nothing like an
image-generation change. whisper.cpp only survives sharing that directory
because its ggml files happen to carry distinct versioned names.

Two consequences for whoever wires the process up:

- `scripts/link-sidecar-libs.sh` deliberately does **not** flatten `sd-libs/`
  into `target/debug/`. Doing so reintroduces exactly the collision above.
- ggml discovers its compute backends by scanning the directory containing
  `/proc/self/exe`, so `sd-server` **must be launched from a directory that
  holds its own libraries**. `LD_LIBRARY_PATH` alone is not enough; it
  resolves the direct links but not the backend scan. Measured on this
  machine:

  | Launch | Result |
  | --- | --- |
  | From `binaries/`, `LD_LIBRARY_PATH=sd-libs` | `No devices found!` — no backend at all |
  | `GGML_BACKEND_PATH=sd-libs` (a directory) | `cannot read file data: Is a directory` |
  | `GGML_BACKEND_PATH=…/libggml-vulkan.so` | Vulkan loads, then `backend 'cpu' was not found` |
  | Binary placed **inside** `sd-libs/` | Vulkan + `libggml-cpu-zen4.so` both load; GPU detected |

  `GGML_BACKEND_PATH` names a single backend file, so it cannot stand in for
  the scan: ggml picks the CPU backend by microarchitecture from among a dozen
  `libggml-cpu-*.so` variants, and hardcoding one would pin the build to a
  chip. The supervisor therefore places the binary beside the libraries and
  spawns it there.

- `LD_LIBRARY_PATH` must list `sd-libs/` **before** the executable's own
  directory, which is the opposite of what `sidecar_utils::library_paths`
  does for every other sidecar. In a dev tree `target/debug` carries
  llama.cpp's `libggml-base.so.0`, and with the usual ordering `ldd` resolves
  sd-server against it — an older ABI under an identical soname.

### Refreshing the pin

```bash
# 1. Edit SDCPP_VERSION in scripts/fetch-sdcpp.sh and the table above.
./scripts/fetch-sdcpp.sh          # re-downloads; the version stamp forces it
./scripts/sdcpp-capabilities.sh   # regenerate the committed fixture
git diff src/lib/image/local/capabilities.json
```

The fixture is committed on purpose. The local backend declares its
capabilities from that file rather than asserting them in TypeScript, so a
version bump that drops a feature shows up as a diff and a failing test instead
of a job that silently stops degrading and starts shipping bad output.

### What the fixture does and does not establish

`sdcpp-capabilities.sh` reads `--help` and the binary's own route table. Both
are deterministic and neither needs model weights, which this stage of the work
deliberately does not download. Flag presence means the feature was **compiled
in** — not that it works against any particular checkpoint. The server reports
the second at runtime on `/sdcpp/v1/capabilities` once a model is loaded.

The pinned build reports:

| Capability | Flag |
| --- | --- |
| Reference conditioning | `--ip-adapter` (with `--clip_vision`) |
| Seamless tiling | `--circular` |
| LoRAs | `--lora-model-dir` |

It serves three HTTP APIs: its own `/sdcpp/v1/*`, an AUTOMATIC1111-compatible
`/sdapi/v1/*`, and an OpenAI-compatible `/v1/images/*`.

## Models

Two curated checkpoints, both single-file and both UNet:

| Model | Licence | Commercial | Native edge | Size |
| --- | --- | --- | --- | --- |
| Stable Diffusion 1.5 | CreativeML OpenRAIL-M | yes | 512 | 2.1 GB |
| Stable Diffusion XL 1.0 | CreativeML OpenRAIL++-M | yes | 1024 | 6.9 GB |

Every checksum and size in the catalogue was read from the publisher's own
object metadata rather than quoted, and SD1.5's was confirmed byte-for-byte
against a downloaded copy.

`native_edge` is not decoration. A normalize profile's `upscale` is only
meaningful relative to it: SD1.5 degrades above 512 and SDXL produces
artefacts below 1024, so a 32px target wants `upscale: 16` on one and `32` on
the other. Measured — an SDXL sprite sheet generated at 512 comes out as mush.

### Why only these two

**UNet.** Two of the three coherence layers — IP-Adapter reference
conditioning and circular-padding seamless tiling — are UNet techniques that
do not carry to a DiT. A Flux, Qwen or Z-Image entry would ship with two of
three layers reporting false. The DiT remedy for tiling is offset-and-inpaint
(shift the tile by half, inpaint the seams, shift back), which is real work
rather than a flag.

**Single file.** Flux and SD3.5 need separate text encoders and a VAE
alongside the diffusion weights — three or four downloads per model and a
different shape of catalogue entry.

Deliberately excluded, so the decision is not revisited by accident: SD3.5
(Stability community licence, revenue threshold), Bria FIBO (non-commercial),
FLUX.1-dev and FLUX.2-dev (non-commercial weights; FLUX.2-dev requires a paid
commercial licence).

### The LoRA is the licensing trap

`AssetStyle.loras` lets a spec name LoRAs, and most published pixel-art LoRAs
carry their own terms — many were trained on art their author did not own. A
LoRA can therefore contaminate output whose base model is perfectly clean.

Haruspex cannot classify a file the user supplies, so it does not pretend to:
every run report carries a Licensing section naming the base model's licence,
and any LoRA the spec named is listed as **licence unknown** beside it. A
checkpoint Haruspex did not provide — a hand-placed file, or whatever ComfyUI
has configured — is reported as unknown too, rather than given the benefit of
the doubt.

### What is verified, and what is not

Verified against a running engine: SD1.5 loads from a co-located binary,
Vulkan and the CPU backend both register, `/sdcpp/v1/capabilities` answers
200, and `/sdapi/v1/txt2img` returns `images` as base64 with `info` as a JSON
string carrying the resolved seed.

NOT yet verified: a full asset job end to end against the bundled engine, and
anything at all on macOS or Windows. Those are hand checks — see the manual
checklist above.
