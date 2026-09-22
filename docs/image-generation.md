# Image generation

Haruspex can generate images through a local diffusion backend. Two are
planned: **ComfyUI**, which you run yourself, and a bundled **sd-server**
(stable-diffusion.cpp) that needs no separate install. Only the first is wired
up today; this page records what the second is pinned to and how to refresh it.

## The bundled sd-server binary

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

### What is not here yet

The bundled engine has never generated an asset through a full job run; phase
15 is where the local path is verified end to end.
