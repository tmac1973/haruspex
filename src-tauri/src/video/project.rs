//! Which project a tool means, the media it adds, and the cut and ops the
//! tools ask for, put together over `format::ProjectDoc`.

use super::binaries::{self, BinaryOverrides, Tool};
use super::format::{self, ProjectDoc, ProjectSummary};
use super::kdenlive;
use super::mlt::{mlt_path, profile::profile};
use super::paths::{display_path, resolve_episode, resolve_in_working, resolve_media};
use super::probe;
use super::timeline::GainRange;
use super::timeline::{
    assign_audio_tracks, current_audio, AudioPlacement, AudioSource, Fit, Media, Placement, Source,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What the frontend passes from Settings → Video editing.
#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoSettings {
    pub overrides: BinaryOverrides,
    /// Settings → Video editing → Editor: the format of a new project.
    pub editor: format::Format,
    pub intro: String,
    pub outro: String,
    pub preset: String,
}

/// `true` for the one set in Settings → Video editing, or a path.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(untagged)]
pub enum EndClip {
    Settings(bool),
    Path(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct CutItemSpec {
    /// 1-based: an item already on the main track.
    pub index: Option<u32>,
    /// A new clip, in the working folder (or the Settings intro/outro).
    pub path: Option<String>,
    /// Where to start and stop in the clip.
    pub in_secs: Option<f64>,
    pub out_secs: Option<f64>,
    /// Or exact frames of the clip, at the project's rate, overriding the
    /// seconds: the first shown and the last shown.
    #[ts(type = "number | null")]
    pub in_frame: Option<i64>,
    #[ts(type = "number | null")]
    pub out_frame: Option<i64>,
    /// A crossfade into this clip, overriding the cut's.
    pub crossfade_secs: Option<f64>,
    /// How its picture fills the frame; none keeps what is there (letterbox
    /// for a new clip).
    pub fit: Option<Fit>,
    /// Gains over stretches of its sound, in its own time, replacing those
    /// Haruspex set; none keeps them.
    pub gain_ranges: Option<Vec<RangeSpec>>,
}

/// A gain over a stretch of a clip's sound, in seconds of the clip's own time.
/// A gain of -60 dB or less mutes it.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RangeSpec {
    pub from_secs: f64,
    pub to_secs: f64,
    pub gain_db: f64,
}

impl RangeSpec {
    /// In the clip's source frames, or what is wrong with it.
    fn frames(&self, fps: &super::mlt::fps::Fps) -> Result<GainRange, String> {
        let ok = [self.from_secs, self.to_secs, self.gain_db]
            .iter()
            .all(|v| v.is_finite());
        if !ok || self.from_secs < 0.0 || self.to_secs <= self.from_secs {
            return Err("A gain range needs from_secs before to_secs, both from 0.".into());
        }
        if self.gain_db > 20.0 {
            return Err("A gain range adds at most 20 dB.".into());
        }
        Ok(GainRange {
            from_frame: fps.frames(self.from_secs),
            to_frame: (fps.frames(self.to_secs) - 1).max(fps.frames(self.from_secs)),
            gain_db: self.gain_db.max(-70.0),
        })
    }
}

/// Add a range to a clip's ranges, replacing any it overlaps, in time order.
fn with_range(mut ranges: Vec<GainRange>, r: GainRange) -> Vec<GainRange> {
    ranges.retain(|o| o.to_frame < r.from_frame || o.from_frame > r.to_frame);
    ranges.push(r);
    ranges.sort_by_key(|o| o.from_frame);
    ranges
}

/// A sound on an audio track under the picture: a voiceover or music bed.
#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct CutAudioSpec {
    /// 1-based: an item already on the audio tracks.
    pub index: Option<u32>,
    /// A new sound file, in the working folder.
    pub path: Option<String>,
    /// Where it starts in the video, in seconds. Default 0.
    pub at_secs: Option<f64>,
    /// Where to start and stop in the file.
    pub in_secs: Option<f64>,
    pub out_secs: Option<f64>,
    /// How loud to make it: -14 LUFS (the default) for speech, about -30
    /// for music under speech.
    pub lufs: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct CutSpec {
    pub project: Option<String>,
    /// The format of a new project, overriding Settings → Video editing.
    pub editor: Option<format::Format>,
    pub preset: Option<String>,
    pub intro: Option<EndClip>,
    pub outro: Option<EndClip>,
    pub items: Vec<CutItemSpec>,
    /// Everything on the audio tracks under the picture, replacing what is
    /// there. None keeps it, moved with the clips it starts over.
    pub audio: Option<Vec<CutAudioSpec>>,
    /// A crossfade at every join, in seconds; 0 or none for hard cuts.
    pub crossfade_secs: Option<f64>,
    /// Even out the sound to YouTube's -14 LUFS. Default true.
    pub normalize: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum ProjectOp {
    #[serde(rename_all = "camelCase")]
    Trim {
        index: u32,
        in_secs: Option<f64>,
        out_secs: Option<f64>,
        /// Exact frames, overriding the seconds: the first and last shown.
        #[serde(default)]
        #[ts(type = "number | null")]
        in_frame: Option<i64>,
        #[serde(default)]
        #[ts(type = "number | null")]
        out_frame: Option<i64>,
    },
    /// How one clip's picture fills the frame.
    Fit {
        index: u32,
        fit: Fit,
    },
    /// A gain over a stretch of one clip's sound, in its own time; it replaces
    /// any range of Haruspex's it overlaps.
    #[serde(rename_all = "camelCase")]
    GainRange {
        index: u32,
        from_secs: f64,
        to_secs: f64,
        gain_db: f64,
    },
    /// Take Haruspex's gain ranges off one clip.
    ClearGainRanges {
        index: u32,
    },
    Remove {
        index: u32,
    },
    Move {
        from: u32,
        to: u32,
    },
    /// Cut stretches out of one clip, in its own time; it becomes pieces.
    RemoveRanges {
        index: u32,
        ranges: Vec<super::silence::SilenceRange>,
    },
    /// Cut the silences out of one clip, or every clip when `index` is none.
    #[serde(rename_all = "camelCase")]
    RemoveSilences {
        index: Option<u32>,
        min_secs: f64,
        pad_secs: f64,
    },
    /// Measure every clip again and set its gain to reach -14 LUFS.
    Normalize,
}

/// Set each placement's gain so its stretch of sound reaches -14 LUFS.
/// Returns a note for the model.
async fn normalize_gains(
    doc: &ProjectDoc,
    wanted: &mut [Placement],
    ffmpeg: &str,
    episode_dir: &Path,
) -> Result<String, String> {
    use super::loudness::{self, Stretch};
    let clips = doc.clips();
    let spans = doc.spans();
    let fps = doc.fps();
    let mut stretches = Vec::new();
    let mut which = Vec::new();
    for (k, p) in wanted.iter().enumerate() {
        let (file, stream, in_f, out_f) = match &p.source {
            Source::Existing(i) | Source::Piece(i) => {
                let Some(a) = &clips[*i].audio else { continue };
                (
                    spans[*i].file.clone(),
                    a.stream,
                    p.in_frame.unwrap_or(a.in_frame),
                    p.out_frame.unwrap_or(a.out_frame),
                )
            }
            Source::New(m) => {
                let Some(stream) = m.audio_index else {
                    continue;
                };
                let r = Path::new(&m.resource);
                let file = if r.is_absolute() {
                    r.to_path_buf()
                } else {
                    Path::new(doc.root_dir()).join(r)
                };
                (
                    file,
                    stream,
                    p.in_frame.unwrap_or(0),
                    p.out_frame.unwrap_or(m.length - 1),
                )
            }
        };
        stretches.push(Stretch {
            file,
            stream,
            from: fps.secs(in_f),
            to: fps.secs(out_f + 1),
        });
        which.push(k);
    }
    let measured = loudness::measure_all(ffmpeg, episode_dir, &stretches, &|_, _| {}).await?;
    let n = which.len();
    let mut quiet = Vec::new();
    for ((k, m), s) in which.into_iter().zip(measured).zip(&stretches) {
        let gain = loudness::gain_for(&m);
        wanted[k].gain_db = Some(gain.map_or(0.0, |g| g.db));
        wanted[k].limiter = gain.is_some_and(|g| g.limit);
        if let Some(g) = gain {
            let short = loudness::short_of_target(&m, &g);
            if short > super::check::LUFS_TOLERANCE {
                let name = s.file.file_name().map_or_else(
                    || s.file.display().to_string(),
                    |f| f.to_string_lossy().into_owned(),
                );
                quiet.push(format!("{name} (about {short:.0} dB under)"));
            }
        }
    }
    let mut note = format!(
        "Evened out the sound of {n} clip{} to about -14 LUFS.",
        if n == 1 { "" } else { "s" }
    );
    if !quiet.is_empty() {
        note.push_str(&format!(
            " Some stay under it, as more gain would raise their noise or squash their \
             peaks: {}. Tell the user.",
            quiet.join(", ")
        ));
    }
    Ok(note)
}

/// The loudness an audio-track item may aim at.
const LUFS_RANGE: (f64, f64) = (-40.0, -10.0);

/// Set each audio placement's gain so it reaches its loudness: -14 LUFS, or
/// the one it asks for or already aims at. `doc` is the project the
/// placements' `Existing` indexes are read from. Returns a note, or none
/// when there is nothing on the audio tracks.
async fn normalize_audio(
    doc: &ProjectDoc,
    wanted: &mut [AudioPlacement],
    ffmpeg: &str,
    episode_dir: &Path,
) -> Result<Option<String>, String> {
    use super::check::{LUFS_TOLERANCE, TARGET_LUFS};
    use super::loudness::{self, Stretch};
    let clips = doc.audio_clips();
    let fps = doc.fps();
    let root = Path::new(doc.root_dir());
    let file_of = |r: &str| {
        let p = Path::new(r);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    let mut stretches = Vec::new();
    let mut which = Vec::new();
    for (k, p) in wanted.iter().enumerate() {
        let (file, stream, in_f, out_f, target) = match &p.source {
            AudioSource::Existing(i) => {
                let Some(c) = clips.get(*i) else { continue };
                let Some(stream) = c.stream else { continue };
                (
                    file_of(&c.resource),
                    stream,
                    p.in_frame.unwrap_or(c.in_frame),
                    p.out_frame.unwrap_or(c.out_frame),
                    p.lufs.or(c.lufs),
                )
            }
            AudioSource::New(m) => {
                let Some(stream) = m.audio_index else {
                    continue;
                };
                (
                    file_of(&m.resource),
                    stream,
                    p.in_frame.unwrap_or(0),
                    p.out_frame.unwrap_or(m.length - 1),
                    p.lufs,
                )
            }
        };
        stretches.push(Stretch {
            file,
            stream,
            from: fps.secs(in_f),
            to: fps.secs(out_f + 1),
        });
        which.push((k, target.unwrap_or(TARGET_LUFS)));
    }
    if which.is_empty() {
        return Ok(None);
    }
    let measured = loudness::measure_all(ffmpeg, episode_dir, &stretches, &|_, _| {}).await?;
    let n = which.len();
    let mut quiet = Vec::new();
    for (((k, target), m), s) in which.into_iter().zip(measured).zip(&stretches) {
        let gain = loudness::gain_for_target(&m, target);
        wanted[k].gain_db = Some(gain.map_or(0.0, |g| g.db));
        wanted[k].limiter = gain.is_some_and(|g| g.limit);
        wanted[k].lufs = ((target - TARGET_LUFS).abs() > 0.05).then_some(target);
        if let Some(g) = gain {
            if loudness::short_of(&m, &g, target) > LUFS_TOLERANCE {
                let name = s.file.file_name().map_or_else(
                    || s.file.display().to_string(),
                    |f| f.to_string_lossy().into_owned(),
                );
                quiet.push(name);
            }
        }
    }
    let mut note = format!(
        "Set the sound of {n} audio-track item{} to its loudness (-14 LUFS unless lufs says \
         otherwise).",
        if n == 1 { "" } else { "s" }
    );
    if !quiet.is_empty() {
        note.push_str(&format!(
            " Some stay under it, as more gain would raise their noise or squash their peaks: \
             {}.",
            quiet.join(", ")
        ));
    }
    Ok(Some(note))
}

/// Where an audio-track item that started at `s` (old timeline frames)
/// starts after the main track became `wanted`: with the main-track clip it
/// started over, at the same moment of that clip; when that moment was cut
/// out, at the next piece kept. `old` and `new` are each main-track item's
/// (start, in, out) frames, `new` in `wanted`'s order.
fn follow(s: i64, old: &[(i64, i64, i64)], new: &[(i64, i64, i64)], wanted: &[Placement]) -> i64 {
    let from_item = |k: usize| -> Vec<usize> {
        let mut js: Vec<usize> = (0..new.len())
            .filter(
                |&j| matches!(wanted[j].source, Source::Existing(i) | Source::Piece(i) if i == k),
            )
            .collect();
        js.sort_by_key(|&j| new[j].1);
        js
    };
    let end = |items: &[(i64, i64, i64)]| {
        items
            .iter()
            .map(|&(st, i, o)| st + o - i + 1)
            .max()
            .unwrap_or(0)
    };
    let next_kept = |after: usize| {
        (after..old.len()).find_map(|k| from_item(k).iter().map(|&j| new[j].0).min())
    };
    let inside = old
        .iter()
        .rposition(|&(st, i, o)| s >= st && s < st + o - i + 1);
    if let Some(k) = inside {
        let (st, i, _) = old[k];
        let f = i + (s - st);
        let hit = from_item(k).into_iter().find(|&j| new[j].2 >= f);
        if let Some(j) = hit {
            return new[j].0 + (f - new[j].1).max(0);
        }
        return next_kept(k + 1).unwrap_or(s);
    }
    let old_end = end(old);
    if s >= old_end {
        return (s + end(new) - old_end).max(0);
    }
    // In a gap: as far before the next clip as it was.
    match old.iter().position(|&(st, _, _)| st > s) {
        Some(k) => next_kept(k).map_or(s, |n| (n - (old[k].0 - s)).max(0)),
        None => s,
    }
}

/// Each main-track item's (start, in, out) frames.
fn item_frames(doc: &ProjectDoc) -> Vec<(i64, i64, i64)> {
    let fps = doc.fps();
    doc.spans()
        .iter()
        .zip(doc.clips())
        .map(|(s, c)| (fps.frames(s.start), c.in_frame, c.out_frame))
        .collect()
}

/// Write `main` to the main track, then the audio tracks: `audio` when the
/// call says what they hold, else what is there, each item moved with the
/// main-track clip it starts over. Evens out the audio tracks' sound when
/// `normalize` gives the ffmpeg and episode folder to measure with.
async fn edit_text(
    doc: &ProjectDoc,
    main: &[Placement],
    audio: Option<Vec<AudioPlacement>>,
    normalize: Option<(&str, &Path)>,
    notes: &mut Vec<String>,
) -> Result<String, String> {
    let first = doc.apply(main)?;
    notes.extend(first.notes);
    let after = doc.reparse(first.text)?;
    let clips = after.audio_clips();
    let mut wanted = match audio {
        Some(w) => w,
        None if clips.is_empty() => return Ok(after_text(after)),
        None => {
            let old = item_frames(doc);
            let new = item_frames(&after);
            let mut w = current_audio(&clips);
            if new.len() == main.len() {
                for p in &mut w {
                    p.at = follow(p.at, &old, &new, main);
                }
            }
            w
        }
    };
    if wanted.is_empty() && clips.is_empty() {
        return Ok(after_text(after));
    }
    if let Some((ffmpeg, dir)) = normalize {
        if let Some(note) = normalize_audio(&after, &mut wanted, ffmpeg, dir).await? {
            notes.push(note);
        }
    }
    let lens: Vec<i64> = wanted
        .iter()
        .map(|p| {
            let (i, o) = match &p.source {
                AudioSource::Existing(k) => {
                    clips.get(*k).map_or((0, 0), |c| (c.in_frame, c.out_frame))
                }
                AudioSource::New(m) => (0, m.length - 1),
            };
            p.out_frame.unwrap_or(o) - p.in_frame.unwrap_or(i) + 1
        })
        .collect();
    assign_audio_tracks(&mut wanted, &lens, after.audio_track_count());
    let second = after.apply_audio(&wanted)?;
    notes.extend(second.notes);
    Ok(second.text)
}

fn after_text(doc: ProjectDoc) -> String {
    match doc {
        ProjectDoc::Shotcut(d) => d.text,
        ProjectDoc::Kdenlive(d) => d.text,
    }
}

/// The audio tracks a cut asks for, as placements.
async fn audio_placements(
    doc: &ProjectDoc,
    working_dir: &str,
    list: &[CutAudioSpec],
    settings: &VideoSettings,
    ffprobe: &str,
) -> Result<Vec<AudioPlacement>, String> {
    let clips = doc.audio_clips();
    let fps = doc.fps();
    let mut out = Vec::new();
    for (n, a) in list.iter().enumerate() {
        let (source, track) = match (&a.index, &a.path) {
            (Some(i), None) if *i >= 1 && (*i as usize) <= clips.len() => {
                let k = *i as usize - 1;
                (AudioSource::Existing(k), clips[k].track)
            }
            (Some(i), None) => {
                return Err(format!(
                    "Audio item {} names audio item {i}, but the audio tracks have {}. \
                     video_project_read lists them.",
                    n + 1,
                    clips.len()
                ))
            }
            (None, Some(p)) => {
                let m = media(doc, working_dir, p, settings, ffprobe).await?;
                if m.audio_index.is_none() {
                    return Err(format!("{p} has no sound to put on the audio track."));
                }
                (AudioSource::New(m), 0)
            }
            _ => {
                return Err(format!(
                    "Audio item {} needs exactly one of index (an item already on the audio \
                     tracks, from 1) or path.",
                    n + 1
                ))
            }
        };
        out.push(AudioPlacement {
            source,
            at: fps.frames(a.at_secs.unwrap_or(0.0).max(0.0)),
            in_frame: a.in_secs.map(|s| fps.frames(s.max(0.0))),
            out_frame: a.out_secs.map(|s| fps.frames(s) - 1),
            track,
            gain_db: None,
            limiter: false,
            lufs: a.lufs.map(|l| l.clamp(LUFS_RANGE.0, LUFS_RANGE.1)),
        });
    }
    Ok(out)
}

/// A crossfade on the cut's first clip has nothing before it to fade from.
fn first_clip_fade(own: Option<f64>) -> Result<(), String> {
    if own.is_some_and(|s| s > 0.0) {
        return Err(
            "The first clip has nothing before it to crossfade from. Put \
                    crossfade_secs on the clip after the join, or set the cut's \
                    crossfade_secs for every join."
                .into(),
        );
    }
    Ok(())
}

/// The shortest piece a cut leaves: anything shorter is dropped with its gap.
const MIN_PIECE_SECS: f64 = 0.2;

/// Cut `ranges` (source frames) out of the placement at `pos`, which shows
/// item `item` from `in_f` to `out_f`. Its first piece stays the item, so its
/// identity and effects stay; the rest are copies. Returns frames removed.
fn cut_ranges(
    wanted: &mut Vec<Placement>,
    pos: usize,
    item: usize,
    in_f: i64,
    out_f: i64,
    ranges: &[(i64, i64)],
    min_piece: i64,
) -> i64 {
    let mut cuts: Vec<(i64, i64)> = ranges
        .iter()
        .map(|&(a, b)| (a.max(in_f), b.min(out_f + 1)))
        .filter(|(a, b)| b > a)
        .collect();
    cuts.sort();
    let mut keeps = Vec::new();
    let mut at = in_f;
    for (a, b) in cuts {
        if a > at {
            keeps.push((at, a - 1));
        }
        at = at.max(b);
    }
    if at <= out_f {
        keeps.push((at, out_f));
    }
    keeps.retain(|(a, b)| b - a + 1 >= min_piece);
    let kept: i64 = keeps.iter().map(|(a, b)| b - a + 1).sum();
    let first_mix = wanted[pos].mix_in;
    let gain = wanted[pos].gain_db;
    let limiter = wanted[pos].limiter;
    let fit = wanted[pos].fit;
    let ranges = wanted[pos].gain_ranges.clone();
    let pieces: Vec<Placement> = keeps
        .iter()
        .enumerate()
        .map(|(n, &(a, b))| Placement {
            source: if n == 0 {
                Source::Existing(item)
            } else {
                Source::Piece(item)
            },
            in_frame: Some(a),
            out_frame: Some(b),
            mix_in: if n == 0 { first_mix } else { None },
            gain_db: gain,
            limiter,
            fit,
            gain_ranges: ranges.clone(),
        })
        .collect();
    wanted.splice(pos..=pos, pieces);
    (out_f - in_f + 1) - kept
}

/// A trim's first and last shown frames: the frames when given, else the
/// seconds at the project's rate.
fn trim_frames(
    fps: &super::mlt::fps::Fps,
    (in_secs, out_secs): (Option<f64>, Option<f64>),
    (in_frame, out_frame): (Option<i64>, Option<i64>),
) -> Result<(Option<i64>, Option<i64>), String> {
    if in_frame.is_some_and(|f| f < 0) || out_frame.is_some_and(|f| f < 0) {
        return Err("Frames count from 0.".into());
    }
    if let (Some(a), Some(b)) = (in_frame, out_frame) {
        if b < a {
            return Err("out_frame comes before in_frame.".into());
        }
    }
    Ok((
        in_frame.or_else(|| in_secs.map(|s| fps.frames(s.max(0.0)))),
        out_frame.or_else(|| out_secs.map(|s| fps.frames(s) - 1)),
    ))
}

fn format_secs(secs: f64) -> String {
    let t = secs.round() as i64;
    format!("{}:{:02}", t / 60, t % 60)
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CutResult {
    pub summary: ProjectSummary,
    pub notes: Vec<String>,
    /// The project was made by this call.
    pub created: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct EpisodeState {
    /// The project the last cut used, relative to the working folder.
    project: Option<String>,
}

fn state_path(episode_dir: &Path) -> PathBuf {
    episode_dir.join(".haruspex").join("state.json")
}

fn read_state(episode_dir: &Path) -> EpisodeState {
    std::fs::read_to_string(state_path(episode_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_state(episode_dir: &Path, project: &str) {
    let path = state_path(episode_dir);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let state = EpisodeState {
        project: Some(project.to_string()),
    };
    if let Ok(text) = serde_json::to_string_pretty(&state) {
        let _ = std::fs::write(path, text);
    }
}

/// The projects in a folder: `.kdenlive` files, and `.mlt` files that are
/// Shotcut projects (Shotcut also saves playlists and presets as `.mlt`).
fn project_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_file())
                .filter(|p| match format::Format::from_path(p) {
                    Some(format::Format::Kdenlive) => true,
                    Some(format::Format::Shotcut) => super::shotcut::is_project(p),
                    None => false,
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// The digits an episode folder's name ends with: `ep010` → `010`.
fn trailing_number(name: &str) -> Option<&str> {
    let digits = name.len() - name.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    (digits > 0).then(|| &name[name.len() - digits..])
}

/// Which project a tool means.
///
/// Named → that one. Otherwise: the one the episode's last cut used; else the
/// only project (`.mlt` or `.kdenlive`) in the episode folder; else the only
/// one in the working folder whose name ends in the episode's number
/// (`spronglehump_010.mlt` for `ep010`); else, when the call may create one,
/// `<episode>/<episode>.<the create format's extension>`.
pub fn default_project(
    working_dir: &str,
    episode: &str,
    named: Option<&str>,
    create: Option<format::Format>,
) -> Result<PathBuf, String> {
    if let Some(named) = named.map(str::trim).filter(|n| !n.is_empty()) {
        if format::Format::from_path(Path::new(named)).is_none() {
            return Err(format!(
                "{named} is not a project: use a Shotcut (.mlt) or Kdenlive (.kdenlive) file."
            ));
        }
        return resolve_in_working(working_dir, named);
    }
    let episode_dir = resolve_episode(working_dir, episode)?;
    if let Some(rel) = read_state(&episode_dir).project {
        if let Ok(p) = resolve_in_working(working_dir, &rel) {
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    let here = project_files(&episode_dir);
    match here.len() {
        1 => return Ok(here[0].clone()),
        n if n > 1 => {
            let names: Vec<String> = here.iter().map(|p| display_path(working_dir, p)).collect();
            return Err(format!("Name the project: {}.", names.join(", ")));
        }
        _ => {}
    }
    let name = episode_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video")
        .to_string();
    if let Some(num) = trailing_number(&name) {
        let root = resolve_episode(working_dir, "")?;
        let matches: Vec<PathBuf> = project_files(&root)
            .into_iter()
            .filter(|p| {
                p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| trailing_number(s) == Some(num))
            })
            .collect();
        if matches.len() == 1 {
            return Ok(matches[0].clone());
        }
    }
    if let Some(f) = create {
        return Ok(episode_dir.join(format!("{name}.{}", f.extension())));
    }
    Err(format!(
        "There is no project for {} yet. Make one with video_cut.",
        if episode.trim().is_empty() {
            "this folder"
        } else {
            episode.trim()
        }
    ))
}

/// Where an episode's own files go (renders, captions, chapters, thumbnail):
/// the episode folder when one is named, else the project's folder, so a
/// call naming only `ep01/ep01.kdenlive` still writes into `ep01/`.
pub fn episode_home(working_dir: &str, episode: &str, project: &Path) -> Result<PathBuf, String> {
    if !episode.trim().is_empty() {
        return resolve_episode(working_dir, episode);
    }
    match project.parent() {
        Some(dir) if dir.is_dir() => resolve_episode(working_dir, &display_path(working_dir, dir)),
        _ => resolve_episode(working_dir, ""),
    }
}

/// The resource string a file gets in a project rooted at `root`.
fn resource_for(root: &str, file: &Path) -> String {
    let file = mlt_path(&file.canonicalize().unwrap_or_else(|_| file.to_path_buf()));
    let root = mlt_path(
        &Path::new(root)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(root)),
    );
    let prefix = format!("{}/", root.trim_end_matches('/'));
    file.strip_prefix(&prefix)
        .map_or(file.clone(), str::to_string)
}

async fn media(
    doc: &ProjectDoc,
    working_dir: &str,
    path: &str,
    settings: &VideoSettings,
    ffprobe: &str,
) -> Result<Media, String> {
    let file = resolve_media(working_dir, path, &settings.intro, &settings.outro)?;
    let info = probe::probe_file(ffprobe, &file, path.to_string()).await?;
    Ok(Media {
        resource: resource_for(doc.root_dir(), &file),
        length: doc.fps().frames(info.duration_secs).max(1),
        video_index: info.video.as_ref().map(|_| 0),
        audio_index: info.audio.first().map(|a| a.index),
        file_size: info.size_bytes,
        file_hash: kdenlive::file_hash(&file)?,
    })
    .map(|mut m| {
        // ffprobe's own stream index for the picture, as MLT counts.
        if info.video.is_some() {
            m.video_index = Some(video_stream_index(&info));
        }
        m
    })
}

/// The picture's stream index: the first index not taken by sound, which is
/// what files from OBS, phones and cameras have (picture 0, sound 1).
fn video_stream_index(info: &probe::ClipInfo) -> u32 {
    (0..)
        .find(|i| !info.audio.iter().any(|a| a.index == *i))
        .unwrap_or(0)
}

fn end_clip_path<'a>(
    choice: &'a EndClip,
    setting: &'a str,
    which: &str,
) -> Result<Option<&'a str>, String> {
    match choice {
        EndClip::Settings(false) => Ok(None),
        EndClip::Settings(true) if setting.trim().is_empty() => Err(format!(
            "No {which} is set in Settings → Video editing; name the file."
        )),
        EndClip::Settings(true) => Ok(Some(setting)),
        EndClip::Path(p) => Ok(Some(p.as_str())),
    }
}

async fn tools(settings: &VideoSettings) -> Result<(String, String, String), String> {
    let found = binaries::resolve(&settings.overrides).await;
    Ok((
        found.require(Tool::Ffprobe)?.to_string(),
        found.require(Tool::Melt)?.to_string(),
        found.require(Tool::Ffmpeg)?.to_string(),
    ))
}

/// Item `n`'s `index` (from 1) as a main-track position, when the cut has
/// that many clips. Checked here because the loudness pass reads the clip
/// before the edit itself would refuse it.
fn existing_index(n: usize, index: u32, count: usize) -> Result<usize, String> {
    let i = index as usize - 1;
    if i < count {
        return Ok(i);
    }
    Err(if count == 0 {
        format!(
            "Item {} names clip {index}, but the cut has no clips yet. Give its path instead.",
            n + 1
        )
    } else {
        format!(
            "Item {} names clip {index}, but the cut has {count}. video_project_read lists them.",
            n + 1
        )
    })
}

/// Make the main track hold the cut, creating the project when needed.
pub async fn cut(
    working_dir: &str,
    episode: &str,
    spec: CutSpec,
    settings: &VideoSettings,
) -> Result<CutResult, String> {
    let (ffprobe, melt, ffmpeg) = tools(settings).await?;
    let editor = spec.editor.unwrap_or(settings.editor);
    let path = default_project(working_dir, episode, spec.project.as_deref(), Some(editor))?;
    let created = !path.exists();
    let mut notes = Vec::new();
    let mut doc = if created {
        let preset = spec
            .preset
            .clone()
            .unwrap_or_else(|| settings.preset.clone());
        let preset = if preset.is_empty() {
            "1080p60".to_string()
        } else {
            preset
        };
        ProjectDoc::template(
            format::Format::from_path(&path).unwrap_or(editor),
            &preset,
            &resolve_episode(working_dir, "")?,
        )?
    } else {
        ProjectDoc::open(&path)?
    };
    doc.editable()?;
    if let (Some(preset), false) = (&spec.preset, created) {
        let p = profile(preset)?;
        let fps = doc.fps();
        let same_rate = fps.num == p.fps * fps.den;
        if !same_rate && !doc.clips().is_empty() {
            let where_to = match doc.format() {
                format::Format::Shotcut => "Shotcut (Settings → Video Mode)",
                format::Format::Kdenlive => "Kdenlive (Project → Project Settings)",
            };
            return Err(format!(
                "This project already has clips at another frame rate. Change it in {where_to}."
            ));
        }
        doc = doc.with_profile(preset)?;
    }

    let resources: Vec<String> = doc.clips().into_iter().map(|c| c.resource).collect();
    let elsewhere = doc.other_track_resources();
    let mut wanted: Vec<Placement> = Vec::new();
    // Each placement's own crossfade, when its item names one.
    let mut fades: Vec<Option<f64>> = Vec::new();
    let mut ends: Vec<(usize, Placement)> = Vec::new();
    for (which, choice, setting) in [
        ("intro", &spec.intro, &settings.intro),
        ("outro", &spec.outro, &settings.outro),
    ] {
        let Some(choice) = choice else { continue };
        let Some(file) = end_clip_path(choice, setting, which)? else {
            continue;
        };
        let m = media(&doc, working_dir, file, settings, &ffprobe).await?;
        if elsewhere.contains(&m.resource) {
            notes.push(format!(
                "The {which} is already on another track, so it was not added again."
            ));
            continue;
        }
        let placement = match resources.iter().position(|r| *r == m.resource) {
            Some(i) => Placement::of(Source::Existing(i)),
            None => Placement::of(Source::New(m)),
        };
        ends.push((if which == "intro" { 0 } else { 1 }, placement));
    }
    for (n, item) in spec.items.iter().enumerate() {
        let source = match (&item.index, &item.path) {
            (Some(i), None) if *i >= 1 => Source::Existing(existing_index(n, *i, resources.len())?),
            (None, Some(p)) => Source::New(media(&doc, working_dir, p, settings, &ffprobe).await?),
            _ => {
                return Err(format!(
                "Item {} needs exactly one of index (a clip already in the cut, from 1) or path.",
                n + 1
            ))
            }
        };
        if let Some(problem) = item.fit.as_ref().and_then(Fit::problem) {
            return Err(format!("Item {}: {problem}", n + 1));
        }
        let (in_frame, out_frame) = trim_frames(
            &doc.fps(),
            (item.in_secs, item.out_secs),
            (item.in_frame, item.out_frame),
        )
        .map_err(|e| format!("Item {}: {e}", n + 1))?;
        let gain_ranges = match &item.gain_ranges {
            Some(list) => Some(
                list.iter()
                    .try_fold(Vec::new(), |acc, r| {
                        r.frames(&doc.fps()).map(|g| with_range(acc, g))
                    })
                    .map_err(|e| format!("Item {}: {e}", n + 1))?,
            ),
            None => None,
        };
        wanted.push(Placement {
            in_frame,
            out_frame,
            fit: item.fit,
            gain_ranges,
            ..Placement::of(source)
        });
        fades.push(item.crossfade_secs);
    }
    // The intro and outro go at the ends, and are not listed twice.
    let mut paired: Vec<(Placement, Option<f64>)> = wanted.into_iter().zip(fades).collect();
    paired.retain(|(p, _)| !ends.iter().any(|(_, e)| matches!((&e.source, &p.source), (Source::Existing(a), Source::Existing(b)) if a == b)));
    for (end, p) in ends {
        if end == 0 {
            paired.insert(0, (p, None));
        } else {
            paired.push((p, None));
        }
    }
    if paired.is_empty() {
        return Err("The cut has no clips. List them in items.".into());
    }
    first_clip_fade(paired[0].1)?;
    let mut wanted: Vec<Placement> = paired
        .into_iter()
        .enumerate()
        .map(|(k, (mut p, own))| {
            let secs = own.or(spec.crossfade_secs).unwrap_or(0.0).clamp(0.0, 3.0);
            if k > 0 && secs > 0.0 {
                p.mix_in = Some(doc.fps().frames(secs));
            }
            p
        })
        .collect();
    let normalize = spec.normalize.unwrap_or(true);
    let episode_dir = resolve_episode(working_dir, episode)?;
    if normalize {
        notes.push(normalize_gains(&doc, &mut wanted, &ffmpeg, &episode_dir).await?);
    }
    let audio = match &spec.audio {
        Some(list) => Some(audio_placements(&doc, working_dir, list, settings, &ffprobe).await?),
        None => None,
    };
    let text = edit_text(
        &doc,
        &wanted,
        audio,
        normalize.then_some((ffmpeg.as_str(), episode_dir.as_path())),
        &mut notes,
    )
    .await?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    }
    format::save(&path, &text, &melt).await?;
    let rel = display_path(working_dir, &path);
    if let Ok(dir) = resolve_episode(working_dir, episode) {
        write_state(&dir, &rel);
    }
    let after = ProjectDoc::open(&path)?;
    Ok(CutResult {
        summary: after.summary(working_dir, &path),
        notes,
        created,
    })
}

/// One small change to the main track.
pub async fn op(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
    op: ProjectOp,
    settings: &VideoSettings,
) -> Result<CutResult, String> {
    let (_, melt, ffmpeg) = tools(settings).await?;
    let path = default_project(working_dir, episode, project, None)?;
    let doc = ProjectDoc::open(&path)?;
    let mut wanted = doc.current();
    let items = doc.clips();
    let min_piece = doc.fps().frames(MIN_PIECE_SECS).max(1);
    let mut notes = Vec::new();
    let count = wanted.len() as u32;
    let normalizing = matches!(op, ProjectOp::Normalize);
    let check = |i: u32| {
        if i == 0 || i > count {
            Err(format!("There is no clip {i}; the cut has {count}."))
        } else {
            Ok(i as usize - 1)
        }
    };
    match op {
        ProjectOp::Trim {
            index,
            in_secs,
            out_secs,
            in_frame,
            out_frame,
        } => {
            let i = check(index)?;
            let (a, b) = trim_frames(&doc.fps(), (in_secs, out_secs), (in_frame, out_frame))?;
            if a.is_some() {
                wanted[i].in_frame = a;
            }
            if b.is_some() {
                wanted[i].out_frame = b;
            }
        }
        ProjectOp::GainRange {
            index,
            from_secs,
            to_secs,
            gain_db,
        } => {
            let i = check(index)?;
            let r = RangeSpec {
                from_secs,
                to_secs,
                gain_db,
            }
            .frames(&doc.fps())?;
            wanted[i].gain_ranges = Some(with_range(items[i].gain_ranges.clone(), r));
        }
        ProjectOp::ClearGainRanges { index } => {
            let i = check(index)?;
            wanted[i].gain_ranges = Some(Vec::new());
        }
        ProjectOp::Fit { index, fit } => {
            let i = check(index)?;
            if let Some(problem) = fit.problem() {
                return Err(problem);
            }
            wanted[i].fit = Some(fit);
        }
        ProjectOp::Remove { index } => {
            wanted.remove(check(index)?);
        }
        ProjectOp::Move { from, to } => {
            let from = check(from)?;
            let to = check(to)?;
            let p = wanted.remove(from);
            wanted.insert(to, p);
        }
        ProjectOp::RemoveRanges { index, ranges } => {
            let i = check(index)?;
            let e = &items[i];
            let frames: Vec<(i64, i64)> = ranges
                .iter()
                .map(|r| (doc.fps().frames(r.start), doc.fps().frames(r.end)))
                .collect();
            let removed = cut_ranges(
                &mut wanted,
                i,
                i,
                e.in_frame,
                e.out_frame,
                &frames,
                min_piece,
            );
            notes.push(format!(
                "Removed {} from clip {index}.",
                format_secs(doc.fps().secs(removed))
            ));
        }
        ProjectOp::Normalize => {
            let episode_dir = resolve_episode(working_dir, episode)?;
            notes.push(normalize_gains(&doc, &mut wanted, &ffmpeg, &episode_dir).await?);
        }
        ProjectOp::RemoveSilences {
            index,
            min_secs,
            pad_secs,
        } => {
            let found = binaries::resolve(&settings.overrides).await;
            let ffmpeg = found.require(Tool::Ffmpeg)?.to_string();
            let targets: Vec<usize> = match index {
                Some(n) => vec![check(n)?],
                None => (0..items.len()).collect(),
            };
            let spans = doc.spans();
            let mut total = 0;
            let mut cut_count = 0;
            // From the last, so earlier positions in `wanted` stay put.
            for &i in targets.iter().rev() {
                let e = &items[i];
                if e.audio.is_none() {
                    continue;
                }
                let span = &spans[i];
                let found = super::silence::detect(
                    &ffmpeg,
                    &span.file,
                    -35.0,
                    min_secs.max(0.3),
                    Some((span.source_in, span.source_out)),
                )
                .await?;
                let pad = pad_secs.max(0.0);
                let frames: Vec<(i64, i64)> = found
                    .iter()
                    .filter(|r| r.len() > 2.0 * pad)
                    .map(|r| {
                        (
                            doc.fps().frames(r.start + pad),
                            doc.fps().frames(r.end - pad),
                        )
                    })
                    .collect();
                cut_count += frames.len();
                total += cut_ranges(
                    &mut wanted,
                    i,
                    i,
                    e.in_frame,
                    e.out_frame,
                    &frames,
                    min_piece,
                );
            }
            notes.push(format!(
                "Cut {cut_count} silence{} longer than {min_secs} s, {} in all.",
                if cut_count == 1 { "" } else { "s" },
                format_secs(doc.fps().secs(total))
            ));
        }
    }
    let episode_dir = resolve_episode(working_dir, episode)?;
    // Normalising measures the audio tracks too; other ops move them with
    // the clips they start over.
    let (audio, measure) = if normalizing {
        (
            Some(current_audio(&doc.audio_clips())),
            Some((ffmpeg.as_str(), episode_dir.as_path())),
        )
    } else {
        (None, None)
    };
    let text = edit_text(&doc, &wanted, audio, measure, &mut notes).await?;
    format::save(&path, &text, &melt).await?;
    let after = ProjectDoc::open(&path)?;
    Ok(CutResult {
        summary: after.summary(working_dir, &path),
        notes,
        created: false,
    })
}

pub fn summary(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
) -> Result<ProjectSummary, String> {
    let path = default_project(working_dir, episode, project, None)?;
    let doc = ProjectDoc::open(&path)?;
    Ok(doc.summary(working_dir, &path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use std::fs;

    fn series() -> crate::test_util::TestDir {
        let dir = temp_dir("video_project");
        fs::create_dir_all(dir.join("ep010/raw")).unwrap();
        fs::create_dir_all(dir.join("ep011")).unwrap();
        dir
    }

    #[test]
    fn frame_trims_win_over_seconds_and_are_checked() {
        let fps = super::super::mlt::fps::Fps { num: 24, den: 1 };
        // One frame off the start; the end stays as the seconds say.
        assert_eq!(
            trim_frames(&fps, (Some(0.0), Some(2.0)), (Some(1), None)).unwrap(),
            (Some(1), Some(47))
        );
        assert_eq!(
            trim_frames(&fps, (None, None), (None, Some(95))).unwrap(),
            (None, Some(95))
        );
        assert!(trim_frames(&fps, (None, None), (Some(-1), None)).is_err());
        assert!(trim_frames(&fps, (None, None), (Some(10), Some(9))).is_err());
    }

    #[test]
    fn the_series_project_named_by_number_is_found() {
        let dir = series();
        fs::write(dir.join("spronglehump_010.kdenlive"), "").unwrap();
        fs::write(dir.join("spronglehump_009.kdenlive"), "").unwrap();
        let wd = dir.to_string_lossy();
        let p = default_project(&wd, "ep010", None, None).unwrap();
        assert!(p.ends_with("spronglehump_010.kdenlive"));
        // ep011 has none, so a new one is made in its folder.
        let p = default_project(&wd, "ep011", None, Some(format::Format::Kdenlive)).unwrap();
        assert!(p.ends_with("ep011/ep011.kdenlive"));
        assert!(default_project(&wd, "ep011", None, None)
            .unwrap_err()
            .contains("video_cut"));
    }

    #[test]
    fn one_in_the_episode_wins_and_two_must_be_named() {
        let dir = series();
        let wd = dir.to_string_lossy();
        fs::write(dir.join("ep010/a.kdenlive"), "").unwrap();
        assert!(default_project(&wd, "ep010", None, None)
            .unwrap()
            .ends_with("a.kdenlive"));
        fs::write(dir.join("ep010/b.kdenlive"), "").unwrap();
        let err = default_project(&wd, "ep010", None, None).unwrap_err();
        assert!(
            err.contains("ep010/a.kdenlive") && err.contains("ep010/b.kdenlive"),
            "{err}"
        );
        // The last cut's choice settles it.
        write_state(&dir.join("ep010"), "ep010/b.kdenlive");
        assert!(default_project(&wd, "ep010", None, None)
            .unwrap()
            .ends_with("b.kdenlive"));
    }

    fn shotcut_text() -> String {
        fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/video/shotcut/fixtures/edited-26.6.mlt"),
        )
        .unwrap()
    }

    #[test]
    fn shotcut_projects_are_found_and_made_in_the_chosen_editor() {
        let dir = series();
        let wd = dir.to_string_lossy();
        // A playlist Shotcut saved as .mlt is not a project.
        fs::write(dir.join("ep010/playlist.mlt"), "<mlt/>").unwrap();
        fs::write(dir.join("ep010/ep010.mlt"), shotcut_text()).unwrap();
        assert!(default_project(&wd, "ep010", None, None)
            .unwrap()
            .ends_with("ep010/ep010.mlt"));
        // Both editors' projects in one episode: the tools ask which.
        fs::write(dir.join("ep010/ep010.kdenlive"), "").unwrap();
        let err = default_project(&wd, "ep010", None, None).unwrap_err();
        assert!(
            err.contains("ep010.mlt") && err.contains("ep010.kdenlive"),
            "{err}"
        );
        // A new project takes the editor's extension.
        let p = default_project(&wd, "ep011", None, Some(format::Format::Shotcut)).unwrap();
        assert!(p.ends_with("ep011/ep011.mlt"));
        let p = default_project(&wd, "ep011", None, Some(format::Format::Kdenlive)).unwrap();
        assert!(p.ends_with("ep011/ep011.kdenlive"));
        // Named, by number, in the working folder.
        fs::write(dir.join("show_012.mlt"), shotcut_text()).unwrap();
        fs::create_dir_all(dir.join("ep012")).unwrap();
        assert!(default_project(&wd, "ep012", None, None)
            .unwrap()
            .ends_with("show_012.mlt"));
        assert!(default_project(&wd, "ep010", Some("ep010/ep010.mlt"), None).is_ok());
    }

    #[test]
    fn a_named_project_must_be_a_project_and_inside() {
        let dir = series();
        let wd = dir.to_string_lossy();
        assert!(default_project(
            &wd,
            "ep010",
            Some("notes.txt"),
            Some(format::Format::Shotcut)
        )
        .is_err());
        assert!(default_project(
            &wd,
            "ep010",
            Some("../x.kdenlive"),
            Some(format::Format::Shotcut)
        )
        .is_err());
    }

    #[test]
    fn cutting_ranges_leaves_pieces_and_keeps_the_first_as_the_item() {
        let mut wanted = vec![
            Placement {
                source: Source::Existing(0),
                in_frame: None,
                out_frame: None,
                mix_in: None,
                gain_db: None,
                limiter: false,
                fit: None,
                gain_ranges: None,
            },
            Placement {
                source: Source::Existing(1),
                in_frame: None,
                out_frame: None,
                mix_in: None,
                gain_db: None,
                limiter: false,
                fit: None,
                gain_ranges: None,
            },
        ];
        // Item 1 shows 0–599; cut 100–199 and 400–404 (too short a piece after it? no).
        let removed = cut_ranges(&mut wanted, 1, 1, 0, 599, &[(100, 200), (400, 405)], 6);
        assert_eq!(removed, 105);
        let got: Vec<(bool, i64, i64)> = wanted[1..]
            .iter()
            .map(|p| {
                (
                    matches!(p.source, Source::Existing(1)),
                    p.in_frame.unwrap(),
                    p.out_frame.unwrap(),
                )
            })
            .collect();
        assert_eq!(got, [(true, 0, 99), (false, 200, 399), (false, 405, 599)]);
        assert!(matches!(wanted[2].source, Source::Piece(1)));
        // A sliver shorter than the minimum goes with its gap.
        let mut w = vec![Placement {
            source: Source::Existing(0),
            in_frame: None,
            out_frame: None,
            mix_in: None,
            gain_db: None,
            limiter: false,
            fit: None,
            gain_ranges: None,
        }];
        let removed = cut_ranges(&mut w, 0, 0, 0, 99, &[(10, 97)], 6);
        assert_eq!((w.len(), removed), (1, 90));
    }

    #[test]
    fn a_crossfade_into_the_first_clip_is_refused() {
        assert!(first_clip_fade(None).is_ok());
        assert!(first_clip_fade(Some(0.0)).is_ok());
        let e = first_clip_fade(Some(1.0)).unwrap_err();
        assert!(e.contains("on the clip after the join"));
    }

    #[test]
    fn an_episodes_files_go_beside_its_project_when_no_episode_is_named() {
        let dir = series();
        let wd = dir.to_string_lossy();
        let project = dir.join("ep010/ep010.kdenlive");
        assert!(episode_home(&wd, "", &project).unwrap().ends_with("ep010"));
        assert!(episode_home(&wd, "ep011", &project)
            .unwrap()
            .ends_with("ep011"));
        // A series-folder project with no episode named: the series folder.
        let top = dir.join("show_010.kdenlive");
        assert_eq!(episode_home(&wd, "", &top).unwrap(), dir.to_path_buf());
    }

    #[test]
    fn an_empty_intro_setting_is_an_error_naming_settings() {
        let err = end_clip_path(&EndClip::Settings(true), "", "intro").unwrap_err();
        assert!(err.contains("Settings → Video editing"));
        assert_eq!(
            end_clip_path(&EndClip::Settings(false), "x", "intro").unwrap(),
            None
        );
        assert_eq!(
            end_clip_path(&EndClip::Path("i.mp4".into()), "", "intro").unwrap(),
            Some("i.mp4")
        );
    }

    #[test]
    fn resources_are_relative_to_the_root_when_inside() {
        let dir = series();
        fs::write(dir.join("ep010/raw/a.mp4"), "").unwrap();
        let root = dir.to_string_lossy();
        assert_eq!(
            resource_for(&root, &dir.join("ep010/raw/a.mp4")),
            "ep010/raw/a.mp4"
        );
        let outside = temp_dir("video_outside_res");
        fs::write(outside.join("i.mp4"), "").unwrap();
        assert!(resource_for(&root, &outside.join("i.mp4")).starts_with('/') || cfg!(windows));
    }

    #[test]
    fn a_clip_number_past_the_cut_is_refused() {
        assert_eq!(existing_index(0, 2, 2), Ok(1));
        let none = existing_index(0, 2, 0).unwrap_err();
        assert!(none.contains("no clips yet"), "{none}");
        let past = existing_index(1, 3, 2).unwrap_err();
        assert!(
            past.starts_with("Item 2 names clip 3, but the cut has 2."),
            "{past}"
        );
    }

    /// Audio-track items move with the main-track clip they start over when
    /// a stretch of it is cut out or it goes, in both formats alike.
    #[tokio::test]
    async fn audio_items_follow_the_clip_they_start_over() {
        let mut results = Vec::new();
        for f in format::Format::ALL {
            let doc = ProjectDoc::template(f, "1080p30", Path::new("/videos")).unwrap();
            let fps = doc.fps();
            let m = |r: &str, secs: f64, video: bool| Media {
                resource: r.into(),
                length: fps.frames(secs),
                video_index: video.then_some(0),
                audio_index: Some(1),
                file_size: 1,
                file_hash: "0".repeat(32),
            };
            let main = vec![
                Placement::of(Source::New(m("a.mp4", 10.0, true))),
                Placement::of(Source::New(m("b.mp4", 8.0, true))),
            ];
            let under = |r: &str, secs: f64, at: f64| AudioPlacement {
                source: AudioSource::New(m(r, secs, false)),
                at: fps.frames(at),
                in_frame: None,
                out_frame: None,
                track: 0,
                gain_db: None,
                limiter: false,
                lufs: None,
            };
            let mut notes = Vec::new();
            let audio = vec![under("voice.wav", 4.0, 12.0), under("tag.wav", 1.0, 3.0)];
            let text = edit_text(&doc, &main, Some(audio), None, &mut notes)
                .await
                .unwrap();
            let doc = doc.reparse(text).unwrap();
            let starts = |d: &ProjectDoc| -> Vec<(String, f64)> {
                d.audio_clips()
                    .iter()
                    .map(|c| (c.resource.clone(), d.fps().secs(c.start)))
                    .collect()
            };
            let placed = starts(&doc);
            // Cut 1–2 s out of a.mp4.
            let mut wanted = doc.current();
            cut_ranges(
                &mut wanted,
                0,
                0,
                0,
                fps.frames(10.0) - 1,
                &[(fps.frames(1.0), fps.frames(2.0))],
                6,
            );
            let text = edit_text(&doc, &wanted, None, None, &mut notes)
                .await
                .unwrap();
            let doc = doc.reparse(text).unwrap();
            let after_cut = starts(&doc);
            // Remove both pieces of a.mp4: tag.wav goes to where b.mp4 now starts.
            let mut wanted = doc.current();
            wanted.drain(0..2);
            let text = edit_text(&doc, &wanted, None, None, &mut notes)
                .await
                .unwrap();
            let doc = doc.reparse(text).unwrap();
            results.push((placed, after_cut, starts(&doc), doc.sequence_end()));
        }
        assert_eq!(results[0], results[1]);
        let (placed, after_cut, after_remove, end) = &results[0];
        let s = |v: &Vec<(String, f64)>| -> Vec<(String, i64)> {
            v.iter()
                .map(|(r, t)| (r.clone(), (t * 10.0).round() as i64))
                .collect()
        };
        assert_eq!(
            s(placed),
            [("tag.wav".to_string(), 30), ("voice.wav".to_string(), 120)]
        );
        assert_eq!(
            s(after_cut),
            [("tag.wav".to_string(), 20), ("voice.wav".to_string(), 110)]
        );
        assert_eq!(
            s(after_remove),
            [("tag.wav".to_string(), 0), ("voice.wav".to_string(), 20)]
        );
        // b.mp4 is 8 s; the voice ends at 6 s, inside it.
        assert_eq!(*end, 240);
    }

    #[test]
    fn a_moment_cut_out_lands_on_the_next_piece_and_the_end_keeps_its_distance() {
        let old = [(0, 0, 299), (300, 0, 239)];
        // Clip 1 lost 30–59; clip 2 follows.
        let new = [(0, 0, 29), (30, 60, 299), (270, 0, 239)];
        let wanted = [
            Placement::of(Source::Existing(0)),
            Placement::of(Source::Piece(0)),
            Placement::of(Source::Existing(1)),
        ];
        assert_eq!(follow(10, &old, &new, &wanted), 10);
        assert_eq!(follow(45, &old, &new, &wanted), 30);
        assert_eq!(follow(100, &old, &new, &wanted), 70);
        assert_eq!(follow(330, &old, &new, &wanted), 300);
        // Past the end: as far past the new end.
        assert_eq!(follow(600, &old, &new, &wanted), 570);
    }

    /// A cut from generated clips into a new project, then an op, end to end
    /// with the real ffprobe and melt.
    #[tokio::test]
    #[ignore = "needs ffmpeg, ffprobe and melt"]
    async fn cut_and_trim_a_real_folder() {
        let dir = series();
        for (name, color) in [
            ("ep010/raw/a.mp4", "red"),
            ("ep010/raw/b.mp4", "blue"),
            ("intro001/intro.mp4", "white"),
        ] {
            let p = dir.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            let ok = crate::test_util::host_command("ffmpeg")
                .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
                .arg(format!("color=c={color}:s=640x360:r=60:d=3"))
                .args(["-f", "lavfi", "-i", "sine=d=3", "-shortest"])
                .arg(&p)
                .status()
                .unwrap()
                .success();
            assert!(ok);
        }
        let wd = dir.to_string_lossy().into_owned();
        let settings = VideoSettings {
            preset: "1080p60".into(),
            ..Default::default()
        };
        // Clip numbers before there is a cut: refused, where the loudness
        // pass once panicked on them and left the tool call waiting forever.
        let by_number = CutSpec {
            items: vec![CutItemSpec {
                index: Some(1),
                ..Default::default()
            }],
            ..Default::default()
        };
        let err = cut(&wd, "ep010", by_number, &settings).await.unwrap_err();
        assert!(err.contains("no clips yet"), "{err}");
        let spec = CutSpec {
            intro: Some(EndClip::Path("intro001/intro.mp4".into())),
            items: vec![
                CutItemSpec {
                    path: Some("ep010/raw/a.mp4".into()),
                    in_secs: Some(1.0),
                    ..Default::default()
                },
                CutItemSpec {
                    path: Some("ep010/raw/b.mp4".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let r = cut(&wd, "ep010", spec, &settings).await.unwrap();
        assert!(r.created);
        assert_eq!(r.summary.project, "ep010/ep010.kdenlive");
        let paths: Vec<&str> = r.summary.items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(
            paths,
            ["intro001/intro.mp4", "ep010/raw/a.mp4", "ep010/raw/b.mp4"]
        );
        assert!(
            (r.summary.total_secs - 8.0).abs() < 0.05,
            "{}",
            r.summary.total_secs
        );
        let r = op(
            &wd,
            "ep010",
            None,
            ProjectOp::Remove { index: 2 },
            &settings,
        )
        .await
        .unwrap();
        assert_eq!(r.summary.items.len(), 2);
        assert!(
            dir.join("ep010/.haruspex/backups")
                .read_dir()
                .unwrap()
                .count()
                >= 1
        );
        println!("{}", dir.join("ep010/ep010.kdenlive").display());
    }
}

#[cfg(test)]
mod loudness_end_to_end {
    use super::*;

    /// Clips at very different levels, cut with a crossfade and evened out,
    /// render at YouTube's loudness.
    /// `cargo test -- --ignored a_normalised_cut_renders_at_minus_14 --nocapture`
    #[tokio::test]
    #[ignore = "needs ffmpeg, ffprobe and melt"]
    async fn a_normalised_cut_renders_at_minus_14() {
        let dir = crate::test_util::temp_dir("normalised_cut");
        std::fs::create_dir_all(dir.join("ep1")).unwrap();
        for (name, volume) in [("ep1/quiet.mp4", "0.05"), ("ep1/loud.mp4", "0.9")] {
            let ok = crate::test_util::host_command("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=s=640x360:r=30:d=5",
                    "-f",
                    "lavfi",
                    "-i",
                ])
                .arg(format!("sine=f=330:d=5,volume={volume}"))
                .args(["-ac", "2", "-shortest"])
                .arg(dir.join(name))
                .status()
                .unwrap()
                .success();
            assert!(ok);
        }
        let wd = dir.to_string_lossy().into_owned();
        let settings = VideoSettings {
            preset: "1080p30".into(),
            ..Default::default()
        };
        let spec = CutSpec {
            items: vec![
                CutItemSpec {
                    path: Some("ep1/quiet.mp4".into()),
                    ..Default::default()
                },
                CutItemSpec {
                    path: Some("ep1/loud.mp4".into()),
                    ..Default::default()
                },
            ],
            crossfade_secs: Some(1.0),
            ..Default::default()
        };
        let r = cut(&wd, "ep1", spec, &settings).await.unwrap();
        println!("{:?}\n{:#?}", r.notes, r.summary.items);
        assert!(r.summary.items[1]
            .crossfade_in_secs
            .is_some_and(|c| (c - 1.0).abs() < 0.05));
        assert!(r.summary.items.iter().all(|i| i.gain_db.is_some()));
        let out = dir.join("out.mp4");
        let ok = crate::test_util::host_command("melt")
            .arg(dir.join("ep1/ep1.kdenlive"))
            .arg("-consumer")
            .arg(format!("avformat:{}", out.display()))
            .args(["vcodec=libx264", "acodec=aac", "ab=192k"])
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let l = crate::video::check::measure("ffmpeg", &out).await.unwrap();
        println!("render: {l:?}");
        assert!((l.lufs + 14.0).abs() <= 1.0, "{l:?}");
        assert!(l.true_peak_db.unwrap_or(-99.0) <= -0.9, "{l:?}");
        // Asking again changes nothing.
        let again = op(&wd, "ep1", None, ProjectOp::Normalize, &settings)
            .await
            .unwrap();
        assert_eq!(again.summary.items, r.summary.items);
    }
}
