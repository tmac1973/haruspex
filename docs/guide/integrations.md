---
title: Integrations
description: Connect email, calendars and contacts, MCP servers like GitHub or Blender, and screen capture. All off by default.
---

# Integrations

Email, calendars and contacts, MCP servers, and screen capture. All are off until set up: email and calendar in Settings → Integrations, MCP in Settings → MCP servers, screen capture in Settings → Screen.

## Connect an email account

Go to Settings → Integrations → Email and click **Add email account**. Pick a provider, enter your address and an **app password**, then click **Save password**. Switch the account on with **Enabled**.

An app password is a code your provider creates for Haruspex; it needs 2-factor authentication. Microsoft 365 and Outlook.com are not supported, because Microsoft turned off app-password access. Passwords go in the system keychain, or Haruspex's encrypted secrets file where there is no keychain (see the `search-and-network` page).

With an account on, the assistant can list recent mail, summarise a message, or read it in full. Reading a message never marks it as read. Home's Important emails card watches unread mail and drafts replies (`home` page).

## Let the assistant draft emails

Turn on **Allow sending** for an account and fill in its SMTP server (filled in for listed providers). The assistant can then draft a reply or a new message, which opens in a **Review email** window. You can edit any of it. Nothing is sent until you click **Send**. **Discard** declines it; anything in **Note** goes back to the assistant. Replies thread under the original, and a copy goes to Sent. Jobs can never send email, and auto-approve does not apply.

## Connect calendars and contacts

Settings → Integrations → Calendar & Contacts. Access is read-only: the assistant can list and search events and look up contacts, but never changes anything.

- **Sign in with Google** opens Google in your browser. **Remove** also revokes access at Google.
- **Add a server account** is for CalDAV/CardDAV servers such as Nextcloud, Fastmail, iCloud, Radicale, Baikal and Synology. Enter your address or server URL, username and app password, then click **Check** to list your calendars and address books. If your server is not found, fill in **Calendar URL** or **Contacts URL** by hand.
- **Add a calendar link** takes an iCal address (`https://…` or `webcal://…`). One link is one calendar, with no contacts. Anyone with the link can read the calendar, so Haruspex stores it like a password.

To find the link:

- **Google Calendar:** Settings → your calendar → Integrate calendar → **Secret address in iCal format**.
- **Outlook:** Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS link.
- **iCloud:** share the calendar as a Public Calendar and copy its link.

## Add an MCP server

MCP servers give the assistant tools from other software. Haruspex runs them with its own Node and Python. In Settings → MCP servers:

- **Add from the catalog** installs GitHub, Google Drive & Sheets, Browser (Playwright), Blender or Godot, then walks you through its setup.
- **Add a server on this computer** runs an MCP program you already have.
- **Add a server on your network** connects over HTTP, with an optional token. Browser sign-in is not supported yet.

Each server has **Tools**, a switch per tool. Catalog servers start with a recommended set on; others start with all off. Tools marked "asks first" ask before they run. Turn off tools you don't need; each takes room in the model's context. Pictures a tool returns reach models that read images.

**Edit** changes a local server's program, arguments and secrets; a blank secret keeps its value. Home's GitHub card uses the GitHub server and its token's access (`home` page).

**Blender and Godot** need the app running with its MCP addon. The card says when it is "not connected"; **Check again** retries.

## Update an MCP server

When a release brings a newer version of a catalog server, its card shows **Update**. The old version works until you click it. It keeps setup files, sign-ins and tool switches, and resets **Always allow**. Playwright downloads its browser again (about 200 MB); Godot's addon is replaced in each project. If the new version won't start, the old one comes back. It waits for a running tool. A version Haruspex knows is unsafe won't start; its card says why, and Update fixes it.

## Test a web app in a browser

**Browser (Playwright)** from the catalog lets the assistant open pages in a headless Chromium, click and type in them, and read the page's console and network requests. It reaches `localhost`, so the Code tab can check the app it is building. Setup downloads Playwright's own Chromium: about 200 MB, 400 MB once unpacked. It never uses your own browser or logins; each start is a fresh profile.

Its tools are on by default. Reading the page, its console and requests and taking screenshots run without asking; the rest ask first, and **Always allow** stops asking for that tool.

## Let the assistant see your screen

The camera button in the chat box attaches a screenshot of the screen, one window, or a region you drag out. To let the assistant take one when you ask, turn on Settings → Screen → **Let the assistant take a screenshot when you ask it to**. It captures once per request, never watches your screen, and needs a model that reads images.

Haruspex asks first (**Ask before each screenshot**, beside it) and hides while it captures. Asked for a window, the assistant gets the one you were using; on Linux outside KDE Plasma, the whole screen.

On Linux your desktop asks once whether Haruspex may take screenshots. On KDE Plasma, **Window…** turns the cursor into a crosshair: click the window, or press Escape. Elsewhere on Linux, and in the AppImage, **Window…** works like **Region…**. On macOS and Windows, **Window…** lists your windows. On macOS, grant Screen Recording in System Settings first.
