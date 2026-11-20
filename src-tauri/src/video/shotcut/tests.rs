use super::doc::{Doc, OURS};
use super::edit::{apply, current};
use super::*;
use crate::video::mlt::fps::Fps;
use crate::video::timeline::{Media, Placement, Source};
use std::path::Path;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/video/shotcut/fixtures")
            .join(name),
    )
    .unwrap()
}

/// Three clips on V1 (a crossfade made in Shotcut between the first two, a
/// gap, a text filter on the third), an image on V2 and a marker.
fn edited() -> Doc {
    Doc::parse(
        fixture("edited-26.6.mlt"),
        Some(Path::new("/videos/ep12/ep12.mlt")),
    )
    .unwrap()
}

fn empty() -> Doc {
    Doc::parse(
        template_text("1080p30", Path::new("/videos")).unwrap(),
        None,
    )
    .unwrap()
}

fn reparse(text: String) -> Doc {
    Doc::parse(text, Some(Path::new("/videos/ep12/ep12.mlt"))).unwrap()
}

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

fn new(m: Media) -> Placement {
    Placement::of(Source::New(m))
}

fn keep(i: usize) -> Placement {
    Placement::of(Source::Existing(i))
}

#[test]
fn a_shotcut_project_reads() {
    let doc = edited();
    assert_eq!(doc.version, "26.6.25");
    assert_eq!(doc.fps, Fps { num: 30, den: 1 });
    assert_eq!(doc.root_dir, "/videos/ep12");
    let names: Vec<&str> = doc.tracks.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, ["V1", "V2", "A1"]);
    assert_eq!(doc.main, Some(0));
    let got: Vec<(String, i64, i64, i64)> = doc
        .items
        .iter()
        .map(|i| (i.chain.clone(), i.in_frame, i.out_frame, i.start))
        .collect();
    assert_eq!(
        got,
        [
            ("chain0".into(), 0, 164, 0),
            ("chain1".into(), 30, 209, 150),
            ("chain2".into(), 0, 179, 360)
        ]
    );
    assert_eq!(doc.fades.len(), 1);
    assert!(!doc.fades[0].ours);
    assert_eq!(doc.items[1].fade_in, Some(0));
    assert_eq!(doc.items[0].fade_out, Some(0));
    assert_eq!(doc.sequence_end(), 540);
    assert!(doc.editable().is_ok());
}

#[test]
fn the_summary_names_shotcut_and_counts_what_the_user_made() {
    let doc = edited();
    let s = summary(&doc, "/videos", Path::new("/videos/ep12/ep12.mlt"));
    assert_eq!(s.editor, crate::video::format::Format::Shotcut);
    assert_eq!(s.editor_version, "26.6.25");
    assert_eq!(s.project, "ep12/ep12.mlt");
    assert_eq!(s.items.len(), 3);
    assert_eq!(s.items[0].path, "ep12/a.mp4");
    assert_eq!(s.items[1].crossfade_in_secs, Some(0.5));
    assert_eq!(s.items[2].effects, 1);
    assert_eq!(s.items[2].start_secs, 12.0);
    assert!(s.items.iter().all(|i| i.has_audio && i.has_video));
    assert_eq!(s.mixes, 1);
    assert_eq!(s.guides, 1);
    assert_eq!(s.other_clips.len(), 1);
    assert_eq!(s.other_clips[0].track, "V2");
    assert_eq!(s.other_clips[0].start_secs, 2.0);
    assert_eq!(s.total_secs, 18.0);
}

#[test]
fn spans_map_the_cut_back_to_its_sources() {
    let doc = edited();
    let spans = timeline_map::spans(&doc);
    assert_eq!(spans[1].file, Path::new("/videos/ep12/b.mp4"));
    let (s, at) = crate::video::timeline::source_at(&spans, 1.0).unwrap();
    assert_eq!((s.index, at), (1, 1.0));
    // In the middle of the crossfade, the clip coming in shows.
    let (s, at) = crate::video::timeline::source_at(&spans, 5.25).unwrap();
    assert_eq!(s.index, 2);
    assert!((at - 1.25).abs() < 1e-9);
    // In the gap, nothing.
    assert!(crate::video::timeline::source_at(&spans, 11.5).is_none());
    let (s, at) = crate::video::timeline::source_at(&spans, 17.0).unwrap();
    assert_eq!((s.index, at), (3, 5.0));
}

