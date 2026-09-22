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
- ggml discovers its compute backends relative to `/proc/self/exe`, so
  launching `sd-server` needs more than `LD_LIBRARY_PATH` pointing at
  `sd-libs/` — the binary has to be able to find `libggml-vulkan.so` beside
  itself. That is the supervising code's problem to solve, and it is the first
  thing to get wrong.

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

### What is not here yet

Nothing starts this binary. There is no sidecar registration, no settings, no
model download, and no code path that reaches it — a user who never opts in
sees no change at all beyond a larger install.
