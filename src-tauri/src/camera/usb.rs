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
    // No -nostdin, which ffprobe doesn't take: stdin is closed anyway.
    cmd.arg("-hide_banner")
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

/// The widest picture a snapshot asks a webcam for: enough for a vision
/// model, and a 4K webcam's MJPEG at full size is slow to decode.
#[cfg(any(target_os = "linux", windows, test))]
const SNAPSHOT_MAX_WIDTH: u32 = 1920;

/// The slowest frame rate a snapshot accepts: a snapshot skips its first
/// frames while the webcam sets its exposure, and below this that takes too
/// long.
#[cfg(any(windows, test))]
const SNAPSHOT_MIN_FPS: f32 = 15.0;

/// The picture a snapshot asks a webcam for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SnapshotMode {
    pub width: u32,
    pub height: u32,
    /// MJPEG rather than the webcam's raw picture.
    pub mjpeg: bool,
}

/// The picture a snapshot asks the webcam `device` for: its widest up to 1920
/// across, in MJPEG when it offers that. `None` when it offers nothing that
/// fits, so ffmpeg picks as before (640×480 raw on many webcams, a Logitech
/// BRIO and a Microsoft LifeCam Studio among them). `tool` is ffmpeg or
/// ffprobe, which lists a Windows webcam's options; Linux asks the device.
#[cfg(target_os = "linux")]
pub(crate) async fn snapshot_mode(_tool: &str, device: &str) -> Option<SnapshotMode> {
    use v4l::framesize::FrameSizeEnum;
    use v4l::video::Capture;
    let device = v4l::Device::with_path(device).ok()?;
    let mjpeg = v4l::FourCC::new(b"MJPG");
    let sizes: Vec<(u32, u32)> = device
        .enum_framesizes(mjpeg)
        .ok()?
        .into_iter()
        .map(|f| match f.size {
            FrameSizeEnum::Discrete(d) => (d.width, d.height),
            FrameSizeEnum::Stepwise(s) => {
                let w = s.max_width.min(SNAPSHOT_MAX_WIDTH);
                (w, s.max_height.min(w * s.max_height / s.max_width.max(1)))
            }
        })
        .collect();
    let (width, height) = widest_up_to(&sizes, SNAPSHOT_MAX_WIDTH)?;
    Some(SnapshotMode {
        width,
        height,
        mjpeg: true,
    })
}

#[cfg(windows)]
pub(crate) async fn snapshot_mode(tool: &str, device: &str) -> Option<SnapshotMode> {
    let video = format!("video={device}");
    let text = ffmpeg_listing(
        tool,
        &["-f", "dshow", "-list_options", "true", "-i", &video],
    )
    .await;
    pick_dshow_mode(&parse_dshow_options(&text))
}

#[cfg(not(any(target_os = "linux", windows)))]
pub(crate) async fn snapshot_mode(_tool: &str, _device: &str) -> Option<SnapshotMode> {
    None
}

/// One line of `-list_options`: a size, its fastest frame rate, and whether
/// it is MJPEG.
#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DshowOption {
    pub width: u32,
    pub height: u32,
    pub max_fps: f32,
    pub mjpeg: bool,
}

/// `ffmpeg -f dshow -list_options true`: lines like
/// `vcodec=mjpeg  min s=1920x1080 fps=5 max s=1920x1080 fps=30` or
/// `pixel_format=yuyv422  min s=640x480 fps=7.5 max s=640x480 fps=30`.
#[cfg(any(windows, test))]
pub(crate) fn parse_dshow_options(text: &str) -> Vec<DshowOption> {
    text.lines()
        .filter_map(|line| {
            let mjpeg = line.contains("vcodec=mjpeg");
            if !mjpeg && !line.contains("pixel_format=") {
                return None;
            }
            let max = &line[line.find("max s=")? + "max s=".len()..];
            let (size, rest) = max.split_once(' ')?;
            let (w, h) = size.split_once('x')?;
            let fps = rest.trim().strip_prefix("fps=")?;
            Some(DshowOption {
                width: w.parse().ok()?,
                height: h.parse().ok()?,
                max_fps: fps.split_whitespace().next()?.parse().ok()?,
                mjpeg,
            })
        })
        .collect()
}

