---
title: Chat conversations
description: Several Chat conversations at once, adding to an answer as it is written, the busy and unread marks, results that arrive while you are elsewhere, and the Tasks list.
---

# Chat conversations

## Run several conversations at once

While one conversation answers, open another and send there. Each has its own **Stop** and its own error message, and stopping one leaves the others running. With one stream (Settings → Inference → Parallel streams, 1 by default) the second waits for the first, unless the first is running a tool for more than a few seconds (a command, a picture, a slow server) or waiting for you to approve something or answer a question, when the second goes ahead; with more streams, or a server that runs several, they answer at the same time.

## Send while it's working

You can type and send while the assistant is still answering. The message shows above the chat box as **Queued** and goes to the assistant once its running tools finish, so it can change course without starting over. It answers with a line saying what it will do, then carries on. Click **×** on a queued message to take it back before it's read.

After you stop an answer, the assistant is told so and doesn't take that request up again unless you ask.

If the answer finishes, or you stop it, before the assistant reads a queued message, the message goes back into the chat box for you to send again. A skill (`/name`) sent while it's working goes as plain text; send it again once the answer is done to run the skill.

## See which conversations are busy

The conversation list shows a dot by each conversation that's doing something:

- **Pulsing dot**: answering.
- **Hollow dot**: waiting, for the model to start or for another conversation's turn to finish.
- **Solid dot**, title in bold: it finished an answer while you were in another conversation. Opening it clears the mark. It stays after a restart.

Hover over a dot to see what it means. The Remote control page (see the `remote-control` page) marks its chat list the same way, and can send and steer in any chat without changing which one this computer shows.

## Results that arrive while you're elsewhere

A long task started from a conversation, such as a video render or an upload (see the `video-render` page), reports back to that conversation when it ends. The assistant gets the result and answers in that conversation straight away, even if you're in a different one. A notice says which conversation it was, with **Open** to go there, and the conversation is marked unread.

If that conversation is busy when the task ends, the result waits until its current answer is done.

## See background tasks

While anything runs in the background, **Tasks: N** shows at the right of the tabs, whichever tab you're in. It counts renders and uploads from any chat or Code session, and the background commands and subtasks of Code sessions open in this window. Click it for the list: each row names the chat or session it belongs to (click the name to go there), with **Cancel** or **Stop**. Tasks that ended in the last ten minutes are listed under **Done**, and the chip stays that long after the last one.

In the chat or session that started it, a task has a card with its progress and **Cancel**, then what it made (**Open**, **Show in folder**) or why it failed.
