//! Reading and editing Shotcut projects (`.mlt`) that the user also edits in
//! Shotcut, under the same rules as Kdenlive projects (see `kdenlive`):
//!
//! - Haruspex edits the main track (V1) and nothing else. Other tracks,
//!   filters, markers, crossfades made in Shotcut and every property it doesn't
//!   know are kept byte for byte; a no-op edit writes the file back unchanged.
//! - Every edit reads the file fresh, so a save the user just made in Shotcut
//!   is what gets edited.
//! - Before writing, the old file is copied to `.haruspex/backups/`; after
//!   writing, melt must load the result, or the backup goes back.
//! - Projects in GPU processing mode (Movit) are refused: the bundled melt
//!   has no Movit.
//!
//! The format followed is Shotcut [`SHOTCUT_FIXTURE_VERSION`]'s, the newest
//! release when this was written; the fixtures in `fixtures/` follow it.

pub mod audio;
pub mod doc;
pub mod edit;
pub mod timeline_map;

#[cfg(test)]
mod tests;

use crate::video::format::{OtherClip, ProjectSummary, SummaryItem};
use crate::video::mlt::profile::{profile, profile_tag};
pub use crate::video::mlt::project_file::save;
use crate::video::mlt::warp;
use crate::video::mlt::{mlt_path, xml};
use crate::video::timeline::{Clip, ClipAudio};
use doc::Doc;
use std::path::Path;

/// The Shotcut release whose project format this follows.
pub const SHOTCUT_FIXTURE_VERSION: &str = "26.6.25";

/// A new, empty project at a preset, rooted at `root`: V1 and A1, as Shotcut
/// makes a new project.
pub fn template_text(preset: &str, root: &Path) -> Result<String, String> {
    let p = profile(preset)?;
    let v = SHOTCUT_FIXTURE_VERSION;
    Ok(format!(
        r#"<?xml version="1.0" standalone="no"?>
<mlt LC_NUMERIC="C" version="7.40.0" title="Shotcut version {v}" producer="main_bin" root="{root}">
  {profile}
  <playlist id="main_bin">
    <property name="shotcut:colorTransfer">sdr</property>
    <property name="xml_retain">1</property>
  </playlist>
  <producer id="black" in="00:00:00.000" out="00:00:00.000">
    <property name="length">00:00:00.040</property>
    <property name="eof">pause</property>
    <property name="resource">0</property>
    <property name="aspect_ratio">1</property>
    <property name="mlt_service">color</property>
    <property name="mlt_image_format">rgba</property>
    <property name="set.test_audio">0</property>
  </producer>
  <playlist id="background">
    <entry producer="black" in="00:00:00.000" out="00:00:00.000"/>
  </playlist>
  <playlist id="playlist0">
    <property name="shotcut:video">1</property>
    <property name="shotcut:name">V1</property>
  </playlist>
  <playlist id="playlist1">
    <property name="shotcut:audio">1</property>
    <property name="shotcut:name">A1</property>
  </playlist>
  <tractor id="tractor0" title="Shotcut version {v}" in="00:00:00.000" out="00:00:00.000">
    <property name="shotcut:colorTransfer">sdr</property>
    <property name="shotcut">1</property>
    <property name="shotcut:projectAudioChannels">2</property>
    <property name="shotcut:projectFolder">1</property>
    <property name="meta.shotcut.vui">1</property>
    <track producer="background"/>
    <track producer="playlist0"/>
    <track producer="playlist1" hide="video"/>
    <transition id="transition0">
      <property name="a_track">0</property>
      <property name="b_track">1</property>
      <property name="mlt_service">mix</property>
      <property name="always_active">1</property>
      <property name="sum">1</property>
    </transition>
    <transition id="transition1">
      <property name="a_track">0</property>
      <property name="b_track">1</property>
      <property name="compositing">0</property>
      <property name="distort">0</property>
      <property name="rotate_center">0</property>
      <property name="mlt_service">qtblend</property>
      <property name="threads">0</property>
      <property name="disable">1</property>
    </transition>
    <transition id="transition2">
      <property name="a_track">0</property>
      <property name="b_track">2</property>
      <property name="mlt_service">mix</property>
      <property name="always_active">1</property>
      <property name="sum">1</property>
    </transition>
    <property name="shotcut:processingMode">Native8Cpu</property>
  </tractor>
</mlt>
"#,
        root = xml::escape(&mlt_path(root)),
        profile = shotcut_profile_tag(&p),
    ))
}

