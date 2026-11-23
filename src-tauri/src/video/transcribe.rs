//! Transcribing footage with timestamps, for cutting by what was said and for
//! chapters and captions.
//!
//! The video tools run their own whisper-server (port 8768, `VideoWhisper`)
//! with the best model there is: large-v3-turbo once Settings → Video editing has
//! downloaded it, base.en until then. It starts on the first transcription and
//! stops five minutes after the last lease on it is dropped (the cameras
//! transcribe on it too), so it holds no memory between uses and voice input's
//! instance is never touched.
//!
//! A clip's sound is extracted once to 16 kHz mono WAV, cut into pieces of
//! about five minutes at the quietest nearby moment, and each piece sent on its
//! own, so progress can be shown and a cancel lands between pieces. The result
//! is kept in `<episode>/.haruspex/transcripts/` until the clip changes.

use super::silence::{self, SilenceRange};
use super::{paths, probe};
use crate::whisper::{Segment, VideoWhisper, Word};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Seconds of audio per request.
const CHUNK_SECS: f64 = 300.0;
/// How far from a chunk mark a silence may be to cut there instead.
const CHUNK_REACH: f64 = 30.0;
/// The transcript cache's format: `v2` added word times, so older files
/// (named without it) are transcribed again once.
const CACHE_FORMAT: &str = "v2";
/// The video whisper-server stops this long after its last use.
const IDLE_STOP: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// The clip, relative to the working folder.
    pub path: String,
    /// The whisper model's file name.
    pub model: String,
    pub language: Option<String>,
    pub duration_secs: f64,
    pub segments: Vec<Segment>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeProgress {
    pub clip: String,
    pub done_secs: f64,
    pub total_secs: f64,
    /// 1-based, of `count`.
    pub index: u32,
    pub count: u32,
}

/// What a cached transcript was made from.
#[derive(Serialize, Deserialize)]
struct Cached {
    size: u64,
    mtime: u64,
    transcript: Transcript,
}

/// The model the video tools transcribe with: turbo if downloaded.
pub fn model_for(models_dir: &Path) -> Option<PathBuf> {
    let dir = models_dir.join("whisper");
    [crate::models::WHISPER_VIDEO_MODEL, "ggml-base.en.bin"]
        .iter()
        .map(|m| dir.join(m))
        .find(|p| p.exists())
}

fn is_turbo(model: &Path) -> bool {
    model
        .file_name()
        .is_some_and(|n| n == crate::models::WHISPER_VIDEO_MODEL)
}

fn stamp(file: &Path) -> (u64, u64) {
    let meta = std::fs::metadata(file).ok();
    let size = meta.as_ref().map_or(0, |m| m.len());
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    (size, mtime)
}

/// A short, stable key for a clip as it is now.
fn clip_key(file: &Path) -> String {
    let (size, mtime) = stamp(file);
    let mut h = Sha256::new();
    h.update(file.to_string_lossy().as_bytes());
    h.update(size.to_le_bytes());
    h.update(mtime.to_le_bytes());
    crate::hash_util::hex(&h.finalize())[..12].to_string()
}

fn haruspex_dir(episode_dir: &Path) -> PathBuf {
    episode_dir.join(".haruspex")
}

pub fn cache_path(episode_dir: &Path, file: &Path) -> PathBuf {
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    haruspex_dir(episode_dir).join("transcripts").join(format!(
        "{stem}-{}.{CACHE_FORMAT}.json",
        &clip_key(file)[..8]
    ))
}

/// The cached transcript of a clip, if it is still current.
pub fn cached(episode_dir: &Path, file: &Path) -> Option<Transcript> {
    let text = std::fs::read_to_string(cache_path(episode_dir, file)).ok()?;
    let c: Cached = serde_json::from_str(&text).ok()?;
    ((c.size, c.mtime) == stamp(file)).then_some(c.transcript)
}

fn save_cache(episode_dir: &Path, file: &Path, t: &Transcript) {
    let path = cache_path(episode_dir, file);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let (size, mtime) = stamp(file);
    let c = Cached {
        size,
        mtime,
        transcript: t.clone(),
    };
    if let Ok(text) = serde_json::to_string(&c) {
        let _ = std::fs::write(path, text);
    }
}

async fn run_ffmpeg(ffmpeg: &str, args: &[&str], what: &str) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-v", "error"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(30 * 60), cmd.output())
        .await
        .map_err(|_| format!("{what} took too long"))?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{what} failed: {}",
            err.lines().next().unwrap_or("ffmpeg failed")
        ));
    }
    Ok(out.stdout)
}

