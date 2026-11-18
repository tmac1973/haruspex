# Constant Listening — Project Overview

## Problem
Voice input is push-to-talk only: hold the mic button (or F2), speak, release, and the
transcript is sent straight away as a message. That works for short questions but not for
brainstorming or dictating something long, because you have to hold a key the whole time
and every release sends a message.

Constant listening lets you turn the mic on and leave it on. The app writes what you say
into the chat box phrase by phrase, so you can talk at length, look at the text, edit it,
and send when you're ready.

## Goals
- Right-click any mic button (Chat tab composer, the Shell tab's assistant sidebar
  `ChatSidebar.svelte`, Code tab composer) →
  **Constant listening** turns on always-on listening for that composer.
- Shift+F2 toggles it from anywhere. While it's on, a left-click on the mic button turns it off.
- Speech is split into phrases at pauses (voice activity detection in Rust). Each phrase is
  transcribed by the existing whisper-server and added to the end of the composer's text.
- A phrase ending in **"send it"** drops those words and sends the composer, then listening
  carries on for the next message.
- A phrase that is **"scratch that"** removes the last phrase that was dictated.
- Listening pauses while an answer is read aloud (TTS) and resumes when it ends.
- It stops by itself when you switch chat or tab, or after 5 minutes with no speech.
- Settings → Audio → **Speech model** picks base.en (default) or large-v3-turbo for all
  voice input. The turbo file is shared with the video tools.
- A clear always-on indicator on the mic button: listening, paused or transcribing.

## Non-goals
- Hands-free conversation (auto-send every phrase, reply read aloud automatically, echo
  cancellation, talking over the reply). Filed as a follow-up GitHub issue.
- Word-by-word text while you're still speaking; text arrives one finished phrase at a time.
- Haru-4B or any speech-to-speech model.
- Voice commands other than "send it" and "scratch that", and a configurable trigger phrase.
- Constant listening in the remote web client (Settings → Remote control).
- Listening when no composer is on screen, or dictating into other apps.
- Changing how push-to-talk behaves: it still sends on release.

## Users & primary flow
Anyone using voice input in Haruspex; the main case is the user brainstorming or dictating.

1. Right-click the mic button in the chat composer → **Constant listening** (or press Shift+F2).
2. The first time, the whisper model downloads and the server starts, as push-to-talk
   does today. The button shows the always-on listening state.
3. The user talks. At each pause the phrase is transcribed and added to the composer
   (separated by a space), with the indicator showing "transcribing" in the meantime.
4. The user can type in the composer at any time. Dictated text is always added at the end.
5. "Scratch that" removes the last dictated phrase. "…and that's the plan, send it" sends
   the composer without the trigger words and starts a new message.
6. If the user clicks play on an answer, listening pauses until the audio finishes.
7. A left-click on the mic button, Shift+F2, switching chat or tab, or 5 minutes of silence
   turns it off.

## Constraints
- Tauri 2 + Svelte 5 runes. Mic capture stays in Rust (`src-tauri/src/audio.rs`, cpal). The
  webview never opens the mic.
- whisper.cpp v1.9.2 whisper-server sidecar on port 8766 (`src-tauri/src/whisper.rs`),
  which takes one WAV per `/inference` request. The live audio is split into phrases on our
  side, not by the server.
- Linux, Windows and macOS. Device hot-swap handling in `audio.rs` (`safe_cpal`, fresh
  device lookup each time) must keep working.
- Only one recorder at a time. Push-to-talk (F2) and constant listening share the
  `AudioRecorder` singleton and the `voiceCapture` state module, and can't both run.
- Transcription must not fall behind. base.en on Vulkan should return each phrase within
  about a second.
- UI copy rules: one short sentence, details in `title` tooltips, Settings paths in full.
- User-facing change:
  - Add a new `docs/guide/voice.md` page covering voice input in all three composers.
  - Point `docs/guide/chat.md` at it, and update `docs/guide/shortcuts.md` (matching
    `src/lib/shortcuts.ts`) and `docs/guide/settings.md`.
  - Leave `docs/guide/code-sessions.md` and `shell.md` alone. They're already at the
    6 000-byte limit and don't mention the mic; the `voice` page covers those composers.
  - Each page stays under 6 000 bytes.
- A new Tauri command or `#[ts(export)]` type means running `./scripts/export-ipc-types.sh`.

## Success criteria
- Right-click → Constant listening, then speaking three sentences with pauses puts all three
  in the composer, in order, without sending anything.
- Silence produces no text. No "Thank you." from whisper making things up during long pauses.
- "send it" at the end of a phrase sends the message without those words, and the next
  phrase starts a new draft.
- "scratch that" removes exactly the last dictated phrase and leaves typed text alone.
- Playing TTS through speakers while listening adds none of its words to the composer.
- Switching chat, switching tab, Shift+F2, a left-click and 5 minutes of silence each turn
  it off, and the mic is released (the OS mic indicator goes out).
- Push-to-talk (button hold and F2) works exactly as before.
- Settings → Audio → Speech model switches the model and push-to-talk uses it too.
- `cargo test`, `cargo clippy -D warnings`, `npm run check`, `npm run lint` and
  `npm run test` pass, and the Guide check passes.

## Decisions
- **What happens to each phrase** → it's added to the composer; a spoken "send" word sends.
- **Which mic buttons** → all three: the Chat tab composer, the Shell tab's assistant sidebar and the Code composer.
- **Speech detection** → earshot (a pure-Rust neural VAD on 16 ms frames) splits phrases, and whisper-server also runs `--vad` with Silero v6.2.0 as a second guard against made-up text.
- **Where phrases are transcribed** → all in Rust; the webview only gets text events.
- **Delivery** → one branch, one commit per phase, one PR hand-tested before merging.
- **Scope** → dictation only; hands-free conversation becomes a follow-up issue.
- **Auto-stop** → when you switch chat or tab, or after 5 minutes without speech; not when the window loses focus.
- **Whisper model** → a setting for all voice input: base.en (default) or large-v3-turbo, shared with the video tools.
- **Spoken commands** → fixed "send it" at the end of a phrase, plus "scratch that" to undo the last phrase.
- **While TTS plays** → listening pauses and resumes automatically.
- **Other toggles** → Shift+F2 from anywhere, and a left-click on the active button turns it off; F2 stays push-to-talk.
