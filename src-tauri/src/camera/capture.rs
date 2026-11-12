//! A frame, a clip of sound, or a probe from a camera, through ffmpeg and
//! ffprobe. Every child is readied with `video::prepare_child` and killed if
//! it runs past its time.

use super::{CameraCaps, CameraConfig, CameraSource, Credentials};
use std::time::Duration;

/// The widest a snapshot is: a small vision model gains nothing from more.
pub const SNAPSHOT_MAX_WIDTH: u32 = 1280;
/// The longest clip `record_audio` takes.
pub const MAX_LISTEN_SECS: u32 = 30;
/// How long a snapshot or probe may take, connecting included.
const GRAB_TIMEOUT: Duration = Duration::from_secs(15);
/// ffmpeg's RTSP socket timeout, in microseconds.
const RTSP_TIMEOUT_US: &str = "10000000";
pub(crate) const NO_MICROPHONE: &str = "This camera has no microphone.";

/// The OS a USB device is read on; it decides ffmpeg's input device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Platform {
    Linux,
    Mac,
    Windows,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}

/// ffmpeg's input options for an RTSP stream, `url` with credentials in it.
pub(crate) fn rtsp_input(url: &str) -> Vec<String> {
    strings(&[
        "-rtsp_transport",
        "tcp",
        "-timeout",
        RTSP_TIMEOUT_US,
        "-i",
        url,
    ])
}

/// ffmpeg's input options for a webcam's picture.
pub(crate) fn usb_video_input(platform: Platform, device: &str) -> Vec<String> {
    match platform {
        Platform::Linux => strings(&["-f", "v4l2", "-i", device]),
        Platform::Mac => strings(&["-f", "avfoundation", "-i", &format!("{device}:none")]),
        Platform::Windows => strings(&["-f", "dshow", "-i", &format!("video={device}")]),
    }
}

/// ffmpeg's input options for a webcam's microphone. On Linux an ALSA device
/// (`hw:1,0`, `plughw:…`) goes through ALSA, anything else through PulseAudio
/// (PipeWire answers for it).
pub(crate) fn usb_audio_input(platform: Platform, device: &str) -> Vec<String> {
    match platform {
        Platform::Linux => {
            let alsa = ["hw:", "plughw:", "default:", "sysdefault:"]
                .iter()
                .any(|p| device.starts_with(p));
            let format = if alsa { "alsa" } else { "pulse" };
            strings(&["-f", format, "-i", device])
        }
        Platform::Mac => strings(&["-f", "avfoundation", "-i", &format!(":{device}")]),
        Platform::Windows => strings(&["-f", "dshow", "-i", &format!("audio={device}")]),
    }
}

/// The options that turn the first input's picture into one JPEG on stdout.
pub(crate) fn snapshot_output(max_width: u32) -> Vec<String> {
    strings(&[
        "-frames:v",
        "1",
        "-vf",
        &format!("scale='min({max_width},iw)':-2"),
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-q:v",
        "3",
        "-",
    ])
}

/// The options that turn the first input's sound into `seconds` of 16 kHz
/// mono WAV on stdout, as `video::transcribe::audio_wav` makes it.
pub(crate) fn audio_output(seconds: u32) -> Vec<String> {
    strings(&[
        "-t",
        &seconds.to_string(),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-map_metadata",
        "-1",
        "-f",
        "wav",
        "-",
    ])
}

/// A camera's input to ffmpeg, and the credentials to blank out of errors.
pub(crate) struct Input {
    pub args: Vec<String>,
    pub creds: Credentials,
}

/// The picture's input for `cfg`.
pub(crate) async fn video_input(cfg: &CameraConfig) -> Result<Input, String> {
    let creds = Credentials::for_source(&cfg.source).await?;
    let args = match &cfg.source {
        CameraSource::Rtsp { url, .. } => rtsp_input(&creds.inject(url)),
        CameraSource::Usb { video_device, .. } => {
            usb_video_input(Platform::current(), video_device)
        }
    };
    Ok(Input { args, creds })
}

/// The sound's input for `cfg`, or the no-microphone error.
pub(crate) async fn audio_input(cfg: &CameraConfig) -> Result<Input, String> {
    match &cfg.source {
        CameraSource::Rtsp { .. } => video_input(cfg).await,
        CameraSource::Usb { audio_device, .. } => {
            let device = audio_device
                .as_deref()
                .filter(|d| !d.trim().is_empty())
                .ok_or(NO_MICROPHONE)?;
            Ok(Input {
                args: usb_audio_input(Platform::current(), device),
                creds: Credentials::default(),
            })
        }
    }
}

