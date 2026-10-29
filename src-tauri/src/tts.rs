use crate::audio_cache::MAX_AUDIO_BYTES;
use crate::db::Database;
use crate::sidecar_process::SidecarChild;
use futures_util::StreamExt;
use log::{error, info, warn};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::sidecar_util::{
    base_url, clear_logs, kill_child, new_log_buffer, ports, require_ready, snapshot_logs,
    start_sidecar, LogBuffer, SidecarStart, SidecarStatus, LOOPBACK,
};

const TTS_PORT: u16 = ports::TTS;

/// Lifecycle state of the koko TTS sidecar. Aliased onto the shared
/// `SidecarStatus` so all three sidecars share one wire shape.
type TtsStatus = SidecarStatus;

/// How long `start_and_wait` waits for koko to load its model: 30 s.
const READY_ATTEMPTS: usize = 60;
const READY_INTERVAL: Duration = Duration::from_millis(500);

// TtsEngine is Send + Sync because it only contains Send+Sync types.
// Audio playback happens on a dedicated thread (not stored in the struct).
pub struct TtsEngine {
    child: Mutex<Option<SidecarChild>>,
    status: Arc<Mutex<TtsStatus>>,
    playing: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    log_buffer: LogBuffer,
}

/// Pick a path to pass koko via `--model` / `--data`.
///
/// Preference order:
///   1. `<resource_dir>/<subdir>/<filename>` if it exists. This is the
///      bundled location — populated in dev (the files live under
///      src-tauri/) and in prod when tauri.conf.json's bundle.resources
///      ships them.
///   2. `<app_data_dir>/tts/<subdir>/<filename>` as a writable fallback.
///      Returned even if the file doesn't exist yet, because koko will
///      auto-download missing models to whatever path it's given — the
///      important property is that the parent directory is writable, so
///      the download doesn't blow up against a read-only AppImage mount.
///
/// Returns None only if neither directory could be resolved (extremely
/// unusual — would indicate a Tauri config problem).
fn resolve_koko_path(
    resource_dir: &Option<PathBuf>,
    app_data_dir: &Option<PathBuf>,
    subdir: &str,
    filename: &str,
) -> Option<PathBuf> {
    if let Some(rd) = resource_dir {
        let bundled = rd.join(subdir).join(filename);
        if bundled.exists() {
            return Some(bundled);
        }
    }
    if let Some(ad) = app_data_dir {
        let writable_dir = ad.join("tts").join(subdir);
        if let Err(e) = std::fs::create_dir_all(&writable_dir) {
            warn!("Failed to create koko model dir {:?}: {}", writable_dir, e);
            return None;
        }
        return Some(writable_dir.join(filename));
    }
    None
}

