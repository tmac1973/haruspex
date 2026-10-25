//! What an episode's clips are: length, picture, sound, from ffprobe.

use super::paths::display_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// Per file. A probe reads the container header, so even a long recording
/// answers in well under a second; this only catches a stuck network mount.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// How many ffprobes run at once.
const PROBE_PARALLEL: usize = 4;

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "avi", "m4v", "flv", "ts", "mts",
];
const AUDIO_EXTS: &[&str] = &["wav", "mp3", "flac", "m4a", "ogg"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub pix_fmt: String,
    /// Degrees from the display matrix (a phone held upright says 90 or -90).
    pub rotation: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    /// The stream's index in the file, as ffmpeg's `-map 0:<index>` counts.
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    /// Relative to the working folder, with forward slashes.
    pub path: String,
    pub duration_secs: f64,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub video: Option<VideoStream>,
    pub audio: Vec<AudioStream>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeProbe {
    pub clips: Vec<ClipInfo>,
    /// Media files ffprobe could not read, with why.
    pub unreadable: Vec<String>,
    /// Files in the working folder that look like an intro or outro, by
    /// their own or their folder's name.
    pub intro_candidates: Vec<String>,
}

// The slice of ffprobe's JSON this reads.
#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: Option<RawFormat>,
}

#[derive(Deserialize)]
struct RawStream {
    index: u32,
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    pix_fmt: Option<String>,
    channels: Option<u32>,
    sample_rate: Option<String>,
    #[serde(default)]
    disposition: RawDisposition,
    #[serde(default)]
    side_data_list: Vec<RawSideData>,
}

#[derive(Deserialize, Default)]
struct RawDisposition {
    #[serde(default)]
    attached_pic: u8,
}

#[derive(Deserialize)]
struct RawSideData {
    rotation: Option<f64>,
}

#[derive(Deserialize)]
struct RawFormat {
    duration: Option<String>,
    size: Option<String>,
}

/// `"30000/1001"` → (30000, 1001). `"0/0"` and junk → None.
fn parse_rate(rate: Option<&str>) -> Option<(u32, u32)> {
    let (n, d) = rate?.split_once('/')?;
    let (n, d) = (n.parse::<u32>().ok()?, d.parse::<u32>().ok()?);
    (n > 0 && d > 0).then_some((n, d))
}

/// Map ffprobe's JSON for one file.
fn parse(json: &str, path: String) -> Result<ClipInfo, String> {
    let raw: RawProbe =
        serde_json::from_str(json).map_err(|e| format!("unexpected ffprobe output: {e}"))?;
    let format = raw.format.ok_or("ffprobe found no container")?;
    let video = raw
        .streams
        .iter()
        // Cover art in an mp3 or m4a is a "video" stream of one frame.
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0)
        .map(|s| {
            let (fps_num, fps_den) = parse_rate(s.avg_frame_rate.as_deref())
                .or_else(|| parse_rate(s.r_frame_rate.as_deref()))
                .unwrap_or((0, 1));
            VideoStream {
                codec: s.codec_name.clone().unwrap_or_default(),
                width: s.width.unwrap_or(0),
                height: s.height.unwrap_or(0),
                fps_num,
                fps_den,
                pix_fmt: s.pix_fmt.clone().unwrap_or_default(),
                rotation: s
                    .side_data_list
                    .iter()
                    .find_map(|d| d.rotation)
                    .map(|r| r.round() as i32)
                    .unwrap_or(0),
            }
        });
    let audio = raw
        .streams
        .iter()
        .filter(|s| s.codec_type.as_deref() == Some("audio"))
        .map(|s| AudioStream {
            index: s.index,
            codec: s.codec_name.clone().unwrap_or_default(),
            channels: s.channels.unwrap_or(0),
            sample_rate: s
                .sample_rate
                .as_deref()
                .and_then(|r| r.parse().ok())
                .unwrap_or(0),
        })
        .collect::<Vec<_>>();
    if video.is_none() && audio.is_empty() {
        return Err("no picture or sound in it".into());
    }
    Ok(ClipInfo {
        path,
        duration_secs: format
            .duration
            .as_deref()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
        size_bytes: format
            .size
            .as_deref()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
        video,
        audio,
    })
}

fn is_media(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    VIDEO_EXTS.contains(&ext.as_str()) || AUDIO_EXTS.contains(&ext.as_str())
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

/// Media files in `dir` and its subfolders one level down (`ep010/raw/`),
/// skipping hidden folders such as `.haruspex/` and the `renders/` folder
/// Haruspex writes into.
pub fn media_files(dir: &Path) -> Vec<PathBuf> {
    fn entries(dir: &Path) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default();
        out.sort();
        out
    }
    let mut files = Vec::new();
    for entry in entries(dir) {
        if is_hidden(&entry) {
            continue;
        }
        if entry.is_dir() {
            if entry.file_name().is_some_and(|n| n == "renders") {
                continue;
            }
            files.extend(
                entries(&entry)
                    .into_iter()
                    .filter(|p| p.is_file() && !is_hidden(p) && is_media(p)),
            );
        } else if is_media(&entry) {
            files.push(entry);
        }
    }
    files.sort();
    files
}

