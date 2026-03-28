# Phase 7.5: Speech-to-Text & Text-to-Speech

## Goal

Add voice interaction to Haruspex: users can speak their questions via microphone and hear responses read aloud. All processing runs locally — no cloud APIs, no data leaves the device.

## Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Text-to-Speech | **Kokoros** (`kokoro-tts` crate) | Pure Rust, Apache 2.0, 82M param model, fast inference, OpenAI-compatible API |
| Speech-to-Text | **whisper.cpp** (sidecar) | MIT license, 100+ languages, server mode like llama.cpp, proven Tauri integration pattern |
| Audio capture | **cpal** crate (Rust) | Cross-platform audio I/O, MIT/Apache 2.0 |
| Audio playback | **rodio** crate (Rust) | Built on cpal, simple playback API, MIT/Apache 2.0 |

### License Compatibility

All components are MIT or Apache 2.0 — fully compatible with open-source distribution.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Frontend                       │
│  [🎤 Record] ──→ invoke("transcribe")           │
│  [🔊 Speak]  ←── invoke("synthesize")           │
└────────────┬──────────────────────┬──────────────┘
             │                      │
     ┌───────▼───────┐     ┌───────▼───────┐
     │  whisper.cpp   │     │   Kokoros TTS  │
     │  (sidecar)     │     │  (Rust crate)  │
     │  HTTP :8766    │     │  in-process    │
     └───────────────┘     └───────────────┘
```

- **STT**: whisper.cpp runs as a sidecar on port 8766 (like llama-server on 8765). Audio is sent via HTTP POST, transcription returned as JSON.
- **TTS**: Kokoros runs in-process as a Rust library. Text goes in, WAV audio comes out, played via `rodio`.

---

## Tasks

### 7.5.1 Whisper.cpp sidecar setup

**Binary management** (mirrors llama-server pattern):

- Add `whisper-server` to `tauri.conf.json` `externalBin` list.
- Add sidecar binary naming: `whisper-server-x86_64-unknown-linux-gnu`, etc.
- Update `scripts/link-sidecar-libs.sh` to handle whisper.cpp shared libs.

**Whisper model management:**

- Add a whisper model registry (similar to LLM models) in `models.rs`:
  - `ggml-base.en.bin` (~148 MB) — English only, fast, good accuracy
  - `ggml-small.en.bin` (~488 MB) — English only, better accuracy
  - `ggml-base.bin` (~148 MB) — multilingual
- Store whisper models in `appDataDir/models/whisper/`.
- Download on first use (not during initial setup — voice is optional).

**Sidecar lifecycle** (`src-tauri/src/whisper.rs`):

```rust
pub struct WhisperServer {
    child: Option<CommandChild>,
    port: u16,           // default 8766
    status: WhisperStatus,
}
```

- `start(model_path)` — spawn whisper-server sidecar with:
  ```
  whisper-server
    --model <path>
    --host 127.0.0.1
    --port 8766
  ```
- `stop()` — kill sidecar process.
- Health check: poll `/health` endpoint.
- Start on demand (when user first clicks the mic button), not on app launch.

### 7.5.2 Audio capture (`src-tauri/src/audio.rs`)

Use the `cpal` crate for cross-platform microphone access:

```rust
pub struct AudioRecorder {
    is_recording: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
}
```

**Recording modes:**

1. **Push-to-talk**: Hold mic button to record, release to transcribe.
2. **Voice activity detection (VAD)**: Auto-detect speech start/stop. Use `webrtc-vad` crate or energy-based detection.

**Implementation:**

- Record to 16kHz mono f32 PCM (whisper's expected format).
- Convert to WAV in-memory for sending to whisper-server.
- Tauri commands:
  ```rust
  #[tauri::command]
  fn start_recording() -> Result<(), String>;

  #[tauri::command]
  fn stop_recording() -> Result<Vec<u8>, String>;  // returns WAV bytes
  ```

### 7.5.3 Speech-to-text integration

**Transcription flow:**

1. User clicks mic button (or presses hotkey).
2. Frontend calls `invoke("start_recording")`.
3. User speaks. Waveform visualizer shows audio level.
4. User releases button / clicks stop.
5. Frontend calls `invoke("stop_recording")` → gets WAV bytes.
6. Frontend calls `invoke("transcribe", { audio: wavBytes })`.
7. Rust sends WAV to whisper-server via HTTP POST to `/inference`.
8. Transcription text returned to frontend.
9. Text inserted into chat input (user can edit before sending).

**Tauri command:**

```rust
#[tauri::command]
async fn transcribe(audio: Vec<u8>) -> Result<String, String> {
    let client = reqwest::Client::new();
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(audio)
            .file_name("recording.wav")
            .mime_str("audio/wav")?);

    let resp = client.post("http://127.0.0.1:8766/inference")
        .multipart(form)
        .send().await?;

    // Parse transcription from response
    let result: TranscriptionResult = resp.json().await?;
    Ok(result.text)
}
```

### 7.5.4 Kokoros TTS integration (`src-tauri/src/tts.rs`)

**In-process Rust integration:**

Use the `kokoro-tts` crate directly (no sidecar needed):

```rust
use kokoro_tts::Kokoro;

