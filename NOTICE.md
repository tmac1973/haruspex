# Third-Party Notices

This file lists third-party assets bundled with Haruspex and the licenses they
are distributed under. The Haruspex source code itself is licensed separately
(see `LICENSE` / the License section of `README.md`).

## Application icon

The Haruspex application icon is derived from a photograph of the
**Piacenza Bronze Liver** (Italian: *Fegato di Piacenza*) — an Etruscan bronze
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