/// The clip's sound as 16 kHz mono WAV, extracted once.
pub async fn audio_wav(
    ffmpeg: &str,
    episode_dir: &Path,
    file: &Path,
    stream: u32,
) -> Result<PathBuf, String> {
    let dir = haruspex_dir(episode_dir).join("audio");
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let wav = dir.join(format!("{}.wav", clip_key(file)));
    if wav.exists() {
        return Ok(wav);
    }
    let part = wav.with_extension("part.wav");
    let map = format!("0:{stream}");
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &file.to_string_lossy(),
            "-map",
            &map,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            &part.to_string_lossy(),
        ],
        "extracting the sound",
    )
    .await?;
    std::fs::rename(&part, &wav).map_err(|e| format!("can't save the sound: {e}"))?;
    Ok(wav)
}

/// Cancels a running transcription between (and during) requests.
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl Cancel {
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        loop {
            // Registered before the check, so a cancel in between still wakes it.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.cancelled() {
                return;
            }
            notified.await;
        }
    }
}

const CANCELLED: &str = "Transcription cancelled.";

/// Bumped by every lease taken and every idle stop scheduled, so a stop only
/// fires when nothing has used the server since it was scheduled.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Leases held now. The server is never stopped while one is out.
static LEASES: AtomicUsize = AtomicUsize::new(0);
static LOADED: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
/// One start at a time, so two callers don't both restart the server.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A hold on the video whisper-server (port 8768), shared by the video tools
/// and the cameras. While any lease is held the server stays up; dropping the
/// last one schedules the idle stop, so one user never stops it under another.
pub struct WhisperLease {
    app: tauri::AppHandle,
}

impl Drop for WhisperLease {
    fn drop(&mut self) {
        if LEASES.fetch_sub(1, Ordering::SeqCst) == 1 {
            schedule_idle_stop(self.app.clone());
        }
    }
}

/// Start the video whisper-server with `model` if it isn't up, and hold it
/// until the lease is dropped. A server already running for another lease
/// keeps the model it has rather than restarting under that user.
pub(crate) async fn lease_server(
    app: &tauri::AppHandle,
    model: &Path,
) -> Result<WhisperLease, String> {
    use tauri::Manager;
    let others = LEASES.fetch_add(1, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let lease = WhisperLease { app: app.clone() };
    let whisper = app.state::<VideoWhisper>();
    {
        let _one = STARTING.lock().await;
        let loaded = LOADED.lock().map(|l| l.clone()).unwrap_or(None);
        let running = whisper.0.is_running().await;
        if !running || (others == 0 && loaded.as_deref() != Some(model)) {
            whisper.0.start(app, &model.to_string_lossy(), None).await?;
            if let Ok(mut l) = LOADED.lock() {
                *l = Some(model.to_path_buf());
            }
        }
    }
    whisper.0.wait_ready(Duration::from_secs(120)).await?;
    Ok(lease)
}

/// The language to ask whisper for: turbo detects it, base.en is English only.
pub(crate) fn language_for(model: &Path) -> &'static str {
    if is_turbo(model) {
        "auto"
    } else {
        "en"
    }
}

/// Stop the video whisper-server once it has been idle a while.
fn schedule_idle_stop(app: tauri::AppHandle) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(IDLE_STOP).await;
        if GENERATION.load(Ordering::SeqCst) == generation && LEASES.load(Ordering::SeqCst) == 0 {
            use tauri::Manager;
            let _ = app.state::<VideoWhisper>().0.stop().await;
            if let Ok(mut l) = LOADED.lock() {
                *l = None;
            }
        }
    });
}

/// Whether a kept transcript will do: a base.en one is kept until turbo is
/// there and `refresh` asks for it, and one in another language than the one
/// asked for is redone.
fn kept_will_do(t: &Transcript, model: &Path, refresh: bool, language: Option<&str>) -> bool {
    let model_name = model.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let same_language = language.is_none_or(|l| t.language.as_deref() == Some(l));
    same_language && (!refresh || t.model == model_name)
}

/// Whether a clip needs whisper, or its kept transcript will do.
pub fn needs_whisper(
    episode_dir: &Path,
    file: &Path,
    model: &Path,
    refresh: bool,
    language: Option<&str>,
) -> bool {
    cached(episode_dir, file).is_none_or(|t| !kept_will_do(&t, model, refresh, language))
}

