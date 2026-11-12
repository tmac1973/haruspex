//! Webcams and microphones plugged into this computer, for Settings → Cameras
//! to offer.
//!
//! Linux asks each `/dev/video*` node whether it captures video (a webcam
//! also has a metadata node that doesn't) and lists PulseAudio sources with
//! `ffmpeg -sources pulse`. macOS and Windows ask ffmpeg to list its
//! AVFoundation or DirectShow devices. A webcam's own microphone is paired
//! with it by name.

use super::capture::Platform;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const LIST_TIMEOUT: Duration = Duration::from_secs(10);

/// Devices as `(id, name)`.
type Named = Vec<(String, String)>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsbVideoDevice {
    /// What `CameraSource::Usb::video_device` holds.
    pub id: String,
    pub name: String,
    /// The `id` of the microphone that seems to be this webcam's own.
    pub audio_device: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsbAudioDevice {
    /// What `CameraSource::Usb::audio_device` holds.
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsbDevices {
    pub video: Vec<UsbVideoDevice>,
    pub audio: Vec<UsbAudioDevice>,
}

/// Every webcam and microphone, each webcam with its own mic if one matches.
pub async fn list_devices(ffmpeg: Option<&str>) -> Result<UsbDevices, String> {
    let (video, audio) = match Platform::current() {
        Platform::Linux => {
            let video = tokio::task::spawn_blocking(v4l_capture_devices)
                .await
                .map_err(|e| format!("listing webcams failed: {e}"))?;
            let audio = match ffmpeg {
                Some(f) => parse_pulse_sources(&ffmpeg_listing(f, &["-sources", "pulse"]).await),
                None => Vec::new(),
            };
            (video, audio)
        }
        Platform::Mac => {
            let f = ffmpeg.ok_or("ffmpeg was not found.")?;
            let text = ffmpeg_listing(
                f,
                &["-f", "avfoundation", "-list_devices", "true", "-i", ""],
            )
            .await;
            parse_avfoundation(&text)
        }
        Platform::Windows => {
            let f = ffmpeg.ok_or("ffmpeg was not found.")?;
            let text =
                ffmpeg_listing(f, &["-f", "dshow", "-list_devices", "true", "-i", "dummy"]).await;
            parse_dshow(&text)
        }
    };
    Ok(pair(video, audio))
}

/// ffmpeg's stdout and stderr for a listing. These runs "fail" by design (no
/// output is given), so the exit status is ignored.
async fn ffmpeg_listing(ffmpeg: &str, args: &[&str]) -> String {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::video::prepare_child(&mut cmd);
    match tokio::time::timeout(LIST_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push('\n');
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            text
        }
        _ => String::new(),
    }
}

/// `/dev/video*` nodes that capture video, in number order, named by card.
#[cfg(target_os = "linux")]
fn v4l_capture_devices() -> Vec<(String, String)> {
    use v4l::capability::Flags;
    let Ok(dir) = std::fs::read_dir("/dev") else {
        return Vec::new();
    };
    let mut nodes: Vec<(u32, std::path::PathBuf)> = dir
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let n = name.strip_prefix("video")?.parse().ok()?;
            Some((n, e.path()))
        })
        .collect();
    nodes.sort();
    nodes
        .into_iter()
        .filter_map(|(_, path)| {
            // v4l unwraps the card name as UTF-8; a device that isn't is skipped.
            let caps = std::panic::catch_unwind(|| {
                v4l::Device::with_path(&path).and_then(|d| d.query_caps())
            })
            .ok()?
            .ok()?;
            caps.capabilities
                .contains(Flags::VIDEO_CAPTURE)
                .then(|| (path.to_string_lossy().into_owned(), caps.card))
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn v4l_capture_devices() -> Vec<(String, String)> {
    Vec::new()
}

/// `ffmpeg -sources pulse`: one source per line as `id [description] (note)`,
/// the default starred. Monitors of outputs are not microphones.
pub(crate) fn parse_pulse_sources(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches('*').trim();
            let (id, rest) = line.split_once(" [")?;
            // A name may hold brackets itself; a note such as `(none)` follows.
            let name = &rest[..rest.rfind(']')?];
            let id = id.trim();
            (!id.is_empty() && !id.ends_with(".monitor") && !id.contains(' '))
                .then(|| (id.to_string(), name.to_string()))
        })
        .collect()
}

/// ffmpeg's `[AVFoundation indev @ …] [0] FaceTime HD Camera` lines, under
/// a video and an audio heading. A video device is given by name, a mic by
/// index. Screen captures are not cameras.
pub(crate) fn parse_avfoundation(text: &str) -> (Named, Named) {
    let (mut video, mut audio) = (Vec::new(), Vec::new());
    let mut in_audio = None;
    for line in text.lines() {
        if line.contains("AVFoundation video devices") {
            in_audio = Some(false);
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            in_audio = Some(true);
            continue;
        }
        let Some(is_audio) = in_audio else { continue };
        // The device's own `[n]`, after the `[AVFoundation indev @ …]` tag.
        let rest = line.split_once("] [").map(|(_, r)| r);
        let Some((index, name)) = rest.and_then(|r| r.split_once("] ")) else {
            continue;
        };
        if index.parse::<u32>().is_err() {
            continue;
        }
        let name = name.trim().to_string();
        if is_audio {
            audio.push((index.to_string(), name));
        } else if !name.starts_with("Capture screen") {
            video.push((name.clone(), name));
        }
    }
    (video, audio)
}

