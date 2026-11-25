---
title: Chat conversations
description: Several conversations at once, steering or editing a message, retrying an answer, busy and unread marks, finding and deleting, printing and emailing, results that arrive later, the Tasks list.
---

# Chat conversations

## Run several conversations at once

While one conversation answers, open another and send there. Each has its own **Stop** and its own error message, and stopping one leaves the others running. With one stream (Settings → Inference → Parallel streams, 1 by default) the second waits for the first, unless the first is running a tool for more than a few seconds (a command, a picture, a slow server) or waiting for you to approve something or answer a question, when the second goes ahead; with more streams, or a server that runs several, they answer at the same time.

## Send while it's working

You can type and send while the assistant is still answering. The message shows above the chat box as **Queued** and goes to the assistant once its running tools finish, so it can change course without starting over. It answers with a line saying what it will do, then carries on. Click **×** on a queued message to take it back before it's read.

After you stop an answer, the assistant is told so and doesn't take that request up again unless you ask.

If the answer finishes, or you stop it, before the assistant reads a queued message, the message goes back into the chat box for you to send again. A skill (`/name`) sent while it's working goes as plain text; send it again once the answer is done to run the skill.

## Edit a message or retry an answer

Point at one of your messages and click ✏️ to put it back in the chat box. Change it and send: it replaces your message and everything after it. **Cancel** or `Esc` gives back what the box held. 🔄 under the last answer drops it and asks again.

Files written, memories saved and Python variables from the dropped turns stay. Neither shows while the chat is answering.

## See which conversations are busy

The conversation list shows a dot by each conversation that's doing something:

- **Pulsing dot**: answering.
- **Hollow dot**: waiting, for the model to start or for another conversation's turn to finish.
- **Solid dot**, title in bold: it finished an answer while you were in another conversation. Opening it clears the mark. It stays after a restart.

While any conversation is answering or waiting, the **Chat** tab has a dot too, so you see it from Code, Jobs or the other tabs. Hover over a dot to see what it means. The Remote control page (see the `remote-control` page) marks its chat list the same way, and can send and steer in any chat without changing which one this computer shows.

## Find, tidy and delete conversations

- **Search chats**, above the list, keeps the conversations whose title has every word you type, and the ones where those words were said (yours or an answer; not tool results). It searches your other computers' chats too (see `other-computers`). `Esc` clears it.
- **Select** puts a checkbox on each row. Click rows to pick them, shift-click to pick a range, or **Select all shown** for everything the search keeps, then **Delete N**. It asks first, saying how many go on each computer. An offline computer's chats can't be picked.
- **Clear all on this computer** deletes every conversation here. Your other computers' chats stay.
- Drag the list's right edge to make it wider; the width is remembered.

## Print or email an answer or a conversation

Under each answer, 🖨️ prints it and ✉️ emails it. The printer and envelope buttons beside the chat box do the same for the whole conversation: what you typed and the answers, without the reasoning or tool steps.

Print opens the text as a page, then the print dialog; **Print…** in that window opens the dialog again. Email opens a new message in the **Review email** window, with the conversation's title as its subject: add the recipients and click **Send**. It goes as formatted mail. Pictures you attached and ones Haruspex generated go inside it; a picture from the web goes as its credit and a link. Email shows only when an email account has **Allow sending** on. See the `email` page for what is sent and the size limit.

## Results that arrive while you're elsewhere

A long task started from a conversation, such as a video render or an upload (see the `video-render` page), reports back to that conversation when it ends. The assistant gets the result and answers in that conversation straight away, even if you're in a different one. A notice says which conversation it was, with **Open** to go there, and the conversation is marked unread.

If that conversation is busy when the task ends, the result waits until its current answer is done. If you stopped its last answer, or it stopped at the turn limit, the result waits for your next message or **Continue** instead, and goes to the assistant after that turn.

The result shows in the conversation as a folded line, such as *Background task "Fox" finished*; Haruspex sent it, not you. Click it to read what the assistant was told. Code sessions do the same, for tasks, background commands and subtasks.

## See background tasks

While anything runs in the background, **Tasks: N** shows at the right of the tabs, whichever tab you're in. It counts renders and uploads from any chat or Code session, and the background commands and subtasks of Code sessions open in this window. Click it for the list: each row names the chat or session it belongs to (click the name to go there), with **Cancel** or **Stop**. Tasks that ended in the last ten minutes are listed under **Done**, and the chip stays that long after the last one.

In the chat or session that started it, a task has a card with its progress and **Cancel**, then what it made (**Open**, **Show in folder**) or why it failed.
