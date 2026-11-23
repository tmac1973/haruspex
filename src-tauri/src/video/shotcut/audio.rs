//! A Shotcut project's audio tracks: sound under the picture, such as a
//! voiceover or a music bed, each item at a time of its own.
//!
//! Every audio playlist (A1, A2, …) is Haruspex's to edit, as V1 is. An item
//! is an `<entry>` with a `<blank>` before it for the time it starts at; the
//! main tractor mixes each track in with an always-active `mix` transition,
//! as Shotcut does. A track whose items would overlap goes on the next one,
//! and a missing track is added. Unchanged tracks are left byte for byte.

use super::doc::{Doc, Entry, Slot};
use super::edit::{
    chain_length, gain_filter_for, limiter_filter, new_chain, set_length, tc, whole_line,
};
use crate::video::mlt::xml::{escape, Splices};
use crate::video::timeline::{AudioClip, AudioPlacement, AudioSource, Edited};
use std::collections::HashSet;

/// Every audio-track entry: (audio track, `tracks` index, entry), in time order.
fn placed(doc: &Doc) -> Vec<(usize, usize, Entry)> {
    let mut out: Vec<(usize, usize, Entry)> = doc
        .audio_tracks()
        .into_iter()
        .enumerate()
        .flat_map(|(k, t)| doc.track_entries(t).into_iter().map(move |e| (k, t, e)))
        .collect();
    out.sort_by_key(|(k, _, e)| (e.start, *k));
    out
}

fn track_name(doc: &Doc, t: usize, k: usize) -> String {
    let n = &doc.tracks[t].name;
    if n.is_empty() {
        format!("A{}", k + 1)
    } else {
        n.clone()
    }
}

pub fn clips(doc: &Doc) -> Vec<AudioClip> {
    placed(doc)
        .into_iter()
        .map(|(k, t, e)| AudioClip {
            track: k,
            track_name: track_name(doc, t, k),
            resource: doc.resource(&e.chain),
            start: e.start,
            in_frame: e.in_frame,
            out_frame: e.out_frame,
            stream: doc.stream(&e.chain, "audio_index"),
            gain_db: doc.our_gain(&e.chain),
            limited: doc.our_limiter(&e.chain),
            lufs: doc.our_lufs(&e.chain),
        })
        .collect()
}

struct Laid {
    source: AudioSource,
    track: usize,
    chain: String,
    at: i64,
    in_frame: i64,
    out_frame: i64,
    gain_db: Option<f64>,
    limiter: bool,
    lufs: Option<f64>,
}

#[derive(PartialEq)]
enum Want {
    Blank(i64),
    Clip(String, i64, i64),
}

/// The gain and limiter filters for a chain.
fn filters(next_filter: &mut i64, db: f64, limiter: bool, lufs: Option<f64>) -> String {
    let mut out = String::new();
    *next_filter += 1;
    out.push_str(&gain_filter_for(&format!("filter{next_filter}"), db, lufs));
    if limiter {
        *next_filter += 1;
        out.push_str(&limiter_filter(&format!("filter{next_filter}")));
    }
    out
}

