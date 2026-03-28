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

        // Split into sentences and synthesize each individually
        // to avoid kokoro-micro's internal chunking which causes
        // inconsistent volume/speed between chunks
        let sentences = split_into_sentences(text);
        let mut all_samples: Vec<f32> = Vec::new();

        for sentence in &sentences {
            if sentence.trim().is_empty() {
                continue;
            }
            match kokoro.synthesize_with_options(sentence, voice, speed, 1.0, Some("en")) {
                Ok(mut samples) => {
                    normalize_volume(&mut samples);
                    all_samples.extend_from_slice(&samples);
                    // Add a small pause between sentences
                    all_samples.extend(std::iter::repeat(0.0).take(2400)); // 100ms at 24kHz
                }
                Err(e) => {
                    info!("Skipping sentence synthesis error: {}", e);
                }
            }
        }

        info!(
            "Synthesized {} samples from {} sentences",
            all_samples.len(),
            sentences.len()
        );
        Ok(all_samples)
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

fn split_into_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '.' | '!' | '?' | '\n') {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current.clear();
        }
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }

    // Merge very short sentences with the next one
    let mut merged = Vec::new();
    let mut buf = String::new();
    for s in sentences {
        if buf.is_empty() {
            buf = s;
        } else if buf.len() + s.len() < 100 {
            buf.push(' ');
            buf.push_str(&s);
        } else {
            merged.push(buf);
            buf = s;
        }
    }
    if !buf.is_empty() {
        merged.push(buf);
    }

    merged
}

fn normalize_volume(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }
    let peak = samples.iter().map(|s| s.abs()).fold(0.0f32, f32::max);
    if peak > 0.01 && peak != 1.0 {
        let target = 0.7; // Target peak volume
        let scale = target / peak;
        for s in samples.iter_mut() {
            *s *= scale;
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
