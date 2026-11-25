---
title: Email
description: Connect an email account, let the assistant read and draft mail, find mail you sent, email an answer, a conversation or a notebook, write to contacts by name, and the size limit.
---

# Email

## Connect an email account

Go to Settings → Integrations → Email and click **Add email account**. Pick a provider, enter your address and an **app password**, then click **Save password**. Switch the account on with **Enabled**.

An app password is a code your provider creates for Haruspex; it needs 2-factor authentication. Microsoft 365 and Outlook.com are not supported: Microsoft turned off app passwords. Passwords go in the system keychain, or Haruspex's encrypted secrets file where there is no keychain (see the `search-and-network` page).

With an account on, the assistant can list recent mail, summarise a message, or read it in full. Reading a message never marks it as read. Home's Important emails card watches unread mail and drafts replies (see the `home` page).

## Find mail you sent

The assistant reads the inbox unless you ask about another folder. It can also list and read Sent, Drafts, Trash, Junk and Archive, so "what did I tell Sam about the invoice?" finds your Sent copy. It can narrow Sent by who a message went to.

Haruspex finds those folders the way your mail app does: by the role the server gives them, or by a usual name such as "Sent Items" or "[Gmail]/Drafts". If an account has no such folder, the assistant says so. Folders you made yourself can't be read, and the other folders are only read: nothing is moved or deleted there.

## Let the assistant draft emails

Turn on **Allow sending** for an account and fill in its SMTP server (preset for listed providers). The assistant can then draft a reply or a new message, and can attach a notebook or one card of it: as a PDF unless you ask for Word, OpenDocument, a web page or Markdown. A file or picture card attaches the file it holds.

Every draft opens in a **Review email** window. Edit any of it, and remove an attachment with its **×**. Nothing is sent until you click **Send**. **Discard** declines it; a **Note** goes back to the assistant. Replies thread under the original, and a copy goes to Sent. Jobs never send email (camera alerts aside: see the `camera-alerts` page), and auto-approve does not apply.

## Email an answer, a conversation or a notebook

With an account that may send, Chat shows ✉️ under each answer, and an envelope button beside the chat box for the whole conversation (see the `chat-conversations` page). A notebook's **⋯ → Email…** and a card's **⋯ → Email card…** do the same in Notebooks (see the `notebook-files` page).

The message opens in **Review email** with no recipient yet. Its text is Markdown, which is sent as formatted mail with a plain-text copy for mail apps that show only text. **Preview** shows it as it will look.

- Pictures that are yours go inside the message: ones you attached, ones Haruspex generated, a notebook's pictures and Python plots.
- A picture from the web is not sent. Its credit and a link to where it came from are sent instead.
- A notebook's file cards are attached. **Attach as PDF** adds the notebook as a PDF too; it is off unless you tick it.

## Write to your contacts

With a contacts account connected (Google, or a CardDAV server: see the `integrations` page), **To** and **Cc** in **Review email** suggest contacts as you type a name or an address. Use ↑ and ↓ to choose and Enter or Tab to add one, or click it; Esc closes the list. A contact is added with their name, as `Sam Lee <sam@example.com>`.

You can also ask the assistant to "email Sam the notes" by name. It looks the name up in your contacts. If the name fits more than one address, the assistant asks which one; if it fits none, it asks for the address.

Haruspex keeps the list of addresses in memory for five minutes, so a contact added in the last few minutes may not be suggested yet.

## How much a message can carry

Pictures and attachments together can be up to 18 MB, which fits under Gmail's 25 MB limit once encoded. The window shows the total, and **Send** is off while it is over. A file that would take a message over the limit is left out before the window opens, and the window names it.

Gmail shows only the first part of a very long message and links to the rest ("Message clipped"). Pictures don't count toward that, but a notebook with large tables can reach it.
