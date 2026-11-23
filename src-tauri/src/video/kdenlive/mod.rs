//! Reading and editing Kdenlive projects that the user also edits in Kdenlive.
//!
//! The rules (see `plan/video-editing/phase-02-kdenlive-project.md`):
//!
//! - Haruspex edits the main track (V1 with A1) and nothing else. Other
//!   tracks, effects, guides, mixes made in Kdenlive and every property it
//!   doesn't know are kept byte for byte; a no-op edit writes the file back
//!   unchanged.
//! - Every edit reads the file fresh, so a save the user just made in Kdenlive
//!   is what gets edited.
//! - Before writing, the old file is copied to `.haruspex/backups/`; after
//!   writing, melt must load the result, or the backup goes back.
//! - Only document version 1.1 (Kdenlive 25.04–26.08) is edited.

pub mod audio;
pub mod doc;
pub mod edit;
pub mod timeline_map;

#[cfg(test)]
mod tests;

use crate::video::format::{OtherClip, ProjectSummary, SummaryItem};
use crate::video::mlt::profile::{profile, profile_tag};
pub use crate::video::mlt::project_file::{file_hash, save};
use crate::video::mlt::{mlt_path, xml};
use doc::Doc;
use std::path::Path;

/// An empty project saved by Kdenlive 26.08.2: two audio and two video tracks,
/// with placeholders for the profile and the ids.
const TEMPLATE: &str = include_str!("../../../resources/video/empty-26.08.kdenlive");

/// A new, empty project.
pub fn template_text(preset: &str, root: &Path) -> Result<String, String> {
    let p = profile(preset)?;
    let uuid = format!("{{{}}}", uuid::Uuid::new_v4());
    let session = format!("{{{}}}", uuid::Uuid::new_v4());
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    Ok(TEMPLATE
        .replace("{{PROFILE}}", &profile_tag(&p))
        .replace("{{PROFILE_NAME}}", p.name)
        .replace("{{ROOT}}", &xml::escape(&mlt_path(root)))
        .replace("{{DOC_UUID}}", &uuid)
        .replace("{{SESSION_UUID}}", &session)
        .replace("{{DOCUMENT_ID}}", &id.to_string()))
}

/// Change an existing project's profile to a preset's.
pub fn set_profile(doc: &Doc, preset: &str) -> Result<String, String> {
    let p = profile(preset)?;
    let mut splices = xml::Splices::default();
    let node = doc
        .tree
        .children_named(doc.tree.root, "profile")
        .next()
        .ok_or("the project has no profile")?;
    splices.replace(doc.tree.node(node).span.clone(), profile_tag(&p));
    if let Some(prop) = doc
        .tree
        .property_node(doc.bin, "kdenlive:docproperties.profile")
    {
        splices.replace(
            doc.tree.node(prop).span.clone(),
            format!(
                "<property name=\"kdenlive:docproperties.profile\">{}</property>",
                p.name
            ),
        );
    }
    splices.apply(&doc.text)
}

pub fn open(path: &Path) -> Result<Doc, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    Doc::parse(text)
}

fn track_name(doc: &Doc, track: usize) -> String {
    if doc.tracks[track].audio {
        format!("A{}", doc.main_audio as i64 - track as i64 + 1)
    } else {
        format!("V{}", track as i64 - doc.main_video as i64 + 1)
    }
}

/// A resource as the user knows it: relative to the working folder when inside.
fn shown_resource(doc: &Doc, working_dir: &str, resource: &str) -> String {
    let p = Path::new(resource);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(&doc.root_dir).join(p)
    };
    super::paths::display_path(working_dir, &abs)
}

fn resource_of(doc: &Doc, chain: &str) -> String {
    doc.tree
        .by_id(chain)
        .and_then(|c| doc.tree.property(c, "resource"))
        .unwrap_or("")
        .to_string()
}