/// A short reason from ffmpeg's errors, in words the user can act on, with
/// the password blanked out.
pub(crate) fn explain(stderr: &str, creds: &Credentials) -> String {
    let lower = stderr.to_lowercase();
    let known = [
        // Whole phrases: ffmpeg's `[rtsp @ 0x5640401…]` tags hold digits too.
        (
            "unauthorized",
            "The camera turned down the user name or password.",
        ),
        ("matches no streams", NO_MICROPHONE),
        ("does not contain any stream", NO_MICROPHONE),
        (
            "connection refused",
            "The camera refused the connection; check the address and port.",
        ),
        (
            "no route to host",
            "The camera can't be reached; check that it is on and the address is right.",
        ),
        (
            "timed out",
            "The camera did not answer; check that it is on and the address is right.",
        ),
        (
            "no such file or directory",
            "The webcam was not found; check that it is plugged in.",
        ),
        (
            "404 not found",
            "The camera has no stream at that address; check the path.",
        ),
        (
            "device or resource busy",
            "Another app is using the webcam.",
        ),
    ];
    if let Some((_, msg)) = known.iter().find(|(needle, _)| lower.contains(needle)) {
        return msg.to_string();
    }
    let line = stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("ffmpeg failed");
    creds.redact(line)
}

/// Run `program` (ffmpeg or ffprobe) with `args`, killed after `timeout`;
/// stdout on success. ffmpeg's `args` start with `-nostdin`, which ffprobe
/// doesn't take.
async fn run(
    program: &str,
    args: &[String],
    timeout: Duration,
    creds: &Credentials,
    what: &str,
) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(["-hide_banner", "-v", "error"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::video::prepare_child(&mut cmd);
    let out = tokio::time::timeout(timeout, cmd.output())
        .await
        .map_err(|_| format!("{what} took too long; the camera did not answer."))?
        .map_err(|e| format!("could not run {program}: {e}"))?;
    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{what} failed: {}", explain(&err, creds)));
    }
    Ok(out.stdout)
}

/// The shared-files folder of a USB camera whose watcher is running.
fn watched_usb(cfg: &CameraConfig) -> Option<std::path::PathBuf> {
    match cfg.source {
        CameraSource::Usb { .. } => super::shared::dir_for(&cfg.id),
        CameraSource::Rtsp { .. } => None,
    }
}

/// One frame from the camera as JPEG, at most `max_width` wide.
/// A webcam with a watcher running is read from the watcher's files, since it
/// can't be opened twice.
pub async fn snapshot(ffmpeg: &str, cfg: &CameraConfig, max_width: u32) -> Result<Vec<u8>, String> {
    if let Some(dir) = watched_usb(cfg) {
        return super::shared::snapshot(&dir, max_width).await;
    }
    let input = video_input(cfg).await?;
    let mut args = strings(&["-nostdin"]);
    args.extend(input.args);
    args.extend(snapshot_output(max_width));
    run(
        ffmpeg,
        &args,
        GRAB_TIMEOUT,
        &input.creds,
        "Taking a picture",
    )
    .await
}

/// `seconds` (at most [`MAX_LISTEN_SECS`]) of the camera's sound, as 16 kHz
/// mono WAV with its sizes filled in.
pub async fn record_audio(
    ffmpeg: &str,
    cfg: &CameraConfig,
    seconds: u32,
) -> Result<Vec<u8>, String> {
    let seconds = seconds.clamp(1, MAX_LISTEN_SECS);
    if let Some(dir) = watched_usb(cfg) {
        if let CameraSource::Usb { audio_device, .. } = &cfg.source {
            if audio_device.as_deref().is_none_or(|d| d.trim().is_empty()) {
                return Err(NO_MICROPHONE.into());
            }
        }
        return super::shared::record_audio(&dir, seconds).await;
    }
    let input = audio_input(cfg).await?;
    let mut args = strings(&["-nostdin"]);
    args.extend(input.args);
    args.extend(audio_output(seconds));
    let timeout = Duration::from_secs(u64::from(seconds)) + GRAB_TIMEOUT;
    let mut wav = run(ffmpeg, &args, timeout, &input.creds, "Listening").await?;
    fix_wav_sizes(&mut wav)?;
    Ok(wav)
}

