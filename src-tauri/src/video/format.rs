//! Which editor a project is for, and the one interface the video tools read
//! and edit a project through. Each editor's format lives in its own module
//! (`kdenlive`, `shotcut`); this dispatches to it.

use super::kdenlive::{self, doc::Doc as KdenliveDoc};
use super::mlt::fps::Fps;
use super::shotcut::{self, doc::Doc as ShotcutDoc};
use super::timeline::{AudioClip, AudioPlacement, Clip, Edited, Placement, Span};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The editor a project is made for. Shotcut is the default for new ones.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    #[default]
    Shotcut,
    Kdenlive,
}

impl Format {
    pub const ALL: [Format; 2] = [Format::Shotcut, Format::Kdenlive];

    /// The project file's extension, without the dot.
    pub fn extension(self) -> &'static str {
        match self {
            Format::Shotcut => "mlt",
            Format::Kdenlive => "kdenlive",
        }
    }

    /// The editor's name, as the user knows it.
    pub fn name(self) -> &'static str {
        match self {
            Format::Shotcut => "Shotcut",
            Format::Kdenlive => "Kdenlive",
        }
    }

    /// The format a project file is in, by its extension.
    pub fn from_path(path: &Path) -> Option<Format> {
        let ext = path.extension()?.to_str()?;
        Format::ALL
            .into_iter()
            .find(|f| f.extension().eq_ignore_ascii_case(ext))
    }
}

/// A project, read.
pub enum ProjectDoc {
    Shotcut(ShotcutDoc),
    Kdenlive(KdenliveDoc),
}

fn not_a_project(path: &Path) -> String {
    let names: Vec<String> = Format::ALL
        .iter()
        .map(|f| format!("{} (.{})", f.name(), f.extension()))
        .collect();
    format!(
        "{} is not a project: use a {} file.",
        path.display(),
        names.join(" or ")
    )
}

impl ProjectDoc {
    pub fn open(path: &Path) -> Result<ProjectDoc, String> {
        match Format::from_path(path) {
            Some(Format::Shotcut) => Ok(ProjectDoc::Shotcut(shotcut::open(path)?)),
            Some(Format::Kdenlive) => Ok(ProjectDoc::Kdenlive(kdenlive::open(path)?)),
            None => Err(not_a_project(path)),
        }
    }

    /// A new, empty project in `format` at a preset, rooted at `root`.
    pub fn template(format: Format, preset: &str, root: &Path) -> Result<ProjectDoc, String> {
        match format {
            Format::Shotcut => Ok(ProjectDoc::Shotcut(ShotcutDoc::parse(
                shotcut::template_text(preset, root)?,
                None,
            )?)),
            Format::Kdenlive => Ok(ProjectDoc::Kdenlive(KdenliveDoc::parse(
                kdenlive::template_text(preset, root)?,
            )?)),
        }
    }

    pub fn format(&self) -> Format {
        match self {
            ProjectDoc::Shotcut(_) => Format::Shotcut,
            ProjectDoc::Kdenlive(_) => Format::Kdenlive,
        }
    }

    pub fn fps(&self) -> Fps {
        match self {
            ProjectDoc::Shotcut(d) => d.fps,
            ProjectDoc::Kdenlive(d) => d.fps,
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            ProjectDoc::Shotcut(d) => d.height,
            ProjectDoc::Kdenlive(d) => d.height,
        }
    }

    /// The folder relative resources are read from.
    pub fn root_dir(&self) -> &str {
        match self {
            ProjectDoc::Shotcut(d) => &d.root_dir,
            ProjectDoc::Kdenlive(d) => &d.root_dir,
        }
    }

    /// Where the timeline ends, in frames.
    pub fn sequence_end(&self) -> i64 {
        match self {
            ProjectDoc::Shotcut(d) => d.sequence_end(),
            ProjectDoc::Kdenlive(d) => d.sequence_end(),
        }
    }

