# Phase 05 — Music backend layer and Settings → Music

**Depends on:** 01 (`phase`, `meta.api`), 02 (the Rust toolchest client and the
`src/lib/toolchest/` helpers), 03 (`audio_store_url`), 04 (`AudioPlayer`) ·
**Enables:** 06

## Goal
Add a music backend layer that mirrors `src/lib/image/`: types, a registry, a
`none` backend, and a `llama-toolchest` backend over `/v1/music/jobs`. Add a
Settings → Music section in the Capabilities group with:
- the backend choice;
- Connection (address, saved key, Model dropdown of ACE instances with state);
- Default length;
- Test generation, which makes a 10 s clip and plays it;
- the audio cache size, with "Clear unused audio".

Autodetection works as it does for images.

## Files touched
- **`src/lib/music/types.ts`** (new):
  - `MusicBackendKind = 'none' | 'llama-toolchest'`;
  - `MusicRequest {title, caption, lyrics?, durationSec, instrumental, bpm?, key?,
    timeSignature?, language?, seed, format: 'mp3' | 'wav'}`;
  - `MusicProgress {phase: 'queued' | 'running' | 'composing' |
    'synthesizing' | 'saving', ahead?}` (`running` only for pre-Phase-01
    jobs with no `phase`);
  - `MusicResult {hash, url, mime, durationSec, seed, model, bpm?, key?}`;
  - `MusicGenerateOptions {signal, onProgress, conversationId?,
    codeSessionId?}`;
  - `MusicBackendError` (same kinds as images).
- **`src/lib/music/backend.ts`**, **`registry.ts`**, **`none.ts`**,
  **`index.ts`** (new): `MusicBackend {kind, probe(), generate(req,
  opts: MusicGenerateOptions)}` and `resolveMusicBackend()`.
- **`src/lib/music/progress.ts`** (new): `describeMusicProgress` → "Queued
  (2 ahead)", "Generating…", "Composing…", "Synthesizing…", "Saving…".
- **`src/lib/music/toolchest/adapter.ts`**, **`backend.ts`**,
  **`adapter.test.ts`**, **`backend.test.ts`** (new).
- **`src/lib/toolchest/fixtures/`:** a recorded music job JSON in each status.
- **`src/lib/stores/settings.ts`:**
  - `musicBackendKind: 'none'`;
  - `musicToolchestBaseUrl: ''`, `musicToolchestApiKeyId: null`,
    `musicToolchestModelId: ''`;
  - `musicDefaultDurationSec: 30`.
- **`src/lib/components/settings/MusicSection.svelte`** (new) and
  **`MusicSection.test.ts`** (new).
- **`src/lib/components/settings/SettingsPanel.svelte`:**
  - import;
  - `'music'` in the `Category` union (L28-44);
  - an entry after Image in the Capabilities group (L141-146) with a feather
    "music" icon;
  - an `{:else if}` branch (L267-268).
- **`src/lib/components/settings/SettingsPanel.test.ts`:** the Music entry.
- **`src/lib/toolchest/models.ts`:** add `'musicToolchestApiKeyId'` to
  `ApiKeyIdField`.
- **`src/lib/guide/status.ts`:** a `MUSIC` map and a status line, as for
  images.
- **`docs/guide/music.md`** (new):
  - title/description frontmatter;
  - "Turn it on";
  - "Set up llama-toolchest";
  - "Where the audio is kept";
  - "What it doesn't do".
- **`src/lib/guide/guide.ts`** (`ORDER`, L14-35): add `music` after `images`.
- **`docs/guide/settings.md`:** a Music section.

## Steps
1. **Music layer.** Copy the shape of `src/lib/image/backend.ts` and
   `registry.ts` without the image-only parts (capabilities, LoRAs). `none`
   probes to "Choose a backend in Settings → Music."
2. **Toolchest adapter.** `buildJobBody(req, model)` maps:
   - `caption`;
   - `lyrics`: `"[Instrumental]"` when `instrumental` and no lyrics;
   - `duration`, `bpm`, `keyscale`, `timesignature`, `vocal_language`, `seed`,
     `output_format`;
   - `rewrite_caption: false`.
   - Zero or empty values are omitted, as toolchest does.
