# Phase 03 — The Settings Entry

Makes the mode selectable and its dependency legible. Depends on phases 01–02.

## Steps

### 1. The provider entry

`SearchProvider` (`stores/settings.ts:18`) gains `'browser'`:

```ts
export type SearchProvider = 'auto' | 'duckduckgo' | 'brave' | 'searxng' | 'browser';
```

Label it for what it is and what it needs — "Browser-assisted (requires Chrome
or Chromium)" — rather than something opaque like "Enhanced". The user is
picking a mode with a dependency and a speed cost; the label should say so.

### 2. Detection status in the UI

A new IPC command (`detect_browser`) returning the detection result: the
resolved path and version, or a not-found with the list of locations searched.
`SearchSection.svelte` renders one of three states under the dropdown:

- **Found** — "Using Google Chrome 151.0.7922.137 (/usr/bin/google-chrome)".
  Naming the binary is what lets a user with three browsers understand which
  one is being driven.
- **Not found** — the locations searched, plus platform-appropriate advice.
  On Windows that advice is *not* "install Chrome": Edge ships with Windows 10+
  and is Chromium, so a not-found there means something unusual and the copy
  should say so rather than send the user to a download page they don't need.
- **Override set** — the path came from settings or `HARUSPEX_BROWSER_PATH`,
  shown so a stale override is visible rather than mysterious.

Probe on mount and on demand ("Check again"), never on a timer: launching
`--version` repeatedly to keep a label fresh is not worth the process churn.

### 3. Manual override

A path field, used when detection misses (a portable install, an unusual
prefix, a distro layout not in the candidate list). Validate on save by running
`--version` through the same verification phase 01 uses, and reject with the
actual output when it isn't a Chromium-family browser — "that isn't a
Chromium-based browser" beats a silent failure at search time.

### 4. Honesty about what the mode does

Two things the section should state plainly, because both are surprising:

- **Every search launches a real browser in the background.** Users should not
  discover a headless Chrome in their process list and wonder what it is. Say
  it starts on demand and quits when idle.
- **It is slower.** Roughly 2x per search, measured. Worth it for the engines
  it unlocks; not worth pretending otherwise.

If phase 02's fallback has been firing, say that too — a mode that has silently
been using the standard rotation for a week should not look healthy.

### 5. Tests

- The dropdown renders the new option; selecting it persists `'browser'`.
- Not-found state renders the searched locations rather than a bare error.
- Override validation rejects a non-Chromium binary and surfaces its output.
- Settings migration: an existing config with no `searchProvider` still
  defaults to `'auto'` — nobody gets moved onto a mode with a dependency by
  upgrading.

## Verification

- With Chrome installed: entry selectable, status names the binary, searches
  route through it.
- Rename the binary, hit "Check again", confirm the not-found state lists the
  paths searched and that search still works via fallback.
- Set an override to Chromium while Chrome is also installed and confirm the
  override wins and the status says so.
- Check the copy on a Windows VM if one is available — the Edge-is-already-here
  advice is the piece most likely to read wrong on the platform it targets.
