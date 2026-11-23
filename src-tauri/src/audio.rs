use crate::sync_util::LockExt;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat as CpalSampleFormat};
use hound::{SampleFormat, WavSpec, WavWriter};
use log::{error, info, warn};
use std::io::Cursor;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16000;

/// USB-switch / hot-plug hint appended to errors so the user knows the
/// likely cause. The deeper libasound `dlopen` crash that can land here
/// can't be caught from Rust, but most hot-swap failures cpal/alsa-rs
/// reports as plain errors or panics — those we wrap.
const HOT_SWAP_HINT: &str =
    " (this can happen after switching a USB audio device between machines; \
     unplug and replug the device, then try again — if it persists, restart Haruspex)";

/// The name the settings store for an input or output device. TTS playback
/// matches output devices by it too (rodio re-exports this same cpal).
pub(crate) fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

/// Catch Rust panics from cpal / alsa-rs / coreaudio-rs internals so a
/// post-hot-swap stale state doesn't bring down the app. Does NOT catch
/// SIGSEGV — that's libasound's plugin loader and is fundamentally
/// uncatchable in-process.
fn safe_cpal<F, T>(label: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(res) => res,
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "cpal call panicked".to_string());
            error!("audio: {} panicked: {}", label, msg);
            Err(format!("{}: {}{}", label, msg, HOT_SWAP_HINT))
        }
    }
}

/// Enumerate input devices freshly from a brand-new host. Returns the
/// list so the caller can pick one — never returns cpal's cached
/// default-device handle, which is the part most likely to be stale
/// after a USB hot-swap.
fn enumerate_input_devices() -> Result<Vec<cpal::Device>, String> {
    safe_cpal("input device enumeration", || {
        let host = cpal::default_host();
        let devices = host
            .input_devices()
            .map_err(|e| format!("Failed to list input devices: {}", e))?;
        Ok(devices.collect())
    })
}

/// Returns the host's system default input device, wrapped in
/// catch_unwind. On Linux this is libasound's "default" PCM which
/// routes through ~/.asoundrc to PulseAudio/PipeWire — i.e. the
/// device the user actually thinks of as "my mic." We deliberately
/// keep this path because the enumerated-name list contains raw
/// ALSA devices (sysdefault:CARD=PCH, hw:CARD=…, etc.) that mostly
/// don't carry a real signal.
fn host_default_input_device() -> Result<cpal::Device, String> {
    safe_cpal("default_input_device", || {
        let host = cpal::default_host();
        host.default_input_device()
            .ok_or_else(|| format!("No default input device found.{}", HOT_SWAP_HINT))
    })
}

/// Pick an input device by user-configured name. Empty / "System Default"
/// goes through cpal's `default_input_device()` (the only thing that
/// reliably hits the user's real mic on Linux). Specific names are
/// looked up via fresh enumeration so a hot-swap doesn't strand us
/// on a stale handle. Both paths are wrapped in catch_unwind.
fn find_input_device_by_name(name: &str) -> Result<cpal::Device, String> {
    if name.is_empty() || name == "System Default" {
        return host_default_input_device();
    }

    let devices = enumerate_input_devices()?;
    for device in &devices {
        if device_name(device) == name {
            return Ok(device.clone());
        }
    }
    warn!(
        "Input device '{}' not found in {} enumerated devices, falling back to host default",
        name,
        devices.len()
    );
    host_default_input_device()
}

/// Who has the microphone. Push-to-talk and constant listening both open
/// it, and only one may at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MicUser {
    PushToTalk,
    Listening,
}

impl MicUser {
    fn busy_message(self) -> &'static str {
        match self {
            MicUser::PushToTalk => "The microphone is in use by push-to-talk",
            MicUser::Listening => "The microphone is in use by constant listening",
        }
    }
}

/// The process-wide microphone lock, managed as Tauri state.
#[derive(Default)]
pub struct MicLock(Arc<Mutex<Option<MicUser>>>);

/// Holds the microphone until dropped.
pub struct MicGuard(Arc<Mutex<Option<MicUser>>>);