/// How to transcribe a clip: past a kept transcript or not, in which
/// language (the model's default when none), and what to tell on the way.
pub struct How<'a> {
    pub refresh: bool,
    pub language: Option<&'a str>,
    pub cancel: &'a Cancel,
    pub progress: &'a (dyn Fn(f64) + Send + Sync),
}

/// Transcribe one clip, from the cache when it will do (`kept_will_do`).
/// The video whisper-server must be running (`lease_server`) unless the
/// transcript is kept.
pub async fn transcribe_clip(
    whisper: &VideoWhisper,
    ffmpeg: &str,
    model: &Path,
    episode_dir: &Path,
    file: &Path,
    info: &probe::ClipInfo,
    how: &How<'_>,
) -> Result<Transcript, String> {
    let (cancel, progress) = (how.cancel, how.progress);
    let model_name = model
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    if let Some(t) = cached(episode_dir, file) {
        if kept_will_do(&t, model, how.refresh, how.language) {
            return Ok(t);
        }
    }
    let stream = info
        .audio
        .first()
        .map(|a| a.index)
        .ok_or_else(|| format!("{} has no sound to transcribe.", info.path))?;
    let wav = audio_wav(ffmpeg, episode_dir, file, stream).await?;
    if cancel.cancelled() {
        return Err(CANCELLED.into());
    }
    let duration = info.duration_secs;
    let silences: Vec<SilenceRange> = if duration > CHUNK_SECS + CHUNK_REACH {
        silence::detect(ffmpeg, &wav, -35.0, 0.4, None).await?
    } else {
        Vec::new()
    };
    let points = silence::chunk_points(duration, &silences, CHUNK_SECS, CHUNK_REACH);
    let language = how.language.unwrap_or(language_for(model));
    let mut segments = Vec::new();
    let mut detected = None;
    for pair in points.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let chunk = run_ffmpeg(
            ffmpeg,
            &[
                "-ss",
                &format!("{from:.3}"),
                "-to",
                &format!("{to:.3}"),
                "-i",
                &wav.to_string_lossy(),
                "-f",
                "wav",
                "-",
            ],
            "cutting the sound",
        )
        .await?;
        let answer = tokio::select! {
            r = whisper.0.transcribe_segments(chunk, language) => r?,
            _ = cancel.wait() => return Err(CANCELLED.into()),
        };
        detected = detected.or(answer.1);
        segments.extend(answer.0.into_iter().map(|s| offset(s, from, to)));
        progress(to);
        if cancel.cancelled() {
            return Err(CANCELLED.into());
        }
    }
    let t = Transcript {
        path: info.path.clone(),
        model: model_name,
        language: detected,
        duration_secs: duration,
        segments,
    };
    save_cache(episode_dir, file, &t);
    Ok(t)
}

/// A chunk's segment in the clip's time: moved by `from`, ending by `to`.
fn offset(s: Segment, from: f64, to: f64) -> Segment {
    let at = |t: f64| (t + from).min(to);
    Segment {
        start: s.start + from,
        end: at(s.end),
        text: s.text,
        words: s
            .words
            .into_iter()
            .map(|w| Word {
                start: at(w.start),
                end: at(w.end),
                text: w.text,
            })
            .collect(),
    }
}