/// Make the audio tracks hold `wanted`.
pub fn apply(doc: &Doc, wanted: &[AudioPlacement]) -> Result<Edited, String> {
    doc.editable()?;
    let fps = doc.fps;
    let text = &doc.text;
    let have = placed(doc);
    let tracks = doc.audio_tracks();
    let mut notes = Vec::new();
    let mut next_chain = doc
        .max_id_number("chain")
        .max(doc.max_id_number("producer"));
    let mut next_filter = doc.max_id_number("filter");

    let mut seen = HashSet::new();
    let mut laid: Vec<Laid> = Vec::new();
    for (n, p) in wanted.iter().enumerate() {
        let (default_in, default_out, max_out, chain) = match &p.source {
            AudioSource::Existing(i) => {
                let (_, _, e) = have.get(*i).ok_or_else(|| {
                    format!(
                        "There is no audio item {} (the audio tracks have {}).",
                        i + 1,
                        have.len()
                    )
                })?;
                if !seen.insert(*i) {
                    return Err(format!("Audio item {} is listed twice.", i + 1));
                }
                let max = chain_length(doc, &e.chain).map(|l| l - 1);
                (e.in_frame, e.out_frame, max, e.chain.clone())
            }
            AudioSource::New(m) => {
                next_chain += 1;
                (
                    0,
                    m.length - 1,
                    Some(m.length - 1),
                    format!("chain{next_chain}"),
                )
            }
        };
        let in_frame = p.in_frame.unwrap_or(default_in).max(0);
        let mut out_frame = p.out_frame.unwrap_or(default_out);
        if let Some(max) = max_out.filter(|&m| out_frame > m) {
            notes.push(format!(
                "Audio item {}: the end was past the file's end, so it ends there.",
                n + 1
            ));
            out_frame = max;
        }
        if out_frame < in_frame {
            return Err(format!(
                "Audio item {}: it would end before it starts.",
                n + 1
            ));
        }
        laid.push(Laid {
            source: p.source.clone(),
            track: p.track,
            chain,
            at: p.at.max(0),
            in_frame,
            out_frame,
            gain_db: p.gain_db,
            limiter: p.limiter,
            lufs: p.lufs,
        });
    }

    let mut splices = Splices::default();
    // New chains, before the first playlist that plays a timeline clip.
    let first_playlist = doc
        .tracks
        .iter()
        .map(|t| doc.tree.node(t.node).span.start)
        .min()
        .ok_or("This Shotcut project has no tracks.")?;
    let chains_at = whole_line(text, first_playlist..first_playlist).start;
    let mut chain_text = String::new();
    for l in &laid {
        match &l.source {
            AudioSource::New(m) => {
                let mut c = new_chain(&fps, &l.chain, m);
                if let Some(g) = l.gain_db.filter(|&g| g != 0.0) {
                    let f = filters(&mut next_filter, g, l.limiter, l.lufs);
                    c = c.replacen("  </chain>\n", &format!("{f}  </chain>\n"), 1);
                }
                chain_text.push_str(&c);
            }
            AudioSource::Existing(_) => {
                let Some(g) = l.gain_db else { continue };
                let unchanged = doc.our_gain(&l.chain) == Some(g)
                    && doc.our_limiter(&l.chain) == l.limiter
                    && doc.our_lufs(&l.chain) == l.lufs
                    || g == 0.0 && doc.our_sound_filters(&l.chain).is_empty();
                if unchanged {
                    continue;
                }
                for f in doc.our_sound_filters(&l.chain) {
                    splices.replace(
                        whole_line(text, doc.tree.node(f).span.clone()),
                        String::new(),
                    );
                }
                if g != 0.0 {
                    let node = doc.chain(&l.chain).ok_or("a clip's chain is missing")?;
                    let n = doc.tree.node(node);
                    let line = text[..n.inner_end]
                        .rfind('\n')
                        .map_or(n.inner_end, |i| i + 1);
                    splices.insert(line, filters(&mut next_filter, g, l.limiter, l.lufs));
                }
            }
        }
    }
    if !chain_text.is_empty() {
        splices.insert(chains_at, chain_text);
    }

    // Each track's children: a blank up to each item, then the item.
    let count = laid
        .iter()
        .map(|l| l.track + 1)
        .max()
        .unwrap_or(0)
        .max(tracks.len());
    let mut new_playlists = String::new();
    let mut new_tracks = String::new();
    let mut new_transitions = String::new();
    let mut next_playlist = doc.max_id_number("playlist");
    let mut next_transition = doc.max_id_number("transition");
    let tractor_tracks = doc.tree.children_named(doc.main_tractor, "track").count();
    let mut changed_tracks = Vec::new();
    for k in 0..count {
        let mut on: Vec<&Laid> = laid.iter().filter(|l| l.track == k).collect();
        on.sort_by_key(|l| l.at);
        let mut slots = Vec::new();
        let mut at = 0;
        for l in &on {
            if l.at < at {
                return Err("internal error: overlapping audio items on one track".into());
            }
            if l.at > at {
                slots.push(Want::Blank(l.at - at));
            }
            slots.push(Want::Clip(l.chain.clone(), l.in_frame, l.out_frame));
            at = l.at + l.out_frame - l.in_frame + 1;
        }
        let body = |indent: &str| {
            let mut b = String::new();
            for s in &slots {
                b.push('\n');
                b.push_str(indent);
                match s {
                    Want::Blank(n) => b.push_str(&format!("<blank length=\"{}\"/>", tc(&fps, *n))),
                    Want::Clip(chain, i, o) => b.push_str(&format!(
                        "<entry producer=\"{}\" in=\"{}\" out=\"{}\"/>",
                        escape(chain),
                        tc(&fps, *i),
                        tc(&fps, *o)
                    )),
                }
            }
            b
        };
        if let Some(&t) = tracks.get(k) {
            let current = doc.read_slots(doc.tracks[t].node)?;
            let have: Vec<Want> = current
                .iter()
                .map(|s| match s {
                    Slot::Blank { len, .. } => Want::Blank(*len),
                    Slot::Clip(e) => Want::Clip(e.chain.clone(), e.in_frame, e.out_frame),
                    Slot::Fade(f) => Want::Clip(f.tractor_id.clone(), -1, -1),
                })
                .collect();
            // Trailing blanks change nothing.
            let trimmed = have.len()
                - have
                    .iter()
                    .rev()
                    .take_while(|w| matches!(w, Want::Blank(_)))
                    .count();
            if have[..trimmed] == slots[..] {
                continue;
            }
            let name = track_name(doc, t, k);
            if current.iter().any(|s| matches!(s, Slot::Fade(_))) {
                return Err(format!(
                    "Track {name} has a crossfade made in Shotcut; remove it there first."
                ));
            }
            if doc.tree.property(doc.tracks[t].node, "shotcut:lock") == Some("1") {
                return Err(format!(
                    "Track {name} is locked in Shotcut. Unlock it there and save first."
                ));
            }
            let pl = doc.tree.node(doc.tracks[t].node);
            if pl.self_closing() {
                let open = text[pl.span.clone()].replacen("/>", ">", 1);
                splices.replace(
                    pl.span.clone(),
                    format!("{open}{}\n  </playlist>", body("    ")),
                );
            } else {
                let from = doc
                    .tree
                    .children_named(doc.tracks[t].node, "property")
                    .last()
                    .map_or(pl.inner_start, |p| doc.tree.node(p).span.end);
                splices.replace(from..pl.inner_end, format!("{}\n  ", body("    ")));
            }
            changed_tracks.push(t);
        } else {
            next_playlist += 1;
            let id = format!("playlist{next_playlist}");
            new_playlists.push_str(&format!(
                "  <playlist id=\"{id}\">\n\
                 \x20   <property name=\"shotcut:audio\">1</property>\n\
                 \x20   <property name=\"shotcut:name\">A{}</property>{}\n\
                 \x20 </playlist>\n",
                k + 1,
                body("    ")
            ));
            new_tracks.push_str(&format!("    <track producer=\"{id}\" hide=\"video\"/>\n"));
            next_transition += 1;
            let index = tractor_tracks + (k - tracks.len());
            new_transitions.push_str(&format!(
                "    <transition id=\"transition{next_transition}\">\n\
                 \x20     <property name=\"a_track\">0</property>\n\
                 \x20     <property name=\"b_track\">{index}</property>\n\
                 \x20     <property name=\"mlt_service\">mix</property>\n\
                 \x20     <property name=\"always_active\">1</property>\n\
                 \x20     <property name=\"sum\">1</property>\n\
                 \x20   </transition>\n"
            ));
        }
    }
    if count > tracks.len() {
        let tractor = doc.tree.node(doc.main_tractor).span.clone();
        splices.insert(whole_line(text, tractor).start, new_playlists);
        let last_track = doc
            .tree
            .children_named(doc.main_tractor, "track")
            .last()
            .ok_or("the main tractor has no tracks")?;
        let after_tracks = whole_line(text, doc.tree.node(last_track).span.clone()).end;
        splices.insert(after_tracks, new_tracks);
        let after = doc
            .tree
            .children_named(doc.main_tractor, "transition")
            .last()
            .map_or(after_tracks, |t| {
                whole_line(text, doc.tree.node(t).span.clone()).end
            });
        splices.insert(after, new_transitions);
        notes.push(format!(
            "Added audio track{} for sound that overlaps.",
            if count - tracks.len() == 1 { "" } else { "s" }
        ));
    }

    // Chains of items that went, when nothing else plays them.
    let used: HashSet<&str> = laid.iter().map(|l| l.chain.as_str()).collect();
    let rewritten: Vec<std::ops::Range<usize>> = changed_tracks
        .iter()
        .map(|&t| doc.tree.node(doc.tracks[t].node).span.clone())
        .collect();
    let mut gone = HashSet::new();
    for (_, _, e) in &have {
        if used.contains(e.chain.as_str()) || !gone.insert(e.chain.clone()) {
            continue;
        }
        let elsewhere = doc.tree.nodes.iter().any(|n| {
            n.attr("producer") == Some(e.chain.as_str())
                && !rewritten.iter().any(|r| r.contains(&n.span.start))
        });
        if !elsewhere {
            if let Some(c) = doc.chain(&e.chain) {
                splices.replace(
                    whole_line(text, doc.tree.node(c).span.clone()),
                    String::new(),
                );
            }
        }
    }

    // The timeline covers the longest track.
    let picture_end = (0..doc.tracks.len())
        .filter(|&t| doc.tracks[t].video)
        .map(|t| {
            doc.read_slots(doc.tracks[t].node)
                .unwrap_or_default()
                .iter()
                .map(|s| match s {
                    Slot::Clip(e) => e.start + e.len(),
                    Slot::Fade(f) => f.start + f.len,
                    Slot::Blank { .. } => 0,
                })
                .max()
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    let sound_end = laid
        .iter()
        .map(|l| l.at + l.out_frame - l.in_frame + 1)
        .max()
        .unwrap_or(0);
    let total = picture_end.max(sound_end).max(1);
    if total != doc.sequence_end().max(1) {
        set_length(doc, &mut splices, total);
    }
    Ok(Edited {
        text: splices.apply(text)?,
        notes,
    })
}