/// The widest MJPEG option up to 1920 across that runs at 15 fps or more,
/// else the widest such raw one.
#[cfg(any(windows, test))]
pub(crate) fn pick_dshow_mode(options: &[DshowOption]) -> Option<SnapshotMode> {
    let widest = |mjpeg: bool| {
        let sizes: Vec<(u32, u32)> = options
            .iter()
            .filter(|o| o.mjpeg == mjpeg && o.max_fps >= SNAPSHOT_MIN_FPS)
            .map(|o| (o.width, o.height))
            .collect();
        widest_up_to(&sizes, SNAPSHOT_MAX_WIDTH).map(|(width, height)| SnapshotMode {
            width,
            height,
            mjpeg,
        })
    };
    widest(true).or_else(|| widest(false))
}

/// The widest of `sizes` no wider than `max`, the taller on a tie.
#[cfg(any(target_os = "linux", windows, test))]
pub(crate) fn widest_up_to(sizes: &[(u32, u32)], max: u32) -> Option<(u32, u32)> {
    sizes.iter().copied().filter(|(w, _)| *w <= max).max()
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
    fn a_snapshot_asks_for_the_widest_size_up_to_1920() {
        let brio = [
            (640, 480),
            (1920, 1080),
            (4096, 2160),
            (1280, 720),
            (1920, 1200),
        ];
        assert_eq!(widest_up_to(&brio, 1920), Some((1920, 1200)));
        assert_eq!(widest_up_to(&[(3840, 2160)], 1920), None);
        assert_eq!(widest_up_to(&[], 1920), None);
    }

    #[test]
    fn a_windows_snapshot_prefers_mjpeg_then_a_fast_enough_raw_size() {
        let lifecam = "[dshow @ 01]  Pin \"Capture\" (alternative pin name \"Capture\")\n\
            [dshow @ 01]   pixel_format=yuyv422  min s=640x480 fps=7.5 max s=640x480 fps=30\n\
            [dshow @ 01]   pixel_format=yuyv422  min s=960x544 fps=7.5 max s=960x544 fps=20\n\
            [dshow @ 01]   pixel_format=yuyv422  min s=1920x1080 fps=7.5 max s=1920x1080 fps=30\n\
            [dshow @ 01]   pixel_format=yuyv422  min s=1280x720 fps=7.5 max s=1280x720 fps=30\n";
        let options = parse_dshow_options(lifecam);
        assert_eq!(options.len(), 4);
        assert_eq!(
            options[1],
            DshowOption {
                width: 960,
                height: 544,
                max_fps: 20.0,
                mjpeg: false
            }
        );
        let raw_1080 = SnapshotMode {
            width: 1920,
            height: 1080,
            mjpeg: false,
        };
        assert_eq!(pick_dshow_mode(&options), Some(raw_1080));

        // A Logitech's raw 1080p runs at 5 fps; its MJPEG at 30.
        let logitech =
            "[dshow @ 01]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=5\n\
            [dshow @ 01]   pixel_format=yuyv422  min s=640x480 fps=5 max s=640x480 fps=30\n\
            [dshow @ 01]   vcodec=mjpeg  min s=1280x720 fps=5 max s=1280x720 fps=60.0002\n\
            [dshow @ 01]   vcodec=mjpeg  min s=1920x1080 fps=5 max s=1920x1080 fps=30\n\
            [dshow @ 01]   vcodec=mjpeg  min s=3840x2160 fps=5 max s=3840x2160 fps=30\n";
        let mjpeg_1080 = SnapshotMode {
            width: 1920,
            height: 1080,
            mjpeg: true,
        };
        assert_eq!(
            pick_dshow_mode(&parse_dshow_options(logitech)),
            Some(mjpeg_1080)
        );

        // Only slow sizes: ffmpeg's default.
        let slow =
            "[dshow @ 01]   pixel_format=yuyv422  min s=1920x1080 fps=5 max s=1920x1080 fps=5\n";
        assert_eq!(pick_dshow_mode(&parse_dshow_options(slow)), None);
    }

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