/// Media files in the working folder (and one level down) whose name, or whose
/// folder's name, starts with "intro" or "outro".
pub fn intro_candidates(working_dir: &str) -> Vec<String> {
    let starts = |p: &Path| {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.to_ascii_lowercase())
            .is_some_and(|n| n.starts_with("intro") || n.starts_with("outro"))
    };
    media_files(Path::new(working_dir))
        .into_iter()
        .filter(|p| starts(p) || p.parent().is_some_and(starts))
        .map(|p| display_path(working_dir, &p))
        .collect()
}

/// ffprobe one file.
pub async fn probe_file(ffprobe: &str, file: &Path, shown_as: String) -> Result<ClipInfo, String> {
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(file)
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    super::no_window(&mut cmd);
    let out = tokio::time::timeout(PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "ffprobe took too long".to_string())?
        .map_err(|e| format!("could not run ffprobe: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().next().unwrap_or("ffprobe failed").trim();
        return Err(first.to_string());
    }
    parse(&String::from_utf8_lossy(&out.stdout), shown_as)
}

/// ffprobe every clip in an episode folder.
pub async fn probe_episode(ffprobe: &str, working_dir: &str, episode_dir: &Path) -> EpisodeProbe {
    let files = media_files(episode_dir);
    let gate = Arc::new(tokio::sync::Semaphore::new(PROBE_PARALLEL));
    let mut tasks = tokio::task::JoinSet::new();
    for (i, file) in files.into_iter().enumerate() {
        let gate = gate.clone();
        let ffprobe = ffprobe.to_string();
        let shown = display_path(working_dir, &file);
        tasks.spawn(async move {
            let _permit = gate.acquire_owned().await;
            (i, shown.clone(), probe_file(&ffprobe, &file, shown).await)
        });
    }
    let mut done = Vec::new();
    while let Some(Ok(item)) = tasks.join_next().await {
        done.push(item);
    }
    done.sort_by_key(|(i, _, _)| *i);
    let mut probe = EpisodeProbe {
        clips: Vec::new(),
        unreadable: Vec::new(),
        intro_candidates: intro_candidates(working_dir),
    };
    for (_, shown, result) in done {
        match result {
            Ok(clip) => probe.clips.push(clip),
            Err(why) => probe.unreadable.push(format!("{shown}: {why}")),
        }
    }
    probe
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/video/fixtures")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn an_obs_recording_maps() {
        let clip = parse(&fixture("probe-obs.json"), "ep010/raw/obs.mp4".into()).unwrap();
        let v = clip.video.unwrap();
        assert_eq!(
            (v.codec.as_str(), v.width, v.fps_num, v.fps_den),
            ("h264", 1920, 60, 1)
        );
        assert_eq!(clip.audio.len(), 1);
        assert_eq!(clip.audio[0].channels, 2);
        assert!((clip.duration_secs - 1943.25).abs() < 0.01);
    }

    #[test]
    fn a_phone_clip_keeps_its_rotation_and_ntsc_rate() {
        let clip = parse(&fixture("probe-phone.json"), "ep010/phone.mov".into()).unwrap();
        let v = clip.video.unwrap();
        assert_eq!(v.rotation, 90);
        assert_eq!((v.fps_num, v.fps_den), (30000, 1001));
    }

    #[test]
    fn a_wav_is_sound_only() {
        let clip = parse(&fixture("probe-wav.json"), "music/tone.wav".into()).unwrap();
        assert!(clip.video.is_none());
        assert_eq!(clip.audio[0].sample_rate, 44100);
    }

    /// `HARUSPEX_VIDEO_DIR=/path/to/series cargo test -- --ignored probe_a_real_folder --nocapture`
    #[tokio::test]
    #[ignore = "needs ffprobe and a folder of clips"]
    async fn probe_a_real_folder() {
        let dir = std::env::var("HARUSPEX_VIDEO_DIR").expect("set HARUSPEX_VIDEO_DIR");
        let found = super::super::binaries::resolve(&Default::default()).await;
        let ffprobe = found.require(super::super::binaries::Tool::Ffprobe).unwrap();
        let probe = probe_episode(ffprobe, &dir, Path::new(&dir)).await;
        println!("{probe:#?}");
        assert!(!probe.clips.is_empty());
    }

    #[test]
    fn rates_parse() {
        assert_eq!(parse_rate(Some("30000/1001")), Some((30000, 1001)));
        assert_eq!(parse_rate(Some("0/0")), None);
        assert_eq!(parse_rate(Some("x")), None);
    }

    #[test]
    fn media_files_look_one_level_down_and_skip_ours() {
        let dir = temp_dir("video_media_files");
        for f in [
            "a.mp4",
            "notes.txt",
            "raw/b.MKV",
            "raw/deep/c.mp4",
            ".haruspex/x.mp4",
            "renders/out.mp4",
            "music/song.mp3",
        ] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let names: Vec<String> = media_files(&dir)
            .iter()
            .map(|p| display_path(&dir.to_string_lossy(), p))
            .collect();
        assert_eq!(names, ["a.mp4", "music/song.mp3", "raw/b.MKV"]);
    }

    #[test]
    fn intro_candidates_match_by_file_or_folder_name() {
        let dir = temp_dir("video_intros");
        for f in [
            "intro001/intro.mp4",
            "intro001/other.mp4",
            "ep1/raw.mp4",
            "Outro.mov",
        ] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        assert_eq!(
            intro_candidates(&dir.to_string_lossy()),
            ["Outro.mov", "intro001/intro.mp4", "intro001/other.mp4"]
        );
    }
}
