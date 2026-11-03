---
title: Helpers
description: Helpers in the Code tab — tools the coding agent runs without a model. The Search helper finds code from a plain-words question; the 3D helper builds and checks a 3D model.
---

# Helpers

A helper is a tool the Code tab's agent runs with no model behind it. It does one job the agent can't do well by itself, such as looking at a 3D model it made, and hands back what it found. For small models that do a narrow job, see the `specialists` page.

## Turn a helper on

Settings → Code → Helpers has a switch for each helper, all off. A helper's tool reaches the agent from the next message after you turn it on. Hover a helper for what it does.

Helpers work in the Code tab only. The 3D helper needs a session that can write; the Search helper also works in a read-only session.

## The Search helper

Turn on **Search** and the agent gets a `search_code` tool. It asks a question in plain words ("where does the message box grow as I type?") and gets back the six best snippets of code, each with its path and line numbers, best first. Snippets next to each other in one file are joined, so there can be fewer. The agent then reads around the best one or greps for a name it saw.

It searches the text files in the session's folder, fresh on every call. Files your `.gitignore` skips, binaries, lockfiles and files over 1 MB are left out; tests and generated files are kept but ranked lower. The agent can narrow a search to one subfolder.

It works in a read-only session, since it changes nothing.

For better results on vaguely worded questions, set a reranker on the Search row (Settings → Code → Helpers → Search): the server's address, an API key if it needs one, and a model (**Fetch** lists the server's rerank models). Any server with `/v1/rerank` works, such as llama-toolchest or llama-server started with `--reranking`. It adds a couple of seconds a search. If the reranker is down or takes over 15 seconds, the helper uses keyword ranking and tells the agent why.

## The 3D helper

Ask for a 3D asset as usual ("make a low-poly mana potion for my Godot game"). The agent writes a short Three.js file that builds the model and calls the helper's `check_3d` tool on it. The helper builds it hidden in the app, saves it as a `.glb` beside the file, and gives the agent:

- **a render sheet**: front, right, back, left, top and three-quarter views over a floor grid, with the height marked;
- **size**: width, height and depth in metres, and where the feet sit;
- **parts**: each named part, with parts that float free or hide inside others;
- **problems**: faces that vanish from behind or point inward, missing normals, big textures;
- **materials**;
- **clips**: for each animation clip, whether it goes through or off the floor, parts pass into others or come away, feet slide, knees or elbows bend the wrong way, how far its key pose reaches, and how far it ends from where it started.

The agent can also ask to see one clip moving: eight frames from the side and the front, then all of them overlaid with trails of the parts that move most.

If the file has an error, the agent gets it with its line number and fixes it. It usually checks a few times before it's done.

The agent can also check a `.glb` made another way, for example with a Blender script. That writes nothing, unless it asks for a resized copy.

The agent can ask the helper to:

| Ask | What it does |
|---|---|
| `height` | scales the model to that many metres tall |
| `ground` | puts the feet on the floor, centred |
| `max_triangles` | warns when the model is over a triangle budget |
| `clip` | shows that animation clip moving instead of the still views |

Three.js comes with the app, so the 3D helper needs no network. The agent sees the render sheet only if its model can read images; the text report comes either way.

## What it doesn't do

- No model: a helper can't make anything on its own; the agent writes the code.
- Search matches words, not meaning or code structure: it knows nothing of calls, types or imports, and a question worded unlike the code can miss.
- It can't tell whether a motion looks good, only what's physically wrong. You can play the clips in the file's 3D view (**Animation**).
- It finds knees and elbows by name only (knee, shin, elbow, forearm and so on).
- It doesn't check a Three.js app with its own renderer; for that, see the `specialists` page.
- It doesn't fix problems, rig or skin a character, unwrap UVs or make lower-detail copies.
- Not in Chat, the Shell, jobs or subtasks.