    /// Why Haruspex can't edit it, when it can't.
    pub fn editable(&self) -> Result<(), String> {
        match self {
            ProjectDoc::Shotcut(d) => d.editable(),
            ProjectDoc::Kdenlive(d) => d.editable(),
        }
    }

    /// The same project at another preset's profile.
    pub fn with_profile(&self, preset: &str) -> Result<ProjectDoc, String> {
        match self {
            ProjectDoc::Shotcut(d) => {
                let mut changed = ShotcutDoc::parse(shotcut::set_profile(d, preset)?, None)?;
                changed.root_dir = d.root_dir.clone();
                Ok(ProjectDoc::Shotcut(changed))
            }
            ProjectDoc::Kdenlive(d) => Ok(ProjectDoc::Kdenlive(KdenliveDoc::parse(
                kdenlive::set_profile(d, preset)?,
            )?)),
        }
    }

    /// The main track as placements: applying them changes nothing.
    pub fn current(&self) -> Vec<Placement> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::edit::current(d),
            ProjectDoc::Kdenlive(d) => kdenlive::edit::current(d),
        }
    }

    /// The project's text with the main track made `wanted`.
    pub fn apply(&self, wanted: &[Placement]) -> Result<Edited, String> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::edit::apply(d, wanted),
            ProjectDoc::Kdenlive(d) => kdenlive::edit::apply(d, wanted),
        }
    }

    /// The project's text with the audio tracks under the picture made
    /// `wanted`.
    pub fn apply_audio(&self, wanted: &[AudioPlacement]) -> Result<Edited, String> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::audio::apply(d, wanted),
            ProjectDoc::Kdenlive(d) => kdenlive::audio::apply(d, wanted),
        }
    }

    /// The clips on the audio tracks under the picture, in time order: the
    /// order the tools number them in.
    pub fn audio_clips(&self) -> Vec<AudioClip> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::audio::clips(d),
            ProjectDoc::Kdenlive(d) => kdenlive::audio::clips(d),
        }
    }

    /// How many audio tracks under the picture the project has.
    pub fn audio_track_count(&self) -> usize {
        match self {
            ProjectDoc::Shotcut(d) => d.audio_tracks().len(),
            ProjectDoc::Kdenlive(d) => d.audio_tracks().len(),
        }
    }

    /// The audio-track clips as spans, numbered as `audio_clips`.
    pub fn audio_spans(&self) -> Vec<Span> {
        super::timeline::audio_spans(&self.audio_clips(), self.root_dir(), self.fps())
    }

    /// The same project read from edited text.
    pub fn reparse(&self, text: String) -> Result<ProjectDoc, String> {
        match self {
            ProjectDoc::Shotcut(d) => {
                let mut changed = ShotcutDoc::parse(text, None)?;
                changed.root_dir = d.root_dir.clone();
                Ok(ProjectDoc::Shotcut(changed))
            }
            ProjectDoc::Kdenlive(_) => Ok(ProjectDoc::Kdenlive(KdenliveDoc::parse(text)?)),
        }
    }

    pub fn spans(&self) -> Vec<Span> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::timeline_map::spans(d),
            ProjectDoc::Kdenlive(d) => kdenlive::timeline_map::spans(d),
        }
    }

    pub fn clips(&self) -> Vec<Clip> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::clips(d),
            ProjectDoc::Kdenlive(d) => kdenlive::clips(d),
        }
    }

    /// The files on tracks other than the main one and the audio tracks.
    pub fn other_track_resources(&self) -> Vec<String> {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::other_track_resources(d),
            ProjectDoc::Kdenlive(d) => kdenlive::other_track_resources(d),
        }
    }

    pub fn summary(&self, working_dir: &str, project: &Path) -> ProjectSummary {
        match self {
            ProjectDoc::Shotcut(d) => shotcut::summary(d, working_dir, project),
            ProjectDoc::Kdenlive(d) => kdenlive::summary(d, working_dir, project),
        }
    }
}

