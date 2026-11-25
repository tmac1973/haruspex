---
title: Code & terminal
description: Build and fix code in a project folder, find your way round a repo, get help in the terminal, and and make 3D models.
---

## Build a small web page and watch it live

Ask for a page in your project folder. The agent writes it and opens it in a preview window that reloads whenever its files change.

Tab: Code
Required settings: None

Prompt:

> Mock up a sign-up page in site/ with an email field, a password field and a big button.

Example output:

The agent writes `site/index.html` and `site/style.css`, then a preview window opens on the page. **Phone**, **Tablet** and **Full** in its toolbar show it at each width.

<!-- media: Code session beside the preview window showing the sign-up page at Phone width -->

Read more: web-preview, code, helpers

## Fix a failing test

Point a session at your project and say what's broken. The agent reads the code, edits it and runs the tests; each edit shows as a diff and each command as a card with its output.

Tab: Code
Required settings: None

Prompt:

> `npm test` fails in parseDate.test.ts since yesterday. Find out why and fix it.

Example output:

```
$ npm test -- parseDate
✗ parses "2024-03-31" as a local date (expected 31, got 30)
```

The agent finds the date was read as UTC, changes `src/parseDate.ts`, and runs the test again until it passes. The diff shows the changed lines with line numbers.

Read more: code

## Find your way round an unfamiliar project

Ask how something works in a repo you haven't read. The agent searches and reads the files, and answers with file names you can click to open. With the Search helper and a reranker it can ask the code in plain words.

Tab: Code
Required settings: None (optional: Settings → Code → Helpers → Search with a reranker server)

Prompt:

> I've just cloned this. Where does a request come in, and how does it reach the database?

Example output:

Requests start in `src/server.ts:18`, which hands each route to the handlers in `src/routes/` …

- `src/routes/orders.ts:42` checks the input, then calls `OrderStore.save` …
- `src/db/orderStore.ts:10` wraps every query in one connection pool …

Read more: code, helpers

## Ask the shell why your disk is full

The Shell tab is a real terminal with an assistant beside it. In Read-only, the default, it suggests commands as cards; **Run** runs one and sends the output back, and risky ones get a red chip.

Tab: Shell
Required settings: None

Prompt:

> Why is my disk full?

Example output:

Let's see which folders are largest in your home folder:

```
du -h --max-depth=1 ~ | sort -h | tail -15
```

**Paste** · **Run**

After you run it: `~/.cache` holds 38 GB, most of it in old downloads …

Read more: shell

## Let the shell assistant clean up for you

Click the **Read-only** lock to switch a Shell tab to Full access. The assistant then runs commands in your terminal itself, and asks first before a risky one.

Tab: Shell
Required settings: None (click the lock in the Shell sidebar to switch that tab to Full access)

Prompt:

> Clear out the pip and npm caches, then tell me how much space that freed.

Example output:

Commands that look safe run on their own and show in your scrollback. A risky one opens **Run this command?** with **Allow for this session**, **Allow once** or **Deny**.

Freed about 4.2 GB: pip cache 3.1 GB, npm cache 1.1 GB.

Read more: shell

## Install something that needs sudo

The Code tab can't type passwords, so it hands a `sudo` command to you: a Shell tab opens with the command typed in, and the agent reads the result once you press Enter.

Tab: Code
Required settings: None

Prompt:

> Install the SDL2 development libraries so this builds, then build it.

Example output:

**Waiting for you in Shell 2 — press Enter there**

**Go to shell** · **Cancel**

After you press Enter, the agent gets the exit code and output, and carries on with the build.

Read more: code, shell

## Make a 3D model and check it

Ask for a 3D asset. The agent writes code that builds the model, and the 3D helper saves it as a `.glb` and reports its size, parts, problems and a sheet of views. The agent usually checks a few times before it's done.

Tab: Code
Required settings: Settings → Code → Helpers → 3D

Prompt:

> Make a low-poly mana potion for my Godot game, about 30 cm tall, in assets/props/.

Example output:

The agent writes `assets/props/mana_potion.js` and checks it with `check_3d`, which saves `mana_potion.glb` beside it. The report gives its width, height and depth in metres and any floating parts; the render sheet shows front, right, back, left, top and three-quarter views. Open the `.glb` to orbit it in the 3D viewer.

<!-- media: render sheet of the potion, then the .glb orbiting in the 3D viewer -->

Read more: helpers, 3d-helper, viewers

## Hand a 3D character to a stronger model

Keep a local model as the session's model and let a frontier model on OpenRouter do just the 3D work. The agent writes the brief, the delegate builds and checks the asset until it is clean, and the card shows its steps, render sheets and cost.

Tab: Code
Required settings: Settings → Code → Helpers → 3D → Delegate to

Prompt:

> Make a goblin for assets/goblin.glb: about 1.2 m tall, low-poly, with Idle and Walk clips, to match the other characters in assets/.

Example output:

The agent reads the other characters to get their scale and style, then calls `delegate_3d` with path `assets/goblin.glb` and a task naming the height, style, pivots and clips. The delegate writes `goblin.js` and `goblin.anim.js`, checks them with `check_3d` until both clips pass, and writes `goblin.glb`. The agent gets its report, "Final check: clean.", the files and the cost, and wires the goblin into the scene.

<!-- media: the delegate's card with its steps, render sheet and cost, then goblin.glb walking in the 3D viewer -->

Read more: 3d-delegate, 3d-helper, helpers

## Work on a branch without touching your checkout

Tick **Work in a new worktree** when you start a session. It works in its own folder on a new branch, so your checkout stays as it is. Merging back is ordinary git.

Tab: Code
Required settings: None (a git repository)

Prompt:

> Try switching the config loader from JSON to TOML and see what breaks.

Example output:

The session works in `myapp-worktrees/session` on a new branch `session`, starting from the last commit. The agent sets up dependencies first, then makes the change and runs the tests there.

Read more: code-sessions, code

## Hand parts of a big question to subtasks

List several asks and the agent can hand each to a subtask: a sub-agent that looks into one thing and reports back, so the session's context stays small. Each shows as a card with its steps and report.

Tab: Code
Required settings: None (Settings → Code → Subtasks → Read and write lets them change files too)

Prompt:

> Before I refactor the cache:
> 1. Find every caller of `getCached`.
> 2. Work out how the tests mock Redis.
> 3. List the config keys the cache reads.

Example output:

Three subtask cards run, then fold away behind **Show N steps** with a **Report** each. The agent sums them up:

- `getCached` is called from 7 places, all in `src/api/` …
- Tests swap Redis for an in-memory map in `test/setup.ts` …

Read more: code-subtasks