/// What the camera's stream holds. A USB camera has sound when it has a
/// microphone set.
pub async fn probe(ffprobe: &str, cfg: &CameraConfig) -> Result<CameraCaps, String> {
    let input = video_input(cfg).await?;
    let mut args = strings(&["-show_streams", "-of", "json"]);
    args.extend(input.args);
    let out = run(
        ffprobe,
        &args,
        GRAB_TIMEOUT,
        &input.creds,
        "Probing the camera",
    )
    .await?;
    let mut caps = parse_probe(&String::from_utf8_lossy(&out))?;
    if let CameraSource::Usb { audio_device, .. } = &cfg.source {
        caps.has_audio = audio_device
            .as_deref()
            .is_some_and(|d| !d.trim().is_empty());
    }
    Ok(caps)
}

/// The first picture's size and codec, and whether there is any sound.
pub(crate) fn parse_probe(json: &str) -> Result<CameraCaps, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("ffprobe's answer did not parse: {e}"))?;
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let kind = |s: &serde_json::Value, k: &str| s["codec_type"].as_str() == Some(k);
    let video = streams
        .iter()
        .find(|s| kind(s, "video"))
        .ok_or("The camera sent no picture.")?;
    Ok(CameraCaps {
        has_audio: streams.iter().any(|s| kind(s, "audio")),
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        video_codec: video["codec_name"].as_str().unwrap_or("").to_string(),
    })
}

