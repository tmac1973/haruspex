# Phase 3 — The shipped planning skills

## Goal

A first set of planning skills, written with Tim and tested on real plans,
shipped through phase 1.

## Work

Each skill is a `SKILL.md` under `src-tauri/resources/skills/`, with
`metadata.haruspex-job: guided-planning`, a description that says which
projects it fits, and the two sections from the overview.

**Writing rules for every skill:**

- **A question earns its place** when the answer changes the code, and a
  model left alone tends to pick wrong or not think of it.
- **Each topic** gives one line on why it matters and the usual options,
  with a sensible default marked.
- **A requirement is checkable**: something a reader of the phase files can
  confirm or deny, not "should be fun".
- **Stay engine-neutral** unless the skill is for one engine. The interview
  asks which.

**First set**, with draft topics to refine together:

### `plan-2d-game`

Questions:
- Engine or library (pygame, Godot, a browser canvas, …), if not given.
- Window: size, resizable or fixed, fullscreen, scaling (pixel-perfect or
  smooth).
- Camera: fixed, follows the player, dead zone, clamped to the map edges.
- World edges: walls, wrap-around, or open, and what happens at them.
- Controls: keyboard, mouse, gamepad, and whether keys can be rebound.
- Game loop: fixed or variable timestep, target frame rate.
- HUD and GUI overlay: score, health, minimap, debug overlay.
- Menus: title, pause, game over, settings.
- Win and lose conditions, levels, progression.
- Saving: none, high scores, or full save and load.
- Audio: music, sound effects, volume control.
- Art: placeholder shapes, generated art (the asset chain), or the user's
  own; sprite and tile size.
- Collision: boxes, tiles or physics.
- Enemies or other actors, and how they behave.

Plan requirements:
- The first playable phase opens the window at the agreed size, runs the
  game loop, and shows a player who can move, with the camera behaving as
  agreed.
- The player can't leave the playable area unless the user chose open
  edges.
- Pause and quit work from the first playable phase on.
- Game rules are separate from drawing, so the verification command can
  test them headlessly.
- Every phase ends with the game launching and playable.

### `plan-web-app`

Questions:
- Users and sign-in: none, local accounts, or OAuth.
- Data: where it is stored, and whether it must survive a restart.
- Where it runs: local only, a static host, or a server.
- Frontend: a framework or none; the backend, if any.
- Screen sizes and mobile; accessibility level.
- Offline use.
- Loading, empty and error states.
- Dark mode; languages.
- Browser support.
- Security: input handling, secrets, CSRF.
- Seed or sample data.

Plan requirements:
- The first phase serves a page that loads with no console errors.
- Every view that shows data has loading, empty and error states.
- The verification command runs headless (unit tests, plus a DOM smoke
  check).
- No secret is committed; configuration comes from the environment or a
  file that is gitignored.

### Candidates for the same set (Tim to choose)

- `plan-cli-tool`: argument style, config files, output formats (human or
  JSON), exit codes, stdin and pipes, shell completion, packaging.
- `plan-3d-game`: the 2D topics plus camera rig, lighting, physics engine,
  and performance budget.
- `plan-api-service`: API style, auth, persistence, migrations, rate limits,
  observability, deployment.

**Hand test for each:** run a guided planning job with a one-line
description ("a top-down 2D zombie shooter") on the model Haruspex ships for
16 GB. The skill earns its place when the interview asks the topics that
matter and skips the ones the description answered. The plan should then
meet every requirement without the user restating any.

## Done when

The agreed skills ship, each has passed its hand test, and a fresh profile
offers them in the guided planning editor.
