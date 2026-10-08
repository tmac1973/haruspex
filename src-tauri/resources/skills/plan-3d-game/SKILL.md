---
name: plan-3d-game
description: Questions and requirements for planning a 3D game, covering the engine, camera rig, controls, world, physics, lighting, HUD, menus, assets and performance budget. Use when the project is a 3D game of any genre.
metadata:
  haruspex-job: guided-planning
---

# Planning a 3D game

3D adds decisions on top of those for any game, and they're the expensive
ones to change later: the camera rig, the scale of the world, what physics
does, and how much the scene can hold before the frame rate drops.

Settle each topic below that the description hasn't already settled. Offer
the options given, recommended first. Skip topics that clearly don't apply.

## Questions

### Engine
- Godot: free, an editor and scenes, GDScript or C#.
- A browser engine (three.js, Babylon.js): runs from a link.
- Python with a 3D library (Panda3D, Ursina): quick for small games.
- Whatever the project already uses.

Default: what the project uses; otherwise Godot.

### Window and resolution
- 1280×720 or 1920×1080, resizable or not, with a fullscreen toggle.
- Whether the rendering resolution scales separately from the window, to
  keep the frame rate up.

Default: 1280×720, resizable, F11 for fullscreen.

### Camera
This decides how the game feels and most of the control code.
- First person.
- Third person behind the player, orbiting with the mouse.
- Fixed angle that follows (isometric, top-down).
- Fixed cameras per room or area.

Also ask how the camera handles walls between it and the player (pull in,
or fade the wall), its field of view, and whether the player can invert the
look axis. Default: third person with collision pull-in, 70° field of view.

### Controls
- Keyboard and mouse: WASD to move, the mouse to look.
- Gamepad as well.
- Click to move.

Also ask whether the mouse is captured while playing and released on
pause, and how sensitive it is. Default: keyboard and mouse, captured
while playing, Esc to release and pause.

### Units and world scale
Physics, movement speeds and imported models all need one scale.
- One unit is one metre (the usual choice).
- Anything else, stated explicitly.

Also ask the player's size and the world's size in those units.

### World and levels
- One hand-built scene.
- Several levels or areas, loaded separately.
- An open world streamed in pieces.
- Procedurally generated.

Also ask what happens at the edge of the world: invisible walls, water,
cliffs, or a kill plane below the map. Default: hand-built levels with
invisible walls and a kill plane.

### Physics and movement
- A character controller with no physics response (simple, predictable).
- A full physics body for the player.
- Physics only for props and projectiles.

Also ask about gravity, jumping, slopes and steps, and whether objects can
be pushed.

### Lighting and look
- Flat or stylised (unlit or toon shading), which is cheap.
- Realistic, with dynamic lights and shadows.
- Baked lighting, if the engine supports it.

Also ask about the time of day and the sky.

### Models and art
- Primitives (boxes, capsules) as placeholders.
- A free asset pack: name it and its licence.
- The user's own models, and their format (glTF recommended).

Also ask about animation: none, simple transforms, or skeletal animation.
Default: primitives first, glTF models later.

### HUD and menus
- HUD: crosshair, health, ammo, objective text, minimap, none.
- Screens: title, pause, settings (sensitivity, volume, graphics),
  game over and win.

Default: crosshair and health, plus title, pause and game over screens.

### Winning and losing
Ask how the player wins and loses, and what happens after (respawn at a
checkpoint, restart the level, back to the title screen).

### Saving
Nothing, checkpoints, or full save and load.

### Sound
- None, sound effects, or effects and music.
- Whether effects are positional (3D sound).

### Performance budget
- Target frame rate (60 fps is the usual target) and the weakest machine it
  must run on.
- The most characters or objects active at once.

## Plan requirements

- The first phase that runs the game opens the window, shows a scene with
  the player, and moves the player with the agreed controls and camera.
- From the first playable phase, the mouse is released and the game
  pauses on the agreed key, and the game can be quit.
- The player can't fall out of the world or walk through its outer edges
  without the agreed outcome.
- The camera never ends up inside a wall in the third-person case.
- Game rules and state (health, scoring, winning and losing) are kept apart
  from rendering, so the verification command can test them without a
  window or GPU.
- Every phase ends with the game starting and playable, and with the
  verification command passing.
- Models, textures and sounds load from one assets folder by name, so
  placeholders can be replaced without code changes.
- One phase measures the frame rate against the agreed budget with a
  visible counter.