impl TtsEngine {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            status: Arc::new(Mutex::new(TtsStatus::Stopped)),
            playing: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            log_buffer: new_log_buffer(),
        }
    }

    pub async fn start(&self, app: &AppHandle) -> Result<(), String> {
        {
            let status = self.status.lock().await;
            if *status == TtsStatus::Ready || *status == TtsStatus::Starting {
                return Ok(());
            }
        }

        self.stop().await?;

        info!("Starting Kokoro TTS server on port {}", TTS_PORT);

        // Resolve model + voices paths. Preferred location is the bundled
        // resource_dir (works in dev where the files live under
        // src-tauri/{checkpoints,data}/, and in prod when tauri.conf.json's
        // bundle.resources ships them). Falls back to a writable path under
        // app_data_dir/tts/ so koko's built-in download won't hit a
        // read-only AppImage mount if the bundle was built without the
        // models.
        let resource_dir = app.path().resource_dir().ok();
        let app_data_dir = app.path().app_data_dir().ok();
        let model_path = resolve_koko_path(
            &resource_dir,
            &app_data_dir,
            "checkpoints",
            "kokoro-v1.0.onnx",
        );
        let data_path = resolve_koko_path(&resource_dir, &app_data_dir, "data", "voices-v1.0.bin");

        let mut args: Vec<String> = Vec::new();
        if let Some(p) = &model_path {
            args.push("--model".into());
            args.push(p.to_string_lossy().into_owned());
        }
        if let Some(p) = &data_path {
            args.push("--data".into());
            args.push(p.to_string_lossy().into_owned());
        }
        args.extend([
            "openai".into(),
            "--ip".into(),
            LOOPBACK.into(),
            "--port".into(),
            TTS_PORT.to_string(),
        ]);

        // espeak-rs-sys bakes the build-time path into the binary for espeak-ng-data.
        // Set ESPEAK_DATA_PATH to our bundled copy so phonemization works.
        let mut env = Vec::new();
        if let Some(resource_dir) = &resource_dir {
            let espeak_data = resource_dir.join("binaries").join("espeak-ng-data");
            if espeak_data.exists() {
                env.push((
                    "ESPEAK_DATA_PATH",
                    espeak_data.to_string_lossy().to_string(),
                ));
            }
        }

        // A stdout line containing "listening" flips status Starting → Ready
        // (koko's readiness signal).
        //
        // Health-poll fallback. koko's root `/` endpoint may return 4xx
        // depending on version, so we accept *any* response (not just
        // 2xx) as "process is up". The primary readiness signal is the
        // "listening" stdout sniff — this just covers the case where koko
        // buffers stdout past the moment it starts accepting connections.
        let spec = SidecarStart {
            name: "koko",
            id: "koko",
            port: TTS_PORT,
            args,
            env,
            ready_markers: &["listening", "Listening"],
            health_url: format!("{}/", base_url(TTS_PORT)),
            accept_any: true,
        };
        start_sidecar(app, spec, &self.child, &self.status, &self.log_buffer).await
    }

    pub async fn stop(&self) -> Result<(), String> {
        kill_child(&self.child, "koko").await?;
        *self.status.lock().await = TtsStatus::Stopped;
        self.stop_flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub async fn is_ready(&self) -> bool {
        *self.status.lock().await == TtsStatus::Ready
    }

    /// Start the server if it is not up, and wait for it to be ready, so the
    /// caller can synthesize as soon as this returns. The local app and a
    /// remote guest both come through here.
    pub async fn start_and_wait(&self, app: &AppHandle) -> Result<(), String> {
        self.start(app).await?;
        for _ in 0..READY_ATTEMPTS {
            if self.is_ready().await {
                return Ok(());
            }
            sleep(READY_INTERVAL).await;
        }
        Err("TTS server failed to become ready".to_string())
    }

    pub async fn get_logs(&self) -> Vec<String> {
        snapshot_logs(&self.log_buffer).await
    }

    pub async fn clear_logs(&self) {
        clear_logs(&self.log_buffer).await;
    }

    /// Speak `text`, starting as soon as koko has the first sentence.
    ///
    /// The audio is queued on the player while the rest arrives. Returns once
    /// the stream ends; playback carries on until `is_playing` turns false.
    pub async fn synthesize_and_play(
        &self,
        text: &str,
        voice: &str,
        output_device: Option<&str>,
    ) -> Result<(), String> {
        require_ready(&self.status, "TTS server not ready").await?;

        self.stop_flag.store(false, Ordering::SeqCst);
        self.playing.store(true, Ordering::SeqCst);

        let (tx, rx) = std::sync::mpsc::channel::<Vec<f32>>();
        let playing = Arc::clone(&self.playing);
        let stop_flag = Arc::clone(&self.stop_flag);
        let device_name = output_device.unwrap_or("").to_string();
        // A dedicated thread, because OutputStream is not Send on macOS.
        std::thread::spawn(move || play_queued(rx, &device_name, &playing, &stop_flag));

        // A send fails once the player has gone (stopped, or no device).
        let streamed = stream_speech(text, voice, 1.0, |samples| {
            !self.stop_flag.load(Ordering::SeqCst) && tx.send(samples).is_ok()
        })
        .await;
        drop(tx);
        match streamed {
            Ok(0) if !self.stop_flag.load(Ordering::SeqCst) => {
                Err("TTS produced no audio".to_string())
            }
            Ok(_) => Ok(()),
            Err(e) => {
                self.stop_playback();
                Err(e)
            }
        }
    }

    /// Write koko's speech for `text` to a WAV at `path`, as it streams in.
    /// Returns its length in seconds.
    pub async fn synthesize_to_file(
        &self,
        text: &str,
        voice: &str,
        speed: f32,
        path: &Path,
    ) -> Result<f64, String> {
        require_ready(&self.status, "TTS server not ready").await?;
        let mut wav = WavWriter::create(path, MAX_AUDIO_BYTES)?;
        let mut failed = None;
        let streamed = stream_speech(text, voice, speed, |samples| match wav.write(&samples) {
            Ok(()) => true,
            Err(e) => {
                failed = Some(e);
                false
            }
        })
        .await;
        let result = match (streamed, failed) {
            (Err(e), _) | (_, Some(e)) => Err(e),
            (Ok(0), None) => Err("TTS produced no audio".to_string()),
            (Ok(samples), None) => wav
                .finish()
                .map(|()| samples as f64 / SAMPLE_RATE.get() as f64),
        };
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }

    pub fn stop_playback(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
    }

    pub fn is_playing(&self) -> bool {
        self.playing.load(Ordering::SeqCst)
    }
}