impl MicLock {
    pub fn try_take(&self, user: MicUser) -> Result<MicGuard, String> {
        let mut holder = self.0.lock_or_recover();
        if let Some(other) = *holder {
            return Err(other.busy_message().to_string());
        }
        *holder = Some(user);
        Ok(MicGuard(self.0.clone()))
    }
}

impl Drop for MicGuard {
    fn drop(&mut self) {
        *self.0.lock_or_recover() = None;
    }
}

/// Open the named input device (empty for the system default) at its native
/// config and start it. `on_mono` gets each callback's audio downmixed to
/// mono f32 at the returned native rate; `on_error` gets stream errors.
pub(crate) fn open_input_stream(
    device_name_opt: Option<&str>,
    mut on_mono: impl FnMut(&[f32]) + Send + 'static,
    mut on_error: impl FnMut(&cpal::Error) + Send + 'static,
) -> Result<(cpal::Stream, u32), String> {
    // Always go through fresh enumeration — bypasses cpal's cached
    // default-device handle which is the most likely thing to be
    // stale after a USB hot-swap.
    let device = find_input_device_by_name(device_name_opt.unwrap_or(""))?;

    info!("Recording from: {}", device_name(&device));

    // Use the device's native config — Windows WASAPI rejects forced 16kHz mono.
    // Wrapped in catch_unwind because cpal/alsa-rs can panic when ALSA
    // is in a half-broken state post-hot-swap.
    let supported = safe_cpal("default_input_config", || {
        device
            .default_input_config()
            .map_err(|e| format!("No supported input config: {}", e))
    })?;
    let sample_format = supported.sample_format();
    let native_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.into();

    info!(
        "Input config: {} Hz, {} ch, {:?}",
        native_rate, channels, sample_format
    );

    let err_fn = move |err: cpal::Error| {
        error!("Audio input error: {}", err);
        on_error(&err);
    };
    let mut mono: Vec<f32> = Vec::new();

    macro_rules! build_stream {
        ($t:ty) => {{
            device.build_input_stream(
                config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    mono.clear();
                    if channels <= 1 {
                        mono.extend(data.iter().map(|s| s.to_sample::<f32>()));
                    } else {
                        for frame in data.chunks_exact(channels) {
                            let sum: f32 = frame.iter().map(|s| s.to_sample::<f32>()).sum();
                            mono.push(sum / channels as f32);
                        }
                    }
                    on_mono(&mono);
                },
                err_fn,
                None,
            )
        }};
    }

    let stream = safe_cpal("build_input_stream", || {
        let r = match sample_format {
            // cpal 0.18 ranks I32 and I24 above I16 when picking the
            // default config, so every integer width has to be handled.
            CpalSampleFormat::F32 => build_stream!(f32),
            CpalSampleFormat::F64 => build_stream!(f64),
            CpalSampleFormat::I8 => build_stream!(i8),
            CpalSampleFormat::I16 => build_stream!(i16),
            CpalSampleFormat::I24 => build_stream!(cpal::I24),
            CpalSampleFormat::I32 => build_stream!(i32),
            CpalSampleFormat::U8 => build_stream!(u8),
            CpalSampleFormat::U16 => build_stream!(u16),
            CpalSampleFormat::U32 => build_stream!(u32),
            other => return Err(format!("Unsupported sample format: {:?}", other)),
        };
        r.map_err(|e| format!("Failed to build audio stream: {}{}", e, HOT_SWAP_HINT))
    })?;

    safe_cpal("stream.play", || {
        stream
            .play()
            .map_err(|e| format!("Failed to start audio stream: {}{}", e, HOT_SWAP_HINT))
    })?;

    Ok((stream, native_rate))
}