/// Shotcut writes the same `<profile>` as Kdenlive.
fn shotcut_profile_tag(p: &crate::video::mlt::profile::Profile) -> String {
    profile_tag(p)
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
    splices.replace(doc.tree.node(node).span.clone(), shotcut_profile_tag(&p));
    splices.apply(&doc.text)
}

pub fn open(path: &Path) -> Result<Doc, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    Doc::parse(text, Some(path))
}

/// Whether a `.mlt` file is a Shotcut project, not a playlist or filter
/// preset Shotcut also saves as `.mlt`.
pub fn is_project(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| Doc::parse(t, Some(path)).ok())
        .is_some()
}

/// A resource as the user knows it: relative to the working folder when inside.
fn shown_resource(doc: &Doc, working_dir: &str, resource: &str) -> String {
    let p = Path::new(resource);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(&doc.root_dir).join(p)
    };
    crate::video::paths::display_path(working_dir, &abs)
}

/// The main track's clips, for the tools that measure or cut them.
pub fn clips(doc: &Doc) -> Vec<Clip> {
    doc.items
        .iter()
        .map(|item| {
            let speed = doc.speed(&item.chain);
            let (in_frame, out_frame) = warp::to_source(item.in_frame, item.out_frame, speed);
            Clip {
                resource: doc.resource(&item.chain),
                in_frame,
                out_frame,
                audio: doc
                    .stream(&item.chain, "audio_index")
                    .map(|stream| ClipAudio {
                        stream,
                        in_frame,
                        out_frame,
                    }),
                gain_ranges: doc.our_gain_ranges(&item.chain),
                fit: doc.our_fit(&item.chain),
                speed,
            }
        })
        .collect()
}

/// The files on tracks other than the main one and the audio tracks.
pub fn other_track_resources(doc: &Doc) -> Vec<String> {
    (0..doc.tracks.len())
        .filter(|&t| Some(t) != doc.main && doc.tracks[t].video)
        .flat_map(|t| doc.track_entries(t))
        .map(|e| doc.resource(&e.chain))
        .filter(|r| !r.is_empty())
        .collect()
}

pub fn summary(doc: &Doc, working_dir: &str, project: &Path) -> ProjectSummary {
    let fps = doc.fps;
    let items = doc
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let ours = doc.our_filters(&item.chain);
            let speed = doc.speed(&item.chain);
            let (src_in, src_out) = warp::to_source(item.in_frame, item.out_frame, speed);
            SummaryItem {
                index: i as u32 + 1,
                path: shown_resource(doc, working_dir, &doc.resource(&item.chain)),
                source_in_secs: fps.secs(src_in),
                source_out_secs: fps.secs(src_out + 1),
                speed,
                start_secs: fps.secs(item.start),
                duration_secs: fps.secs(item.len()),
                effects: (doc.filters(&item.chain).len() - ours.len()) as u32,
                has_video: doc.stream(&item.chain, "video_index").is_some(),
                has_audio: doc.stream(&item.chain, "audio_index").is_some(),
                crossfade_in_secs: item.fade_in.map(|f| fps.secs(doc.fades[f].len)),
                gain_db: doc.our_gain(&item.chain),
                limited: doc.our_limiter(&item.chain),
                fit: doc.our_fit(&item.chain),
                gain_ranges: doc
                    .our_gain_ranges(&item.chain)
                    .iter()
                    .map(|r| crate::video::format::SummaryRange::of(r, fps))
                    .collect(),
            }
        })
        .collect();
    let mut other_clips = Vec::new();
    for t in 0..doc.tracks.len() {
        if Some(t) == doc.main || !doc.tracks[t].video {
            continue;
        }
        for e in doc.track_entries(t) {
            other_clips.push(OtherClip {
                track: doc.tracks[t].name.clone(),
                path: shown_resource(doc, working_dir, &doc.resource(&e.chain)),
                start_secs: fps.secs(e.start),
                end_secs: fps.secs(e.start + e.len()),
            });
        }
    }
    ProjectSummary {
        project: crate::video::paths::display_path(working_dir, project),
        width: doc.width,
        height: doc.height,
        fps: fps.num as f64 / fps.den as f64,
        editor: crate::video::format::Format::Shotcut,
        editor_version: doc.version.clone(),
        read_only: doc.editable().err(),
        items,
        audio: crate::video::format::AudioItem::from_clips(&audio::clips(doc), fps, |r| {
            shown_resource(doc, working_dir, r)
        }),
        other_clips,
        mixes: doc.fades.len() as u32,
        guides: doc.markers() as u32,
        total_secs: fps.secs(doc.sequence_end()),
    }
}