pub struct TtsEngine {
    kokoro: Option<Kokoro>,
    voice: String,
}
```

**Model management:**

- Kokoro model files (~87 MB) stored in `appDataDir/models/tts/`.
- Downloaded on first use of TTS.
- Default voice: `af_heart` (natural female voice).

**Synthesis flow:**

1. Assistant message finishes generating.
2. If auto-read is enabled, or user clicks speaker icon on message:
3. Frontend calls `invoke("synthesize", { text, voice })`.
4. Rust synthesizes audio via Kokoros → WAV bytes.
5. Rust plays audio via `rodio`, or returns bytes to frontend.

**Tauri commands:**

```rust
#[tauri::command]
async fn synthesize(text: String, voice: Option<String>) -> Result<(), String>;

#[tauri::command]
fn stop_playback() -> Result<(), String>;

#[tauri::command]
fn list_voices() -> Vec<VoiceInfo>;
```

**Streaming TTS:**

For longer responses, synthesize and play paragraph-by-paragraph:
- Split response text on paragraph boundaries.
- Synthesize each chunk, queue for playback.
- Begin playback as soon as the first chunk is ready (low latency).

### 7.5.5 Frontend UI components

**Mic button** (`src/lib/components/MicButton.svelte`):

- Circular button next to the send button in the input area.
- States: idle (grey), recording (red pulsing), processing (spinner).
- Push-to-hold behavior: mousedown starts recording, mouseup stops.
- Also supports click-to-start, click-to-stop mode.
- Shows audio level indicator while recording.

**Speaker button** (`src/lib/components/SpeakerButton.svelte`):

- Small speaker icon on each assistant message.
- Click to read that message aloud.
- Shows playing state (animated speaker icon).
- Click again to stop.

**Auto-read toggle** in settings:

- When enabled, every new assistant response is automatically read aloud.
- Setting persisted in AppSettings.

**Waveform visualizer** (optional, stretch goal):

- Shows real-time audio levels during recording.
- Canvas-based, lightweight.

### 7.5.6 Settings integration

Add to AppSettings:

```typescript
interface AppSettings {
  // ... existing settings ...
  voiceEnabled: boolean;           // master toggle for voice features
  autoReadResponses: boolean;     // auto-TTS on assistant messages
  ttsVoice: string;               // kokoro voice ID
  sttModel: string;               // whisper model ID
  pushToTalk: boolean;            // vs click-to-toggle recording
}
```

Settings page additions:
- **Voice** section with master enable/disable toggle.
- TTS voice selector dropdown (with preview button).
- STT model selector (base.en vs small.en).
- Auto-read responses toggle.
- Push-to-talk vs toggle recording mode.

### 7.5.7 Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Space (when input empty) | Toggle recording |
| Ctrl/Cmd+Shift+S | Read last assistant message |
| Escape | Stop recording / stop playback |

---

## Model Downloads

| Model | Size | Purpose | When Downloaded |
|---|---|---|---|
| `ggml-base.en.bin` | ~148 MB | Whisper STT (English) | First mic button click |
| `kokoro-v1.0.onnx` | ~87 MB | Kokoros TTS | First TTS use |
| `voices/af_heart.bin` | ~few MB | Default voice data | With TTS model |

Models are downloaded on-demand, not during initial setup. Voice features are optional — the app works fully without them.

---

## Dependency Summary

| Crate | Purpose | License |
|---|---|---|
| `kokoro-tts` | Text-to-speech synthesis | Apache 2.0 |
| `cpal` | Audio input (microphone) | MIT / Apache 2.0 |
| `rodio` | Audio output (playback) | MIT / Apache 2.0 |
| `hound` | WAV encoding/decoding | Apache 2.0 |

Sidecar: `whisper-server` binary from whisper.cpp (MIT license).

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| Audio recorder | Start/stop recording produces valid WAV | cargo test |
| Audio recorder | Recording respects 16kHz mono format | cargo test |
| WAV encoding | Valid WAV header and data | cargo test |
| Transcription | Whisper server HTTP call format | cargo test (mock) |
| TTS synthesis | Kokoros produces non-empty audio output | cargo test |
| TTS streaming | Paragraph splitting produces correct chunks | cargo test |
| Voice list | All voices have valid IDs and names | cargo test |
| Settings | Voice settings persist and load correctly | Vitest |
| Mic button | States transition correctly (idle → recording → processing) | Vitest + testing-library |
| Speaker button | Click triggers synthesize invoke | Vitest + testing-library |

---

## Definition of Done

- [ ] Mic button in input area, press-and-hold to record
- [ ] Audio recorded at 16kHz mono, sent to whisper.cpp for transcription
- [ ] Transcribed text appears in chat input for editing before send
- [ ] Speaker icon on assistant messages, click to read aloud
- [ ] Auto-read setting for automatic TTS on new responses
- [ ] Voice settings in settings page (voice selection, model selection, enable/disable)
- [ ] Whisper model downloaded on first mic use (not during setup)
- [ ] Kokoro model downloaded on first TTS use
- [ ] All audio processing runs locally, no network calls
- [ ] Works on Linux, macOS, Windows
- [ ] All unit tests pass
