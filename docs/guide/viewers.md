---
title: Viewers for models, images and sounds
description: Looking at .glb models, images and sounds — opening any file or folder, stepping through a folder with the arrow keys, orbiting a model, playing a sound, and what the viewers don't do.
---

# Viewers for models, images and sounds

A `.glb` model, an image (`.png`, `.jpg`, `.webp`, `.gif`, `.bmp`, `.svg`) or a sound (`.wav`, `.mp3`, `.ogg`, `.opus`, `.flac`, `.m4a`, `.aac`) opens in a viewer inside an editor window, one window per folder. The viewers only show files; they never change them. Any other file opens as text.

## Open a file or a folder

- From the Code tab: click **Open** at the top of the sessions list, then **File…** to pick any file, or **Folder…** to pick a folder. Any folder works, not only a session's.
- From a Code session: click a file name in the transcript, or ask the agent to open it.

**Folder…** opens on the folder's first model, else its first image, else its first sound. A file picked with **File…** opens in its own folder's window, so the list beside it holds that folder and the folders inside it. To compare files spread over several folders, use **Folder…** on the folder above them.

## Step through a folder

When the window's folder holds more than one model, image or sound, a list sits beside the viewer, with each file's folder under its name. Folders inside it count too, up to eight deep; hidden folders and `node_modules` are skipped.

- Click a file, press ← or →, or use **‹** and **›**, to show the previous or next one in the same tab. The list wraps round.
- The list shows one kind at a time. When the folder has more than one kind, **3D**, **Images** and **Audio** switch between them.
- **Attempts** adds the earlier tries the 3D models job keeps in `attempts/` folders. It only shows when there are some. See the `3d-models` page.
- **↻** looks again for files added since the list was made.

## Look at a model

- Drag to orbit, scroll to zoom, right-drag to pan. **Reset view** puts the camera back.
- The camera keeps its angle from one model to the next, scaled to each model's size, so they're seen the same way.
- The grid is the floor, at the model's lowest point.
- **Animation** picks which clip loops; **Rest pose** stops it. It only shows when the model has clips.
- The bar gives its meshes, triangles and size in units.

## Look at an image

- It's fitted to the window, never enlarged. **1:1** shows it at its real size, scrolling when it's larger; **Fit** goes back.
- A checkerboard shows through transparent parts.
- The bar gives its size in pixels and on disk.

## Listen to a sound

- The waveform shows the whole sound; click it to play from that point.
- The player under it plays, pauses, seeks and sets the volume.
- Stepping to the next sound while one plays starts the next one too, so a folder of sound effects plays one after another as you press →.
- **Loop** plays it over and over, and stays on for the next sound.
- The bar gives its length, channels and size on disk.
- Formats come from your system's media codecs. On Linux, `.m4a` and `.aac` may need GStreamer's `gst-libav`; without a codec the viewer says it can't play the file.

**Reload** reads the file again, after something rewrote it. The viewers don't reload by themselves.

## What they don't do

- Open `.gltf`, `.fbx`, `.obj` or other model formats. Only `.glb`.
- Play video.
- Edit, trim, convert or export a file.
- Open a file from your file manager, or by dropping it on the window.
- List more than 2,000 files in one folder.