/// ffmpeg's DirectShow listing: `"Name" (video)` / `"Name" (audio)` in newer
/// builds, quoted names under a "DirectShow video/audio devices" heading in
/// older ones. Alternative names are skipped.
pub(crate) fn parse_dshow(text: &str) -> (Named, Named) {
    let (mut video, mut audio) = (Vec::new(), Vec::new());
    let mut section = None;
    for line in text.lines() {
        if line.contains("DirectShow video devices") {
            section = Some(false);
            continue;
        }
        if line.contains("DirectShow audio devices") {
            section = Some(true);
            continue;
        }
        if line.contains("Alternative name") {
            continue;
        }
        let Some(start) = line.find('"') else {
            continue;
        };
        let rest = &line[start + 1..];
        let Some(end) = rest.find('"') else { continue };
        let name = rest[..end].to_string();
        let tail = &rest[end + 1..];
        let is_audio = if tail.contains("(audio)") {
            Some(true)
        } else if tail.contains("(video)") {
            Some(false)
        } else {
            section
        };
        match is_audio {
            Some(true) => audio.push((name.clone(), name)),
            Some(false) => video.push((name.clone(), name)),
            None => {}
        }
    }
    (video, audio)
}

/// Words in a device name that say nothing about which device it is.
const GENERIC: &[&str] = &[
    "usb",
    "camera",
    "webcam",
    "video",
    "audio",
    "the",
    "with",
    "and",
    "analog",
    "stereo",
    "mono",
    "input",
    "microphone",
    "mic",
    "digital",
    "device",
    "capture",
    "built",
    "alsa",
    "pci",
];

fn words(name: &str) -> Vec<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3 && !GENERIC.contains(w))
        .map(str::to_string)
        .collect()
}

/// The microphone whose name shares a telling word with the webcam's.
pub(crate) fn matching_mic(video_name: &str, audio: &[(String, String)]) -> Option<String> {
    let wanted = words(video_name);
    audio
        .iter()
        .find(|(id, name)| {
            let have = words(&format!("{id} {name}"));
            wanted.iter().any(|w| have.contains(w))
        })
        .map(|(id, _)| id.clone())
}

fn pair(video: Vec<(String, String)>, audio: Vec<(String, String)>) -> UsbDevices {
    UsbDevices {
        video: video
            .into_iter()
            .map(|(id, name)| UsbVideoDevice {
                audio_device: matching_mic(&name, &audio),
                id,
                name,
            })
            .collect(),
        audio: audio
            .into_iter()
            .map(|(id, name)| UsbAudioDevice { id, name })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_sources_skip_monitors() {
        let text = "Auto-detected sources for pulse:\n  \
            alsa_output.pci-0000_11_00.1.hdmi-stereo.monitor [Monitor of HDMI [Odyssey G9]] (none)\n\
            * alsa_input.pci-0000_14_00.4.analog-stereo [Built-in Audio Analog Stereo] (none)\n  \
            alsa_input.usb-Remo_Tech_Co.__Ltd._OBSBOT_Tiny_2-02.mono-fallback [OBSBOT Tiny 2 Mono] (none)\n";
        let got = parse_pulse_sources(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].1, "Built-in Audio Analog Stereo");
        assert_eq!(
            matching_mic("OBSBOT Tiny 2 StreamCamera: OBSBOT", &got).as_deref(),
            Some("alsa_input.usb-Remo_Tech_Co.__Ltd._OBSBOT_Tiny_2-02.mono-fallback")
        );
        assert_eq!(matching_mic("Integrated Camera: Integrated C", &got), None);
    }

    #[test]
    fn avfoundation_listing() {
        let text = "[AVFoundation indev @ 0x7f8] AVFoundation video devices:\n\
            [AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera\n\
            [AVFoundation indev @ 0x7f8] [1] OBSBOT Tiny 2\n\
            [AVFoundation indev @ 0x7f8] [2] Capture screen 0\n\
            [AVFoundation indev @ 0x7f8] AVFoundation audio devices:\n\
            [AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone\n\
            [AVFoundation indev @ 0x7f8] [1] OBSBOT Tiny 2 Microphone\n\
            : Input/output error\n";
        let (video, audio) = parse_avfoundation(text);
        assert_eq!(
            video.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
            ["FaceTime HD Camera", "OBSBOT Tiny 2"]
        );
        assert_eq!(
            audio[1],
            ("1".to_string(), "OBSBOT Tiny 2 Microphone".to_string())
        );
        let devices = pair(video, audio);
        assert_eq!(devices.video[1].audio_device.as_deref(), Some("1"));
        assert_eq!(devices.video[0].audio_device, None);
    }

    #[test]
    fn dshow_listing_new_and_old() {
        let new = "[dshow @ 000001] \"Integrated Camera\" (video)\n\
            [dshow @ 000001]   Alternative name \"@device_pnp_\\\\?\\usb#vid\"\n\
            [dshow @ 000001] \"Microphone Array (Realtek(R) Audio)\" (audio)\n\
            [dshow @ 000001]   Alternative name \"@device_cm_{33D9A762}\"\n";
        let (video, audio) = parse_dshow(new);
        assert_eq!(
            video,
            [("Integrated Camera".into(), "Integrated Camera".into())]
        );
        assert_eq!(audio[0].0, "Microphone Array (Realtek(R) Audio)");
        let old = "[dshow @ 01] DirectShow video devices\n\
            [dshow @ 01]  \"OBSBOT Tiny 2 StreamCamera\"\n\
            [dshow @ 01] DirectShow audio devices\n\
            [dshow @ 01]  \"Microphone (OBSBOT Tiny 2 Microphone)\"\n";
        let devices = pair(parse_dshow(old).0, parse_dshow(old).1);
        assert_eq!(
            devices.video[0].audio_device.as_deref(),
            Some("Microphone (OBSBOT Tiny 2 Microphone)")
        );
    }
}
