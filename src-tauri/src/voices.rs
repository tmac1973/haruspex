//! Saved voices: short reference clips a llama.cpp `/tts` server copies a
//! voice from (see `speech_server.rs`).
//!
//! Each lives in `<app data>/voices/<id>/`: `reference.wav` (mono, 24 kHz,
//! 5–30 s) and `voice.json`. A voice is added from a file the user picks in
//! Settings → Audio, or cut from a clip in the working folder. Every add
//! needs `consent: true`, the user's tick under the warning that they may
//! only use their own voice or one they have permission for; without it
//! nothing is written. `ref_text` is what the clip says, transcribed with the
//! video tools' whisper; the user can correct it in Settings.

use crate::video::binaries::{self, BinaryOverrides, Tool};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The shortest and longest reference clip, in seconds.
pub const MIN_SECS: f64 = 5.0;
pub const MAX_SECS: f64 = 30.0;
/// The reference's sample rate: Qwen3-TTS's own.
const RATE: u32 = 24_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SavedVoice {
    pub id: String,
    pub name: String,
    /// `file` (picked in Settings) or `clip` (cut from footage).
    pub source: String,
    pub source_path: Option<String>,
    pub from_secs: Option<f64>,
    pub to_secs: Option<f64>,
    /// What the reference clip says.
    pub ref_text: String,
    pub secs: f64,
    /// When the user ticked the consent box, in ms since 1970.
    #[ts(type = "number")]
    pub consented_at: i64,
}

fn voices_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|d| d.join("voices"))
        .map_err(|e| format!("No app data folder: {e}"))
}

/// A voice's folder, refusing an id that could leave `voices/`.
fn voice_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(format!("No saved voice {id}."));
    }
    Ok(root.join(id))
}

/// The reference clip of the voice `id`.
pub fn reference_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(voice_dir(root, id)?.join("reference.wav"))
}

/// Every saved voice, by name.
pub fn list(root: &Path) -> Vec<SavedVoice> {
    let mut out: Vec<SavedVoice> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| std::fs::read_to_string(e.path().join("voice.json")).ok())
        .filter_map(|t| serde_json::from_str(&t).ok())
        .collect();
    out.sort_by_key(|v| v.name.to_lowercase());
    out
}

/// The voice called `name` (any case), or with the id `name`.
pub fn find(root: &Path, name: &str) -> Option<SavedVoice> {
    let wanted = name.trim().to_lowercase();
    list(root)
        .into_iter()
        .find(|v| v.name.to_lowercase() == wanted || v.id == name.trim())
}

/// A folder name for `name`: its letters and digits, and a short suffix.
fn new_id(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("-");
    let tail = &uuid::Uuid::new_v4().simple().to_string()[..6];
    if slug.is_empty() {
        format!("voice-{tail}")
    } else {
        format!("{slug}-{tail}")
    }
}

/// What every add checks before anything is written.
fn check_new(root: &Path, name: &str, consent: bool) -> Result<String, String> {
    if !consent {
        return Err(
            "A voice is saved only once you confirm it is your own voice, \
                    or one you have permission to use."
                .into(),
        );
    }
    let name = name.trim();
    if name.is_empty() {
        return Err("The voice needs a name.".into());
    }
    if find(root, name).is_some_and(|v| v.name.eq_ignore_ascii_case(name)) {
        return Err(format!("There is already a voice called {name}."));
    }
    Ok(name.to_string())
}

/// Seconds of 16-bit mono at `RATE` in a WAV of `len` bytes (44-byte header).
fn wav_secs(len: u64) -> f64 {
    len.saturating_sub(44) as f64 / (RATE as f64 * 2.0)
}

/// Refuse a reference too short to copy a voice from, or too long to send.
fn check_length(secs: f64) -> Result<(), String> {
    if secs < MIN_SECS - 0.05 {
        return Err(format!(
            "The clip is {secs:.1} s; a voice needs {MIN_SECS:.0} s or more of speech."
        ));
    }
    if secs > MAX_SECS + 0.05 {
        return Err(format!(
            "The clip is {secs:.1} s; the most is {MAX_SECS:.0} s. A clean 5–10 s is enough."
        ));
    }
    Ok(())
}

async fn ffmpeg(ffmpeg: &str, args: &[String]) -> Result<Vec<u8>, String> {
    crate::video::ffmpeg_checked(ffmpeg, args, Duration::from_secs(120), "Reading the sound").await
}

