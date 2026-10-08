---
name: plan-2d-game
description: Questions and requirements for planning a 2D game, covering the window, camera, world edges, controls, game loop, HUD, menus, win and lose, saving, art and audio. Use when the project is a 2D game of any genre, in any engine or library.
metadata:
  haruspex-job: guided-planning
---

# Planning a 2D game

A 2D game turns on many decisions that a one-line description rarely
mentions, and a coding run that has to guess gets them wrong: the camera
stays put and the player walks off the screen, the window is whatever size
the library defaults to, and there's no way to pause.

Settle each topic below that the description hasn't already settled. Offer
the options given, recommended first, adapted to the engine chosen. Skip
topics that clearly don't apply, such as the camera for a single-screen
puzzle game.

## Questions

### Engine or library
Everything else depends on it, including how the game is run and tested.
- pygame: Python, simple, easy to test without a window.
- A browser canvas in TypeScript or JavaScript: runs anywhere, nothing to
  install.
- Godot: scenes and an editor, more structure, a bigger download.
- Whatever the project already uses.

Default: what the project uses; otherwise pygame for a small game, or a
browser canvas if it should be shared by a link.

### Window and resolution
Sprite sizes, UI layout and the camera all depend on it, and changing it
late breaks positioning everywhere.
- 1280×720.
- 960×540, which scales evenly to 1080p.
- A small pixel-art base resolution (320×180, 480×270) scaled up.

Also ask whether it's resizable, whether there's a fullscreen toggle, and
how it scales: whole-number pixel-perfect (for pixel art) or smooth
stretching. Default: 1280×720, fixed size, F11 for fullscreen,
pixel-perfect if the art is pixel art.

### Camera
Any world bigger than the screen needs a camera. Without a decision the
player walks off the visible area.
- Fixed: the whole level fits on one screen.
- Follows the player, centred.
- Follows the player with a dead zone, so small moves don't shift the view.
- Scrolls by itself (auto-runners, shoot-'em-ups).
- Flips screen by screen as the player crosses an edge.

Also ask whether it's clamped to the world's edges, so nothing outside the
map ever shows, and whether it moves smoothly. Default: follows with a
small dead zone, clamped to the world.

### World size and edges
This decides the map data, collision with the boundary, and what the
camera clamps to.
- Size: one screen; a fixed-size map larger than the screen; separate
  levels; endless or procedurally generated.
- Edges: solid walls; wrap around to the other side; touching the edge
  ends the level or kills the player; open (endless worlds only).

Default: a fixed-size map with solid edges.

### Levels and maps
Hand-made levels need a file format; generated ones need rules and a seed.
- Built in code.
- Files: a plain text grid, JSON, or Tiled maps (`.tmx` or `.json`).
- Procedural from a seed.
- A single arena.

Default: a text grid or JSON, one file per level.

### Controls
- Keyboard only (WASD or the arrows, plus action keys).
- Keyboard and mouse, aiming with the mouse.
- A gamepad as well.
- Touch.

Also ask for the key list and whether keys can be rebound. Default: WASD
and the arrows both move, Space for the main action, Esc to pause, no
rebinding in the first version.

### How the player moves
This is the core of how the game feels, and it decides the physics code.
- Top-down, eight directions.
- Top-down on a grid, one tile per step.
- Side-on platformer with gravity and jumping.
- Thrust and rotation, like Asteroids.

For a platformer, also ask about variable jump height, jumping just after
leaving a ledge ("coyote time"), and double jumps.

### Game loop and timing
Movement and physics mustn't speed up or slow down with the frame rate.
- A fixed update step (60 Hz), with drawing kept separate.
- A variable time step scaled by the frame time.
- Turn-based, with no real-time loop.

Default: fixed 60 Hz updates at a 60 fps target.

### Collision
- Rectangles (axis-aligned boxes).
- Against a tile grid.
- Circles.
- A physics engine (pymunk, Box2D, Godot's own).

Default: rectangles against a tile grid.

### HUD and overlays
Score, health and status need space on screen and a layer drawn above the
moving world.
- Counters for score, health or lives.
- Health bars over characters.
- A minimap.
- An inventory or hotbar.
- None.

Also offer a debug overlay toggled with a key (frame rate, hitboxes),
recommended while building. Default: a top bar with the essentials, and
F3 for the debug overlay.

### Menus and screens
Multiple choice:
- A title screen.
- A pause menu.
- Game over and win screens.
- Settings: volume, controls, fullscreen.
- Level select.

Default: title, pause, and game over.

### Winning and losing
Without these there's no game, only a toy. Ask:
- How the player wins: reach an exit, hit a score, survive a time, beat a
  boss.
- How they lose: health, lives, a timer.
- What happens next: restart the level, or return to the title screen.

### Progression and difficulty
- A single level.
- A series of hand-made levels.
- Waves that get harder.
- Endless, with rising speed or spawn rates.

Also ask whether there are difficulty settings.

### Enemies and other characters
Ask what kinds there are, how they behave (patrol, chase, shoot from
range), how many can be on screen at once, and which belong in the first
version.

### Saving
- Nothing.
- A high-score table.
- Settings only.
- Progress: which level was reached.
- Full save and load at any point.

Default: high scores and settings, in a file in the user's data folder.

### Art
This decides sprite sizes, the animation code and where images come from.
- Coloured shapes as placeholders: fastest, and replaceable later.
- Art made by Haruspex's asset generation.
- The user's own image files.
- A free asset pack: name it and its licence.

Also ask the sprite and tile size (16, 32 or 48 px), and which actions are
animated. Default: placeholders first, built so that image files drop in.

### Sound
- None.
- Sound effects.
- Music and sound effects.

Also ask about volume and mute. Default: sound effects, with a mute key.

### Performance
Ask only if there will be many objects at once or the game must run on a
weak machine: the most objects on screen, and the target hardware.

## Plan requirements

- The first phase that runs the game opens a window at the agreed size,
  runs the loop at the agreed timing, and shows the player moving with the
  agreed controls.
- From the first phase whose world is bigger than the screen, the camera
  behaves as agreed. It never shows past the edge of the world unless the
  user chose that.
- The player can't leave the playable area unless the user chose open or
  wrapping edges.
- From the first playable phase, the agreed key pauses the game, and it can
  be quit both from the window and from a menu or key.
- Game rules and state (movement, collision, scoring, winning and losing)
  are kept apart from drawing and input. The verification command tests
  them without opening a window.
- Every phase ends with the game starting and playable, and with the
  verification command passing.
- Images and sounds load from one assets folder by file name, so
  placeholders can be swapped for real art without code changes.
- Every agreed HUD element, menu and win or lose screen is built in a named
  phase. None is left for later.