3. **Toolchest backend.**
   - `probe()` uses `parseGenerationModels(json, 'music')` from Phase 02, with
     the same messages as the image probe. "No running music instance on
     <host>…" says to start one in llama-toolchest.
   - `generate()`:
     - `POST /v1/music/jobs` through `toolchest_json`;
     - poll every 1000 ms, mapping `phase` and `queue_position` to
       `MusicProgress`;
     - on `succeeded`, call `audio_store_url(base + audio_url, key, mime,
       req.title, opts.conversationId, opts.codeSessionId)` and return
       `MusicResult` with `hash` and `url = audioSrc(hash)`, filled from `result` (bpm, key, duration, seed);
     - on `failed`, raise `rejected(error)`;
     - on abort, `DELETE` the job, then raise `cancelled`;
     - on 429, raise "llama-toolchest's queue is full; try again in a minute."
   - Before Phase 01 builds: a job with no `phase` reports `queued` while
     `status=queued`, and "Generating…" while running.
   - No total timeout: a job that stays `running` is polled until the turn is
     cancelled. 20 failed polls in a row (unreachable) raise `unreachable`.
4. **Settings → Music UI.** Reuse the Connection-section markup from
   `ImageSection.svelte`:
   - extract the address, key and model rows into
     `components/settings/ServerConnection.svelte` with props `{fields, models,
     probe}`;
   - switch ImageSection to it in this phase, behaviour-neutral, with the
     `ImageSection.test.ts` cases still passing.
   - Below the Connection rows:
     - **Default length:** a number input in seconds, clamped 5–240.
     - **Test generation:** a 10 s instrumental titled "Test clip" with
       caption "short upbeat chiptune loop", progress line, then `AudioPlayer`. Stored without a
       conversation, so the sweep collects it after an hour.
     - **Audio cache:** "Audio cache: 312 MB" with a "Clear unused audio"
       button calling `audio_cache_clear`.
     - `<ToolchestModels kind="music" instances={…} baseUrl={…}>` from
       Phase 02.
5. **Autodetect.**
   - Switching to `llama-toolchest` with an empty address prefills from
     `inferenceToolchest()`.
   - With `none`, `toolchestHint('music')` shows "llama-toolchest on <host>
     has music models."
6. **Guide.**
   - Write `music.md` under 6 KB; it states that toolchest is the only backend
     and keeps its own copy for 24 h.
   - Add Settings → Music to `settings.md`.
   - The PR body names `music` and `settings`.

## Build gate
```bash
npm run check
npm run lint
npm run test
npm run format:check
node scripts/guide-check.mjs
```
(No Rust or IPC changes in this phase.)

## Test plan
Automated:
- **`adapter.test.ts`:** an instrumental with no lyrics sends
  `"[Instrumental]"`; zero bpm is omitted; `format` maps to `output_format`.
- **`backend.test.ts`,** with a mocked `invoke`:
  - queued (2 ahead) → composing → synthesizing → succeeded → `audio_store_url`
    called with the absolute URL and key;
  - abort sends `DELETE`;
  - `failed` maps its error;
  - 20 unreachable polls raise `unreachable`;
  - a pre-Phase-01 job without `phase` still finishes.
- **`MusicSection.test.ts`:**
  - kind switch prefill;
  - the hint;
  - Default length clamps to 5–240;
  - Test generation renders a player on success.
- **`SettingsPanel.test.ts`:** Music appears after Image and opens its
  section.
- **`ImageSection.test.ts`:** still green after the `ServerConnection`
  extraction.

Manual:
- Settings → Music → llama-toolchest, pointing at asmodean:3000 (start
  `ace-xl` in toolchest first). Probe lists `ace-xl — running`.
- Test generation shows the phases and then plays a 10 s clip.
- Clear unused audio shrinks the size line.

## Commit
`feat(music): add a music backend layer and Settings → Music with llama-toolchest`

## Rollback
Revert the PR. The settings fields are additive, and the Music category
disappears. If a saved `haruspex-settings-category` was `'music'`, it falls
back to `general` through the existing guard in `SettingsPanel.svelte`
`onMount` (`categories.some(...)`). The `ServerConnection` extraction is
reverted too, and ImageSection returns to its inline markup.
