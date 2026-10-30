---
title: Keyboard shortcuts
description: Every keyboard shortcut in Haruspex — global keys, switching tabs, voice, chat, the Shell and Code tabs, editor windows, dialogs and the / command list.
---

# Keyboard shortcuts

Press **F1**, or click the **?** in the header, to see the shortcut list in the app at any time. It opens with a link to this guide online. On macOS, ⌘ is the Cmd key and ⌥ the Option key.

## Everywhere

| Keys | What it does |
|---|---|
| F1 | Show the keyboard shortcuts |
| F2 (hold) | Push-to-talk voice input; release to send |
| F3 | Read the last reply aloud (press again to stop) |
| Ctrl / ⌘ + N | New conversation (Chat tab) |
| Ctrl / ⌘ + 1–4 | Switch to the Chat, Jobs, Shell or Code tab (Chat and Jobs only in lean mode) |
| Ctrl / ⌘ + + / − | Zoom the interface in / out |
| Ctrl / ⌘ + 0 | Reset the zoom |
| Ctrl + Shift + I / ⌘ + ⌥ + I | Open the web inspector (developer tools) |

## Chat

| Keys | What it does |
|---|---|
| Enter | Send the message |
| Shift + Enter | New line |
| ↑ / ↓ | Step back and forward through the messages you sent in this conversation |
| Esc | Stop generating |

## Shell tab

| Keys | What it does |
|---|---|
| F4 | Send your recent shell commands and their output to the assistant, with no question |
| Ctrl + Shift + A | Show or hide the assistant sidebar |
| Ctrl + ` | Move focus between the terminal and the assistant |
| Ctrl + Shift + C | Copy the terminal selection |
| Ctrl + Shift + V | Paste into the terminal |
| Enter | Send to the assistant (Shift + Enter for a new line) |
| ↑ / ↓ | Step back and forward through the questions you asked in this tab |
| Esc | Stop the assistant |

## Code tab

| Keys | What it does |
|---|---|
| Enter | Send; while the agent works, queue it as a steering message |
| Esc | Stop the agent |

## Editor windows

| Keys | What it does |
|---|---|
| Ctrl / ⌘ + S | Save the file |
| Ctrl / ⌘ + W | Close the tab (asks first if it has unsaved changes) |
| Ctrl / ⌘ + F | Find and replace, with match case, regular expression and whole word |
| Ctrl / ⌘ + G | Next match (Shift for the previous one) |
| Ctrl / ⌘ + ⌥ + G | Go to a line |
| Ctrl / ⌘ + D | Add the next match to the selection, to edit both at once |
| Ctrl / ⌘ + ⌥ + ↑ / ↓ | Add a cursor on the line above / below |
| ⌥ + ↑ / ↓ | Move the line up / down; with Shift, copy it |
| Ctrl / ⌘ + Shift + K | Delete the line |
| Ctrl / ⌘ + / | Comment or uncomment the line |
| Tab / Shift + Tab | Indent / outdent, with the tabs or spaces the file already uses; press Esc, then Tab, to move out of the editor |

⌥ is Alt on Windows and Linux. Ctrl / ⌘ + click adds a cursor; ⌥ + drag selects a rectangle. Ctrl / ⌘ + Z undoes, Ctrl / ⌘ + Shift + Z redoes. The same keys work wherever this editor appears, such as a skill under review.

## Recall what you sent

Up recalls your last message when the cursor is on the first line of the input box, and each press goes one further back; Down goes forward again, and past the newest brings back whatever you had typed. In a message with several lines, the arrows move the cursor until it reaches the first or last line. In the Shell tab, only your question comes back, not the shell output sent with it. Edit a recalled message and press Enter to send it as a new one.

## The / command list

Typing `/` at the start of the Chat, Shell or Code input box opens a list of commands and skills (see the `skills` page). While it is open:

| Keys | What it does |
|---|---|
| Up / Down arrows | Move through the list |
| Enter or Tab | Pick the highlighted item |
| Enter, with a name typed in full | Run it, as if the list were closed (Tab still just picks it) |
| Esc | Close the list and keep your text |

## Dialogs

| Keys | What it does |
|---|---|
| Esc | Close the logs, the image viewer or the shortcuts list |

Some dialogs ignore Esc on purpose. **Run this command?** (command approval) and other approval windows wait for you to pick a button, so a stray key never answers for you.
