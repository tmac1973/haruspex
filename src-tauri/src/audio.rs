use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
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
}

impl AudioRecorder {
    pub fn new() -> Self {
        Self {
            is_recording: Arc::new(AtomicBool::new(false)),
            samples: Arc::new(Mutex::new(Vec::new())),
            stream: Mutex::new(None),
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

        // Request 16kHz mono f32 for whisper compatibility
        let config = cpal::StreamConfig {
            channels: 1,
            sample_rate: WHISPER_SAMPLE_RATE,
            buffer_size: cpal::BufferSize::Default,
        };

        // Clear previous samples
        {
            let mut samples = self.samples.lock().unwrap();
            samples.clear();
        }

        let samples = self.samples.clone();
        let is_recording = self.is_recording.clone();

        let stream = device
            .build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if is_recording.load(Ordering::SeqCst) {
                        let mut buf = samples.lock().unwrap();
                        buf.extend_from_slice(data);
                    }
                },
                move |err| {
                    error!("Audio input error: {}", err);
                },
                None,
            )
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

        info!(
            "Recording stopped: {} samples ({:.1}s)",
            samples.len(),
            samples.len() as f32 / WHISPER_SAMPLE_RATE as f32
        );

        if samples.is_empty() {
            return Err("No audio recorded".to_string());
        }

        // Encode as WAV
        encode_wav(&samples, WHISPER_SAMPLE_RATE)
    }

    pub fn is_recording(&self) -> bool {
        self.is_recording.load(Ordering::SeqCst)
    }
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