/// koko's PCM: 16-bit signed little-endian, mono, 24 kHz.
const SAMPLE_RATE: std::num::NonZeroU32 = std::num::NonZeroU32::new(24_000).unwrap();

/// Turns koko's streamed PCM into samples. A network chunk can end halfway
/// through a sample, so its odd byte waits for the next chunk.
#[derive(Default)]
struct PcmDecoder {
    carry: Option<u8>,
}

impl PcmDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<f32> {
        let joined;
        let bytes = match self.carry.take() {
            Some(first) => {
                joined = [&[first], bytes].concat();
                &joined[..]
            }
            None => bytes,
        };
        let (pairs, rest) = bytes.as_chunks::<2>();
        self.carry = rest.first().copied();
        pairs
            .iter()
            .map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0)
            .collect()
    }
}

/// Ask koko to speak `text` and hand each piece of audio to `on_samples` as
/// it arrives. koko streams raw PCM one sentence at a time, far faster than
/// it plays. `on_samples` returns false to stop early. Returns how many
/// samples came.
async fn stream_speech(
    text: &str,
    voice: &str,
    speed: f32,
    mut on_samples: impl FnMut(Vec<f32>) -> bool,
) -> Result<usize, String> {
    if text.trim().is_empty() {
        return Err("No text to speak".to_string());
    }
    info!(
        "TTS request: {} chars, voice='{}', speed {}",
        text.len(),
        voice,
        speed
    );

    // No total timeout: a long text streams for longer than any fixed limit.
    // A stalled koko is caught between chunks instead.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("TTS client: {}", e))?;

    let body = serde_json::json!({
        "model": "tts-1",
        "input": text,
        "voice": voice,
        "speed": speed,
        "response_format": "pcm",
        "stream": true
    });

    let resp = client
        .post(format!("{}/v1/audio/speech", base_url(TTS_PORT)))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("TTS request failed: {}", e))?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(format!("TTS failed: {}", err_text));
    }

    let mut stream = resp.bytes_stream();
    let mut pcm = PcmDecoder::default();
    let mut samples = 0usize;
    let started = std::time::Instant::now();
    while let Some(chunk) = StreamExt::next(&mut stream).await {
        let chunk = chunk.map_err(|e| format!("Failed to read TTS response: {}", e))?;
        let decoded = pcm.push(&chunk);
        if decoded.is_empty() {
            continue;
        }
        if samples == 0 {
            info!("TTS first audio after {} ms", started.elapsed().as_millis());
        }
        samples += decoded.len();
        if !on_samples(decoded) {
            break;
        }
    }

    info!(
        "TTS streamed {} samples ({:.1}s)",
        samples,
        samples as f32 / SAMPLE_RATE.get() as f32
    );
    Ok(samples)
}