#[test]
fn a_no_op_edit_changes_no_byte() {
    let doc = edited();
    let out = apply(&doc, &current(&doc)).unwrap();
    assert_eq!(out.text, doc.text);
    assert!(out.notes.is_empty());
    let empty = empty();
    assert_eq!(apply(&empty, &current(&empty)).unwrap().text, empty.text);
}

#[test]
fn a_cut_on_the_template_with_crossfades_reads_back_the_same() {
    let doc = empty();
    let fps = doc.fps;
    let mut wanted = vec![
        new(media("a.mp4", 10.0, fps)),
        new(media("b.mp4", 8.0, fps)),
        new(media("c.mp4", 6.0, fps)),
    ];
    wanted[1].mix_in = Some(fps.frames(1.0));
    wanted[2].mix_in = Some(fps.frames(0.5));
    wanted[0].in_frame = Some(fps.frames(2.0));
    let out = apply(&doc, &wanted).unwrap();
    let after = Doc::parse(out.text.clone(), None).unwrap();
    assert!(after.editable().is_ok());
    let got: Vec<(i64, i64, i64)> = after
        .items
        .iter()
        .map(|i| (i.in_frame, i.out_frame, i.start))
        .collect();
    // a: 2–10 s (240 frames) at 0; b overlaps it by 1 s; c overlaps b by 0.5 s.
    assert_eq!(got, [(60, 299, 0), (0, 239, 210), (0, 179, 435)]);
    assert_eq!(after.fades.len(), 2);
    assert!(after.fades.iter().all(|f| f.ours));
    assert_eq!(after.sequence_end(), 615);
    let again = current(&after);
    assert_eq!(again[1].mix_in, Some(30));
    assert_eq!(again[2].mix_in, Some(15));
    // Writing what it reads changes nothing.
    assert_eq!(apply(&after, &again).unwrap().text, out.text);
    // The background and the main tractor cover the cut.
    assert!(out.text.contains("<tractor id=\"tractor0\" title=\"Shotcut version 26.6.25\" in=\"00:00:00.000\" out=\"00:00:20.467\">"));
    assert!(out
        .text
        .contains("<property name=\"length\">00:00:20.500</property>"));
}

#[test]
fn crossfades_come_off_again() {
    let doc = empty();
    let fps = doc.fps;
    let mut wanted = vec![new(media("a.mp4", 4.0, fps)), new(media("b.mp4", 4.0, fps))];
    wanted[1].mix_in = Some(15);
    let with = reparse(apply(&doc, &wanted).unwrap().text);
    let mut plain = current(&with);
    plain[1].mix_in = None;
    let without = reparse(apply(&with, &plain).unwrap().text);
    assert!(without.fades.is_empty());
    assert!(!without.text.contains("lumaMix"));
    assert_eq!(without.items[1].start, 120);
}

#[test]
fn a_crossfade_longer_than_half_a_clip_is_shortened() {
    let doc = empty();
    let fps = doc.fps;
    let mut wanted = vec![new(media("a.mp4", 1.0, fps)), new(media("b.mp4", 4.0, fps))];
    wanted[1].mix_in = Some(60);
    let out = apply(&doc, &wanted).unwrap();
    assert!(out.notes.iter().any(|n| n.contains("shortened")));
    assert_eq!(reparse(out.text).fades[0].len, 14);
}

#[test]
fn removing_a_clip_keeps_the_other_tracks_the_marker_and_the_users_crossfade() {
    let doc = edited();
    let out = apply(&doc, &[keep(0), keep(1)]).unwrap();
    let after = reparse(out.text.clone());
    assert_eq!(after.items.len(), 2);
    assert_eq!(after.fades.len(), 1);
    assert!(!after.fades[0].ours);
    assert_eq!(after.markers(), 1);
    // c.mp4's chain (and its text filter) went with it; V2's image stayed.
    assert!(!out.text.contains("c.mp4"));
    assert!(out.text.contains("logo.png"));
    assert!(out.notes.iter().any(|n| n.contains("other tracks")));
    // V2 ends at 5 s, inside the 11 s main track, so 11 s in all.
    assert_eq!(after.sequence_end(), 330);
}

