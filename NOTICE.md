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

| Component | Upstream                          | License                                                                                                                                                |
| --------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node.js   | <https://nodejs.org/>             | [MIT](https://github.com/nodejs/node/blob/main/LICENSE)                                                                                                |
| npm CLI   | <https://github.com/npm/cli>      | [Artistic License 2.0](https://github.com/npm/cli/blob/latest/LICENSE)                                                                                 |
| uv        | <https://github.com/astral-sh/uv> | [MIT](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT) or [Apache-2.0](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE), at your option |

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

## Bundled ffmpeg and melt

Haruspex bundles `ffmpeg` and `ffprobe` from [FFmpeg](https://ffmpeg.org/) and
`melt` from [MLT](https://www.mltframework.org/), with the libraries they
share. All are built from unmodified upstream sources, pinned in
`scripts/media-versions.sh` and `scripts/build-media.sh`, which is the complete
build recipe:

| Component | Upstream | License |
| --- | --- | --- |
| FFmpeg (libav*, ffmpeg, ffprobe) | <https://github.com/FFmpeg/FFmpeg> | [GPL v3 or later](https://www.gnu.org/licenses/gpl-3.0.html): built with `--enable-gpl --enable-version3`, no `--enable-nonfree` |
| x264 | <https://code.videolan.org/videolan/x264> | GPL v2 or later |
| LAME | <https://sourceforge.net/projects/lame/> | LGPL v2 or later |
| MLT (libmlt, melt and its modules) | <https://github.com/mltframework/mlt> | LGPL v2.1 or later; the qt6, plusgpl and normalize modules are GPL |
| Qt 6 (qtbase, qtsvg) | <https://download.qt.io/archive/qt/> | LGPL v3 |
| libxml2 | <https://gitlab.gnome.org/GNOME/libxml2> | MIT |

On Linux, libva, libdrm and libvpl (MIT) are linked in for hardware encoding.
Every component's licence text ships in `binaries/media/LICENSES/`, and each
`media-<tag>` release names its versions and sources.

## Bundled libraries

| Component      | Upstream                                         | License                                                                        |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| glTF Validator | <https://github.com/KhronosGroup/glTF-Validator> | [Apache-2.0](https://github.com/KhronosGroup/glTF-Validator/blob/main/LICENSE) |
| pdfmake        | <https://github.com/bpampuch/pdfmake>            | [MIT](https://github.com/bpampuch/pdfmake/blob/master/LICENSE)                 |
| Roboto (font)  | <https://github.com/googlefonts/roboto-2>        | [Apache-2.0](https://github.com/googlefonts/roboto-2/blob/main/LICENSE)        |

The 3D helper's checks (`src/lib/glb/validate.ts`) run the Khronos glTF
Validator, from the `gltf-validator` npm package, unmodified, in the app's
webview. It is compiled from Dart, so it also carries code from the Dart SDK
and Dart packages under BSD-style licenses; the package's `NOTICES` file lists
them.

PDFs written by `fs_write_document` are built with pdfmake
(`src/lib/documents/`), which ships Roboto in its `vfs_fonts.js`. Roboto is
embedded, subset, in each PDF Haruspex writes.
