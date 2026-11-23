---
title: Run in the background
description: Keep Haruspex running in the tray, start it at login, and quit it.
---

# Run in the background

Scheduled jobs, Home cards and research requests sent by email only run while Haruspex is open. To keep them going without the window in the way, let Haruspex live in the tray.

## Keep Haruspex running when you close the window

Turn on Settings → General → Background → Keep running in the tray. An icon appears in the system tray (the menu bar on macOS), and the window's close button now hides the window instead of quitting. Everything that was running carries on.

- Click the tray icon, or choose **Show Haruspex** from its menu, to bring the window back.
- On macOS, clicking the Dock icon does the same.
- Launching Haruspex again while it runs in the tray shows the window that is already open; it never starts a second copy.

If the switch turns itself back off with a message, your desktop has no tray for the icon to sit in. Haruspex won't hide the window in that case, since there would be no way to get it back.

## Quit Haruspex

With the tray on, closing the window no longer quits. Right-click the tray icon and choose **Quit Haruspex**. Editor and Code windows still ask about unsaved changes or running commands before they close, just as they do when you close the main window with the tray off.

## Start Haruspex when you log in

Turn on Settings → General → Background → Start at login. The next time you log in, Haruspex starts by itself.

- With Keep running in the tray on, it starts quietly in the tray, with no window.
- With it off, the window opens as usual.

The switch adds an entry to your system's own startup list (an autostart file on Linux, a login item on macOS, a startup entry on Windows), so you can also remove it from there. Turning the switch off removes the entry.

## Things to know

- **GNOME on Linux** shows no tray icons unless you install the AppIndicator extension. KDE Plasma, Cinnamon, XFCE and most other desktops show them.
- Some Linux trays open the menu on any click rather than showing the window. Use **Show Haruspex** from the menu.
- Running in the tray doesn't keep your computer awake. A job that is running holds off sleep until it finishes (Settings → General → Keep the computer awake picks which jobs do), but a scheduled job won't fire while the computer sleeps.
- Both switches belong to this computer. Other computers you connect to keep their own.
