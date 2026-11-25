---
title: The 3D delegate
description: Hand 3D modelling in the Code tab to another model with delegate_3d — setting the model, the files it writes, its round and cost limits, the final check and its report.
---

# The 3D delegate

The 3D delegate lets a Code session hand 3D modelling to a different, usually stronger, model. The session's own model keeps reading code, running tests and talking to you; the delegate sees only the 3D brief and its own checks, so you pay a frontier model only for the 3D work. It is part of the 3D helper: see the `3d-helper` page for `check_3d`, which the delegate uses, and the `helpers` page for all helpers.

## Set a delegate model

Turn on the 3D switch in Settings → Code → Helpers, then set:

- **Delegate to**: the model, picked as for a job: **Remote server** (any OpenAI-compatible server, a llama-server on this computer included) or **OpenRouter (cloud)**. **None** turns the delegate off.
- **Rounds per asset**: the most model calls one asset may take, 5 to 500. The default is 80.
- **Cost limit per asset**: the most one asset may spend, in dollars. **Unlimited**, the default, sets no limit.

With no delegate model, the agent has no `delegate_3d` and uses `check_3d` itself, as before. The delegate's model must call tools, or it can't run its checks.

## Ask for an asset

Ask as usual: "make a goblin with a walk cycle for assets/goblin.glb". The agent calls `delegate_3d` with:

| Argument     | What it does                                                                    |
| ------------ | ------------------------------------------------------------------------------- |
| `path`       | where the `.glb` goes (required)                                                |
| `task`       | what to make: size in metres, style, engine, clips, what it must fit (required) |
| `images`     | up to 3 reference pictures in the project: PNG, JPEG or WebP, 8 MB each         |
| `label`      | the card's name; otherwise "3D: " and the file name                             |
| `background` | return at once; the report arrives in a later turn                              |

The delegate starts with an empty context. It can't see the conversation, so the agent writes the task in full. It can list, read, search and look at images anywhere in the project, and run `check_3d`. It writes only three files: the build module and animation module beside the `.glb` (`goblin.js`, `goblin.anim.js`) and the `.glb` itself; any other write is refused. It has no shell, web or subtasks.

To change an asset, the agent calls again with the same path. The delegate is told the modules exist, and edits them.

## When it's done

The delegate works until `check_3d` reports no errors. When it stops, Haruspex runs the same check on the files on disk. If that fails, or the module was never written, the delegate is sent back once to fix it. At the round or cost limit it stops and gives its report without another check of its own.

The agent then gets the delegate's report (files, size, parts, clips, problems left, what it assumed), **Final check: clean** or **Final check: errors remain** with the errors, the files written and the cost. The final render sheet comes with it when the session's model reads images.

## Follow it

Each call shows as a subtask card with its steps, the newest render sheet, and the tokens and cost so far. **Stop** on the card stops it. Its tokens and cost count toward the session's total. A remote delegate waits on its own server's queue, never on the session's local model.

It counts toward the 8 subtasks a turn may start, but follows Settings → Code → Helpers → 3D, not Settings → Code → Subtasks.

## What it doesn't do

- Only the Code tab: not Chat, the Shell, jobs or the 3D models job.
- One delegate model for every session; a session can't pick its own.
- It writes no textures, but can use PNGs already in the project.
- It keeps nothing between calls: each starts fresh from the files.
- The cost limit counts only what the server reports, or OpenRouter's prices; a server with neither has no cost to limit.
