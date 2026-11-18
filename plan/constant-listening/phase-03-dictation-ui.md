# Phase 03 — Dictation in the composers: right-click menu, indicator, spoken commands

**Depends on:** 01 (exported `ensureWhisperReady`, speech model setting) and 02 (the
`voice_listen_*` commands and `voice://listen` events) · **Enables:** 04 (the Shift+F2
toggle and tab-switch auto-stop drive the module API added here).

## Goal
The user-facing feature:
- Right-click a mic button (Chat tab composer, Shell tab assistant sidebar, Code composer)
  → **Constant listening** turns on dictation into that composer.
- Phrases are added to the end of the composer's text.
- A phrase ending in "send it" sends the message, and "scratch that" removes the last
  dictated phrase.
- The button shows listening, paused or transcribing.
- A left-click stops it. Switching chat or Code session, or the composer closing, stops it.
- An idle or device stop is reported with a toast.

## Files touched
- `src/lib/audio/dictation.ts` (new): pure helpers `cleanPhrase`, `parseDictation`,
  `appendPhrase` and `removeAppended`.
- `src/lib/audio/dictation.test.ts` (new): unit tests for the helpers.
- `src/lib/audio/voiceCapture.svelte.ts`:
  - Add the `'listening' | 'paused'` statuses, a `pendingPhrases` count, the
    `DictationTarget` interface, and `startListening`, `stopListening` and
    `isListeningOwner`.
  - Subscribe to the `voice://listen` event.
- `src/lib/audio/voiceCapture.test.ts` (created in phase 01): add event-driven tests
  against a fake target, with `invoke` and `listen` mocked.
- `src/lib/components/MicButton.svelte`:
  - New optional props `dictation?: DictationTarget` and `contextKey?: string`.
  - The right-click menu, the listening/paused/pending visuals, and left-click-to-stop.
- `src/lib/components/ChatView.svelte`: pass a `dictation` target built on
  `inputText` / `doSend`, and `contextKey={activeConversation?.id}`.
- `src/lib/components/shell/ChatSidebar.svelte`: a target on `composerText` / `doSend`
  (refusing while `submitting`), and `contextKey={session.id}`.
- `src/lib/components/code/CodeComposer.svelte`: a target on `text` / `send`, and
  `contextKey={session.id}`.
