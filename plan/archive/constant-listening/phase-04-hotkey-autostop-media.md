# Phase 04 — Shift+F2, tab-switch auto-stop, pausing for in-page audio, follow-ups

**Depends on:** 02 (`voice_listen_hold`) and 03 (`startListening` / `stopListening`,
`DictationTarget`, the `voice` guide page) · **Enables:** the PR and hand tests.

## Goal
- Shift+F2 toggles constant listening from anywhere, into the composer for the current tab.
- Switching tab stops it.
- Listening also pauses while audio or video plays inside the page (generated speech,
  songs, video previews), not just read-aloud.
- The shortcuts list and guide are updated, and a GitHub issue is filed for hands-free
  conversation plus the hand tests.

## Files touched
- `src/lib/audio/voiceCapture.svelte.ts`:
  - A dictation-target registry: `registerDictationTarget(surface, token, target)`, which
    returns an unregister function, and `toggleListeningFor(surface)`.
  - A media-hold listener: `installMediaHold()`.
- `src/lib/components/MicButton.svelte`: a new optional `surface?: 'chat' | 'shell' | 'code'`
  prop. When `surface` and `dictation` are both set, it registers on mount and unregisters
  on destroy.
- `src/lib/components/ChatView.svelte`, `src/lib/components/shell/ChatSidebar.svelte` and
  `src/lib/components/code/CodeComposer.svelte`: pass `surface="chat"`, `"shell"` and
  `"code"`.
- `src/routes/+layout.svelte`:
  - The Shift+F2 key handler.
  - A `$effect` that stops listening on `hotkeyTab()` change.
  - Call `installMediaHold()` on mount.
- `src/lib/shortcuts.ts`: add `{ keys: 'Shift + F2', action: 'Constant listening — dictate into the composer (toggle)' }`
  to Global.
- `docs/guide/shortcuts.md`: the same key and action, written exactly as `shortcuts.ts`
  writes them.
- `docs/guide/voice.md`: add "or press `Shift + F2`" to the dictation section. Add
  "switching tab" to "When it stops by itself", and widen the pause sentence to "while an
  answer is read aloud or audio or video plays in the page".
- `src/lib/audio/voiceCapture.test.ts`: tests for the registry and media hold.

