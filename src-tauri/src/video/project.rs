//! Which project a tool means, the media it adds, and the cut and ops the
//! tools ask for, put together over `kdenlive`.

use super::binaries::{self, BinaryOverrides, Tool};
use super::kdenlive::doc::Doc;
use super::kdenlive::edit::{self, Media, Placement, Source};
use super::kdenlive::{self, ProjectSummary};
use super::paths::{display_path, resolve_episode, resolve_in_working, resolve_media};
use super::probe;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What the frontend passes from Settings → Video.
#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoSettings {
    pub overrides: BinaryOverrides,
    pub intro: String,
    pub outro: String,
    pub preset: String,
}

/// `true` for the one set in Settings → Video, or a path.
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
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct CutSpec {
    pub project: Option<String>,
    pub preset: Option<String>,
    pub intro: Option<EndClip>,
    pub outro: Option<EndClip>,
    pub items: Vec<CutItemSpec>,
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
    },
    Remove {
        index: u32,
    },
    Move {
        from: u32,
        to: u32,
    },
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

fn kdenlive_files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_file() && p.extension().is_some_and(|e| e == "kdenlive"))
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
/// only `.kdenlive` in the episode folder; else the only one in the working
/// folder whose name ends in the episode's number (`spronglehump_010.kdenlive`
/// for `ep010`); else, when the call may create one, `<episode>/<episode>.kdenlive`.
pub fn default_project(
    working_dir: &str,
    episode: &str,
    named: Option<&str>,
    may_create: bool,
) -> Result<PathBuf, String> {
    if let Some(named) = named.map(str::trim).filter(|n| !n.is_empty()) {
        if !named.ends_with(".kdenlive") {
            return Err(format!("{named} is not a .kdenlive file."));
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
    let here = kdenlive_files(&episode_dir);
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
        let matches: Vec<PathBuf> = kdenlive_files(&root)
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
    if may_create {
        return Ok(episode_dir.join(format!("{name}.kdenlive")));
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

/// The resource string a file gets in a project rooted at `root`.
fn resource_for(root: &str, file: &Path) -> String {
    let file = kdenlive::mlt_path(&file.canonicalize().unwrap_or_else(|_| file.to_path_buf()));
    let root = kdenlive::mlt_path(
        &Path::new(root)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(root)),
    );
    let prefix = format!("{}/", root.trim_end_matches('/'));
    file.strip_prefix(&prefix)
        .map_or(file.clone(), str::to_string)
}

async fn media(
    doc: &Doc,
    working_dir: &str,
    path: &str,
    settings: &VideoSettings,
    ffprobe: &str,
) -> Result<Media, String> {
    let file = resolve_media(working_dir, path, &settings.intro, &settings.outro)?;
    let info = probe::probe_file(ffprobe, &file, path.to_string()).await?;
    Ok(Media {
        resource: resource_for(&doc.root_dir, &file),
        length: doc.fps.frames(info.duration_secs).max(1),
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

/// The resource of each main-track item, for matching an intro to a clip
/// already there.
fn item_resources(doc: &Doc) -> Vec<String> {
    doc.items()
        .iter()
        .map(|i| {
            doc.tree
                .by_id(&i.any().chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .unwrap_or("")
                .to_string()
        })
        .collect()
}

fn other_track_resources(doc: &Doc) -> Vec<String> {
    (0..doc.tracks.len())
        .filter(|&t| t != doc.main_video && t != doc.main_audio)
        .flat_map(|t| doc.track_entries(t))
        .filter_map(|e| {
            doc.tree
                .by_id(&e.chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .map(str::to_string)
        })
        .collect()
}

fn end_clip_path<'a>(
    choice: &'a EndClip,
    setting: &'a str,
    which: &str,
) -> Result<Option<&'a str>, String> {
    match choice {
        EndClip::Settings(false) => Ok(None),
        EndClip::Settings(true) if setting.trim().is_empty() => Err(format!(
            "No {which} is set in Settings → Video; name the file."
        )),
        EndClip::Settings(true) => Ok(Some(setting)),
        EndClip::Path(p) => Ok(Some(p.as_str())),
    }
}

async fn tools(settings: &VideoSettings) -> Result<(String, String), String> {
    let found = binaries::resolve(&settings.overrides).await;
    Ok((
        found.require(Tool::Ffprobe)?.to_string(),
        found.require(Tool::Melt)?.to_string(),
    ))
}

/// Make the main track hold the cut, creating the project when needed.
pub async fn cut(
    working_dir: &str,
    episode: &str,
    spec: CutSpec,
    settings: &VideoSettings,
) -> Result<CutResult, String> {
    let (ffprobe, melt) = tools(settings).await?;
    let path = default_project(working_dir, episode, spec.project.as_deref(), true)?;
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
        Doc::parse(kdenlive::template_text(
            &preset,
            &resolve_episode(working_dir, "")?,
        )?)?
    } else {
        kdenlive::open(&path)?
    };
    doc.editable()?;
    if let (Some(preset), false) = (&spec.preset, created) {
        let p = kdenlive::profile(preset)?;
        let same_rate = doc.fps.num == p.fps * doc.fps.den;
        if !same_rate && !doc.items().is_empty() {
            return Err(
                "This project already has clips at another frame rate. Change it in Kdenlive \
                        (Project → Project Settings)."
                    .into(),
            );
        }
        doc = Doc::parse(kdenlive::set_profile(&doc, preset)?)?;
    }

    let resources = item_resources(&doc);
    let elsewhere = other_track_resources(&doc);
    let mut wanted: Vec<Placement> = Vec::new();
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
            Some(i) => Placement {
                source: Source::Existing(i),
                in_frame: None,
                out_frame: None,
            },
            None => Placement {
                source: Source::New(m),
                in_frame: None,
                out_frame: None,
            },
        };
        ends.push((if which == "intro" { 0 } else { 1 }, placement));
    }
    for (n, item) in spec.items.iter().enumerate() {
        let source = match (&item.index, &item.path) {
            (Some(i), None) if *i >= 1 => Source::Existing(*i as usize - 1),
            (None, Some(p)) => Source::New(media(&doc, working_dir, p, settings, &ffprobe).await?),
            _ => return Err(format!(
                "Item {} needs exactly one of index (a clip already in the cut, from 1) or path.",
                n + 1
            )),
        };
        wanted.push(Placement {
            source,
            in_frame: item.in_secs.map(|s| doc.fps.frames(s.max(0.0))),
            out_frame: item.out_secs.map(|s| doc.fps.frames(s) - 1),
        });
    }
    // The intro and outro go at the ends, and are not listed twice.
    wanted.retain(|p| !ends.iter().any(|(_, e)| matches!((&e.source, &p.source), (Source::Existing(a), Source::Existing(b)) if a == b)));
    for (end, p) in ends {
        if end == 0 {
            wanted.insert(0, p);
        } else {
            wanted.push(p);
        }
    }
    if wanted.is_empty() {
        return Err("The cut has no clips. List them in items.".into());
    }
    let edited = edit::apply(&doc, &wanted)?;
    notes.extend(edited.notes);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("can't make {}: {e}", dir.display()))?;
    }
    kdenlive::save(&path, &edited.text, &melt).await?;
    let rel = display_path(working_dir, &path);
    if let Ok(dir) = resolve_episode(working_dir, episode) {
        write_state(&dir, &rel);
    }
    let after = kdenlive::open(&path)?;
    Ok(CutResult {
        summary: kdenlive::summary(&after, working_dir, &path),
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
    let (_, melt) = tools(settings).await?;
    let path = default_project(working_dir, episode, project, false)?;
    let doc = kdenlive::open(&path)?;
    let mut wanted = edit::current(&doc);
    let count = wanted.len() as u32;
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
        } => {
            let i = check(index)?;
            if let Some(s) = in_secs {
                wanted[i].in_frame = Some(doc.fps.frames(s.max(0.0)));
            }
            if let Some(s) = out_secs {
                wanted[i].out_frame = Some(doc.fps.frames(s) - 1);
            }
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
    }
    let edited = edit::apply(&doc, &wanted)?;
    kdenlive::save(&path, &edited.text, &melt).await?;
    let after = kdenlive::open(&path)?;
    Ok(CutResult {
        summary: kdenlive::summary(&after, working_dir, &path),
        notes: edited.notes,
        created: false,
    })
}

pub fn summary(
    working_dir: &str,
    episode: &str,
    project: Option<&str>,
) -> Result<ProjectSummary, String> {
    let path = default_project(working_dir, episode, project, false)?;
    let doc = kdenlive::open(&path)?;
    Ok(kdenlive::summary(&doc, working_dir, &path))
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
    fn the_series_project_named_by_number_is_found() {
        let dir = series();
        fs::write(dir.join("spronglehump_010.kdenlive"), "").unwrap();
        fs::write(dir.join("spronglehump_009.kdenlive"), "").unwrap();
        let wd = dir.to_string_lossy();
        let p = default_project(&wd, "ep010", None, false).unwrap();
        assert!(p.ends_with("spronglehump_010.kdenlive"));
        // ep011 has none, so a new one is made in its folder.
        let p = default_project(&wd, "ep011", None, true).unwrap();
        assert!(p.ends_with("ep011/ep011.kdenlive"));
        assert!(default_project(&wd, "ep011", None, false)
            .unwrap_err()
            .contains("video_cut"));
    }

    #[test]
    fn one_in_the_episode_wins_and_two_must_be_named() {
        let dir = series();
        let wd = dir.to_string_lossy();
        fs::write(dir.join("ep010/a.kdenlive"), "").unwrap();
        assert!(default_project(&wd, "ep010", None, false)
            .unwrap()
            .ends_with("a.kdenlive"));
        fs::write(dir.join("ep010/b.kdenlive"), "").unwrap();
        let err = default_project(&wd, "ep010", None, false).unwrap_err();
        assert!(
            err.contains("ep010/a.kdenlive") && err.contains("ep010/b.kdenlive"),
            "{err}"
        );
        // The last cut's choice settles it.
        write_state(&dir.join("ep010"), "ep010/b.kdenlive");
        assert!(default_project(&wd, "ep010", None, false)
            .unwrap()
            .ends_with("b.kdenlive"));
    }

    #[test]
    fn a_named_project_must_be_kdenlive_and_inside() {
        let dir = series();
        let wd = dir.to_string_lossy();
        assert!(default_project(&wd, "ep010", Some("notes.txt"), true).is_err());
        assert!(default_project(&wd, "ep010", Some("../x.kdenlive"), true).is_err());
    }

    #[test]
    fn an_empty_intro_setting_is_an_error_naming_settings() {
        let err = end_clip_path(&EndClip::Settings(true), "", "intro").unwrap_err();
        assert!(err.contains("Settings → Video"));
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
            let ok = std::process::Command::new("ffmpeg")
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
