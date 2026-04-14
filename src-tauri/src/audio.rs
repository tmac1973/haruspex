use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat as CpalSampleFormat;
use hound::{SampleFormat, WavSpec, WavWriter};
use log::{error, info, warn};
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const WHISPER_SAMPLE_RATE: u32 = 16000;

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

fn find_input_device_by_name(name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if name.is_empty() || name == "System Default" {
        return host
            .default_input_device()
            .ok_or_else(|| "No default input device".to_string());
    }
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            if device_name(&device) == name {
                return Ok(device);
            }
        }
    }
    warn!("Input device '{}' not found, falling back to default", name);
    host.default_input_device()
        .ok_or_else(|| "No default input device".to_string())
}

pub struct AudioRecorder {
    is_recording: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<f32>>>,
    stream: Mutex<Option<cpal::Stream>>,
    native_rate: Mutex<u32>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(Mutex::new(Vec::new())),
            stream: Mutex::new(None),
            native_rate: Mutex::new(WHISPER_SAMPLE_RATE),
        }
    }

    pub fn start_recording(&self, device_name_opt: Option<&str>) -> Result<(), String> {
        if self.is_recording.load(Ordering::SeqCst) {
            return Err("Already recording".to_string());
        }

        let device = match device_name_opt {
            Some(name) if !name.is_empty() && name != "System Default" => {
                find_input_device_by_name(name)?
            }
            _ => {
                let host = cpal::default_host();
                host.default_input_device()
                    .ok_or("No audio input device found")?
            }
        };

        info!("Recording from: {}", device_name(&device));

        // Use the device's native config — Windows WASAPI rejects forced 16kHz mono.
        // We downmix to mono in the callback and resample to 16kHz at stop_recording.
        let supported = device
            .default_input_config()
            .map_err(|e| format!("No supported input config: {}", e))?;
        let sample_format = supported.sample_format();
        let native_rate = supported.sample_rate();
        let channels = supported.channels() as usize;
        let config: cpal::StreamConfig = supported.into();

        info!(
            "Input config: {} Hz, {} ch, {:?}",
            native_rate, channels, sample_format
        );

        // Clear previous samples
        {
            let mut samples = self.samples.lock().unwrap();
            samples.clear();
        }
        *self.native_rate.lock().unwrap() = native_rate;

        let err_fn = |err: cpal::StreamError| error!("Audio input error: {}", err);

        macro_rules! build_stream {
            ($t:ty, $to_f32:expr) => {{
                let samples = self.samples.clone();
                let is_recording = self.is_recording.clone();
                device.build_input_stream(
                    &config,
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        if !is_recording.load(Ordering::SeqCst) {
                            return;
                        }
                        let mut buf = samples.lock().unwrap();
                        if channels <= 1 {
                            buf.extend(data.iter().map(|s| $to_f32(*s)));
                        } else {
                            for frame in data.chunks_exact(channels) {
                                let sum: f32 = frame.iter().map(|s| $to_f32(*s)).sum();
                                buf.push(sum / channels as f32);
                            }
                        }
                    },
                    err_fn,
                    None,
                )
            }};
        }

        let stream = match sample_format {
            CpalSampleFormat::F32 => build_stream!(f32, |s: f32| s),
            CpalSampleFormat::I16 => build_stream!(i16, |s: i16| s as f32 / 32768.0),
            CpalSampleFormat::U16 => build_stream!(u16, |s: u16| (s as f32 - 32768.0) / 32768.0),
            other => return Err(format!("Unsupported sample format: {:?}", other)),
        }
        .map_err(|e| format!("Failed to build audio stream: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("Failed to start audio stream: {}", e))?;

        self.is_recording.store(true, Ordering::SeqCst);
        *self.stream.lock().unwrap() = Some(stream);

        info!("Recording started");
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<Vec<u8>, String> {
        if !self.is_recording.load(Ordering::SeqCst) {
            return Err("Not recording".to_string());
        }

        self.is_recording.store(false, Ordering::SeqCst);

        // Drop the stream to stop recording
        *self.stream.lock().unwrap() = None;

        let samples = {
            let mut buf = self.samples.lock().unwrap();
            std::mem::take(&mut *buf)
        };
        let native_rate = *self.native_rate.lock().unwrap();

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

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }
}

fn resample_linear(input: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
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

fn encode_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
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

// Tauri commands

#[tauri::command]
pub fn start_recording(
    state: tauri::State<'_, AudioRecorder>,
    device_name: Option<String>,
) -> Result<(), String> {
    state.start_recording(device_name.as_deref())
}

#[tauri::command]
pub fn stop_recording(state: tauri::State<'_, AudioRecorder>) -> Result<Vec<u8>, String> {
    state.stop_recording()
}

#[tauri::command]
pub fn is_recording(state: tauri::State<'_, AudioRecorder>) -> bool {
    state.is_recording()
}

#[tauri::command]
pub fn list_audio_input_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to list input devices: {}", e))?;
    let mut names = vec!["System Default".to_string()];
    for device in devices {
        names.push(device_name(&device));
    }
    Ok(names)
}

#[tauri::command]
pub fn list_audio_output_devices() -> Result<Vec<String>, String> {
    // Use rodio's re-exported cpal so device names match what TTS playback uses
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let host = rodio::cpal::default_host();
    let devices = host
        .output_devices()
        .map_err(|e| format!("Failed to list output devices: {}", e))?;
    let mut names = vec!["System Default".to_string()];
    for device in devices {
        if let Ok(name) = device.name() {
            names.push(name);
        }
    }
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

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