/// A 16-bit mono WAV written as samples arrive. The header's sizes are
/// filled in by `finish`.
struct WavWriter {
    file: std::io::BufWriter<std::fs::File>,
    data_bytes: u64,
    max_bytes: u64,
}

const WAV_HEADER_BYTES: u64 = 44;

impl WavWriter {
    fn create(path: &Path, max_bytes: u64) -> Result<Self, String> {
        let file =
            std::fs::File::create(path).map_err(|e| format!("Failed to write audio: {}", e))?;
        let mut w = Self {
            file: std::io::BufWriter::new(file),
            data_bytes: 0,
            max_bytes,
        };
        w.header()?;
        Ok(w)
    }

    fn header(&mut self) -> Result<(), String> {
        use std::io::Write;
        let rate = SAMPLE_RATE.get();
        let data = u32::try_from(self.data_bytes).unwrap_or(u32::MAX);
        let mut h = Vec::with_capacity(WAV_HEADER_BYTES as usize);
        h.extend(b"RIFF");
        h.extend((36 + data).to_le_bytes());
        h.extend(b"WAVEfmt ");
        h.extend(16u32.to_le_bytes()); // fmt chunk size
        h.extend(1u16.to_le_bytes()); // PCM
        h.extend(1u16.to_le_bytes()); // mono
        h.extend(rate.to_le_bytes());
        h.extend((rate * 2).to_le_bytes()); // bytes per second
        h.extend(2u16.to_le_bytes()); // bytes per frame
        h.extend(16u16.to_le_bytes()); // bits per sample
        h.extend(b"data");
        h.extend(data.to_le_bytes());
        self.file
            .write_all(&h)
            .map_err(|e| format!("Failed to write audio: {}", e))
    }

    fn write(&mut self, samples: &[f32]) -> Result<(), String> {
        use std::io::Write;
        let add = samples.len() as u64 * 2;
        if WAV_HEADER_BYTES + self.data_bytes + add > self.max_bytes {
            return Err(format!(
                "The speech is over the {} MB cache limit: make it shorter.",
                self.max_bytes / (1024 * 1024)
            ));
        }
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect();
        self.file
            .write_all(&bytes)
            .map_err(|e| format!("Failed to write audio: {}", e))?;
        self.data_bytes += add;
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|e| format!("Failed to write audio: {}", e))?;
        self.header()?;
        self.file
            .flush()
            .map_err(|e| format!("Failed to write audio: {}", e))
    }
}

/// Play the samples `rx` brings until the sender is dropped and the queue
/// has drained, or until `stop_flag` is set.
fn play_queued(
    rx: std::sync::mpsc::Receiver<Vec<f32>>,
    device_name: &str,
    playing: &AtomicBool,
    stop_flag: &AtomicBool,
) {
    use rodio::{DeviceSinkBuilder, Player};
    use std::sync::mpsc::RecvTimeoutError;

    let stream = if device_name.is_empty() || device_name == "System Default" {
        DeviceSinkBuilder::open_default_sink()
    } else {
        // Use rodio's re-exported cpal to get a compatible Device type
        use rodio::cpal::traits::HostTrait;
        let host = rodio::cpal::default_host();
        let found = host.output_devices().ok().and_then(|devices| {
            devices
                .into_iter()
                .find(|d| crate::audio::device_name(d) == device_name)
        });
        match found {
            Some(device) => DeviceSinkBuilder::from_device(device).and_then(|b| b.open_stream()),
            None => {
                warn!("Output device '{}' not found, using default", device_name);
                DeviceSinkBuilder::open_default_sink()
            }
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            error!("Audio output error: {}", e);
            playing.store(false, Ordering::SeqCst);
            return;
        }
    };

    let sink = Player::connect_new(stream.mixer());
    let tick = Duration::from_millis(100);
    let mut more = true;
    while !stop_flag.load(Ordering::SeqCst) {
        if more {
            match rx.recv_timeout(tick) {
                Ok(samples) => sink.append(rodio::buffer::SamplesBuffer::new(
                    rodio::nz!(1),
                    SAMPLE_RATE,
                    samples,
                )),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => more = false,
            }
        } else if sink.empty() {
            break;
        } else {
            std::thread::sleep(tick);
        }
    }

    if stop_flag.load(Ordering::SeqCst) {
        sink.stop();
    }
    playing.store(false, Ordering::SeqCst);
}