#[test]
fn a_crossfade_made_in_shotcut_keeps_its_clips_together() {
    let doc = edited();
    let err = apply(&doc, &[keep(1), keep(0), keep(2)]).unwrap_err();
    assert!(err.contains("crossfade made in Shotcut"), "{err}");
    let mut trimmed = current(&doc);
    trimmed[0].out_frame = Some(100);
    assert!(apply(&doc, &trimmed).is_err());
    // Trimming the far side of a joined clip is fine.
    let mut far = current(&doc);
    far[1].out_frame = Some(200);
    let after = reparse(apply(&doc, &far).unwrap().text);
    assert_eq!(after.items[1].out_frame, 200);
    assert!(!after.fades[0].ours);
}

#[test]
fn moving_the_last_clip_first_drops_the_gap() {
    let doc = edited();
    let after = reparse(apply(&doc, &[keep(2), keep(0), keep(1)]).unwrap().text);
    let starts: Vec<i64> = after.items.iter().map(|i| i.start).collect();
    assert_eq!(starts, [0, 180, 330]);
    assert!(after.items[2].fade_in.is_some());
}

#[test]
fn gain_and_its_limiter_go_on_and_come_off_byte_for_byte() {
    let doc = edited();
    let mut wanted = current(&doc);
    wanted[2].gain_db = Some(-3.5);
    wanted[2].limiter = true;
    let out = apply(&doc, &wanted).unwrap();
    let after = reparse(out.text.clone());
    assert_eq!(after.our_gain("chain2"), Some(-3.5));
    assert!(after.our_limiter("chain2"));
    // The user's text filter is still the first.
    assert_eq!(after.filters("chain2").len(), 3);
    assert!(out
        .text
        .contains("<property name=\"shotcut:filter\">audioGain</property>"));
    let s = summary(&after, "/videos", Path::new("/videos/ep12/ep12.mlt"));
    assert_eq!(s.items[2].gain_db, Some(-3.5));
    assert!(s.items[2].limited);
    assert_eq!(s.items[2].effects, 1);
    let mut off = current(&after);
    off[2].gain_db = Some(0.0);
    assert_eq!(apply(&after, &off).unwrap().text, doc.text);
}

#[test]
fn a_clip_split_in_two_keeps_its_filter_in_both_pieces() {
    let doc = edited();
    let mut wanted = current(&doc);
    let mut second = Placement::of(Source::Piece(2));
    second.in_frame = Some(120);
    wanted[2].out_frame = Some(59);
    wanted.push(second);
    let out = apply(&doc, &wanted).unwrap();
    let after = reparse(out.text);
    assert_eq!(after.items.len(), 4);
    assert_eq!(after.items[3].chain, "chain3");
    assert_eq!(after.resource("chain3"), "c.mp4");
    assert_eq!(after.filters("chain3").len(), 1);
    assert_eq!(after.filters("chain2").len(), 1);
    // The copy's filter has an id of its own.
    let ids: Vec<&str> = after
        .tree
        .nodes
        .iter()
        .filter(|n| n.name == "filter")
        .filter_map(|n| n.attr("id"))
        .collect();
    let unique: std::collections::HashSet<&&str> = ids.iter().collect();
    assert_eq!(ids.len(), unique.len());
    assert_eq!((after.items[3].in_frame, after.items[3].start), (120, 420));
}

#[test]
fn a_piece_with_a_new_gain_drops_the_copied_one() {
    let doc = edited();
    let mut wanted = current(&doc);
    wanted[2].gain_db = Some(2.0);
    let gained = reparse(apply(&doc, &wanted).unwrap().text);
    let mut split = current(&gained);
    let mut piece = Placement::of(Source::Piece(2));
    piece.gain_db = Some(-1.0);
    split.push(piece);
    let after = reparse(apply(&gained, &split).unwrap().text);
    assert_eq!(after.our_gain("chain2"), Some(2.0));
    assert_eq!(after.our_gain("chain3"), Some(-1.0));
    assert_eq!(after.our_filters("chain3").len(), 1);
}

#[test]
fn an_end_past_the_clip_is_clamped_and_said() {
    let doc = edited();
    let mut wanted = current(&doc);
    wanted[2].out_frame = Some(10_000);
    let out = apply(&doc, &wanted).unwrap();
    assert!(out.notes.iter().any(|n| n.contains("past the clip's end")));
    assert_eq!(reparse(out.text).items[2].out_frame, 179);
}

