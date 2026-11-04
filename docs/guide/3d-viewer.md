---
title: The 3D viewer
description: Looking at .glb models in Haruspex — opening any file or a folder of them, orbiting, playing clips, stepping through a folder with the arrow keys, and what the viewer doesn't do.
---

# The 3D viewer

A `.glb` opens in a 3D viewer inside an editor window, one window per folder. It only shows models; it never changes them.

## Open a model

- From the Code tab: click **Open** at the top of the sessions list, then **File…** to pick a `.glb`, or **Folder…** to pick a folder and see every model in it. Any folder works, not only a session's.
- From a Code session: click a `.glb` file name in the transcript, or ask the agent to open it.

A model picked with **File…** opens in its own folder's window, so the list beside it holds that folder and the folders inside it. To compare models spread over several folders, use **Folder…** on the folder above them.

## Look at it

- Drag to orbit, scroll to zoom, right-drag to pan. **Reset view** puts the camera back.
- The grid is the floor, at the model's lowest point.
- **Animation** picks which clip loops; **Rest pose** stops it. It only shows when the model has clips.
- The bar under the model gives its meshes, triangles and size in units.
- **Reload** reads the file again, after something rewrote it. The viewer doesn't reload by itself.

## Step through a folder

When the window's folder holds more than one `.glb`, a list of them sits beside the model, with each file's folder under its name. Folders inside it count too, up to eight deep; hidden folders and `node_modules` are skipped.

- Click a model, press ← or →, or use **‹** and **›**, to show the previous or next one in the same tab. The list wraps round.
- The camera keeps its angle from one model to the next, scaled to each model's size, so they're seen the same way.
- **Attempts** adds the earlier tries the 3D models job keeps in `attempts/` folders. It only shows when there are some. See the `3d-models` page.

## What it doesn't do

- Open `.gltf`, `.fbx`, `.obj` or other formats. Only `.glb`.
- Edit, convert or export a model.
- Open a `.glb` from your file manager, or by dropping it on the window.
- List more than 2,000 models in one folder.
