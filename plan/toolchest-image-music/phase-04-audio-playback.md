# Phase 04 — Audio players in answers and step cards

**Depends on:** 03 · **Enables:** 05 (the Settings test clip plays inline), 06
(the tool's answers and step cards play)

## Goal
Make cached audio playable wherever a generated image already shows:
- `![title](haruspex-audio://localhost/<hash>)` in an answer renders as a
  compact player, in both Chat and Code;
- a tool step can carry an audio artifact, which the step card plays;
- a `placeGeneratedAudio` safety net appends audio a tool made but the answer
  left out;
- the web client renders the same player.

No tool produces audio yet; the tests use stored fixtures.

## Files touched
- **`src/lib/components/AudioPlayer.svelte`** (new): a native
  `<audio controls preload="metadata">` with title, duration and a download
  button, themed with the existing CSS tokens. Props: `{src, title, mime}`.
- **`src/lib/components/AudioPlayer.test.ts`** (new).
- **`src/lib/markdown.ts`** (`sanitizeForRender`, L436-467): turn
  `![t](haruspex-audio:…)` into
  `<figure class="audio"><audio controls preload="metadata" src="…"></audio><figcaption>t</figcaption></figure>`,
  only for `LOCAL_AUDIO_URL` matches.
- **`src/lib/markdown.test.ts`:** cases.
- **`src/lib/sandbox/protocol.ts`** (L9): extend `Artifact` with
  `{ kind: 'audio'; mime: string; src: string; title: string }`.
- **`src/lib/components/SearchStep.svelte`** (L311-345): render
  `AudioPlayer` for audio artifacts. The Code tab gets it through
  `code/CodeSteps.svelte`.
- **`src/lib/audio/eligible.ts`** (new): `export const AUDIO_TOOLS: readonly
  string[] = []` (Phase 06 adds `'generate_music'`), `placeGeneratedAudio(text,
  steps, toolNames = AUDIO_TOOLS)` and `audioFromSteps(steps)`, modelled on `images/eligible.ts`
  L281-320.
- **`src/lib/audio/eligible.test.ts`** (new).
- **`src/lib/stores/chat.svelte.ts`:**
  - at L1238, call `placeGeneratedAudio` beside `placeGeneratedImages`;
  - at L334, call `rehydrateAudio` beside `rehydrateImages`.
  - The Code tab has no `placeGeneratedImages` call today and gets no audio
    safety net either. There the step card's player is the guaranteed
    surface, and the Code session's link table (Phase 03) keeps the audio.
- **`src/lib/audio/rehydrate.ts`** (new): `rehydrateAudio(conversationId,
  messages)` collects `haruspex-audio` hashes and calls `audio_rehydrate`,
  modelled on `images/resolve.svelte.ts` `rehydrateImages` (L184).
- **`src/web/components/Message.svelte`:** use `src/web/audio.ts` to rewrite
  audio URLs in rendered markdown.
- **`src/lib/stores/settings.ts` / Settings → Audio:** none. Playback uses the
  webview's default output; this is noted in the guide.

## Steps
1. **`AudioPlayer.svelte`.**
   - Native controls for accessibility and keyboard support.
   - A filename-safe download through an `<a download>` built from the title
     and extension.
   - Only one player plays at a time: a module-level `current` element is
     paused when another starts.
   - Pause any running TTS (`tts_stop_playback`) when a player starts, so the
     two never talk over each other.
2. **Markdown.**
   - In `sanitizeForRender`, before the image branch, check the URL against
     `LOCAL_AUDIO_URL` and build the figure.
   - Every other non-image `![]()` stays dropped, as now.
   - Use the platform-correct src from `audioSrc(hash)`.
   - Phase 03 allowed the scheme. The `<audio>`, `<source>` and `<figure>`
     tags rely on DOMPurify's default allow-list, as Phase 03 records.
     `src/lib/sanitize.ts` sets no `ADD_ATTR` today, and DOMPurify's default
     attribute list keeps `controls` and `preload`, so no attribute change is
     needed. The `markdown.test.ts` case asserts both attributes survive.
3. **Step artifact.** `SearchStep` renders
   `{#each step.artifacts}{#if a.kind === 'audio'}<AudioPlayer …/>` under the
   step text, and the step card stays collapsed-safe.
4. **Safety net.**
   - `placeGeneratedAudio` scans step results of the tools in `toolNames`
     (default `AUDIO_TOOLS`, empty until Phase 06) for `![…](haruspex-audio://…)` lines.
   - It appends any line whose URL is missing from the answer text.
   - Wire `placeGeneratedAudio(text, steps)` after `placeGeneratedImages` at
     `chat.svelte.ts` L1238 (Chat only, as with images). This is the only
     call site; Phase 06 just extends `AUDIO_TOOLS`.
5. **Rehydrate.** On conversation load (`chat.svelte.ts` L334), collect hashes
   with `LOCAL_AUDIO_URL` and call `audio_rehydrate(hashes, conversationId, null)`,
   which re-links rows that exist.
6. **Web client.** The web client's message renderer rewrites both forms,
   `haruspex-audio://localhost/<h>` and `http://haruspex-audio.localhost/<h>`,
   to `/api/v1/audio/<h>` before render, and
   uses the same figure markup.
7. **Guide.**
   - `docs/guide/chat.md`: one line saying generated audio plays inline in an
     answer.
   - `docs/guide/settings.md`, Audio section: note that playback uses the
     system's default output device, while read-aloud uses the device set
     there.

## Build gate
```bash
npm run check
npm run lint
npm run test
npm run format:check
npm run build:web
node scripts/guide-check.mjs
```

## Test plan
Automated:
- **`markdown.test.ts`:**
  - `![song](haruspex-audio://localhost/<64hex>)` renders an `<audio>` with
    `controls`;
  - `![x](https://evil/a.mp3)` is dropped;
  - a Windows-form URL renders.
- **`eligible.test.ts`:** a missing audio line is appended once; a present one
  is not duplicated; a non-listed tool is ignored.
- **`AudioPlayer.test.ts`:** starting one player pauses the other, and the
  download link is built correctly.

Manual:
- Store an mp3 (as in Phase 03), then paste
  `![test](haruspex-audio://localhost/<hash>)` into a debug message. It renders
  and plays in Chat and in a Code session, and seeking works.
- Restart the app and it still plays.
- Open the remote-control web page on a phone and it plays there too.

## Commit
`feat(audio): play cached audio inline in answers and tool steps`

## Rollback
Revert the PR. Markdown goes back to dropping `haruspex-audio` images, so
messages show nothing where the player was, but they still load. The cache
from Phase 03 is unaffected.