- `docs/guide/voice.md` (new): the "Voice input" page.
- `docs/guide/chat.md`: reword the **Speak** bullet to point at the `voice` page, without
  making the file bigger (it's at 5 999 of 6 000 bytes).

## Steps
1. **`dictation.ts`.**
   - `cleanPhrase(raw)`: remove `[...]` and `(...)` annotations (whisper's
     `[BLANK_AUDIO]`, `(music)`), collapse whitespace and trim.
   - `normalise(s)`: lowercase, drop everything except letters, digits, spaces and `'`, and
     collapse spaces.
   - `parseDictation(raw)` returns one of:
     - `{ kind: 'none' }` when the cleaned text is empty.
     - `{ kind: 'scratch' }` when `normalise(clean) === 'scratch that'`.
     - `{ kind: 'send', text }` when `normalise(clean)` is `send it` or ends with
       `' send it'`. `text` is `clean` with `/[\s,.;:!?-]*\bsend it[\s.,!?]*$/i` removed and
       trimmed, which may be `''`.
     - `{ kind: 'append', text: clean }` otherwise.
   - `appendPhrase(current, phrase)` returns `{ text, suffix }`. The `suffix` is
     `phrase` when `current` is `''` or ends in whitespace, and `' ' + phrase` otherwise.
   - `removeAppended(current, suffix)` returns the text with `suffix` cut off the end, or
     `null` when `current` doesn't end with `suffix`.
2. **`voiceCapture.svelte.ts`.**
   - Export `interface DictationTarget { getText(): string; setText(t: string): void; send(): Promise<boolean>; }`.
   - Module state:
     - `status` widens to `'idle' | 'recording' | 'processing' | 'downloading' | 'listening' | 'paused'`.
     - `pendingPhrases = $state(0)`.
     - Plain, non-reactive `session: number | null`, `owner: symbol | null`,
       `target: DictationTarget | null` and `lastSuffix: string | null`.
   - `startListening(ownerToken, target)`:
     1. Returns if status isn't `'idle'`.
     2. Sets `'processing'` and awaits `ensureWhisperReady()`. That function switches to
        `'downloading'` during a first-time download and back to `'processing'`, as it does
        for push-to-talk; the button shows its spinner in both. If it fails: toast "Speech
        recognition not available." and go back to `'idle'`.
     3. `session = await invoke<number>('voice_listen_start', { deviceName })`.
     4. Sets owner and target, and status to `'listening'`.
     5. On error: toast `Mic error: …` and `'idle'`.
   - `stopListening()`: when `session === null` it returns without calling `invoke`, so it
     can be called freely by the `contextKey`/`onDestroy` stops (and phase 04's tab-switch
     stop). Otherwise `await invoke('voice_listen_stop')`, then reset all state to `'idle'`. The `Stopped` event that follows is ignored because `session` is already
     null.
   - `isListeningOwner(token)` is true when `owner === token`.
   - A single `listen('voice://listen', …)` is registered lazily on the first
     `startListening`. It ignores events whose `session` isn't the current one, and handles:
     - `Paused`: status becomes `'paused'` or `'listening'`.
     - `PhraseQueued`: `pendingPhrases++`.
     - `Phrase`: `pendingPhrases--`, then `parseDictation`:
       - `append`: `appendPhrase(target.getText(), text)`, `setText`, and remember
         `lastSuffix`.
       - `scratch`: `removeAppended`. On `null`, toast "Nothing to scratch". Otherwise
         `setText` and clear `lastSuffix`.
       - `send`: append `text` if it's non-empty, then `await target.send()`. If that
         returns `false`, toast "Couldn't send yet — say “send it” again". Otherwise clear
         `lastSuffix`.
     - `Error`: toast `Transcription failed: …`.
     - `Stopped`: reset state. For `Idle`, an info toast "Constant listening stopped after 5
       minutes of silence". For `Device`, an error toast "Microphone disconnected —
       constant listening stopped".
   - The push-to-talk functions keep their `status !== 'idle'` guards, so they can't run
     while listening.
3. **`MicButton.svelte`.**
   - Make an `ownerToken = Symbol()` per instance, and derive
     `mine = isListeningOwner(ownerToken) && (status === 'listening' || status === 'paused')`.
   - Right-click, when `dictation` is set:
     - `oncontextmenu` prevents the default and opens a small menu like
       `WorkingDirButton.svelte`'s: `menu = { x, y }` state, closed by click-away, Esc or
       blur.
     - It has one item, **Constant listening**, with a check mark when `mine`.
     - Picking it calls `startListening(ownerToken, dictation)` or `stopListening()`.
     - The item is disabled when status isn't `'idle'` and the session isn't `mine`.
   - While `mine`:
     - `onmousedown` calls `stopListening()` instead of starting push-to-talk.
     - Enter/Space keydown stops too.
     - `onmouseleave` and `onblur` don't cancel.
     - The `disabled` prop doesn't stop listening; it only blocks starting.
   - Visuals:
     - `class:listening={mine && status === 'listening'}`: an accent-coloured ring with a
       slow 2 s "breathe" opacity animation, so it doesn't look like the red recording
       pulse.
     - `class:paused={mine && status === 'paused'}`: the ring at 40 % opacity, no
       animation.
     - When `pendingPhrases > 0`, a small spinner dot at the top-right of the button.
     - `aria-pressed` is true while `mine`.
   - Tooltips:
     - Listening: "Listening — click to stop. Say “send it” to send, “scratch that” to undo."
     - Paused: "Paused while audio plays".
     - The idle tooltip gains "· right-click for constant listening" when `dictation` is set.
   - Auto-stop:
     - `$effect` tracks `contextKey`. When it changes while `mine`, call `stopListening()`.
     - `onDestroy` does the same when `mine`.
4. **ChatView.svelte.**
   ```ts
   const dictation: DictationTarget = {
     getText: () => inputText,
     setText: (t) => { inputText = t; if (inputEl) autosizeTextarea(inputEl); },
     send: async () => { await doSend(inputText); return true; }
   };
   ```
   Pass `{dictation}` and `contextKey={activeConversation?.id}` to `<MicButton>`, keeping
   the existing `onTranscription`. ChatView queues sends as steering while a turn is running,
   so `send` always succeeds. Use the autosize helper ChatView already uses for `inputEl`.
5. **ChatSidebar.svelte.** Its target uses `composerText`.
   `send: async () => { if (submitting) return false; await doSend(composerText); return true; }`.
   Its `contextKey` is `session.id`.
6. **CodeComposer.svelte.** Its target uses `text` and `autosize()`.
   `send: async () => { if (blocked) return false; await send(text); return true; }`.
   Its `contextKey` is `session.id`.
7. **Guide.**
   - Add `docs/guide/voice.md` with `title: Voice input` and a `description`. Sections:
     - "Talk instead of typing": push-to-talk.
     - "Dictate with constant listening": right-click → Constant listening; text lands in
       the box; "send it" and "scratch that"; click to stop.
     - "When it stops by itself": switching conversation or Code session, 5 minutes of
       silence, a disconnected mic. Listening pauses while an answer is read aloud. Phase
       04 adds switching tab and in-page audio.
     - "Pick the speech model": Settings → Audio → Speech model.
     - "What it doesn't do": no replies read aloud automatically, no word-by-word text,
       English only on Fast.

     Keep it under 6 000 bytes. Phase 04 adds the Shift+F2 line.
   - In `chat.md`, replace the **Speak** bullet with "- **Speak:** hold the microphone
     button or `F2` and release to send, or right-click it to dictate. See the `voice`
     page." Check that `pages.test.ts`'s 6 000-byte limit still passes; if not, shorten
     neighbouring wording. Don't run Prettier on `docs/guide`.

## Build gate
- `npm run check && npm run lint && npm run test`
- `cd src-tauri && cargo test` (no Rust changes are expected; it confirms nothing drifted)
- `node scripts/guide-check.mjs < /dev/null`

## Test plan
- `dictation.test.ts`:
  - `parseDictation('[BLANK_AUDIO]')` gives `none`.
  - `'Scratch that.'` gives `scratch`.
  - `'That covers it, send it.'` gives `send` with text `'That covers it'`.
  - `'Send it!'` gives `send` with `''`.
  - `'I want to send it to Bob'` gives `append`, since "send it" isn't at the end.
  - `appendPhrase('hi', 'there')` gives the suffix `' there'`.
  - `removeAppended('hi there!', ' there')` gives `null`.
- `voiceCapture.test.ts`, with mocked `invoke` / `listen` and a fake target:
  - `PhraseQueued` then `Phrase` appends text and the pending count goes back to 0.
  - "scratch that" restores the earlier text.
  - "…send it" calls `target.send` once, without the trigger in the text.
  - Events with another `session` are ignored.
  - `Stopped { reason: 'Idle' }` resets to `'idle'` and toasts.
- In the dev app, for each of the three composers:
  - Right-click → Constant listening, then dictate three sentences: they're added in order.
  - "scratch that" removes the last one.
  - "send it" sends, and listening carries on.
  - Left-click stops it, and the OS mic indicator goes off.
  - Switching conversation stops it.
  - Push-to-talk still works when listening is off.

## Commit
`feat(voice): dictate into the composer with constant listening from the mic button's menu`

## Rollback
Revert the commit. MicButton goes back to push-to-talk only, and the composers lose their
`dictation` prop. Phase 02's commands stay but nothing calls them, which is harmless.
`docs/guide/voice.md` goes with the revert.