/// `from`–`to` (the whole file when None) of `src` as mono 24 kHz 16-bit WAV.
async fn extract(
    bin: &str,
    src: &Path,
    span: Option<(f64, f64)>,
    out: &Path,
) -> Result<(), String> {
    let mut args: Vec<String> = vec!["-y".into()];
    if let Some((from, to)) = span {
        args.extend([
            "-ss".into(),
            format!("{from:.3}"),
            "-to".into(),
            format!("{to:.3}"),
        ]);
    }
    args.extend([
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        // A plain 44-byte header, so the length reads from the file size.
        "-map_metadata".into(),
        "-1".into(),
        "-fflags".into(),
        "+bitexact".into(),
        out.to_string_lossy().into_owned(),
    ]);
    ffmpeg(bin, &args).await.map(|_| ())
}

/// What the reference says, from the video tools' whisper.
async fn transcribe(app: &tauri::AppHandle, bin: &str, wav: &Path) -> Result<String, String> {
    use crate::video::transcribe;
    use tauri::Manager;
    let models = app.state::<crate::models::ModelManager>();
    let model = transcribe::model_for(models.models_dir())
        .ok_or("No speech model is installed to read the clip. Settings → Audio downloads one.")?;
    let wav16 = ffmpeg(
        bin,
        &[
            "-i".into(),
            wav.to_string_lossy().into_owned(),
            "-ar".into(),
            "16000".into(),
            "-f".into(),
            "wav".into(),
            "-".into(),
        ],
    )
    .await?;
    let _lease = transcribe::lease_server(app, &model).await?;
    let whisper = app.state::<crate::whisper::VideoWhisper>();
    let (segments, _) = whisper
        .0
        .transcribe_segments(wav16, transcribe::language_for(&model))
        .await?;
    Ok(segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" "))
}

/// Where a new voice came from.
struct Source {
    kind: &'static str,
    path: PathBuf,
    span: Option<(f64, f64)>,
}

async fn add(
    app: &tauri::AppHandle,
    overrides: &BinaryOverrides,
    name: &str,
    consent: bool,
    source: Source,
) -> Result<SavedVoice, String> {
    let root = voices_dir(app)?;
    let name = check_new(&root, name, consent)?;
    if let Some((from, to)) = source.span {
        check_length(to - from)?;
    }
    let found = binaries::resolve(overrides).await;
    let bin = found.require(Tool::Ffmpeg)?.to_string();
    let id = new_id(&name);
    let dir = voice_dir(&root, &id)?;
    let staging = root.join(format!(".{id}.part"));
    std::fs::create_dir_all(&staging).map_err(|e| format!("Can't save the voice: {e}"))?;
    let made = async {
        let wav = staging.join("reference.wav");
        extract(&bin, &source.path, source.span, &wav).await?;
        let secs = wav_secs(std::fs::metadata(&wav).map_err(|e| e.to_string())?.len());
        check_length(secs)?;
        let ref_text = transcribe(app, &bin, &wav).await.unwrap_or_default();
        let voice = SavedVoice {
            id: id.clone(),
            name,
            source: source.kind.into(),
            source_path: Some(source.path.to_string_lossy().into_owned()),
            from_secs: source.span.map(|s| s.0),
            to_secs: source.span.map(|s| s.1),
            ref_text,
            secs,
            consented_at: crate::time_util::now_ms(),
        };
        write_json(&staging, &voice)?;
        std::fs::rename(&staging, &dir).map_err(|e| format!("Can't save the voice: {e}"))?;
        Ok::<_, String>(voice)
    }
    .await;
    if made.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    made
}

fn write_json(dir: &Path, voice: &SavedVoice) -> Result<(), String> {
    let text = serde_json::to_string_pretty(voice).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("voice.json"), text).map_err(|e| format!("Can't save the voice: {e}"))
}

#[tauri::command]
pub fn voices_list(app: tauri::AppHandle) -> Result<Vec<SavedVoice>, String> {
    Ok(list(&voices_dir(&app)?))
}

/// Save a voice from a sound or video file the user picked.
#[tauri::command]
pub async fn voice_add_file(
    app: tauri::AppHandle,
    path: String,
    name: String,
    consent: bool,
    overrides: BinaryOverrides,
) -> Result<SavedVoice, String> {
    // Checked first, so a refusal never depends on the file.
    check_new(&voices_dir(&app)?, &name, consent)?;
    let path = PathBuf::from(path.trim());
    if !path.is_file() {
        return Err(format!("No file at {}.", path.display()));
    }
    let source = Source {
        kind: "file",
        path,
        span: None,
    };
    add(&app, &overrides, &name, consent, source).await
}

/// Save a voice from `from_secs`–`to_secs` of a file in the working folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn voice_add_clip(
    app: tauri::AppHandle,
    working_dir: String,
    path: String,
    from_secs: f64,
    to_secs: f64,
    name: String,
    consent: bool,
    overrides: BinaryOverrides,
) -> Result<SavedVoice, String> {
    check_new(&voices_dir(&app)?, &name, consent)?;
    check_length(to_secs - from_secs)?;
    let file = crate::video::paths::resolve_media(&working_dir, &path, "", "")?;
    if !file.is_file() {
        return Err(format!(
            "No file named {} in the working folder.",
            path.trim()
        ));
    }
    let source = Source {
        kind: "clip",
        path: file,
        span: Some((from_secs.max(0.0), to_secs)),
    };
    add(&app, &overrides, &name, consent, source).await
}

