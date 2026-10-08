---
title: Memory
description: How Haruspex remembers facts across chats, "remember that…", incognito chats, reviewing or deleting memories, privacy, and turning memory off.
---

# Memory

Memory carries facts and preferences from one conversation into the next, so you don't have to repeat yourself. It is on by default and works in the Chat tab.

## What gets remembered

A couple of minutes after a chat goes quiet, or when you switch to another chat, Haruspex reads the new part of the finished conversation in the background. It keeps the stable facts that are likely to matter later, in four kinds:

- **preference** — how you like things done
- **fact** — stable facts about you
- **project** — ongoing work you will come back to
- **correction** — something the assistant had wrong

Before a fact is saved, Haruspex checks it against what it already remembers. A near-exact repeat is dropped. A fact that reads like stored memories goes to the model, which decides whether it says the same thing (nothing is saved), adds a detail (the stored memory is rewritten to hold both), or is new. A memory you asked it to save is never rewritten this way.

Very short chats are skipped. Only what you and the assistant wrote is read: web pages and files the assistant opened are not, so a page saying "remember this" cannot add to your memory.

## How memories are used

When you send a message, Haruspex looks for remembered facts related to it and gives the few most relevant ones to the model. Answers that used memory show a **Recalled N memories** line; click it to see which, and **Forget this** to delete one.

## Ask it to remember something

Say "remember that I use fish, not bash." The assistant saves it at once, without waiting for the background pass. By default it first shows **Remember this?** with the exact text and three choices:

- **Remember it** — save this one, ask again next time
- **Allow for this session** — save without asking until you restart the app
- **Don't save** — nothing is stored, and the model is told you declined

To skip the question, turn off Settings → Memory → **Ask before saving something you asked me to remember**. Leaving it on means text planted in something the assistant reads cannot save a memory without you seeing it.

## Keep a chat out of memory

Click the eye button in the chat box to make that chat incognito. It will not be read for memories, and nothing remembered is brought into it. A banner in the chat says "Incognito — this chat won't be remembered". Click again to undo. Chats from other devices through remote access are never remembered.

## Review, edit or delete memories

Settings → Memory lists every stored fact under **Remembered facts**, with its kind and whether you asked for it or it was inferred. You can filter the list, and each fact has **Edit**, **Copy** and **Delete**.

**Find duplicates** (Settings → Memory → Duplicates) looks for memories that say the same thing. The model groups them and suggests one sentence for each group; edit it if you like, then **Merge**, or **Skip**. Merging keeps one memory (one you saved, if there is one) and deletes the rest. Nothing changes until you press Merge.

**Forget everything…** at the bottom deletes every memory. You type `delete` to confirm, and it cannot be undone. Your conversations are not touched.

## The embedding model

Memory needs a small embedding model (about 65 MB) to tell which facts are relevant. It is downloaded once from Hugging Face, normally right after first-run setup, then runs on your computer. If it is missing, Settings → Memory shows **Download embedding model**, and nothing is remembered or recalled until it is there.

## What stays on your device

Memories are stored on your computer, and the embeddings are calculated on your computer. Nothing is uploaded to a memory service.

One limit: finding facts in a chat is done by the model that Chat uses. With the local model that stays on your machine. If you use a remote server or OpenRouter, the conversation already goes there, and so does this background pass. The duplicate checks also run on that model, and send it the memories being compared.

## Turn memory off

Untick Settings → Memory → **Carry facts and preferences from one conversation into the next**. Nothing new is remembered or recalled, and the incognito button disappears. Stored memories are kept until you delete them.