/// The episode's clips to transcribe: those named, or every one with sound.
pub async fn clips_to_transcribe(
    ffprobe: &str,
    working_dir: &str,
    episode: &str,
    named: &[String],
    intro: &str,
    outro: &str,
) -> Result<Vec<(PathBuf, probe::ClipInfo)>, String> {
    let mut out = Vec::new();
    if named.is_empty() {
        let dir = paths::resolve_episode(working_dir, episode)?;
        for file in probe::media_files(&dir) {
            let shown = paths::display_path(working_dir, &file);
            if let Ok(info) = probe::probe_file(ffprobe, &file, shown).await {
                if !info.audio.is_empty() {
                    out.push((file, info));
                }
            }
        }
    } else {
        for p in named {
            let file = paths::resolve_media(working_dir, p, intro, outro)?;
            let info =
                probe::probe_file(ffprobe, &file, paths::display_path(working_dir, &file)).await?;
            out.push((file, info));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn turbo_is_preferred_when_downloaded() {
        let dir = temp_dir("whisper_models");
        std::fs::create_dir_all(dir.join("whisper")).unwrap();
        assert_eq!(model_for(&dir), None);
        std::fs::write(dir.join("whisper/ggml-base.en.bin"), b"").unwrap();
        assert!(model_for(&dir).unwrap().ends_with("ggml-base.en.bin"));
        std::fs::write(
            dir.join("whisper").join(crate::models::WHISPER_VIDEO_MODEL),
            b"",
        )
        .unwrap();
        assert!(is_turbo(&model_for(&dir).unwrap()));
    }

    #[test]
    fn the_cache_is_dropped_when_the_clip_changes() {
        let dir = temp_dir("transcript_cache");
        let clip = dir.join("a.mp4");
        std::fs::write(&clip, b"one").unwrap();
        let t = Transcript {
            path: "a.mp4".into(),
            model: "ggml-base.en.bin".into(),
            language: Some("en".into()),
            duration_secs: 3.0,
            segments: vec![Segment {
                start: 0.0,
                end: 1.0,
                text: "hi".into(),
                words: vec![Word {
                    start: 0.1,
                    end: 0.4,
                    text: "hi".into(),
                }],
            }],
        };
        save_cache(&dir, &clip, &t);
        assert_eq!(cached(&dir, &clip), Some(t));
        std::fs::write(&clip, b"different").unwrap();
        assert_eq!(cached(&dir, &clip), None);
    }

    #[test]
    fn a_v1_cache_without_words_is_not_used() {
        let dir = temp_dir("transcript_cache_v1");
        let clip = dir.join("a.mp4");
        std::fs::write(&clip, b"one").unwrap();
        let (size, mtime) = stamp(&clip);
        let v1 =
            cache_path(&dir, &clip).with_file_name(format!("a-{}.json", &clip_key(&clip)[..8]));
        std::fs::create_dir_all(v1.parent().unwrap()).unwrap();
        let old = serde_json::json!({"size": size, "mtime": mtime, "transcript": {
            "path": "a.mp4", "model": "ggml-base.en.bin", "language": "en", "durationSecs": 3.0,
            "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]}});
        std::fs::write(&v1, old.to_string()).unwrap();
        assert_ne!(v1, cache_path(&dir, &clip));
        assert_eq!(cached(&dir, &clip), None);
    }

    #[test]
    fn a_chunks_words_move_into_the_clips_time() {
        let s = Segment {
            start: 1.0,
            end: 4.0,
            text: "a b".into(),
            words: vec![
                Word {
                    start: 1.0,
                    end: 1.5,
                    text: "a".into(),
                },
                Word {
                    start: 3.5,
                    end: 4.5,
                    text: "b".into(),
                },
            ],
        };
        let moved = offset(s, 300.0, 303.8);
        assert_eq!((moved.start, moved.end), (301.0, 303.8));
        assert_eq!((moved.words[0].start, moved.words[0].end), (301.0, 301.5));
        assert_eq!(moved.words[1].end, 303.8);
    }

    /// Where the OS looks for the sidecar's shared libraries.
    fn lib_path_var() -> &'static str {
        if cfg!(windows) {
            "PATH"
        } else if cfg!(target_os = "macos") {
            "DYLD_LIBRARY_PATH"
        } else {
            "LD_LIBRARY_PATH"
        }
    }

    fn lib_path(libs: &Path) -> std::ffi::OsString {
        let mut dirs = vec![libs.to_path_buf()];
        if let Some(old) = std::env::var_os(lib_path_var()) {
            dirs.extend(std::env::split_paths(&old));
        }
        std::env::join_paths(dirs).unwrap()
    }

    /// Transcribe a real clip against a whisper-server the test starts.
    /// `HARUSPEX_VIDEO_CLIP=/path/clip.mp4 cargo test -- --ignored transcribe_a_real_clip --nocapture`
    /// (needs ffmpeg, ffprobe, the sidecar binaries and base.en, or the model
    /// named by `HARUSPEX_WHISPER_MODEL`; `HARUSPEX_WHISPER_SERVER` picks another
    /// whisper-server, such as an installed app's).
    #[tokio::test]
    #[ignore = "needs whisper-server, its model and a clip"]
    async fn transcribe_a_real_clip() {
        let clip =
            PathBuf::from(std::env::var("HARUSPEX_VIDEO_CLIP").expect("set HARUSPEX_VIDEO_CLIP"));
        let model = std::env::var("HARUSPEX_WHISPER_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap())
                    .join(".local/share/com.haruspex.app/models/whisper/ggml-base.en.bin")
            });
        let bins = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let server = std::env::var_os("HARUSPEX_WHISPER_SERVER")
            .map(PathBuf::from)
            .or_else(|| {
                std::fs::read_dir(&bins)
                    .unwrap()
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .find(|p| {
                        let n = p.file_name().unwrap().to_string_lossy().into_owned();
                        n.starts_with("haruspex-whisper-server-") && !n.ends_with(".version")
                    })
            })
            .expect("no whisper-server sidecar");
        // An installed app keeps its libraries beside the sidecar, in binaries/libs.
        let installed = server.with_file_name("binaries").join("libs");
        let libs = if installed.is_dir() {
            installed
        } else {
            bins.join("libs")
        };
        let mut child = tokio::process::Command::new(&server)
            .args([
                "--model",
                &model.to_string_lossy(),
                "--host",
                "127.0.0.1",
                "--port",
                "8768",
            ])
            .env(lib_path_var(), lib_path(&libs))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let whisper = crate::whisper::WhisperServer::video();
        whisper
            .0
            .attach_ready_for_tests(Duration::from_secs(60))
            .await;
        let dir = temp_dir("transcribe_real");
        let info = probe::probe_file("ffprobe", &clip, "clip".into())
            .await
            .unwrap();
        let progress = |done: f64| println!("progress {done:.0}");
        let t = transcribe_clip(
            &whisper,
            "ffmpeg",
            &model,
            &dir,
            &clip,
            &info,
            &How {
                refresh: false,
                language: None,
                cancel: &Cancel::default(),
                progress: &progress,
            },
        )
        .await
        .unwrap();
        child.kill().await.ok();
        println!(
            "{} segments; first {:?}; last {:?}",
            t.segments.len(),
            t.segments.first(),
            t.segments.last()
        );
        assert!(!t.segments.is_empty());
        assert!(t.segments.windows(2).all(|w| w[0].start <= w[1].start));
        assert!(t.segments.last().unwrap().end <= info.duration_secs + 1.0);
        // Each segment has its words, in order and inside it.
        for s in &t.segments {
            println!("{:?}", s.words.iter().map(|w| &w.text).collect::<Vec<_>>());
            assert!(!s.words.is_empty(), "no words in {s:?}");
            assert!(s.words.windows(2).all(|w| w[0].start <= w[1].start));
            assert!(s
                .words
                .iter()
                .all(|w| w.start >= s.start - 0.05 && w.end <= s.end + 0.05));
        }
        assert!(cached(&dir, &clip).is_some());
    }

    #[test]
    fn cancel_wakes_a_waiter() {
        let c = Cancel::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let waiter = c.clone();
            let h = tokio::spawn(async move { waiter.wait().await });
            tokio::task::yield_now().await;
            c.cancel();
            tokio::time::timeout(Duration::from_secs(1), h)
                .await
                .unwrap()
                .unwrap();
        });
    }
}

/// One line of the cut's speech, in the video's time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLine {
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// The clip it is from, 1-based.
    pub index: u32,
    /// From an item on the audio tracks under the picture (a voiceover):
    /// `index` then numbers those.
    pub audio: bool,
    /// Each word's time in the video, where the transcript has them.
    pub words: Vec<Word>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTranscript {
    /// Relative to the working folder.
    pub project: String,
    pub lines: Vec<TimelineLine>,
    /// Clips with no transcript yet, 1-based.
    pub untranscribed: Vec<u32>,
    /// Audio-track items with no transcript yet, 1-based.
    pub untranscribed_audio: Vec<u32>,
    pub total_secs: f64,
}

/// The project's speech in the cut's time, from the episode's transcripts.
pub fn timeline_transcript(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
) -> Result<(TimelineTranscript, Vec<super::timeline::Line>, PathBuf), String> {
    use super::format::ProjectDoc;
    use super::timeline;
    let path = super::project::default_project(working_dir, episode, project, None)?;
    let doc = ProjectDoc::open(&path)?;
    let episode_dir = paths::resolve_episode(working_dir, episode)?;
    let mut spans = doc.spans();
    spans.extend(doc.audio_spans());
    let (lines, missing) = timeline::lines(&spans, |file| {
        cached(&episode_dir, file).map(|t| t.segments)
    });
    let t = TimelineTranscript {
        project: paths::display_path(working_dir, &path),
        lines: lines
            .iter()
            .map(|l| TimelineLine {
                start: l.start,
                end: l.end,
                text: l.text.clone(),
                index: l.index as u32,
                audio: l.audio,
                words: l.words.clone(),
            })
            .collect(),
        untranscribed: missing
            .iter()
            .filter(|m| !m.1)
            .map(|m| m.0 as u32)
            .collect(),
        untranscribed_audio: missing.iter().filter(|m| m.1).map(|m| m.0 as u32).collect(),
        total_secs: doc.fps().secs(doc.sequence_end()),
    };
    Ok((t, lines, path))
}
