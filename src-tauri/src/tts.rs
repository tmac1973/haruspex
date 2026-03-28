use kokoro_micro::TtsEngine as KokoroEngine;
use log::info;
use rodio::{OutputStream, OutputStreamBuilder, Sink};
use std::sync::Mutex;

const TTS_SAMPLE_RATE: u32 = 24000;

pub struct TtsEngine {
    kokoro: Mutex<Option<KokoroEngine>>,
    sink: Mutex<Option<Sink>>,
    _stream: Mutex<Option<OutputStream>>,
}

impl TtsEngine {
    pub fn new() -> Self {
        Self {
            kokoro: Mutex::new(None),
            sink: Mutex::new(None),
            _stream: Mutex::new(None),
        }
    }

    pub async fn initialize(&self) -> Result<(), String> {
        info!("Initializing TTS engine (will download model if needed)...");
        let kokoro = KokoroEngine::new()
            .await
            .map_err(|e| format!("Failed to initialize Kokoro: {}", e))?;

        let voices = kokoro.voices();
        info!("TTS engine initialized with {} voices", voices.len());

        *self.kokoro.lock().unwrap() = Some(kokoro);
        Ok(())
    }

    pub fn is_initialized(&self) -> bool {
        self.kokoro.lock().unwrap().is_some()
    }

    pub fn synthesize_and_play(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: f32,
    ) -> Result<(), String> {
        let samples = self.synthesize(text, voice, speed)?;
        self.play_samples(&samples)?;
        Ok(())
    }

    pub fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: f32,
    ) -> Result<Vec<f32>, String> {
        let mut kokoro = self.kokoro.lock().unwrap();
        let kokoro = kokoro.as_mut().ok_or("TTS engine not initialized")?;

        info!(
            "Synthesizing {} chars with voice '{}'",
            text.len(),
            voice.unwrap_or("default")
        );

        let samples = kokoro
            .synthesize_with_options(text, voice, speed, 1.0, Some("en"))
            .map_err(|e| format!("TTS synthesis failed: {}", e))?;

        info!("Synthesized {} samples", samples.len());
        Ok(samples)
    }

    pub fn play_samples(&self, samples: &[f32]) -> Result<(), String> {
        self.stop_playback();

        let stream = OutputStreamBuilder::open_default_stream()
            .map_err(|e| format!("Audio output error: {}", e))?;

        let sink = Sink::connect_new(stream.mixer());

        let source = rodio::buffer::SamplesBuffer::new(1, TTS_SAMPLE_RATE, samples.to_vec());
        sink.append(source);

        *self._stream.lock().unwrap() = Some(stream);
        *self.sink.lock().unwrap() = Some(sink);

        Ok(())
    }

    pub fn stop_playback(&self) {
        if let Some(sink) = self.sink.lock().unwrap().take() {
            sink.stop();
        }
        *self._stream.lock().unwrap() = None;
    }

    pub fn is_playing(&self) -> bool {
        if let Some(ref sink) = *self.sink.lock().unwrap() {
            !sink.empty()
        } else {
            false
        }
    }

    pub fn get_voices(&self) -> Vec<String> {
        if let Some(ref kokoro) = *self.kokoro.lock().unwrap() {
            kokoro.voices()
        } else {
            Vec::new()
        }
    }
}

// Tauri commands

#[tauri::command]
pub async fn tts_initialize(state: tauri::State<'_, TtsEngine>) -> Result<(), String> {
    state.initialize().await
}

#[tauri::command]
pub fn tts_synthesize_and_play(
    state: tauri::State<'_, TtsEngine>,
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
) -> Result<(), String> {
    state.synthesize_and_play(&text, voice.as_deref(), speed.unwrap_or(1.0))
}

#[tauri::command]
pub fn tts_stop_playback(state: tauri::State<'_, TtsEngine>) -> Result<(), String> {
    state.stop_playback();
    Ok(())
}

#[tauri::command]
pub fn tts_is_playing(state: tauri::State<'_, TtsEngine>) -> bool {
    state.is_playing()
}

#[tauri::command]
pub fn tts_list_voices(state: tauri::State<'_, TtsEngine>) -> Vec<String> {
    state.get_voices()
}

#[tauri::command]
pub fn tts_is_initialized(state: tauri::State<'_, TtsEngine>) -> bool {
    state.is_initialized()
}
