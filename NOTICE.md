# Third-Party Notices

This file lists third-party assets bundled with Haruspex and the licenses they
are distributed under. The Haruspex source code itself is licensed separately,
under the **GNU General Public License v3.0 or later** — see `LICENSE` and the
License section of `README.md`.

## Application icon

The Haruspex application icon is derived from a photograph of the
**Piacenza Bronze Liver** (Italian: _Fegato di Piacenza_) — an Etruscan bronze
artifact used by haruspices as a divination reference, c. 100 BCE.

- **Source image**: <https://commons.wikimedia.org/wiki/File:Piacenza_Bronzeleber.jpg>
- **Photographer / author**: Lokilech
- **License**: [Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0)](https://creativecommons.org/licenses/by-sa/3.0/)

### Modifications

The original photograph was modified to produce the application icon:

1. The white photographic background was removed (alpha cutout via ImageMagick).
2. The image was trimmed to its bounding box and padded with transparency to a
   square aspect ratio.
3. The result was downscaled to 1024×1024 PNG and used as the source for the
   Tauri icon set in `src-tauri/icons/`.

The 1024×1024 master used to regenerate the platform icon set is committed at
`src-tauri/icons/master.png`. To regenerate the full set after editing it, run:

```bash
npx tauri icon src-tauri/icons/master.png
```

### License inheritance

Because CC BY-SA 3.0 is a copyleft license, the derived icon files
(`src-tauri/icons/master.png` and every file generated from it inside
`src-tauri/icons/`) are themselves licensed under CC BY-SA 3.0, separate from
the license of the rest of the Haruspex source tree. Anyone redistributing
Haruspex or its icon assets must preserve this attribution and license notice.

## Bundled runtimes

Haruspex bundles Node.js and `uv` so that MCP servers — third-party programs
published to npm and PyPI — can be installed and launched without asking the
user to install a toolchain. The pinned versions live in `NODE_VERSION` and
`UV_VERSION` at the repository root; `scripts/fetch-node.sh` and
`scripts/fetch-uv.sh` download them from the upstream releases unmodified.

| Component | Upstream | License |
|---|---|---|
| Node.js | <https://nodejs.org/> | [MIT](https://github.com/nodejs/node/blob/main/LICENSE) |
| npm CLI | <https://github.com/npm/cli> | [Artistic License 2.0](https://github.com/npm/cli/blob/latest/LICENSE) |
| uv | <https://github.com/astral-sh/uv> | [MIT](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT) or [Apache-2.0](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE), at your option |

The npm CLI ships inside the Node.js distribution but is licensed separately,
under the Artistic License 2.0 rather than Node's MIT. Node's own `LICENSE`
additionally covers the third-party components vendored into the Node
distribution (V8, libuv, OpenSSL, zlib and others).

Both license texts travel with the bundled runtime rather than only being
referenced here: `fetch-node.sh` copies Node's `LICENSE` to
`binaries/node-modules/node-LICENSE`, and npm's `LICENSE` is already inside its
own tree. Both are bundled as application resources.

Neither runtime is modified. `uv` provisions its own CPython on demand, so no
Python distribution is bundled with Haruspex.