// Tauri commands

#[tauri::command]
pub async fn tts_initialize(
    app: AppHandle,
    state: tauri::State<'_, TtsEngine>,
) -> Result<(), String> {
    state.start_and_wait(&app).await
}

#[tauri::command]
pub async fn tts_synthesize_and_play(
    state: tauri::State<'_, TtsEngine>,
    text: String,
    // Required: the TS caller always resolves this to `DEFAULT_TTS_VOICE`
    // before invoking, so there's a single default (audit X5).
    voice: String,
    output_device: Option<String>,
) -> Result<(), String> {
    state
        .synthesize_and_play(&text, &voice, output_device.as_deref())
        .await
}

/// Speech made into the audio cache, for the player and `generate_speech`.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct StoredSpeech {
    pub hash: String,
    pub mime: String,
    #[ts(type = "number")]
    pub bytes: u64,
    pub seconds: f64,
}

/// The slowest and fastest `speed` koko is asked for.
const SPEED_RANGE: (f32, f32) = (0.5, 2.0);

/// Speak `text` into a WAV in the audio cache, linked to the chat or Code
/// session that asked. Starts koko if it isn't running.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn tts_synthesize_to_cache(
    app: AppHandle,
    state: tauri::State<'_, TtsEngine>,
    db: tauri::State<'_, Database>,
    text: String,
    voice: String,
    speed: Option<f32>,
    title: Option<String>,
    conversation_id: Option<String>,
    code_session_id: Option<String>,
) -> Result<StoredSpeech, String> {
    state.start_and_wait(&app).await?;
    let dir = crate::audio_cache::cache_dir(&app)?;
    let temp = dir.join(crate::audio_cache::commands::temp_name());
    let speed = speed.unwrap_or(1.0).clamp(SPEED_RANGE.0, SPEED_RANGE.1);
    let seconds = state
        .synthesize_to_file(&text, &voice, speed, &temp)
        .await?;
    let stored = crate::audio_cache::commands::store_file(
        &db,
        &dir,
        &temp,
        "audio/wav",
        title,
        Some((seconds * 1000.0).round() as i64),
        conversation_id.as_deref(),
        code_session_id.as_deref(),
    )
    .await?;
    Ok(StoredSpeech {
        hash: stored.hash,
        mime: stored.mime,
        bytes: stored.bytes,
        seconds,
    })
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
pub async fn tts_is_initialized(state: tauri::State<'_, TtsEngine>) -> Result<bool, ()> {
    Ok(state.is_ready().await)
}

#[tauri::command]
pub async fn get_tts_logs(state: tauri::State<'_, TtsEngine>) -> Result<Vec<String>, ()> {
    Ok(state.get_logs().await)
}

#[tauri::command]
pub async fn clear_tts_logs(state: tauri::State<'_, TtsEngine>) -> Result<(), ()> {
    state.clear_logs().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn pcm_decoder_reads_little_endian_samples() {
        let mut pcm = PcmDecoder::default();
        let got = pcm.push(&[0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]);
        assert_eq!(got, vec![0.5, -0.5, 32767.0 / 32768.0]);
        assert_eq!(pcm.carry, None);
    }

    #[test]
    fn pcm_decoder_carries_a_sample_split_across_chunks() {
        let mut pcm = PcmDecoder::default();
        assert_eq!(pcm.push(&[0x00, 0x40, 0x00]), vec![0.5]);
        assert_eq!(pcm.push(&[]), Vec::<f32>::new());
        assert_eq!(pcm.push(&[0xc0]), vec![-0.5]);
        assert_eq!(pcm.push(&[0x00]), Vec::<f32>::new());
        assert_eq!(pcm.push(&[0x40, 0x00, 0x40]), vec![0.5, 0.5]);
    }

    #[test]
    fn wav_writer_fills_in_the_sizes_on_finish() {
        let dir = temp_dir("wav");
        let path = dir.join("s.wav");
        let mut wav = WavWriter::create(&path, 1024).unwrap();
        wav.write(&[0.5, -0.5]).unwrap();
        wav.write(&[1.5]).unwrap();
        wav.finish().unwrap();
        let b = std::fs::read(&path).unwrap();
        assert_eq!(b.len(), 44 + 6);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 24_000);
        assert_eq!(&b[36..40], b"data");
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 6);
        let s = |i: usize| i16::from_le_bytes(b[44 + i * 2..46 + i * 2].try_into().unwrap());
        assert_eq!((s(0), s(1), s(2)), (16383, -16383, 32767), "clamped");
    }

    #[test]
    fn wav_writer_refuses_to_pass_its_limit() {
        let dir = temp_dir("wav-limit");
        let mut wav = WavWriter::create(&dir.join("s.wav"), 44 + 4).unwrap();
        wav.write(&[0.0, 0.0]).unwrap();
        let err = wav.write(&[0.0]).unwrap_err();
        assert!(err.contains("cache limit"), "{err}");
    }

    #[test]
    fn resolve_koko_path_prefers_the_bundled_file() {
        let root = temp_dir("bundled");
        let res = root.join("res");
        std::fs::create_dir_all(res.join("checkpoints")).unwrap();
        std::fs::write(res.join("checkpoints").join("model.onnx"), b"x").unwrap();
        let data = root.join("data");
        let got = resolve_koko_path(
            &Some(res.clone()),
            &Some(data.clone()),
            "checkpoints",
            "model.onnx",
        );
        assert_eq!(got, Some(res.join("checkpoints").join("model.onnx")));
        assert!(
            !data.exists(),
            "the writable fallback is not created when unused"
        );
    }

    #[test]
    fn resolve_koko_path_falls_back_to_a_created_writable_dir() {
        let root = temp_dir("fallback");
        let res = root.join("res");
        let data = root.join("data");
        let got = resolve_koko_path(&Some(res), &Some(data.clone()), "data", "voices.bin");
        let want = data.join("tts").join("data").join("voices.bin");
        assert_eq!(got, Some(want.clone()));
        assert!(want.parent().unwrap().is_dir());
        assert!(
            !want.exists(),
            "the file itself is left for koko to download"
        );

        let got = resolve_koko_path(&None, &Some(data.clone()), "data", "voices.bin");
        assert_eq!(got, Some(want));
    }

    #[test]
    fn resolve_koko_path_is_none_without_a_usable_dir() {
        let root = temp_dir("none");
        let res = root.join("res");
        assert_eq!(resolve_koko_path(&Some(res), &None, "data", "v.bin"), None);
        assert_eq!(resolve_koko_path(&None, &None, "data", "v.bin"), None);

        // An app data "dir" that is really a file cannot hold the model dir.
        let blocker = root.join("file");
        std::fs::write(&blocker, b"x").unwrap();
        assert_eq!(
            resolve_koko_path(&None, &Some(blocker), "data", "v.bin"),
            None
        );
    }
}
