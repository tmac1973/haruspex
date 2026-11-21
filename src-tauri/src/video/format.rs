//! Which editor a project is for, and the one interface the video tools read
//! and edit a project through. Each editor's format lives in its own module
//! (`kdenlive`, `shotcut`); this dispatches to it.

use super::kdenlive::{self, doc::Doc as KdenliveDoc};
use super::mlt::fps::Fps;
use super::shotcut::{self, doc::Doc as ShotcutDoc};
use super::timeline::{Clip, Edited, Placement, Span};
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

    /// The files on tracks other than the main one.
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
    use crate::video::timeline::{Media, Source};

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
        // And what it is: c (4.5 dB, limited) leads, no crossfade into it.
        let (_, _, clips, gains, fades, total, _, _) = &results[0];
        assert_eq!(clips.len(), 4);
        assert_eq!(gains[0], (Some(4.5), true));
        assert_eq!(fades[0], None);
        assert!(*total > 0.0);
    }
}
