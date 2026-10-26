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

pub mod doc;
pub mod edit;
pub mod xml;

#[cfg(test)]
mod tests;

use doc::Doc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// An empty project saved by Kdenlive 26.08.2: two audio and two video tracks,
/// with placeholders for the profile and the ids.
const TEMPLATE: &str = include_str!("../../../resources/video/empty-26.08.kdenlive");

/// Backups kept per project.
const BACKUPS_KEPT: usize = 20;

/// A preset's MLT profile.
pub struct Profile {
    pub name: &'static str,
    pub description: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

pub fn profile(preset: &str) -> Result<Profile, String> {
    let p = match preset {
        "1080p30" => Profile {
            name: "atsc_1080p_30",
            description: "HD 1080p 30 fps",
            width: 1920,
            height: 1080,
            fps: 30,
        },
        "1080p60" => Profile {
            name: "atsc_1080p_60",
            description: "HD 1080p 60 fps",
            width: 1920,
            height: 1080,
            fps: 60,
        },
        "1440p60" => Profile {
            name: "qhd_1440p_60",
            description: "2.5K QHD 1440p 60 fps",
            width: 2560,
            height: 1440,
            fps: 60,
        },
        "2160p30" => Profile {
            name: "uhd_2160p_30",
            description: "4K UHD 2160p 30 fps",
            width: 3840,
            height: 2160,
            fps: 30,
        },
        other => {
            return Err(format!(
                "Unknown format {other}: use 1080p30, 1080p60, 1440p60 or 2160p30."
            ))
        }
    };
    Ok(p)
}

fn profile_tag(p: &Profile) -> String {
    format!(
        "<profile colorspace=\"709\" description=\"{}\" display_aspect_den=\"9\" display_aspect_num=\"16\" \
         frame_rate_den=\"1\" frame_rate_num=\"{}\" height=\"{}\" progressive=\"1\" sample_aspect_den=\"1\" \
         sample_aspect_num=\"1\" width=\"{}\"/>",
        p.description, p.fps, p.height, p.width
    )
}

/// A path as a project's `root` or `resource` says it: forward slashes, a
/// Windows drive kept as `C:/…`.
pub fn mlt_path(path: &Path) -> String {
    let s = crate::fs_tools::path::strip_verbatim(path)
        .to_string_lossy()
        .into_owned();
    s.replace('\\', "/")
}

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

/// Kdenlive's `kdenlive:file_hash`: MD5 of the whole file up to 2,000,000
/// bytes, otherwise of its first and last 1,000,000 bytes.
pub fn file_hash(path: &Path) -> Result<String, String> {
    use md5::{Digest, Md5};
    use std::io::{Read, Seek, SeekFrom};
    let mut f =
        std::fs::File::open(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut hasher = Md5::new();
    let mut buf = Vec::new();
    if size <= 2_000_000 {
        f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
    } else {
        buf.resize(1_000_000, 0);
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
        f.seek(SeekFrom::End(-1_000_000))
            .map_err(|e| e.to_string())?;
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        hasher.update(&buf);
    }
    Ok(crate::hash_util::hex(&hasher.finalize()))
}

pub fn open(path: &Path) -> Result<Doc, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("can't read {}: {e}", path.display()))?;
    Doc::parse(text)
}

/// The backups folder for a project: `<its folder>/.haruspex/backups/`.
fn backups_dir(project: &Path) -> PathBuf {
    project
        .parent()
        .unwrap_or(Path::new("."))
        .join(".haruspex")
        .join("backups")
}

fn backup(project: &Path) -> Result<Option<PathBuf>, String> {
    if !project.exists() {
        return Ok(None);
    }
    let dir = backups_dir(project);
    std::fs::create_dir_all(&dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    let stem = project
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("project");
    let stamp = chrono_stamp();
    let to = dir.join(format!("{stem}-{stamp}.kdenlive"));
    std::fs::copy(project, &to).map_err(|e| format!("can't back up the project: {e}"))?;
    // Keep the newest few.
    let mut old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                        n.starts_with(&format!("{stem}-")) && n.ends_with(".kdenlive")
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    old.sort();
    while old.len() > BACKUPS_KEPT {
        let _ = std::fs::remove_file(old.remove(0));
    }
    Ok(Some(to))
}

/// `20261025T143005123`, UTC, sorting the way it reads.
fn chrono_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}{:03}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        now.subsec_millis()
    )
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Whether melt can load a project. `Err` carries melt's complaint.
pub async fn melt_loads(melt: &str, project: &Path) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(melt);
    cmd.arg(project)
        .args(["out=0", "-consumer", "null"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::no_window(&mut cmd);
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), cmd.output())
        .await
        .map_err(|_| "melt took too long to load the project".to_string())?
        .map_err(|e| format!("could not run melt: {e}"))?;
    let err = String::from_utf8_lossy(&out.stderr);
    if let Some(line) = err
        .lines()
        .find(|l| l.contains("Failed to load") || l.contains("parse fatal"))
    {
        return Err(line.trim().to_string());
    }
    Ok(())
}

/// Write `text` over `project`: back up first, write beside it and rename,
/// then make sure melt still loads it, restoring the backup if not.
pub async fn save(project: &Path, text: &str, melt: &str) -> Result<(), String> {
    let saved = backup(project)?;
    let tmp = project.with_extension("kdenlive.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("can't write the project: {e}"))?;
    std::fs::rename(&tmp, project).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("can't write the project: {e}")
    })?;
    if let Err(why) = melt_loads(melt, project).await {
        match &saved {
            Some(b) => {
                let _ = std::fs::copy(b, project);
            }
            None => {
                let _ = std::fs::remove_file(project);
            }
        }
        return Err(format!(
            "melt couldn't load the edited project, so it was not changed: {why}"
        ));
    }
    Ok(())
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
    pub kdenlive_version: String,
    /// Why it can't be edited, when it can't.
    pub read_only: Option<String>,
    pub items: Vec<SummaryItem>,
    pub other_clips: Vec<OtherClip>,
    pub mixes: u32,
    pub guides: u32,
    pub total_secs: f64,
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
    let items = doc
        .items()
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let e = item.any();
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
            }
        })
        .collect();
    let mut other_clips = Vec::new();
    for t in 0..doc.tracks.len() {
        if t == doc.main_video || t == doc.main_audio {
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
        kdenlive_version: doc.kdenlive_version.clone(),
        read_only: doc.editable().err(),
        items,
        other_clips,
        mixes: (doc.mixes(doc.main_video).len() + doc.mixes(doc.main_audio).len()) as u32,
        guides,
        total_secs: fps.secs(doc.sequence_end()),
    }
}