pub struct AudioRecorder {
    is_recording: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    stream: Mutex<Option<cpal::Stream>>,
    native_rate: Mutex<u32>,
    guard: Mutex<Option<MicGuard>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(Mutex::new(Vec::new())),
            stream: Mutex::new(None),
            native_rate: Mutex::new(WHISPER_SAMPLE_RATE),
            guard: Mutex::new(None),
        }
    }

    pub fn start_recording(
        &self,
        mic: &MicLock,
        device_name_opt: Option<&str>,
    ) -> Result<(), String> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err("Already recording".to_string());
        }
        let guard = mic.try_take(MicUser::PushToTalk)?;

        // Clear previous samples
        self.samples.lock_or_recover().clear();

        let samples = self.samples.clone();
        let is_recording = self.is_recording.clone();
        // We downmix to mono in the callback and resample to 16kHz at stop_recording.
        let (stream, native_rate) = open_input_stream(
            device_name_opt,
            move |mono| {
                if is_recording.load(Ordering::SeqCst) {
                    samples.lock_or_recover().extend_from_slice(mono);
                }
            },
            |_| {},
        )?;
        *self.native_rate.lock_or_recover() = native_rate;

        self.is_recording.store(true, Ordering::SeqCst);
        *self.stream.lock_or_recover() = Some(stream);
        *self.guard.lock_or_recover() = Some(guard);

        info!("Recording started");
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<Vec<u8>, String> {
        if !self.is_recording.load(Ordering::SeqCst) {
            return Err("Not recording".to_string());
        }

        self.is_recording.store(false, Ordering::SeqCst);

        // Drop the stream to stop recording, then let the mic go.
        *self.stream.lock_or_recover() = None;
        *self.guard.lock_or_recover() = None;

        let samples = {
            let mut buf = self.samples.lock_or_recover();
            std::mem::take(&mut *buf)
        };
        let native_rate = *self.native_rate.lock_or_recover();

        info!(
            "Recording stopped: {} samples ({:.1}s @ {} Hz)",
            samples.len(),
            samples.len() as f32 / native_rate as f32,
            native_rate
        );

        if samples.is_empty() {
            return Err("No audio recorded".to_string());
        }

        let resampled = resample_linear(&samples, native_rate, WHISPER_SAMPLE_RATE);
        encode_wav(&resampled, WHISPER_SAMPLE_RATE)
    }
}

pub(crate) fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || input.len() < 2 {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((input.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos.floor() as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = input[idx];
        let b = if idx + 1 < input.len() {
            input[idx + 1]
        } else {
            a
        };
        out.push(a + (b - a) * frac);
    }
    out
}

pub(crate) fn encode_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer =
            WavWriter::new(&mut cursor, spec).map_err(|e| format!("WAV encode error: {}", e))?;

        for &sample in samples {
            let int_sample = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer
                .write_sample(int_sample)
                .map_err(|e| format!("WAV write error: {}", e))?;
        }

        writer
            .finalize()
            .map_err(|e| format!("WAV finalize error: {}", e))?;
    }

    Ok(cursor.into_inner())
}