/// Write `text` over `project`, in the project's own format: backed up first,
/// and checked by melt after.
pub async fn save(project: &Path, text: &str, melt: &str) -> Result<(), String> {
    match Format::from_path(project) {
        Some(Format::Shotcut) => shotcut::save(project, text, melt).await,
        Some(Format::Kdenlive) => kdenlive::save(project, text, melt).await,
        None => Err(not_a_project(project)),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SummaryItem {
    /// 1-based, as the tools number clips.
    pub index: u32,
    pub path: String,
    pub source_in_secs: f64,
    pub source_out_secs: f64,
    pub start_secs: f64,
    pub duration_secs: f64,
    /// Effects the user put on it.
    pub effects: u32,
    pub has_video: bool,
    pub has_audio: bool,
    /// How long it crossfades from the clip before.
    pub crossfade_in_secs: Option<f64>,
    /// The gain Haruspex set on its sound, in dB.
    pub gain_db: Option<f64>,
    /// Haruspex put a Limiter after the gain to hold its peaks.
    pub limited: bool,
    /// The fit Haruspex set on its picture; `None` is letterbox.
    pub fit: Option<crate::video::timeline::Fit>,
    /// Gains Haruspex set over stretches of its sound, in its own time.
    pub gain_ranges: Vec<SummaryRange>,
}

/// A gain range as the summary shows it: seconds in the clip's own time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRange {
    pub from_secs: f64,
    pub to_secs: f64,
    pub gain_db: f64,
}

impl SummaryRange {
    pub fn of(r: &crate::video::timeline::GainRange, fps: crate::video::mlt::fps::Fps) -> Self {
        SummaryRange {
            from_secs: fps.secs(r.from_frame),
            to_secs: fps.secs(r.to_frame + 1),
            gain_db: r.gain_db,
        }
    }
}

/// A sound on an audio track under the picture.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AudioItem {
    /// 1-based, in time order, as `video_cut`'s audio index names it.
    pub index: u32,
    /// "A1", "A2", as the editor shows it.
    pub track: String,
    pub path: String,
    pub start_secs: f64,
    pub duration_secs: f64,
    pub source_in_secs: f64,
    pub source_out_secs: f64,
    /// The gain Haruspex set on it, in dB.
    pub gain_db: Option<f64>,
    pub limited: bool,
    /// The loudness that gain aims at, when it isn't -14 LUFS.
    pub lufs: Option<f64>,
}

