---
title: Voice input
description: Talking to the assistant instead of typing, push-to-talk, dictating with constant listening, the "send it" and "scratch that" commands, and picking the speech model.
---

# Voice input

Haruspex turns speech into text with whisper, on your computer. Nothing you say leaves it. The first time, the speech model is downloaded.

Voice input works in the Chat tab, the Shell tab's assistant sidebar and the Code tab.

## Talk instead of typing: push-to-talk

Hold the microphone button, or hold `F2`, and speak. Let go and what you said is sent as a message. On the button, press `Esc` or move the pointer off it to throw the recording away.

## Dictate with constant listening

For brainstorming or a long message, right-click the microphone button and choose **Constant listening**. The microphone stays on, and each phrase you say is added to the end of the chat box when you pause. Nothing is sent until you say so, and you can type or edit in the box while it listens.

- Say **"send it"** at the end of a phrase to send the box. The words "send it" are left out, and listening carries on for the next message.
- Say **"scratch that"** to remove the last phrase it added. This works once, and only while the box still ends with that phrase.
- Click the microphone button to stop.

While it listens the button has a glowing ring, and a small spinner shows while a phrase is being turned into text. In the Shell tab's sidebar, "send it" waits until the assistant has finished answering. Say it again then.

## When it stops or pauses by itself

- It stops when you switch to another conversation or Code session, so text never lands in the wrong box.
- It stops after 5 minutes without speech, and when the microphone is unplugged. A message says so.
- It pauses while an answer is read aloud, so it doesn't type out what the speakers say, and carries on afterwards.

## Pick the speech model

Settings → Audio → **Speech model**:

- **Fast** (base.en): quick, about 140 MB, English only.
- **Accurate** (large-v3-turbo): understands more languages and long dictation better. It is a 1.6 GB download, shared with the video tools.

Settings → Audio → **Audio input (microphone)** picks the microphone. Silence comes back as nothing rather than as made-up words.

## What it doesn't do

- It doesn't read answers aloud by itself or hold a spoken conversation. Click the speaker icon, or press `F3`, to hear an answer (see the `speech` page).
- Text arrives a phrase at a time, after each pause, not word by word.
- Push-to-talk and constant listening can't run at once: only one can use the microphone.
- It doesn't type into other apps.