/// The 44-byte header of a 16-bit mono PCM WAV holding `data_len` bytes.
pub(crate) fn wav_header(sample_rate: u32, data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&36u32.saturating_add(data_len).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    h[28..32].copy_from_slice(&(sample_rate * 2).to_le_bytes()); // bytes per second
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // bytes per frame
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

/// 16-bit mono PCM bytes as a WAV file.
pub(crate) fn wav_from_pcm16(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(&wav_header(sample_rate, pcm.len() as u32));
    wav.extend_from_slice(pcm);
    wav
}

/// Where a WAV's `data` chunk starts (after its header) in `wav`, or None
/// when it is not a RIFF/WAVE file or has no `data` chunk.
pub(crate) fn wav_data_start(wav: &[u8]) -> Option<usize> {
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    while at + 8 <= wav.len() {
        let id = &wav[at..at + 4];
        let size = u32::from_le_bytes(wav[at + 4..at + 8].try_into().ok()?) as usize;
        if id == b"data" {
            return Some(at + 8);
        }
        at = at.checked_add(8 + size + (size & 1))?;
    }
    None
}

/// Make a WAV's RIFF and `data` sizes match its bytes: a pipe or a streamed
/// answer leaves them as placeholders. None when it has no `data` chunk.
pub(crate) fn wav_fix_sizes(wav: &mut [u8]) -> Option<()> {
    let data = wav_data_start(wav)?;
    let riff = (wav.len() - 8) as u32;
    let len = (wav.len() - data) as u32;
    wav[4..8].copy_from_slice(&riff.to_le_bytes());
    wav[data - 4..data].copy_from_slice(&len.to_le_bytes());
    Some(())
}

// Tauri commands

#[tauri::command]
pub fn start_recording(
    state: tauri::State<'_, AudioRecorder>,
    mic: tauri::State<'_, MicLock>,
    device_name: Option<String>,
) -> Result<(), String> {
    state.start_recording(&mic, device_name.as_deref())
}

#[tauri::command]
pub fn stop_recording(state: tauri::State<'_, AudioRecorder>) -> Result<Vec<u8>, String> {
    state.stop_recording()
}

#[tauri::command]
pub fn list_audio_input_devices() -> Result<Vec<String>, String> {
    // Use the same panic-safe enumeration the recorder uses so the
    // settings dropdown doesn't take the app down if ALSA is in a
    // half-broken state.
    let devices = enumerate_input_devices()?;
    let mut names = vec!["System Default".to_string()];
    for device in &devices {
        names.push(device_name(device));
    }
    Ok(names)
}

#[tauri::command]
pub fn list_audio_output_devices() -> Result<Vec<String>, String> {
    // Use rodio's re-exported cpal so device names match what TTS playback uses
    let host = rodio::cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|e| format!("Failed to list output devices: {}", e))?;
    let mut names = vec!["System Default".to_string()];
    names.extend(devices.map(|device| device_name(&device)));
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mic_lock_names_who_holds_it() {
        let lock = MicLock::default();
        let ptt = lock.try_take(MicUser::PushToTalk).unwrap();
        assert_eq!(
            lock.try_take(MicUser::Listening).err().as_deref(),
            Some("The microphone is in use by push-to-talk")
        );
        drop(ptt);
        let listening = lock.try_take(MicUser::Listening).unwrap();
        assert_eq!(
            lock.try_take(MicUser::PushToTalk).err().as_deref(),
            Some("The microphone is in use by constant listening")
        );
        drop(listening);
        assert!(lock.try_take(MicUser::PushToTalk).is_ok());
    }

    #[test]
    fn wav_from_pcm16_matches_hound() {
        // The hand-written header is what hound writes for the same samples.
        let samples = [0.0f32, 0.5, -0.5, 0.25];
        let from_hound = encode_wav(&samples, 24_000).unwrap();
        assert_eq!(wav_from_pcm16(&from_hound[44..], 24_000), from_hound);
    }

    #[test]
    fn wav_fix_sizes_fills_in_placeholders() {
        let mut wav = wav_from_pcm16(&[1, 0, 2, 0], 16_000);
        wav[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        wav[40..44].copy_from_slice(&0u32.to_le_bytes());
        wav_fix_sizes(&mut wav).unwrap();
        assert_eq!(wav, wav_from_pcm16(&[1, 0, 2, 0], 16_000));
        assert_eq!(wav_data_start(&wav), Some(44));
        assert!(wav_fix_sizes(&mut b"not a wav file".to_vec()).is_none());
    }

    #[test]
    fn encode_wav_produces_valid_output() {
        let samples: Vec<f32> = (0..16000)
            .map(|i| (i as f32 * 440.0 * 2.0 * std::f32::consts::PI / 16000.0).sin())
            .collect();

        let wav = encode_wav(&samples, 16000).unwrap();

        // Check WAV header: "RIFF"
        assert_eq!(&wav[0..4], b"RIFF");
        // Check format: "WAVE"
        assert_eq!(&wav[8..12], b"WAVE");
        // Should be non-trivial size (header + 16000 samples * 2 bytes)
        assert!(wav.len() > 32000);
    }

    #[test]
    fn encode_wav_empty_samples_errors() {
        // Empty samples should still produce a valid (tiny) WAV
        let wav = encode_wav(&[], 16000).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
    }

    #[test]
    fn encode_wav_clamps_values() {
        let samples = vec![2.0, -2.0, 0.5]; // Values outside [-1, 1]
        let wav = encode_wav(&samples, 16000).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
    }
}
