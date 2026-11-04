---
title: Viewers for models and images
description: Looking at .glb models and images — opening any file or folder, stepping through a folder with the arrow keys, orbiting a model, fitting an image, and what the viewers don't do.
---

# Viewers for models and images

A `.glb` model or an image (`.png`, `.jpg`, `.webp`, `.gif`, `.bmp`, `.svg`) opens in a viewer inside an editor window, one window per folder. The viewers only show files; they never change them. Any other file opens as text.

## Open a file or a folder

- From the Code tab: click **Open** at the top of the sessions list, then **File…** to pick any file, or **Folder…** to pick a folder. Any folder works, not only a session's.
- From a Code session: click a file name in the transcript, or ask the agent to open it.

**Folder…** opens on the folder's first model, or its first image when it has no models. A file picked with **File…** opens in its own folder's window, so the list beside it holds that folder and the folders inside it. To compare files spread over several folders, use **Folder…** on the folder above them.

## Step through a folder

When the window's folder holds more than one model or image, a list sits beside the viewer, with each file's folder under its name. Folders inside it count too, up to eight deep; hidden folders and `node_modules` are skipped.

- Click a file, press ← or →, or use **‹** and **›**, to show the previous or next one in the same tab. The list wraps round.
- The list shows one kind at a time. When the folder has both, **3D** and **Images** switch between them.
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

**Reload** reads the file again, after something rewrote it. The viewers don't reload by themselves.

## What they don't do

- Open `.gltf`, `.fbx`, `.obj` or other model formats. Only `.glb`.
- Play audio or video.
- Edit, convert or export a file.
- Open a file from your file manager, or by dropping it on the window.
- List more than 2,000 files in one folder.
