---
title: Integrations
description: Connect email (IMAP, optional sending), calendars and contacts, MCP servers like GitHub or Blender, and screen capture. All off by default.
---

# Integrations

Haruspex can read your email, calendars and contacts, connect to other software through MCP servers, and look at your screen. Everything here is off until you set it up. Email, calendar and MCP live in Settings → Integrations; screen capture is in Settings → Screen.

## Connect an email account

Go to Settings → Integrations → Email and click **Add email account**. Pick a provider (Gmail, Fastmail, iCloud, Yahoo, or Custom), enter your address and an **app password**, then click **Save password**. It tests the connection before saving. Switch the account on with **Enabled**.

An app password is a code your provider creates for Haruspex; it needs 2-factor authentication on your account. Microsoft 365 and Outlook.com are not supported, because Microsoft turned off app-password access. Passwords go in the system keychain, or Haruspex's encrypted secrets file where there is no keychain.

With an account on, the assistant can list recent mail, summarise one message, or read one in full. Reading a message never marks it as read.

## Let the assistant draft emails

Turn on **Allow sending** for an account and fill in its SMTP server (filled in for you for the listed providers). The assistant can then draft a reply or a new message, which opens in a **Review email** window. You can edit From, To, Cc, Subject and the text. Nothing is sent until you click **Send**. **Discard** declines it; anything in **Note** goes back to the assistant. Replies thread under the original, and a copy goes to Sent. Jobs can never send email, and auto-approve does not apply.

## Connect calendars and contacts

Settings → Integrations → Calendar & Contacts. Access is read-only: the assistant can list and search events and look up contacts, but never creates, changes or deletes anything.

- **Sign in with Google** opens Google in your browser. Haruspex asks only to read your calendars and contacts. You may see an "unverified app" screen first. **Remove** also revokes access at Google.
- **Add a server account** is for CalDAV/CardDAV servers such as Nextcloud, Fastmail, iCloud, Radicale, Baikal and Synology. Enter your address or server URL, username and app password, then click **Check** to list your calendars and address books. If your server is not found, fill in **Calendar URL** or **Contacts URL** by hand.
- **Add a calendar link** takes an iCal address (`https://…` or `webcal://…`). One link is one calendar, with no contacts. Anyone with the link can read the calendar, so Haruspex stores it like a password.

To find the link:

- **Google Calendar:** Settings → your calendar → Integrate calendar → **Secret address in iCal format**.
- **Outlook:** Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS link.
- **iCloud:** share the calendar as a Public Calendar and copy its link.

## Add an MCP server

MCP lets the assistant use tools from other software. Haruspex installs and runs MCP servers itself with its own bundled Node and Python runtimes, so there is no terminal step. In Settings → Integrations → MCP integrations:

- **Add from the catalog** installs GitHub, Google Drive & Sheets, Blender or Godot, then walks you through a setup wizard (tokens, files, a project folder).
- **Add a server on this computer** runs an MCP program you already have.
- **Add a server on your network** connects over HTTP, with an optional token. Servers that sign in through a browser are not supported yet.

Each server has **Tools**, a switch per tool. Catalog servers start with a recommended set on; others start with all off. Tools marked "asks first" ask before they run. Turn off tools you don't need: every tool takes up room in the model's context.

**Blender and Godot** need the app itself running with its MCP addon. The server card says when the app is "not connected"; **Check again** retries.

## Let the assistant see your screen

The camera button in the chat box attaches a screenshot whenever you click it. To let the assistant take one when you ask, turn on Settings → Screen → **Let the assistant take a screenshot when you ask it to** (off by default). It captures once per request and never watches your screen. The model must be able to read images.

On Linux your desktop asks which screen to share. On macOS, grant Screen Recording in System Settings first.