/// Where a WAV's `data` chunk starts (after its header) in `wav`.
pub(crate) fn data_chunk(wav: &[u8]) -> Option<usize> {
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

/// Fill in the RIFF and data sizes, which ffmpeg can't go back and write on a
/// pipe.
pub(crate) fn fix_wav_sizes(wav: &mut [u8]) -> Result<(), String> {
    let data = data_chunk(wav).ok_or("The sound from the camera was not a WAV file.")?;
    let riff = (wav.len() - 8) as u32;
    let len = (wav.len() - data) as u32;
    wav[4..8].copy_from_slice(&riff.to_le_bytes());
    wav[data - 4..data].copy_from_slice(&len.to_le_bytes());
    Ok(())
}

/// How loud 16-bit PCM WAV is overall, in dBFS (RMS). Silence is -120.
pub(crate) fn level_db(wav: &[u8]) -> f64 {
    let Some(data) = data_chunk(wav) else {
        return -120.0;
    };
    let samples: Vec<f64> = wav[data..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| f64::from(i16::from_le_bytes(*b)))
        .collect();
    if samples.is_empty() {
        return -120.0;
    }
    let rms = (samples.iter().map(|s| s * s).sum::<f64>() / samples.len() as f64).sqrt();
    if rms <= 0.0 {
        return -120.0;
    }
    (20.0 * (rms / 32768.0).log10()).max(-120.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{CameraPermission, PtzKind, WatcherConfig};
    use crate::video::binaries::{resolve_tool, BinaryOverrides, Tool};

    fn usb(video: &str, audio: Option<&str>) -> CameraConfig {
        CameraConfig {
            id: "c1".into(),
            name: "Desk".into(),
            source: CameraSource::Usb {
                video_device: video.into(),
                audio_device: audio.map(str::to_string),
            },
            permission: CameraPermission::Ask,
            ptz: PtzKind::None,
            onvif: None,
            watcher: WatcherConfig::default(),
            caps: None,
        }
    }

    #[test]
    fn usb_inputs_per_platform() {
        assert_eq!(
            usb_video_input(Platform::Linux, "/dev/video0"),
            ["-f", "v4l2", "-i", "/dev/video0"]
        );
        assert_eq!(
            usb_video_input(Platform::Mac, "FaceTime HD Camera"),
            ["-f", "avfoundation", "-i", "FaceTime HD Camera:none"]
        );
        assert_eq!(
            usb_video_input(Platform::Windows, "Integrated Camera"),
            ["-f", "dshow", "-i", "video=Integrated Camera"]
        );
        assert_eq!(
            usb_audio_input(Platform::Linux, "alsa_input.usb-OBSBOT.mono"),
            ["-f", "pulse", "-i", "alsa_input.usb-OBSBOT.mono"]
        );
        assert_eq!(
            usb_audio_input(Platform::Linux, "hw:2,0"),
            ["-f", "alsa", "-i", "hw:2,0"]
        );
        assert_eq!(
            usb_audio_input(Platform::Mac, "1"),
            ["-f", "avfoundation", "-i", ":1"]
        );
        assert_eq!(
            usb_audio_input(Platform::Windows, "Microphone (OBSBOT)"),
            ["-f", "dshow", "-i", "audio=Microphone (OBSBOT)"]
        );
    }

    #[test]
    fn rtsp_input_uses_tcp_and_a_timeout() {
        assert_eq!(
            rtsp_input("rtsp://cam/ch0"),
            [
                "-rtsp_transport",
                "tcp",
                "-timeout",
                "10000000",
                "-i",
                "rtsp://cam/ch0"
            ]
        );
        let out = snapshot_output(1280);
        assert!(out
            .windows(2)
            .any(|w| w == ["-vf", "scale='min(1280,iw)':-2"]));
        assert_eq!(out.last().map(String::as_str), Some("-"));
        let audio = audio_output(12);
        assert!(audio.windows(2).any(|w| w == ["-t", "12"]));
        assert!(audio.windows(2).any(|w| w == ["-ar", "16000"]));
    }

    #[tokio::test]
    async fn a_usb_camera_without_a_mic_says_so() {
        let err = audio_input(&usb("/dev/video0", None)).await.err().unwrap();
        assert_eq!(err, NO_MICROPHONE);
        assert!(audio_input(&usb("/dev/video0", Some("hw:1,0")))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn the_password_goes_into_the_url_and_never_into_an_error() {
        crate::secrets::seed_for_test("camera:test-inject", "s3cret-pass");
        let cfg = CameraConfig {
            source: CameraSource::Rtsp {
                url: "rtsp://192.168.1.184:554/ch0".into(),
                substream_url: None,
                username: "root".into(),
                password_ref: Some("camera:test-inject".into()),
            },
            ..usb("", None)
        };
        let input = video_input(&cfg).await.unwrap();
        assert!(input
            .args
            .contains(&"rtsp://root:s3cret-pass@192.168.1.184:554/ch0".to_string()));
        let stderr = "[rtsp @ 0x5] Could not find codec parameters for \
                      rtsp://root:s3cret-pass@192.168.1.184:554/ch0";
        let shown = explain(stderr, &input.creds);
        assert!(!shown.contains("s3cret-pass"), "{shown}");
        assert!(
            explain("method DESCRIBE failed: 401 Unauthorized", &input.creds)
                .contains("user name or password")
        );
        let tagged = "[rtsp @ 0x5640401404] Invalid data found when processing input";
        assert_eq!(explain(tagged, &input.creds), tagged);
    }

    #[tokio::test]
    async fn a_watched_webcam_is_read_from_the_watchers_files() {
        use crate::camera::shared;
        let dir = crate::test_util::temp_dir("camera_watched");
        let cfg = CameraConfig {
            id: "watched-usb".into(),
            ..usb("/dev/video-none", Some("hw:9,0"))
        };
        std::fs::write(
            dir.join(shared::LATEST),
            shared::tests::tiny_jpeg(1920, 1080),
        )
        .unwrap();
        let _guard = shared::register(&cfg.id, &dir);
        // No ffmpeg is run: the device is never opened.
        let jpeg = snapshot("/no/ffmpeg", &cfg, 640).await.unwrap();
        let img = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (640, 360));
        let writer = {
            let dir = dir.to_path_buf();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let wav = shared::wav_from_pcm(&vec![0x40u8; 32_000]);
                std::fs::write(dir.join("seg004.wav"), wav).unwrap();
            })
        };
        let wav = record_audio("/no/ffmpeg", &cfg, 1).await.unwrap();
        writer.await.unwrap();
        assert_eq!(data_chunk(&wav), Some(44));
        assert_eq!(wav.len(), 44 + 32_000);
        let no_mic = CameraConfig {
            id: "watched-usb".into(),
            ..usb("/dev/video-none", None)
        };
        assert_eq!(
            record_audio("/no/ffmpeg", &no_mic, 1).await.unwrap_err(),
            NO_MICROPHONE
        );
    }

    #[test]
    fn probe_output_is_read() {
        let json = r#"{"streams":[
            {"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080},
            {"index":1,"codec_type":"audio","codec_name":"aac"}]}"#;
        assert_eq!(
            parse_probe(json).unwrap(),
            CameraCaps {
                has_audio: true,
                width: 1920,
                height: 1080,
                video_codec: "h264".into()
            }
        );
        assert!(parse_probe(r#"{"streams":[]}"#).is_err());
    }

    #[test]
    fn level_of_silence_and_full_scale() {
        let mut wav = b"RIFF\xff\xff\xff\xffWAVEfmt \x10\x00\x00\x00".to_vec();
        wav.extend([0u8; 16]);
        wav.extend(b"data\xff\xff\xff\xff");
        let header = wav.len();
        wav.extend([0u8; 200]);
        fix_wav_sizes(&mut wav).unwrap();
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize,
            wav.len() - 8
        );
        assert_eq!(
            u32::from_le_bytes(wav[header - 4..header].try_into().unwrap()),
            200
        );
        assert_eq!(level_db(&wav), -120.0);
        for pair in wav[header..].as_chunks_mut::<2>().0 {
            pair.copy_from_slice(&i16::MAX.to_le_bytes());
        }
        assert!(level_db(&wav) > -0.01);
    }

    /// ffmpeg, if one resolves, for the tests that stand a lavfi source in
    /// for a camera.
    async fn ffmpeg() -> Option<String> {
        resolve_tool(Tool::Ffmpeg, &BinaryOverrides::default())
            .await
            .ok()
    }

    async fn run_lavfi(ffmpeg: &str, input: &[&str], output: Vec<String>) -> Vec<u8> {
        let mut args = strings(&["-nostdin", "-f", "lavfi", "-i"]);
        args.extend(strings(input));
        args.extend(output);
        run(ffmpeg, &args, GRAB_TIMEOUT, &Credentials::default(), "test")
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_snapshot_is_a_jpeg_no_wider_than_asked() {
        let Some(ffmpeg) = ffmpeg().await else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let jpeg = run_lavfi(
            &ffmpeg,
            &["testsrc=size=1920x1080:rate=5"],
            snapshot_output(640),
        )
        .await;
        let img = image::load_from_memory(&jpeg).unwrap();
        assert_eq!(&jpeg[..2], b"\xff\xd8");
        assert_eq!((img.width(), img.height()), (640, 360));
    }

    #[tokio::test]
    async fn recorded_sound_is_16k_mono_wav_of_the_asked_length() {
        let Some(ffmpeg) = ffmpeg().await else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let mut wav = run_lavfi(
            &ffmpeg,
            &["sine=frequency=440:sample_rate=44100"],
            audio_output(2),
        )
        .await;
        fix_wav_sizes(&mut wav).unwrap();
        let data = data_chunk(&wav).unwrap();
        // fmt: mono, 16 kHz, 16-bit.
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
        let len = u32::from_le_bytes(wav[data - 4..data].try_into().unwrap()) as usize;
        assert_eq!(len, wav.len() - data);
        assert_eq!(len, 2 * 16_000 * 2);
        // lavfi's sine is at 1/8 of full scale: about -21 dBFS RMS.
        let level = level_db(&wav);
        assert!((-24.0..-18.0).contains(&level), "{level}");
    }

    #[tokio::test]
    async fn a_stream_without_sound_has_no_microphone() {
        let Some(ffmpeg) = ffmpeg().await else {
            eprintln!("skipped: no ffmpeg");
            return;
        };
        let mut args = strings(&["-nostdin", "-f", "lavfi", "-i", "testsrc"]);
        args.extend(audio_output(1));
        let err = run(
            &ffmpeg,
            &args,
            GRAB_TIMEOUT,
            &Credentials::default(),
            "Listening",
        )
        .await
        .unwrap_err();
        assert!(err.contains(NO_MICROPHONE), "{err}");
    }

    #[tokio::test]
    async fn a_probe_reads_the_picture_size() {
        let Ok(ffprobe) = resolve_tool(Tool::Ffprobe, &BinaryOverrides::default()).await else {
            eprintln!("skipped: no ffprobe");
            return;
        };
        let args = strings(&[
            "-show_streams",
            "-of",
            "json",
            "-f",
            "lavfi",
            "-i",
            "testsrc",
        ]);
        let out = run(
            &ffprobe,
            &args,
            GRAB_TIMEOUT,
            &Credentials::default(),
            "probe",
        )
        .await
        .unwrap();
        let caps = parse_probe(&String::from_utf8_lossy(&out)).unwrap();
        assert_eq!((caps.width, caps.height, caps.has_audio), (320, 240, false));
    }
}
