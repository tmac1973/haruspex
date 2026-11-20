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