#[test]
fn gpu_projects_and_locked_tracks_are_read_but_not_edited() {
    let gpu = reparse(fixture("edited-26.6.mlt").replace("Native8Cpu", "Linear10GpuCpu"));
    let err = gpu.editable().unwrap_err();
    assert!(err.contains("GPU"), "{err}");
    assert!(apply(&gpu, &current(&gpu)).is_err());
    let s = summary(&gpu, "/videos", Path::new("/videos/ep12/ep12.mlt"));
    assert!(s.read_only.is_some());
    let locked = reparse(fixture("edited-26.6.mlt").replacen(
        "<property name=\"shotcut:name\">V1</property>",
        "<property name=\"shotcut:name\">V1</property>\n    <property name=\"shotcut:lock\">1</property>",
        1,
    ));
    assert!(locked.editable().unwrap_err().contains("locked"));
}

#[test]
fn ours_is_read_from_a_saved_file() {
    let text = fixture("edited-26.6.mlt").replacen(
        "    <property name=\"shotcut:caption\">a.mp4</property>\n",
        &format!(
            "    <property name=\"shotcut:caption\">a.mp4</property>\n    <filter id=\"filter9\">\n      <property name=\"level\">-3</property>\n      <property name=\"mlt_service\">volume</property>\n      <property name=\"shotcut:filter\">audioGain</property>\n      <property name=\"{OURS}\">1</property>\n    </filter>\n"
        ),
        1,
    );
    let doc = reparse(text);
    assert_eq!(doc.our_gain("chain0"), Some(-3.0));
    assert!(!doc.our_limiter("chain0"));
    assert_eq!(doc.our_gain("chain1"), None);
    let s = summary(&doc, "/videos", Path::new("/videos/ep12/ep12.mlt"));
    assert_eq!(s.items[0].effects, 0);
}

#[test]
fn a_profile_change_rewrites_the_profile_only() {
    let doc = empty();
    let text = set_profile(&doc, "2160p30").unwrap();
    assert!(text.contains("width=\"3840\""));
    assert_eq!(text.lines().count(), doc.text.lines().count());
}

#[test]
fn playlists_and_presets_saved_as_mlt_are_not_projects() {
    let dir = crate::test_util::temp_dir("shotcut_is_project");
    let project = dir.join("ep.mlt");
    std::fs::write(&project, fixture("edited-26.6.mlt")).unwrap();
    let playlist = dir.join("playlist.mlt");
    std::fs::write(
        &playlist,
        "<mlt><profile frame_rate_num=\"30\" frame_rate_den=\"1\"/><playlist id=\"main_bin\"/></mlt>",
    )
    .unwrap();
    assert!(is_project(&project));
    assert!(!is_project(&playlist));
}

/// The melt to check written projects with: `HARUSPEX_MELT`, else `melt` on PATH.
fn melt() -> Option<String> {
    let melt = std::env::var("HARUSPEX_MELT").unwrap_or_else(|_| "melt".into());
    std::process::Command::new(&melt)
        .arg("-version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| melt)
}

#[tokio::test]
async fn melt_loads_and_renders_a_written_project() {
    let Some(melt) = melt() else {
        eprintln!("skipped: no melt (set HARUSPEX_MELT)");
        return;
    };
    let dir = crate::test_util::temp_dir("shotcut_melt");
    let make = |name: &str, color: &str| {
        let status = crate::test_util::host_command("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:s=640x360:r=30:d=2"))
            .args(["-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest"])
            .args(["-c:v", "mpeg4", "-c:a", "aac"])
            .arg(dir.join(name))
            .status()
            .unwrap();
        assert!(status.success());
    };
    make("a.mp4", "red");
    make("b.mp4", "blue");
    let doc = Doc::parse(template_text("1080p30", &dir).unwrap(), None).unwrap();
    let fps = doc.fps;
    let mut wanted = vec![new(media("a.mp4", 2.0, fps)), new(media("b.mp4", 2.0, fps))];
    wanted[1].mix_in = Some(15);
    wanted[1].gain_db = Some(-2.0);
    wanted[1].limiter = true;
    let text = apply(&doc, &wanted).unwrap().text;
    let project = dir.join("cut.mlt");
    save(&project, &text, &melt).await.unwrap();
    // MJPEG in MOV: an encoder the bundled ffmpeg and the distros' both have.
    let out = dir.join("cut.mov");
    let status = std::process::Command::new(&melt)
        .arg(&project)
        .arg("-consumer")
        .arg(format!("avformat:{}", out.display()))
        .args(["vcodec=mjpeg", "acodec=pcm_s16le"])
        .env("QT_QPA_PLATFORM", "offscreen")
        .status()
        .unwrap();
    assert!(status.success() && out.metadata().unwrap().len() > 0);
}