/// Correct what the reference clip says.
#[tauri::command]
pub fn voice_set_ref_text(
    app: tauri::AppHandle,
    id: String,
    ref_text: String,
) -> Result<SavedVoice, String> {
    let dir = voice_dir(&voices_dir(&app)?, &id)?;
    let text = std::fs::read_to_string(dir.join("voice.json"))
        .map_err(|_| format!("No saved voice {id}."))?;
    let mut voice: SavedVoice = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    voice.ref_text = ref_text.trim().to_string();
    write_json(&dir, &voice)?;
    Ok(voice)
}

#[tauri::command]
pub fn voice_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = voice_dir(&voices_dir(&app)?, &id)?;
    std::fs::remove_dir_all(&dir).map_err(|e| format!("Can't delete the voice: {e}"))
}

/// The reference clip's WAV, to play in Settings.
#[tauri::command]
pub fn voice_read_bytes(app: tauri::AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let path = reference_path(&voices_dir(&app)?, &id)?;
    std::fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|_| format!("No saved voice {id}."))
}

/// The voices folder, for `speech_server.rs`.
pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    voices_dir(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    fn save(root: &Path, name: &str) -> SavedVoice {
        let id = new_id(name);
        let dir = root.join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        let v = SavedVoice {
            id,
            name: name.into(),
            source: "file".into(),
            source_path: None,
            from_secs: None,
            to_secs: None,
            ref_text: "hello".into(),
            secs: 8.0,
            consented_at: 1,
        };
        write_json(&dir, &v).unwrap();
        v
    }

    #[test]
    fn no_consent_is_refused_before_anything_else() {
        let root = temp_dir("voices_consent");
        let err = check_new(&root, "Tim", false).unwrap_err();
        assert!(err.contains("permission"));
        assert!(std::fs::read_dir(&root).unwrap().next().is_none());
        assert_eq!(check_new(&root, " Tim ", true).unwrap(), "Tim");
    }

    #[test]
    fn a_name_is_used_once_and_found_in_any_case() {
        let root = temp_dir("voices_names");
        let v = save(&root, "My Voice");
        assert!(check_new(&root, "my voice", true).is_err());
        assert_eq!(find(&root, "MY VOICE"), Some(v.clone()));
        assert_eq!(find(&root, &v.id), Some(v));
        assert_eq!(list(&root).len(), 1);
    }

    #[test]
    fn clips_under_5_or_over_30_seconds_are_refused() {
        assert!(check_length(3.0).unwrap_err().contains("5 s or more"));
        assert!(check_length(31.0).unwrap_err().contains("the most is 30"));
        assert!(check_length(5.0).is_ok());
        assert!(check_length(30.0).is_ok());
        assert!((wav_secs(44 + 24_000 * 2 * 7) - 7.0).abs() < 1e-9);
    }

    #[test]
    fn ids_stay_inside_the_voices_folder() {
        let root = Path::new("/v");
        assert!(voice_dir(root, "../x").is_err());
        assert!(voice_dir(root, "").is_err());
        assert!(voice_dir(root, "a/b").is_err());
        assert_eq!(
            voice_dir(root, "tim-a1b2c3").unwrap(),
            root.join("tim-a1b2c3")
        );
        let id = new_id("Tim's narrator voice, take 2");
        assert!(id.starts_with("tim-s-narrator-voice-"), "{id}");
        assert!(new_id("…").starts_with("voice-"));
    }

    /// A real 3 s clip is refused after extracting it; a 6 s one is kept.
    /// Needs ffmpeg on PATH.
    #[tokio::test]
    #[ignore = "needs ffmpeg"]
    async fn extract_makes_mono_24k_of_the_span() {
        let dir = temp_dir("voices_extract");
        let src = dir.join("tone.wav");
        let made = tokio::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=f=440:d=10",
                "-ac",
                "2",
            ])
            .arg(&src)
            .status()
            .await
            .unwrap();
        assert!(made.success());
        let out = dir.join("ref.wav");
        extract("ffmpeg", &src, Some((1.0, 7.0)), &out)
            .await
            .unwrap();
        let secs = wav_secs(std::fs::metadata(&out).unwrap().len());
        assert!((secs - 6.0).abs() < 0.02, "{secs}");
        extract("ffmpeg", &src, Some((0.0, 3.0)), &out)
            .await
            .unwrap();
        assert!(check_length(wav_secs(std::fs::metadata(&out).unwrap().len())).is_err());
    }
}
