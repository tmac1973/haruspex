---
title: Chat conversations
description: Running several Chat conversations at once, adding to an answer while it's written, the busy and unread marks in the conversation list, and results that arrive while you're elsewhere.
---

# Chat conversations

## Run several conversations at once

While one conversation answers, open another and send there. Each has its own **Stop** and its own error message, and stopping one leaves the others running. With one stream (Settings → Inference → Parallel streams, 1 by default) the second waits for the first to finish; with more streams, or a server that runs several, they answer at the same time.

## Send while it's working

You can type and send while the assistant is still answering. The message shows above the chat box as **Queued** and goes to the assistant at its next step, so it can change course without starting over. Click **×** on a queued message to take it back before it's read.

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
