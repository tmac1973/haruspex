---
title: Web preview
description: Show a web page the Code tab's agent made in a preview window that reloads as it changes, at phone, tablet or full width, and let the agent screenshot it with the Browser (Playwright) server.
---

# Web preview

The Web preview helper shows an HTML page from a Code session's folder in a window of its own, with its CSS, scripts and images. It's on by default.

## See a page the agent made

Ask for a mockup or a page as usual ("mock up a sign-up page in `site/`"). When the agent has written it, it calls `show_preview` and the session's preview window opens on it. The window reloads by itself whenever a file the page loaded changes: an edit by the agent, a command it ran, or your own edit in an editor window.

Each session has one preview window. Previewing another page in the same session shows it in that window.

## Open a preview yourself

A **Preview** button sits beside `.html` files the agent names in its answers, and on the diff card of an `.html` file it wrote. Click it to open the page in the session's preview window, or bring that window forward.

## Check a page at phone or tablet width

The toolbar above the page has:

- the file's path (hover for its address);
- **Reload**, to load the page again;
- **Phone** (390 pixels wide), **Tablet** (820) and **Full** (the window's width). The window remembers your choice;
- **Open in browser**, to open the same address in your web browser.

## Let the agent see the page

`show_preview` gives the agent the page's address. With **Browser (Playwright)** installed from Settings → MCP servers → Add from the catalog (see the `integrations` page), the agent can open that address without asking you, take screenshots and read the page's console. Without it, the agent can't see the page; only you can.

## How the page is served

Haruspex serves the session's folder at a private address on this computer only (`http://127.0.0.1:…`), with a random part no other program knows. The page runs apart from the app and can't reach Haruspex itself. It can still load scripts and fonts from the internet, like any web page.

The address works while the preview window is open. Closing the window stops serving the folder; the next preview gets a new address.

## Turn it off

Switch off Settings → Code → Helpers → Web preview, or untick it in a session's **Extras** menu. The agent then has no `show_preview` and the **Preview** buttons go away.

## What it doesn't do

- No dev servers: it serves files as they are, with no build step, so a page that needs `npm run dev` won't work. Ask the agent to start the dev server and open its address in your browser instead.
- Nothing outside the session's folder, and no hidden files (names starting with a dot, such as `.env`).
- Only `.html` and `.htm` pages open with `show_preview` or **Preview**; links inside a page can reach the folder's other files.
- Not for a session on another computer, or one in a WSL folder.
- Not viewable from the web page for Settings → Remote control: a turn sent from there opens the window on this computer.
- Not in Chat, the Shell or subtasks.