impl AudioItem {
    pub fn from_clips(
        clips: &[AudioClip],
        fps: Fps,
        shown: impl Fn(&str) -> String,
    ) -> Vec<AudioItem> {
        clips
            .iter()
            .enumerate()
            .map(|(i, c)| AudioItem {
                index: i as u32 + 1,
                track: c.track_name.clone(),
                path: shown(&c.resource),
                start_secs: fps.secs(c.start),
                duration_secs: fps.secs(c.len()),
                source_in_secs: fps.secs(c.in_frame),
                source_out_secs: fps.secs(c.out_frame + 1),
                gain_db: c.gain_db,
                limited: c.limited,
                lufs: c.lufs,
            })
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OtherClip {
    /// "V2", "A2".
    pub track: String,
    pub path: String,
    pub start_secs: f64,
    pub end_secs: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// Relative to the working folder.
    pub project: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// The editor the project is for, and the version that last saved it.
    pub editor: Format,
    pub editor_version: String,
    /// Why it can't be edited, when it can't.
    pub read_only: Option<String>,
    pub items: Vec<SummaryItem>,
    /// The audio tracks under the picture: voiceover, music.
    pub audio: Vec<AudioItem>,
    pub other_clips: Vec<OtherClip>,
    pub mixes: u32,
    pub guides: u32,
    pub total_secs: f64,
}

#[cfg(test)]
mod tests {
    //! The same edits on a Shotcut and a Kdenlive project read back the same:
    //! the tools above this layer can't tell the formats apart.
    use super::*;
    use crate::video::timeline::{current_audio, AudioSource, Media, Source};

    fn media(resource: &str, secs: f64, fps: Fps) -> Media {
        Media {
            resource: resource.into(),
            length: fps.frames(secs),
            video_index: Some(0),
            audio_index: Some(1),
            file_size: 1234,
            file_hash: "0".repeat(32),
        }
    }

    fn sound(resource: &str, secs: f64, fps: Fps) -> Media {
        Media {
            video_index: None,
            audio_index: Some(0),
            ..media(resource, secs, fps)
        }
    }

    fn under(m: Media, at: i64) -> AudioPlacement {
        AudioPlacement {
            source: AudioSource::New(m),
            at,
            in_frame: None,
            out_frame: None,
            track: 0,
            gain_db: None,
            limiter: false,
            lufs: None,
        }
    }

    type AudioShape = Vec<(
        String,
        String,
        i64,
        i64,
        i64,
        Option<f64>,
        bool,
        Option<f64>,
    )>;

    fn audio_shape(doc: &ProjectDoc) -> AudioShape {
        doc.audio_clips()
            .iter()
            .map(|c| {
                (
                    c.track_name.clone(),
                    c.resource.clone(),
                    c.start,
                    c.in_frame,
                    c.out_frame,
                    c.gain_db,
                    c.limited,
                    c.lufs,
                )
            })
            .collect()
    }

    fn after_text(doc: &ProjectDoc) -> &str {
        match doc {
            ProjectDoc::Shotcut(d) => &d.text,
            ProjectDoc::Kdenlive(d) => &d.text,
        }
    }

    /// Apply `wanted` to `doc` and read the result back.
    fn edit(doc: &ProjectDoc, wanted: &[Placement]) -> (ProjectDoc, Vec<String>) {
        let out = doc.apply(wanted).unwrap();
        let back = match doc.format() {
            Format::Shotcut => ProjectDoc::Shotcut(ShotcutDoc::parse(out.text, None).unwrap()),
            Format::Kdenlive => ProjectDoc::Kdenlive(KdenliveDoc::parse(out.text).unwrap()),
        };
        (back, out.notes)
    }

    fn shape(doc: &ProjectDoc) -> Vec<(String, i64, i64, String)> {
        doc.spans()
            .iter()
            .map(|s| {
                (
                    s.file.file_name().unwrap().to_string_lossy().into_owned(),
                    doc.fps().frames(s.start),
                    doc.fps().frames(s.source_in),
                    format!("{:.3}", s.source_out),
                )
            })
            .collect()
    }

    #[test]
    fn both_formats_agree_on_every_kind_of_edit() {
        let root = Path::new("/videos");
        let docs: Vec<ProjectDoc> = [Format::Shotcut, Format::Kdenlive]
            .iter()
            .map(|&f| ProjectDoc::template(f, "1080p30", root).unwrap())
            .collect();
        let fps = docs[0].fps();
        assert_eq!(fps, docs[1].fps());
        let mut results = Vec::new();
        for doc in &docs {
            // A cut: three clips, the first trimmed, crossfades into the last two.
            let mut wanted = vec![
                Placement::of(Source::New(media("a.mp4", 10.0, fps))),
                Placement::of(Source::New(media("b.mp4", 8.0, fps))),
                Placement::of(Source::New(media("c.mp4", 6.0, fps))),
            ];
            wanted[0].in_frame = Some(fps.frames(2.0));
            wanted[1].mix_in = Some(fps.frames(1.0));
            wanted[2].mix_in = Some(fps.frames(0.5));
            wanted[2].gain_db = Some(4.5);
            wanted[2].limiter = true;
            let (cut, _) = edit(doc, &wanted);
            let after_cut = shape(&cut);
            // Move the last first, trim the middle, split the first in two.
            let mut next = cut.current();
            let last = next.remove(2);
            next.insert(0, last);
            next[2].out_frame = Some(fps.frames(5.0));
            let mut piece = Placement::of(Source::Piece(0));
            piece.in_frame = Some(fps.frames(7.0));
            next[1].out_frame = Some(fps.frames(5.0) - 1);
            next.push(piece);
            let (moved, notes) = edit(&cut, &next);
            let clips: Vec<(i64, i64, bool)> = moved
                .clips()
                .iter()
                .map(|c| (c.in_frame, c.out_frame, c.audio.is_some()))
                .collect();
            let summary = moved.summary("/videos", Path::new("/videos/ep/ep.x"));
            let gains: Vec<(Option<f64>, bool)> = summary
                .items
                .iter()
                .map(|i| (i.gain_db, i.limited))
                .collect();
            let crossfades: Vec<Option<f64>> =
                summary.items.iter().map(|i| i.crossfade_in_secs).collect();
            results.push((
                after_cut,
                shape(&moved),
                clips,
                gains,
                crossfades,
                summary.total_secs,
                notes,
                moved.sequence_end(),
            ));
        }
        assert_eq!(results[0], results[1]);
        // And the audio tracks under the picture: a voiceover over the first
        // clip, a music bed later at -30 LUFS, then the voiceover trimmed and
        // moved, the bed dropped.
        let mut audio = Vec::new();
        for doc in &docs {
            let (cut, _) = edit(
                doc,
                &[Placement::of(Source::New(media("a.mp4", 10.0, fps)))],
            );
            let mut voice = under(sound("voice.wav", 6.0, fps), fps.frames(1.0));
            voice.gain_db = Some(3.0);
            voice.limiter = true;
            let mut bed = under(sound("bed.mp3", 3.0, fps), fps.frames(7.5));
            bed.gain_db = Some(-12.0);
            bed.lufs = Some(-30.0);
            let out = cut.apply_audio(&[voice, bed]).unwrap();
            let placed = cut.reparse(out.text).unwrap();
            let first = audio_shape(&placed);
            // Unchanged, it is written back byte for byte.
            let same = placed
                .apply_audio(&current_audio(&placed.audio_clips()))
                .unwrap();
            assert_eq!(same.text, after_text(&placed), "{:?}", doc.format());
            let mut moved = current_audio(&placed.audio_clips());
            moved.truncate(1);
            moved[0].at = fps.frames(2.0);
            moved[0].in_frame = Some(fps.frames(0.5));
            let out = placed.apply_audio(&moved).unwrap();
            let again = placed.reparse(out.text).unwrap();
            let summary = again.summary("/videos", Path::new("/videos/ep/ep.x"));
            audio.push((
                first,
                audio_shape(&again),
                summary.audio.len(),
                summary.other_clips.len(),
                summary.total_secs,
            ));
        }
        assert_eq!(audio[0].0[0].0, "A1");
        assert_eq!(audio[1].0[0].0, "A2");
        // Track names aside (Shotcut's first audio track is A1, Kdenlive's
        // above the main sound A2), the two agree.
        let without_names = |s: &AudioShape| -> Vec<_> {
            s.iter()
                .map(|x| (x.1.clone(), x.2, x.3, x.4, x.5, x.6, x.7))
                .collect()
        };
        assert_eq!(without_names(&audio[0].0), without_names(&audio[1].0));
        assert_eq!(without_names(&audio[0].1), without_names(&audio[1].1));
        assert_eq!(
            audio[0].2..=audio[0].4 as usize,
            audio[1].2..=audio[1].4 as usize
        );
        let first = &audio[0].0;
        assert_eq!((first[0].2, first[0].5, first[0].6), (30, Some(3.0), true));
        assert_eq!((first[1].2, first[1].7), (225, Some(-30.0)));
        let again = &audio[0].1;
        assert_eq!(again.len(), 1);
        assert_eq!((again[0].2, again[0].3), (60, 15));
        assert_eq!(audio[0].3, 0);
        // And what it is: c (4.5 dB, limited) leads, no crossfade into it.
        let (_, _, clips, gains, fades, total, _, _) = &results[0];
        assert_eq!(clips.len(), 4);
        assert_eq!(gains[0], (Some(4.5), true));
        assert_eq!(fades[0], None);
        assert!(*total > 0.0);
    }
}