pub fn summary(doc: &Doc, working_dir: &str, project: &Path) -> ProjectSummary {
    let fps = doc.fps;
    let all = doc.items();
    let items = all
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let e = item.any();
            let overlap = if i > 0 {
                all[i - 1].end() - item.start()
            } else {
                0
            };
            SummaryItem {
                index: i as u32 + 1,
                path: shown_resource(doc, working_dir, &resource_of(doc, &e.chain)),
                source_in_secs: fps.secs(e.in_frame),
                source_out_secs: fps.secs(e.out_frame + 1),
                start_secs: fps.secs(e.start),
                duration_secs: fps.secs(e.len()),
                effects: item.filters() as u32,
                has_video: item.video.is_some(),
                has_audio: item.audio.is_some(),
                crossfade_in_secs: (overlap > 0).then(|| fps.secs(overlap)),
                gain_db: item
                    .audio
                    .as_ref()
                    .and_then(|a| doc.our_gain(a.node))
                    .map(|(_, g)| g),
                limited: item.audio.as_ref().is_some_and(|a| doc.our_limiter(a.node)),
                fit: item.video.as_ref().and_then(|v| doc.our_fit(v.node)),
            }
        })
        .collect();
    let mut other_clips = Vec::new();
    let overlay = doc.audio_tracks();
    for t in 0..doc.tracks.len() {
        if t == doc.main_video || t == doc.main_audio || overlay.contains(&t) {
            continue;
        }
        for e in doc.track_entries(t) {
            other_clips.push(OtherClip {
                track: track_name(doc, t),
                path: shown_resource(doc, working_dir, &resource_of(doc, &e.chain)),
                start_secs: fps.secs(e.start),
                end_secs: fps.secs(e.end()),
            });
        }
    }
    let guides = doc
        .tree
        .property(doc.sequence, "kdenlive:sequenceproperties.guides")
        .and_then(|g| serde_json::from_str::<serde_json::Value>(g).ok())
        .and_then(|g| g.as_array().map(Vec::len))
        .unwrap_or(0) as u32;
    ProjectSummary {
        project: super::paths::display_path(working_dir, project),
        width: doc.width,
        height: doc.height,
        fps: fps.num as f64 / fps.den as f64,
        editor: crate::video::format::Format::Kdenlive,
        editor_version: doc.kdenlive_version.clone(),
        read_only: doc.editable().err(),
        items,
        audio: crate::video::format::AudioItem::from_clips(&audio::clips(doc), fps, |r| {
            shown_resource(doc, working_dir, r)
        }),
        other_clips,
        // A crossfade is a mix on each of the picture and sound tracks: count joins.
        mixes: {
            let mut joins: Vec<i64> = [doc.main_video, doc.main_audio]
                .iter()
                .flat_map(|&t| doc.mixes(t))
                .map(|m| m.in_frame)
                .collect();
            joins.sort();
            joins.dedup();
            joins.len() as u32
        },
        guides,
        total_secs: fps.secs(doc.sequence_end()),
    }
}

/// The main track's clips, for the tools that measure or cut them.
pub fn clips(doc: &Doc) -> Vec<crate::video::timeline::Clip> {
    use crate::video::timeline::{Clip, ClipAudio};
    doc.items()
        .iter()
        .map(|item| {
            let e = item.any();
            Clip {
                resource: resource_of(doc, &e.chain),
                in_frame: e.in_frame,
                out_frame: e.out_frame,
                audio: item.audio.as_ref().map(|a| ClipAudio {
                    stream: doc
                        .tree
                        .by_id(&a.chain)
                        .and_then(|c| doc.tree.property(c, "audio_index"))
                        .and_then(|v| v.parse::<u32>().ok())
                        .unwrap_or(1),
                    in_frame: a.in_frame,
                    out_frame: a.out_frame,
                }),
            }
        })
        .collect()
}

/// The files on tracks other than the main one.
pub fn other_track_resources(doc: &Doc) -> Vec<String> {
    let overlay = doc.audio_tracks();
    (0..doc.tracks.len())
        .filter(|&t| t != doc.main_video && t != doc.main_audio && !overlay.contains(&t))
        .flat_map(|t| doc.track_entries(t))
        .filter_map(|e| {
            doc.tree
                .by_id(&e.chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .map(str::to_string)
        })
        .collect()
}