## Steps
1. **Registry.**
   - `const targets = new Map<'chat' | 'shell' | 'code', { token: symbol; target: DictationTarget }>()`.
     A later registration for the same surface replaces the earlier one; the newest mounted
     composer wins.
   - The unregister function only deletes the entry if its token still matches.
   - `toggleListeningFor(surface)`:
     - If status is `'listening'` or `'paused'`, call `stopListening()`.
     - Otherwise, if there's an entry for `surface`, call `startListening(entry.token,
       entry.target)`, so the owning MicButton lights up because the token matches.
     - Otherwise toast "No composer to dictate into here".
2. **MicButton.** In `onMount`, if `surface && dictation`, keep
   `registerDictationTarget(surface, ownerToken, dictation)`'s return value and call it in
   `onDestroy`.
3. **Shift+F2 in `+layout.svelte`.**
   - In `onGlobalKeydown`, before the `if (!hasNoModifiers(event)) return;` line, add a
     branch for `event.key === 'F2' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey`
     that calls `handleListenToggleKey(event)` and returns.
   - `handleListenToggleKey`:
     1. `preventDefault`, and ignore `repeat`.
     2. `const tab = hotkeyTab()`. Unless `tab === 'chat' || tab === 'shell' || tab === 'code'`,
        toast "No composer to dictate into here" and return. This narrows `tab` to the
        `surface` type.
     3. If `tab === 'shell'`, `getActiveShellSession()?.setSidebarOpen(true)` (it already
        exists, `stores/shell.svelte.ts`, and F2 uses it) and `await tick()` so ChatSidebar
        has mounted and registered.
     4. `void toggleListeningFor(tab)`.
   - Make sure the plain-F2 `onGlobalKeyup` path ignores Shift+F2 by adding
     `if (event.shiftKey) return;` before `stopAndTranscribe`. That call already does
     nothing unless status is `'recording'`, but this makes it explicit.
4. **Tab-switch auto-stop.** In `+layout.svelte`:
   ```ts
   let lastTab = hotkeyTab();
   $effect(() => {
     const tab = hotkeyTab();
     if (tab !== lastTab) { lastTab = tab; void stopListening(); }
   });
   ```
   `stopListening` already does nothing when `session === null` (phase 03). The detached
   Code window's `hotkeyTab()` is always `'code'`, so it never fires there.
5. **Media hold.** `installMediaHold()` in `voiceCapture.svelte.ts`:
   - Add capture-phase `document` listeners for `play`, `pause`, `ended`, `emptied` and
     `volumechange`. Media events don't bubble, so they must be capture-phase.
   - Keep a `Set<HTMLMediaElement>` of elements that are playing and not muted. Each event
     re-checks its element: add it when `!paused && !muted && volume > 0`, otherwise
     remove it.
   - When the set goes from empty to non-empty, `invoke('voice_listen_hold', { hold: true })`.
     When it goes back to empty, send `hold: false`.
   - Only send these while `session !== null`. On `startListening`, if the set is already
     non-empty, send `hold: true` straight away.
   - Return a disposer, which `+layout.svelte` calls on destroy.
6. **Shortcuts.** Add the `shortcuts.ts` entry and the matching `docs/guide/shortcuts.md`
   row, and check `src/lib/guide/pages.test.ts` passes. Add the Shift+F2 sentence to
   `voice.md`. Don't run Prettier on `docs/guide`.
7. **Issues, after the commit and once the PR is open** (`gh pr create` comes after this
   phase, since there's one PR for the branch). File them with `gh issue create`, after
   checking `gh issue list` for an existing voice issue to extend instead, then add both
   links to the PR body:
   - "Hands-free conversation mode": auto-send each phrase, read replies aloud, mute the
     mic or cancel echo during playback, talking over the reply. Link it from the PR.
   - "Hand test: constant listening (#PR)", with a checklist of the success criteria in
     `overview.md`. Include speakers rather than headphones for the TTS pause, a USB mic
     unplugged mid-session (Device stop), the 5-minute idle stop, and Windows and macOS
     mic permission prompts.

## Build gate
- `npm run check && npm run lint && npm run test`
- `cd src-tauri && cargo fmt -- --check && cargo clippy --all-targets -- -D warnings && cargo test`
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- `voiceCapture.test.ts`:
  - `toggleListeningFor('code')` with a registered code target calls `voice_listen_start`.
  - Calling it again calls `voice_listen_stop`.
  - With nothing registered it toasts.
  - An unregister function with a stale token leaves the newer entry in place.
  - Media hold: while a session is active, take an `<audio>` element whose `paused` has been
    stubbed with `Object.defineProperty(el, 'paused', { configurable: true, get: () => false })`
    (jsdom leaves it `true`), and dispatch `play`: that sends `hold: true`. Then stub
    `paused` back to `true` and dispatch `ended`: that sends `hold: false`.
- `pages.test.ts` passes with the new shortcut.
- In the dev app:
  - Shift+F2 on the Chat tab starts dictation into the chat box; Shift+F2 again stops it.
  - On the Shell tab it opens the sidebar and dictates there.
  - Ctrl+5 to the Code tab while listening on Chat stops it.
  - Playing a generated speech file in an answer pauses listening until it ends.
  - Plain F2 push-to-talk still sends on release.

## Commit
`feat(voice): toggle constant listening with shift+f2 and pause it while page audio plays`

## Rollback
Revert the commit. Dictation from the right-click menu (phase 03) keeps working, and only
the shortcut, tab-switch stop and in-page media pause go away. The shortcut list and guide
revert with it, so the `pages.test.ts` pairing stays consistent.
