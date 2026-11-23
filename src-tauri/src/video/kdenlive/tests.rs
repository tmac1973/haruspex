use super::doc::{Doc, Fps, Item};
use super::edit::{apply, current};
use super::*;
use crate::video::mlt::mlt_path;
use crate::video::mlt::project_file::melt_loads;
use crate::video::timeline::{Fit, GainRange, Media, Placement, Source};
use std::path::Path;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/video/kdenlive/fixtures")
            .join(name),
    )
    .unwrap()
}

fn obs_project() -> Doc {
    Doc::parse(fixture("intro-plus-obs.kdenlive")).unwrap()
}

fn empty_project() -> Doc {
    Doc::parse(template_text("1080p60", Path::new("/videos")).unwrap()).unwrap()
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

/// Equal texts, or a panic naming the first line that differs.
fn assert_same(got: &str, want: &str) {
    if got == want {
        return;
    }
    let (g, w): (Vec<&str>, Vec<&str>) = (got.lines().collect(), want.lines().collect());
    let at = g
        .iter()
        .zip(&w)
        .position(|(a, b)| a != b)
        .unwrap_or(g.len().min(w.len()));
    let around = |v: &[&str]| v[at.saturating_sub(3)..(at + 4).min(v.len())].join("\n");
    panic!(
        "differs at line {at}:\n--- got\n{}\n--- want\n{}",
        around(&g),
        around(&w)
    );
}

fn reparse(text: String) -> Doc {
    Doc::parse(text).unwrap()
}

#[test]
fn timecodes_round_trip_at_common_rates() {
    for fps in [
        Fps { num: 30, den: 1 },
        Fps { num: 60, den: 1 },
        Fps {
            num: 30000,
            den: 1001,
        },
    ] {
        for f in (0..120_000).step_by(7) {
            assert_eq!(fps.parse(&fps.timecode(f)), Some(f), "{fps:?} {f}");
        }
    }
    let ntsc = Fps {
        num: 30000,
        den: 1001,
    };
    assert_eq!(ntsc.timecode(151), "00:00:05.038");
    assert_eq!(ntsc.timecode(58238), "00:32:23.223");
    // As melt writes and reads them (checked with melt 7.42).
    assert_eq!(ntsc.timecode(5494), "00:03:03.337");
    assert_eq!(ntsc.parse("00:03:03.337"), Some(5494));
    assert_eq!(ntsc.timecode(58390), "00:32:28.295");
    assert_eq!(ntsc.parse("152"), Some(152));
}

#[test]
fn the_real_project_reads() {
    let doc = obs_project();
    assert_eq!(
        doc.fps,
        Fps {
            num: 30000,
            den: 1001
        }
    );
    assert_eq!(doc.version, "1.1");
    assert_eq!((doc.main_audio, doc.main_video), (1, 2));
    let items = doc.items();
    assert_eq!(items.len(), 1);
    let obs = &items[0];
    assert_eq!(obs.start(), 152);
    assert_eq!(obs.any().len(), 58239);
    assert!(obs.video.is_some() && obs.audio.is_some());
    let s = summary(&doc, "/videos", Path::new("/videos/ep010.kdenlive"));
    assert_eq!(s.items[0].path, "ep010/raw/obs.mp4");
    assert_eq!(s.other_clips.len(), 1);
    assert!(s
        .other_clips
        .iter()
        .any(|c| c.track == "V2" && c.path == "intro001/intro.mp4"));
    // A2 is an audio track under the picture: Haruspex's to edit.
    assert_eq!(s.audio.len(), 1);
    assert_eq!(s.audio[0].track, "A2");
    assert!((s.total_secs - 1948.31).abs() < 0.01);
}

#[test]
fn a_no_op_edit_changes_no_byte() {
    for doc in [obs_project(), empty_project()] {
        let out = apply(&doc, &current(&doc)).unwrap();
        assert_eq!(out.text, doc.text);
    }
}

#[test]
fn a_cut_on_the_template_lays_clips_end_to_end_and_links_them() {
    let doc = empty_project();
    let fps = doc.fps;
    let out = apply(
        &doc,
        &[
            new(media("intro001/intro.mp4", 5.0, fps)),
            new(media("ep012/a.mp4", 10.0, fps)),
        ],
    )
    .unwrap();
    let after = reparse(out.text);
    let items = after.items();
    assert_eq!(items.len(), 2);
    assert_eq!((items[0].start(), items[0].end()), (0, 300));
    assert_eq!((items[1].start(), items[1].end()), (300, 900));
    for i in &items {
        assert!(
            i.video.is_some() && i.audio.is_some(),
            "linked picture and sound"
        );
    }
    // Two bin clips, ids after the sequence's 3.
    let bin = after.bin_clips();
    assert_eq!(bin.len(), 2);
    assert_eq!(bin[0].kdenlive_id, "4");
    assert_eq!(bin[1].kdenlive_id, "5");
    // An AVSplit per clip, on V1 (2) and A1 (1).
    let groups = after.groups();
    let datas: Vec<String> = groups
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            g["children"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l["data"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    assert_eq!(datas, ["2:0:-1,1:0:-1", "2:300:-1,1:300:-1"]);
    // Lengths.
    assert_eq!(
        after.tree.node(after.sequence).attr("out"),
        Some(fps.timecode(899).as_str())
    );
    assert_eq!(
        after.tree.property(after.sequence, "kdenlive:maxduration"),
        Some("900")
    );
    // And applying it again is a no-op.
    let again = apply(&after, &current(&after)).unwrap();
    assert_eq!(again.text, after.text);
}

#[test]
fn the_same_file_twice_shares_one_bin_clip() {
    let doc = empty_project();
    let m = media("ep012/a.mp4", 10.0, doc.fps);
    let after = reparse(apply(&doc, &[new(m.clone()), new(m)]).unwrap().text);
    assert_eq!(after.bin_clips().len(), 1);
    assert_eq!(after.items().len(), 2);
}

#[test]
fn trimming_the_start_keeps_the_leading_gap_and_the_groups() {
    let doc = obs_project();
    let fps = doc.fps;
    let trimmed = Placement {
        source: Source::Existing(0),
        in_frame: Some(fps.frames(10.0)),
        out_frame: None,
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let out = apply(&doc, &[trimmed]).unwrap();
    let after = reparse(out.text.clone());
    let obs = &after.items()[0];
    assert_eq!(obs.start(), 152, "the gap the intro on V2 needs stays");
    assert_eq!(obs.any().in_frame, fps.frames(10.0));
    assert_eq!(
        after.groups(),
        doc.groups(),
        "nothing moved, so no group changed"
    );
    // The intro on V2 and A2 is byte for byte the same.
    let v2 = doc.tracks[3].tractor;
    assert!(out.text.contains(&doc.text[doc.tree.node(v2).span.clone()]));
    assert!(out.notes.iter().any(|n| n.contains("other tracks")));
    // Shorter now.
    let total = after.sequence_end();
    assert_eq!(total, 152 + 58239 - fps.frames(10.0));
    assert_eq!(
        after.tree.property(after.sequence, "kdenlive:maxduration"),
        Some(total.to_string().as_str())
    );
}

#[test]
fn an_effect_on_a_kept_clip_survives_a_trim() {
    let doc = empty_project();
    let fps = doc.fps;
    let text = apply(
        &doc,
        &[
            new(media("a.mp4", 10.0, fps)),
            new(media("b.mp4", 10.0, fps)),
        ],
    )
    .unwrap()
    .text;
    // An effect the user added in Kdenlive, on clip 2's video.
    let effect = "<filter id=\"filter99\">\n    <property name=\"mlt_service\">brightness</property>\n   </filter>\n   ";
    let after = reparse(text.clone());
    let v = after.items()[1].video.clone().unwrap();
    let at = after.tree.node(v.node).inner_start;
    let mut with_effect = text.clone();
    with_effect.insert_str(at + 1 + 3, effect);
    let doc = reparse(with_effect);
    assert_eq!(doc.items()[1].filters(), 1);
    let trimmed = Placement {
        source: Source::Existing(1),
        in_frame: Some(fps.frames(2.0)),
        out_frame: None,
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let out = reparse(apply(&doc, &[keep(0), trimmed]).unwrap().text);
    assert_eq!(out.items()[1].filters(), 1);
    assert!(out.text.contains("brightness"));
}

#[test]
fn remove_and_move_relink_groups_and_drop_unused_chains() {
    let doc = empty_project();
    let fps = doc.fps;
    let three = reparse(
        apply(
            &doc,
            &[
                new(media("a.mp4", 1.0, fps)),
                new(media("b.mp4", 2.0, fps)),
                new(media("c.mp4", 3.0, fps)),
            ],
        )
        .unwrap()
        .text,
    );
    let chains_before = three.max_id_number("chain");
    // Drop b, put c first.
    let out = reparse(apply(&three, &[keep(2), keep(0)]).unwrap().text);
    let items = out.items();
    assert_eq!(items.len(), 2);
    let names: Vec<String> = summary(&out, "/videos", Path::new("/videos/p.kdenlive"))
        .items
        .into_iter()
        .map(|i| i.path)
        .collect();
    assert_eq!(names, ["c.mp4", "a.mp4"]);
    assert_eq!((items[0].start(), items[1].start()), (0, 180));
    assert_eq!(out.groups().as_array().unwrap().len(), 2);
    // b's two track chains are gone; its bin clip stays.
    let b_bin = three
        .bin_clips()
        .into_iter()
        .find(|b| b.resource == "b.mp4")
        .unwrap();
    let chains_left = out
        .tree
        .nodes
        .iter()
        .filter(|n| n.name == "chain" && n.text.is_empty())
        .count();
    assert!(out.bin_clip(&b_bin.kdenlive_id).is_some());
    assert!(
        chains_left
            < three
                .tree
                .nodes
                .iter()
                .filter(|n| n.name == "chain")
                .count()
    );
    assert_eq!(out.max_id_number("chain"), chains_before);
}

#[test]
fn a_crossfade_made_in_kdenlive_keeps_its_clips_together() {
    let doc = empty_project();
    let fps = doc.fps;
    let three = apply(
        &doc,
        &[
            new(media("a.mp4", 2.0, fps)),
            new(media("b.mp4", 2.0, fps)),
            new(media("c.mp4", 2.0, fps)),
        ],
    )
    .unwrap()
    .text;
    // A mix into clip 3 (at 4 s), as a transition inside the V1 tractor.
    let d = reparse(three.clone());
    let v1 = d.tree.node(d.tracks[d.main_video].tractor);
    let mix = format!(
        "\n  <transition id=\"transition99\" in=\"{}\" out=\"{}\">\n   <property name=\"mlt_service\">luma</property>\n  </transition>",
        fps.timecode(240),
        fps.timecode(269)
    );
    let mut text = three.clone();
    let last_child = d.tree.node(*v1.children.last().unwrap()).span.end;
    text.insert_str(last_child, &mix);
    let doc = reparse(text);
    assert_eq!(doc.mixes(doc.main_video).len(), 1);
    // Moving 3 away from 2 is refused, saying why.
    let err = apply(&doc, &[keep(2), keep(0), keep(1)]).err().unwrap();
    assert!(err.contains("Clips 2 and 3"), "{err}");
    // Trimming clip 1 moves the mix with its clips.
    let trimmed = Placement {
        source: Source::Existing(0),
        in_frame: Some(fps.frames(1.0)),
        out_frame: None,
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let out = reparse(apply(&doc, &[trimmed, keep(1), keep(2)]).unwrap().text);
    let m = &out.mixes(out.main_video)[0];
    assert_eq!(m.in_frame, 240 - 60);
    assert!(out
        .text
        .contains("<property name=\"mlt_service\">luma</property>"));
}

#[test]
fn an_end_past_the_clip_is_clamped_and_said() {
    let doc = empty_project();
    let fps = doc.fps;
    let p = Placement {
        source: Source::New(media("a.mp4", 2.0, fps)),
        in_frame: None,
        out_frame: Some(fps.frames(9.0)),
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let out = apply(&doc, &[p]).unwrap();
    assert!(out.notes.iter().any(|n| n.contains("past the clip's end")));
    assert_eq!(reparse(out.text).items()[0].any().out_frame, 119);
}

#[test]
fn other_document_versions_are_read_but_not_edited() {
    let text = fixture("intro-plus-obs.kdenlive").replace(
        "<property name=\"kdenlive:docproperties.version\">1.1</property>",
        "<property name=\"kdenlive:docproperties.version\">1.2</property>",
    );
    let doc = Doc::parse(text).unwrap();
    let err = apply(&doc, &current(&doc)).err().unwrap();
    assert!(err.contains("document version 1.2"));
    assert!(summary(&doc, "/videos", Path::new("/videos/p.kdenlive"))
        .read_only
        .is_some());
}

#[test]
fn a_profile_change_rewrites_the_profile_only() {
    let doc = obs_project();
    let text = set_profile(&doc, "1440p60").unwrap();
    let after = reparse(text);
    assert_eq!((after.width, after.height, after.fps.num), (2560, 1440, 60));
    assert_eq!(
        after
            .tree
            .property(after.bin, "kdenlive:docproperties.profile"),
        Some("qhd_1440p_60")
    );
}

#[test]
fn the_file_hash_is_kdenlives() {
    use md5::{Digest, Md5};
    let dir = crate::test_util::temp_dir("kdenlive_hash");
    let small: Vec<u8> = (0..1_000_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(dir.join("small"), &small).unwrap();
    assert_eq!(
        file_hash(&dir.join("small")).unwrap(),
        crate::hash_util::hex(&Md5::digest(&small))
    );
    let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 253) as u8).collect();
    std::fs::write(dir.join("big"), &big).unwrap();
    let mut both = big[..1_000_000].to_vec();
    both.extend_from_slice(&big[2_000_000..]);
    assert_eq!(
        file_hash(&dir.join("big")).unwrap(),
        crate::hash_util::hex(&Md5::digest(&both))
    );
}

#[test]
fn paths_are_written_with_forward_slashes() {
    assert_eq!(mlt_path(Path::new("/videos/show")), "/videos/show");
    #[cfg(windows)]
    assert_eq!(
        mlt_path(Path::new(r"C:\Users\me\Videos")),
        "C:/Users/me/Videos"
    );
}

/// Builds a two-clip project from generated media and has melt render it,
/// then Kdenlive itself when it is installed.
/// `cargo test -- --ignored kdenlive_accepts --nocapture`
#[tokio::test]
#[ignore = "needs ffmpeg and melt (and Kdenlive for the second half)"]
async fn kdenlive_accepts() {
    let dir = crate::test_util::temp_dir("kdenlive_accepts");
    let make = |name: &str, color: &str| {
        let status = crate::test_util::host_command("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:s=640x360:r=60:d=2"))
            .args([
                "-f",
                "lavfi",
                "-i",
                "sine=f=440:d=2",
                "-shortest",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
            ])
            .arg(dir.join(name))
            .status()
            .unwrap();
        assert!(status.success());
    };
    make("a.mp4", "red");
    make("b.mp4", "blue");
    let doc = Doc::parse(template_text("1080p60", &dir).unwrap()).unwrap();
    let fps = doc.fps;
    let m = |name: &str| {
        let mut m = media(name, 2.0, fps);
        m.file_hash = file_hash(&dir.join(name)).unwrap();
        m.file_size = std::fs::metadata(dir.join(name)).unwrap().len();
        m
    };
    let text = apply(&doc, &[new(m("a.mp4")), new(m("b.mp4"))])
        .unwrap()
        .text;
    let project = dir.join("golden.kdenlive");
    std::fs::write(&project, &text).unwrap();
    melt_loads("melt", &project).await.unwrap();
    let out = dir.join("melt.mp4");
    let status = crate::test_util::host_command("melt")
        .arg(&project)
        .arg("-consumer")
        .arg(format!("avformat:{}", out.display()))
        .args(["vcodec=libx264", "acodec=aac"])
        .status()
        .unwrap();
    assert!(status.success() && out.metadata().unwrap().len() > 0);
    println!("project: {}", project.display());
    if crate::test_util::host_command("kdenlive")
        .arg("--version")
        .output()
        .is_ok()
    {
        let kout = dir.join("kdenlive.mp4");
        let status = crate::test_util::host_command("kdenlive")
            .env("QT_QPA_PLATFORM", "offscreen")
            .arg(&project)
            .arg(&kout)
            .arg("--render")
            .status()
            .unwrap();
        assert!(status.success(), "kdenlive --render failed");
        assert!(
            kout.metadata().map(|m| m.len() > 0).unwrap_or(false),
            "kdenlive wrote nothing"
        );
    }
}

/// Trim a copy of a real project and have melt load it.
/// `HARUSPEX_KDENLIVE_PROJECT=/path/p.kdenlive cargo test -- --ignored trim_a_real_project --nocapture`
#[tokio::test]
#[ignore = "needs melt and a real project"]
async fn trim_a_real_project() {
    let src = std::env::var("HARUSPEX_KDENLIVE_PROJECT").expect("set HARUSPEX_KDENLIVE_PROJECT");
    let doc = open(Path::new(&src)).unwrap();
    let mut wanted = current(&doc);
    wanted[0].in_frame = Some(doc.fps.frames(10.0));
    let out = apply(&doc, &wanted).unwrap();
    let dir = crate::test_util::temp_dir("real_trim");
    let copy = dir.join("trimmed.kdenlive");
    std::fs::write(&copy, &out.text).unwrap();
    melt_loads("melt", &copy).await.unwrap();
    let changed = out.text.len() as i64 - doc.text.len() as i64;
    println!("notes: {:?}; size change {changed} bytes", out.notes);
    let after = Doc::parse(out.text).unwrap();
    println!("{:#?}", summary(&after, &doc.root_dir, &copy).items);
}

#[test]
fn a_clip_split_in_two_keeps_its_effect_in_both_pieces() {
    let doc = empty_project();
    let fps = doc.fps;
    let text = apply(&doc, &[new(media("a.mp4", 10.0, fps))]).unwrap().text;
    // An effect on its video entry, as in the trim test above.
    let effect = "<filter id=\"filter99\">\n    <property name=\"mlt_service\">brightness</property>\n   </filter>\n   ";
    let d = reparse(text.clone());
    let v = d.items()[0].video.clone().unwrap();
    let mut with_effect = text;
    with_effect.insert_str(d.tree.node(v.node).inner_start + 4, effect);
    let doc = reparse(with_effect);
    let first = Placement {
        source: Source::Existing(0),
        in_frame: Some(0),
        out_frame: Some(119),
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let second = Placement {
        source: Source::Piece(0),
        in_frame: Some(300),
        out_frame: Some(599),
        mix_in: None,
        gain_db: None,
        limiter: false,
        fit: None,
        gain_ranges: None,
        speed: None,
    };
    let out = reparse(apply(&doc, &[first, second]).unwrap().text);
    let items = out.items();
    assert_eq!(items.len(), 2);
    assert_eq!((items[1].start(), items[1].any().in_frame), (120, 300));
    assert!(items
        .iter()
        .all(|i| i.video.is_some() && i.audio.is_some() && i.filters() == 1));
    // Each piece has chains of its own, and both are linked.
    assert_ne!(
        items[0].video.as_ref().unwrap().chain,
        items[1].video.as_ref().unwrap().chain
    );
    assert_eq!(out.groups().as_array().unwrap().len(), 2);
    assert_eq!(apply(&out, &current(&out)).unwrap().text, out.text);
}

/// The user's reference project: clips on V2/A2, one 1 s mix made in
/// Kdenlive, and Volume effects on two clips' sound.
fn mix_fixture() -> Doc {
    Doc::parse(fixture("mix-26.08.kdenlive")).unwrap()
}

/// The same with its tracks reordered so those clips are the main track
/// (V1 / A1), and the groups' track numbers moved to match.
fn mix_on_main() -> Doc {
    let text = fixture("mix-26.08.kdenlive")
        .replace(
            "  <track producer=\"tractor0\"/>\n  <track producer=\"tractor1\"/>\n  <track producer=\"tractor2\"/>\n  <track producer=\"tractor3\"/>",
            "  <track producer=\"tractor1\"/>\n  <track producer=\"tractor0\"/>\n  <track producer=\"tractor3\"/>\n  <track producer=\"tractor2\"/>",
        )
        .replace("\"data\": \"3:", "\"data\": \"2:")
        .replace("\"data\": \"0:", "\"data\": \"1:");
    let doc = Doc::parse(text).unwrap();
    assert_eq!(
        doc.items().len(),
        5,
        "the reorder put the clips on the main track"
    );
    doc
}

#[test]
fn kdenlives_own_mix_and_effects_read_as_the_users() {
    let doc = mix_fixture();
    // Its clips are on V2/A2: nothing on the main track, all of it elsewhere.
    assert!(doc.items().is_empty());
    let s = summary(&doc, "/videos", Path::new("/videos/mix.kdenlive"));
    assert!(s.other_clips.iter().any(|c| c.track == "V2"));
    assert_eq!(apply(&doc, &current(&doc)).unwrap().text, doc.text);

    let doc = mix_on_main();
    let items = doc.items();
    let mixes = doc.mixes(doc.main_audio);
    assert_eq!(mixes.len(), 1);
    assert!(!mixes[0].ours);
    // The mix overlaps clips 2 and 3 by its whole length (30 frames, 1 s).
    assert_eq!(items[1].end() - items[2].start(), 30);
    assert_eq!(mixes[0].in_frame, items[2].start());
    // The Volume effects are inside the entries, and are the user's.
    assert_eq!(items[0].filters(), 1);
    assert!(doc
        .our_gain(items[0].audio.as_ref().unwrap().node)
        .is_none());
    assert_eq!(apply(&doc, &current(&doc)).unwrap().text, doc.text);
}

#[test]
fn a_trim_moves_the_users_mix_and_keeps_its_effects() {
    let doc = mix_on_main();
    let fps = doc.fps;
    let mut wanted = current(&doc);
    wanted[0].in_frame = Some(fps.frames(1.0));
    let out = reparse(apply(&doc, &wanted).unwrap().text);
    let items = out.items();
    assert_eq!(items.len(), 5);
    let mix = &out.mixes(out.main_audio)[0];
    assert_eq!(mix.in_frame, items[2].start());
    assert_eq!(
        items[1].end() - items[2].start(),
        30,
        "still overlapping by the mix"
    );
    assert_eq!(out.mixes(out.main_video)[0].in_frame, items[2].start());
    assert_eq!(
        items[0].filters() + items[1].filters(),
        2,
        "the user's Volume effects stay"
    );
    // Moving clip 3 away from clip 2 is refused.
    let mut moved = current(&out);
    let third = moved.remove(2);
    moved.insert(0, third);
    assert!(apply(&out, &moved)
        .unwrap_err()
        .contains("crossfade made in Kdenlive"));
}

#[test]
fn haruspex_gain_is_one_tagged_filter_beside_the_users() {
    let doc = mix_on_main();
    let mut wanted = current(&doc);
    wanted[0].gain_db = Some(2.5);
    wanted[3].gain_db = Some(-4.0);
    let once = reparse(apply(&doc, &wanted).unwrap().text);
    let items = once.items();
    let a0 = items[0].audio.as_ref().unwrap().node;
    assert_eq!(once.our_gain(a0).map(|(_, g)| g), Some(2.5));
    assert_eq!(
        items[0].filters(),
        1,
        "the user's Volume; Haruspex's isn't the user's"
    );
    assert_eq!(once.our_filters(a0).len(), 1);
    assert_eq!(
        once.our_gain(items[3].audio.as_ref().unwrap().node)
            .map(|(_, g)| g),
        Some(-4.0)
    );
    assert!(once
        .text
        .contains("<property name=\"level\">00:00:00.000=2.5</property>"));
    // Leaving gains alone changes nothing; setting one again replaces it.
    assert_eq!(apply(&once, &current(&once)).unwrap().text, once.text);
    let mut again = current(&once);
    again[0].gain_db = Some(1.0);
    let twice = reparse(apply(&once, &again).unwrap().text);
    let a0 = twice.items()[0].audio.as_ref().unwrap().node;
    assert_eq!(twice.our_gain(a0).map(|(_, g)| g), Some(1.0));
    assert_eq!(twice.our_filters(a0).len(), 1, "replaced, not added");
    // Zero removes it.
    let mut off = current(&twice);
    off[0].gain_db = Some(0.0);
    let gone = reparse(apply(&twice, &off).unwrap().text);
    assert!(gone
        .our_gain(gone.items()[0].audio.as_ref().unwrap().node)
        .is_none());
    assert!(gone
        .our_filters(gone.items()[0].audio.as_ref().unwrap().node)
        .is_empty());
    assert_eq!(gone.items()[0].filters(), 1);
}

#[test]
fn crossfades_overlap_alternate_lanes_and_come_off_again() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut wanted: Vec<Placement> = ["a.mp4", "b.mp4", "c.mp4"]
        .iter()
        .map(|n| new(media(n, 4.0, fps)))
        .collect();
    wanted[1].mix_in = Some(30);
    wanted[2].mix_in = Some(30);
    let out = reparse(apply(&doc, &wanted).unwrap().text);
    let items = out.items();
    assert_eq!(
        items.iter().map(Item::start).collect::<Vec<_>>(),
        [0, 210, 420]
    );
    let lanes: Vec<usize> = items
        .iter()
        .map(|i| i.video.as_ref().unwrap().lane)
        .collect();
    assert_eq!(lanes, [0, 1, 0]);
    for track in [out.main_video, out.main_audio] {
        let mixes = out.mixes(track);
        assert_eq!(mixes.len(), 2);
        assert!(mixes.iter().all(|m| m.ours));
        assert_eq!((mixes[0].in_frame, mixes[0].out_frame), (210, 240));
    }
    // Kdenlive's shape: luma on video, mix on audio, centred, reversed coming into lane A.
    assert!(out
        .text
        .contains("<property name=\"mlt_service\">luma</property>"));
    assert!(out
        .text
        .contains("<property name=\"kdenlive:mixcut\">15</property>"));
    let rev: Vec<&str> = out
        .mixes(out.main_audio)
        .iter()
        .map(|m| out.tree.property(m.node, "reverse").unwrap())
        .collect();
    assert_eq!(rev, ["0", "1"]);
    // Carried over unchanged; then taken off.
    assert_same(&apply(&out, &current(&out)).unwrap().text, &out.text);
    let plain: Vec<Placement> = (0..3).map(keep).collect();
    let off = reparse(apply(&out, &plain).unwrap().text);
    assert!(off.mixes(off.main_video).is_empty() && off.mixes(off.main_audio).is_empty());
    assert_eq!(
        off.items().iter().map(Item::start).collect::<Vec<_>>(),
        [0, 240, 480]
    );
}

#[test]
fn a_crossfade_longer_than_half_a_clip_is_shortened() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut wanted = vec![new(media("a.mp4", 1.0, fps)), new(media("b.mp4", 4.0, fps))];
    wanted[1].mix_in = Some(fps.frames(3.0));
    let out = apply(&doc, &wanted).unwrap();
    assert!(out.notes.iter().any(|n| n.contains("shortened")));
    let d = reparse(out.text);
    assert_eq!(d.items()[1].start(), 60 - 30);
}

/// A project with Haruspex's crossfade and gain, rendered by melt and by
/// Kdenlive: the two must agree on length and loudness, which they can only
/// if Kdenlive read the mix and the Volume filter the way melt does.
/// `cargo test -- --ignored kdenlive_reads_crossfades_and_gains --nocapture`
#[tokio::test]
#[ignore = "needs ffmpeg, melt and Kdenlive"]
async fn kdenlive_reads_crossfades_and_gains() {
    let dir = crate::test_util::temp_dir("kdenlive_mixes");
    for (name, color, volume) in [
        ("a.mp4", "red", "0.2"),
        ("b.mp4", "blue", "0.8"),
        ("c.mp4", "green", "0.1"),
    ] {
        let ok = crate::test_util::host_command("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("color=c={color}:s=640x360:r=60:d=3"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("sine=f=440:d=3,volume={volume}"))
            .args(["-shortest", "-c:v", "libx264", "-c:a", "aac"])
            .arg(dir.join(name))
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }
    let doc = Doc::parse(template_text("1080p60", &dir).unwrap()).unwrap();
    let fps = doc.fps;
    let mut wanted: Vec<Placement> = ["a.mp4", "b.mp4", "c.mp4"]
        .iter()
        .map(|n| {
            let mut m = media(n, 3.0, fps);
            m.file_hash = file_hash(&dir.join(n)).unwrap();
            new(m)
        })
        .collect();
    wanted[1].mix_in = Some(30);
    wanted[2].gain_db = Some(12.0);
    let project = dir.join("mixes.kdenlive");
    std::fs::write(&project, apply(&doc, &wanted).unwrap().text).unwrap();
    let render = |cmd: &mut std::process::Command| assert!(cmd.status().unwrap().success());
    let melt_out = dir.join("melt.mp4");
    render(
        crate::test_util::host_command("melt")
            .arg(&project)
            .arg("-consumer")
            .arg(format!("avformat:{}", melt_out.display()))
            .args(["vcodec=libx264", "acodec=aac", "ab=192k"]),
    );
    let kd_out = dir.join("kdenlive.mp4");
    render(
        crate::test_util::host_command("kdenlive")
            .env("QT_QPA_PLATFORM", "offscreen")
            .arg(&project)
            .arg(&kd_out)
            .arg("--render"),
    );
    let info = |f: &Path| {
        let rt = tokio::runtime::Handle::current();
        let _ = rt;
        f.to_path_buf()
    };
    let (m, k) = (info(&melt_out), info(&kd_out));
    let mi = crate::video::probe::probe_file("ffprobe", &m, "m".into())
        .await
        .unwrap();
    let ki = crate::video::probe::probe_file("ffprobe", &k, "k".into())
        .await
        .unwrap();
    let ml = crate::video::check::measure("ffmpeg", &m).await.unwrap();
    let kl = crate::video::check::measure("ffmpeg", &k).await.unwrap();
    println!(
        "melt {:.3}s {:?}\nkdenlive {:.3}s {:?}\n{}",
        mi.duration_secs,
        ml,
        ki.duration_secs,
        kl,
        project.display()
    );
    // 3 + 3 + 3 seconds less the 0.5 s crossfade.
    assert!((mi.duration_secs - 8.5).abs() < 0.1, "{}", mi.duration_secs);
    assert!((ki.duration_secs - mi.duration_secs).abs() < 0.1);
    assert!(
        (kl.lufs - ml.lufs).abs() < 0.5,
        "loudness differs: {} vs {}",
        kl.lufs,
        ml.lufs
    );
    // Kept for a look in Kdenlive's window.
    let keep = std::env::temp_dir().join("haruspex-mixes-check");
    let _ = std::fs::remove_dir_all(&keep);
    std::fs::create_dir_all(&keep).unwrap();
    for f in ["a.mp4", "b.mp4", "c.mp4", "mixes.kdenlive"] {
        std::fs::copy(dir.join(f), keep.join(f)).unwrap();
    }
}

#[test]
fn a_limiter_follows_the_gain_and_goes_with_it() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut p = new(media("a.mp4", 4.0, fps));
    p.gain_db = Some(16.8);
    p.limiter = true;
    let out = reparse(apply(&doc, &[p]).unwrap().text);
    let a = out.items()[0].audio.as_ref().unwrap().node;
    let ours = out.our_filters(a);
    let services: Vec<&str> = ours
        .iter()
        .map(|&f| out.tree.property(f, "mlt_service").unwrap())
        .collect();
    assert_eq!(services, ["volume", "avfilter.alimiter"]);
    assert_eq!(out.tree.property(ours[1], "av.limit"), Some("0.841"));
    assert!(out.our_limiter(a));
    assert_eq!(out.items()[0].filters(), 0, "neither counts as the user's");
    let s = summary(&out, "/videos", Path::new("/videos/p.kdenlive"));
    assert!(s.items[0].limited);
    // A gain without a limiter takes the limiter away.
    let mut plain = current(&out);
    plain[0].gain_db = Some(3.0);
    let after = reparse(apply(&out, &plain).unwrap().text);
    let a = after.items()[0].audio.as_ref().unwrap().node;
    assert!(!after.our_limiter(a));
    assert_eq!(after.our_gain(a).map(|(_, g)| g), Some(3.0));
}

const CROP: Fit = Fit::Crop {
    x: 0.25,
    y: 0.0,
    w: 0.5,
    h: 1.0,
};

fn video_node(doc: &Doc, i: usize) -> usize {
    doc.items()[i].video.as_ref().unwrap().node
}

#[test]
fn a_fit_is_one_tagged_crop_on_the_picture_and_comes_off_again() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut a = new(media("a.mp4", 4.0, fps));
    a.fit = Some(Fit::Fill);
    a.gain_db = Some(2.0);
    let b = new(media("b.mp4", 4.0, fps));
    let once = reparse(apply(&doc, &[a, b]).unwrap().text);
    let v0 = video_node(&once, 0);
    assert_eq!(once.our_fit(v0), Some(Fit::Fill));
    assert!(once.our_fit(video_node(&once, 1)).is_none());
    // On the picture only: the sound keeps just its gain.
    let a0 = once.items()[0].audio.as_ref().unwrap().node;
    assert!(once.our_fit_filter(a0).is_none());
    assert_eq!(once.our_gain(a0).map(|(_, g)| g), Some(2.0));
    assert!(once
        .text
        .contains("<property name=\"kdenlive_id\">crop</property>"));
    assert_eq!(once.items()[0].filters(), 0, "the crop isn't the user's");
    let s = summary(&once, "/videos", Path::new("/videos/p.kdenlive"));
    assert_eq!(s.items[0].fit, Some(Fit::Fill));
    assert_eq!(s.items[1].fit, None);
    // Leaving it alone changes nothing; a crop replaces it; a new gain keeps it.
    assert_eq!(apply(&once, &current(&once)).unwrap().text, once.text);
    let mut again = current(&once);
    again[0].fit = Some(CROP);
    again[0].gain_db = Some(-1.0);
    let twice = reparse(apply(&once, &again).unwrap().text);
    let v0 = video_node(&twice, 0);
    assert_eq!(twice.our_fit(v0), Some(CROP));
    assert_eq!(twice.our_filters(v0).len(), 1, "replaced, not added");
    let mut regain = current(&twice);
    regain[0].gain_db = Some(3.0);
    let regained = reparse(apply(&twice, &regain).unwrap().text);
    assert_eq!(regained.our_fit(video_node(&regained, 0)), Some(CROP));
    // Letterbox removes it.
    let mut off = current(&regained);
    off[0].fit = Some(Fit::Letterbox);
    let gone = reparse(apply(&regained, &off).unwrap().text);
    assert!(gone.our_fit_filter(video_node(&gone, 0)).is_none());
}

#[test]
fn both_pieces_of_a_split_clip_keep_its_fit() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut a = new(media("a.mp4", 10.0, fps));
    a.fit = Some(CROP);
    let doc = reparse(apply(&doc, &[a]).unwrap().text);
    let first = Placement {
        out_frame: Some(119),
        ..keep(0)
    };
    let second = Placement {
        in_frame: Some(300),
        ..Placement::of(Source::Piece(0))
    };
    let out = reparse(apply(&doc, &[first, second]).unwrap().text);
    assert_eq!(out.our_fit(video_node(&out, 0)), Some(CROP));
    assert_eq!(out.our_fit(video_node(&out, 1)), Some(CROP));
}

/// melt, when it and the ffmpeg and ffprobe these tests make clips with are
/// all here.
async fn melt() -> Option<String> {
    if !crate::test_util::host_has("ffmpeg") || !crate::test_util::host_has("ffprobe") {
        return None;
    }
    crate::video::binaries::resolve(&Default::default())
        .await
        .melt
        .map(|m| m.path)
}

#[tokio::test]
async fn melt_loads_a_kdenlive_project_with_fits() {
    let Some(melt) = melt().await else {
        eprintln!("skipped: no melt, ffmpeg or ffprobe");
        return;
    };
    let dir = crate::test_util::temp_dir("kdenlive_fits");
    let status = crate::test_util::host_command("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg("color=c=red:s=360x640:r=60:d=1")
        .args(["-c:v", "mpeg4"])
        .arg(dir.join("tall.mp4"))
        .status()
        .unwrap();
    assert!(status.success());
    let doc = Doc::parse(template_text("1080p60", &dir).unwrap()).unwrap();
    let fps = doc.fps;
    let clips: Vec<Placement> = [Some(Fit::Fill), Some(CROP), None]
        .into_iter()
        .map(|fit| {
            let mut m = media("tall.mp4", 1.0, fps);
            m.audio_index = None;
            Placement { fit, ..new(m) }
        })
        .collect();
    let text = apply(&doc, &clips).unwrap().text;
    let project = dir.join("fits.kdenlive");
    std::fs::write(&project, &text).unwrap();
    melt_loads(&melt, &project).await.unwrap();
}

#[test]
fn gain_ranges_go_on_the_sound_beside_its_gain_and_come_off_again() {
    let doc = empty_project();
    let fps = doc.fps;
    let mute = GainRange {
        from_frame: 60,
        to_frame: 89,
        gain_db: -70.0,
    };
    let mut a = new(media("a.mp4", 4.0, fps));
    a.gain_db = Some(2.0);
    a.gain_ranges = Some(vec![mute]);
    let once = reparse(apply(&doc, &[a]).unwrap().text);
    let a0 = once.items()[0].audio.as_ref().unwrap().node;
    assert_eq!(once.our_gain_ranges(a0), vec![mute]);
    assert_eq!(once.our_gain(a0).map(|(_, g)| g), Some(2.0));
    assert!(once.our_gain_ranges(video_node(&once, 0)).is_empty());
    assert_eq!(once.items()[0].filters(), 0);
    assert_eq!(apply(&once, &current(&once)).unwrap().text, once.text);
    // A new gain keeps them; a trim keeps them where they were in the clip.
    let mut again = current(&once);
    again[0].gain_db = Some(-1.0);
    again[0].in_frame = Some(30);
    let twice = reparse(apply(&once, &again).unwrap().text);
    let a0 = twice.items()[0].audio.as_ref().unwrap().node;
    assert_eq!(twice.our_gain_ranges(a0), vec![mute]);
    let mut off = current(&twice);
    off[0].gain_ranges = Some(Vec::new());
    let gone = reparse(apply(&twice, &off).unwrap().text);
    let a0 = gone.items()[0].audio.as_ref().unwrap().node;
    assert!(gone.our_range_filters(a0).is_empty());
    assert_eq!(gone.our_gain(a0).map(|(_, g)| g), Some(-1.0));
}

#[tokio::test]
async fn melt_mutes_a_kdenlive_gain_range() {
    let Some(melt) = melt().await else {
        eprintln!("skipped: no melt, ffmpeg or ffprobe");
        return;
    };
    let dir = crate::test_util::temp_dir("kdenlive_range");
    let status = crate::test_util::host_command("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg("color=c=gray:s=320x180:r=60:d=3")
        .args(["-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest"])
        .args(["-c:v", "mpeg4", "-c:a", "pcm_s16le"])
        .arg(dir.join("tone.mov"))
        .status()
        .unwrap();
    assert!(status.success());
    let doc = Doc::parse(template_text("1080p60", &dir).unwrap()).unwrap();
    let fps = doc.fps;
    let mut clip = new(media("tone.mov", 3.0, fps));
    clip.in_frame = Some(30);
    // 1.0–1.5 s of the clip's own time: 0.5–1.0 s into the cut.
    clip.gain_ranges = Some(vec![GainRange {
        from_frame: 60,
        to_frame: 89,
        gain_db: -70.0,
    }]);
    let text = apply(&doc, &[clip]).unwrap().text;
    let project = dir.join("range.kdenlive");
    std::fs::write(&project, &text).unwrap();
    melt_loads(&melt, &project).await.unwrap();
    let out = dir.join("range.wav");
    let mut cmd = tokio::process::Command::new(&melt);
    cmd.arg(&project)
        .arg("-consumer")
        .arg(format!("avformat:{}", out.display()))
        .args(["acodec=pcm_s16le", "vn=1"]);
    crate::video::prepare_child(&mut cmd);
    assert!(cmd.status().await.unwrap().success());
    let db = |at: f64| {
        let o = crate::test_util::host_command("ffmpeg")
            .args(["-v", "info", "-ss", &at.to_string(), "-t", "0.3", "-i"])
            .arg(&out)
            .args(["-af", "volumedetect", "-f", "null", "-"])
            .output()
            .unwrap();
        let t = String::from_utf8_lossy(&o.stderr).to_string();
        let i = t.find("mean_volume: ").unwrap() + 13;
        t[i..]
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<f64>()
            .unwrap()
    };
    let (before, muted, after) = (db(0.1), db(0.6), db(1.2));
    assert!(before > -40.0 && after > -40.0, "{before} {after}");
    assert!(muted < -80.0, "muted stretch {muted}");
}

#[test]
fn a_clip_at_half_speed_plays_twice_as_long_on_both_tracks() {
    let doc = empty_project();
    let fps = doc.fps;
    let mut a = new(media("a.mp4", 4.0, fps));
    a.speed = Some(0.5);
    let b = new(media("b.mp4", 2.0, fps));
    let once = reparse(apply(&doc, &[a, b]).unwrap().text);
    let c = clips(&once);
    assert_eq!(c[0].speed, 0.5);
    assert_eq!((c[0].in_frame, c[0].out_frame), (0, 239));
    assert_eq!(c[0].resource, "a.mp4");
    let items = once.items();
    assert_eq!(items[0].end() - items[0].start(), 480, "8 s at 60 fps");
    assert_eq!(items[1].start(), 480, "the next clip follows it");
    for e in [
        items[0].video.as_ref().unwrap(),
        items[0].audio.as_ref().unwrap(),
    ] {
        assert_eq!(once.speed(&e.chain), 0.5);
    }
    assert_eq!(apply(&once, &current(&once)).unwrap().text, once.text);
    // Back to its own speed: chains without the warp.
    let mut back = current(&once);
    back[0].speed = Some(1.0);
    let plain = reparse(apply(&once, &back).unwrap().text);
    assert_eq!(plain.items()[0].end() - plain.items()[0].start(), 240);
    assert_eq!(clips(&plain)[0].speed, 1.0);
}

#[tokio::test]
async fn melt_plays_a_kdenlive_clip_at_half_speed_in_twice_the_time() {
    let Some(melt) = melt().await else {
        eprintln!("skipped: no melt, ffmpeg or ffprobe");
        return;
    };
    let dir = crate::test_util::temp_dir("kdenlive_speed");
    let status = crate::test_util::host_command("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg("color=c=gray:s=320x180:r=60:d=2")
        .args(["-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest"])
        .args(["-c:v", "mpeg4", "-c:a", "pcm_s16le"])
        .arg(dir.join("tone.mov"))
        .status()
        .unwrap();
    assert!(status.success());
    let doc = Doc::parse(template_text("1080p60", &dir).unwrap()).unwrap();
    let fps = doc.fps;
    let mut clip = new(media("tone.mov", 2.0, fps));
    clip.speed = Some(0.5);
    let text = apply(&doc, &[clip]).unwrap().text;
    let project = dir.join("speed.kdenlive");
    std::fs::write(&project, &text).unwrap();
    melt_loads(&melt, &project).await.unwrap();
    let out = dir.join("speed.mov");
    let mut cmd = tokio::process::Command::new(&melt);
    cmd.arg(&project)
        .arg("-consumer")
        .arg(format!("avformat:{}", out.display()))
        .args(["vcodec=mjpeg", "acodec=pcm_s16le"]);
    crate::video::prepare_child(&mut cmd);
    assert!(cmd.status().await.unwrap().success());
    let probe = crate::test_util::host_command("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(&out)
        .output()
        .unwrap();
    let secs: f64 = String::from_utf8_lossy(&probe.stdout)
        .trim()
        .parse()
        .unwrap();
    assert!((secs - 4.0).abs() <= 1.0 / 60.0 + 0.01, "rendered {secs} s");
}
