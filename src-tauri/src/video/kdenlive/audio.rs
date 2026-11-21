//! A Kdenlive project's audio tracks above A1: sound under the picture, such
//! as a voiceover or a music bed, each item at a time of its own.
//!
//! A1 carries the main track's sound; the audio tracks above it (A2, A3, …)
//! are Haruspex's to edit, as V1 is. Their items go on each track's first
//! playlist with a `<blank>` before each for the time it starts at. Kdenlive
//! projects get no new tracks here: one that needs more says to add one.

use super::doc::{Doc, Entry};
use super::edit::{
    entry_text, groups_text, line_of, remap_groups, rewrite_playlist, set_attrs, set_property,
    set_sequence_length, BinAdds, GainWrite, Lane,
};
use crate::video::timeline::{AudioClip, AudioPlacement, AudioSource, Edited};
use std::collections::{HashMap, HashSet};

fn name(k: usize) -> String {
    format!("A{}", k + 2)
}

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

fn stream(doc: &Doc, chain: &str) -> Option<u32> {
    let v = doc
        .tree
        .by_id(chain)
        .and_then(|c| doc.tree.property(c, "audio_index"));
    match v {
        Some(v) => v
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|&i| i >= 0)
            .map(|i| i as u32),
        None => Some(1),
    }
}

pub fn clips(doc: &Doc) -> Vec<AudioClip> {
    placed(doc)
        .into_iter()
        .map(|(k, _, e)| AudioClip {
            track: k,
            track_name: name(k),
            resource: doc
                .tree
                .by_id(&e.chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .unwrap_or("")
                .to_string(),
            start: e.start,
            in_frame: e.in_frame,
            out_frame: e.out_frame,
            stream: stream(doc, &e.chain),
            gain_db: doc.our_gain(e.node).map(|(_, g)| g),
            limited: doc.our_limiter(e.node),
            lufs: doc.our_lufs(e.node),
        })
        .collect()
}

/// Make the audio tracks above A1 hold `wanted`.
pub fn apply(doc: &Doc, wanted: &[AudioPlacement]) -> Result<Edited, String> {
    doc.editable()?;
    let fps = doc.fps;
    let have = placed(doc);
    let tracks = doc.audio_tracks();
    let mut notes = Vec::new();
    let needed = wanted.iter().map(|p| p.track + 1).max().unwrap_or(0);
    if needed > tracks.len() {
        return Err(format!(
            "The sound overlaps itself, so it needs {needed} audio track{} above A1, and this \
             project has {}. Add {} in Kdenlive (right-click a track → Insert Track) and save, \
             then cut again.",
            if needed == 1 { "" } else { "s" },
            tracks.len(),
            if needed - tracks.len() == 1 {
                "one"
            } else {
                "more"
            }
        ));
    }
    let mut splices = crate::video::mlt::xml::Splices::default();
    let mut next_id = doc.max_kdenlive_id() + 1;
    let mut next_chain = doc.max_id_number("chain") + 1;
    let mut next_filter = doc.max_nested_id("filter") + 1;
    let mut bins = BinAdds::new(doc);
    let mut new_chains = String::new();

    // (track, start, len, entry text, old entry node, in, out)
    let mut lanes: Vec<Lane> = vec![Vec::new(); tracks.len()];
    let mut seen = HashSet::new();
    let mut moves: HashMap<(usize, i64), Option<i64>> = HashMap::new();
    for (_, t, e) in &have {
        moves.insert((*t, e.start), None);
    }
    let mut ends = vec![0i64; tracks.len()];
    for (n, p) in wanted.iter().enumerate() {
        let (old, chain, bin_id, default_in, default_out, max_out) = match &p.source {
            AudioSource::Existing(i) => {
                let (_, t, e) = have.get(*i).ok_or_else(|| {
                    format!(
                        "There is no audio item {} (the audio tracks have {}).",
                        i + 1,
                        have.len()
                    )
                })?;
                if !seen.insert(*i) {
                    return Err(format!("Audio item {} is listed twice.", i + 1));
                }
                let max = doc
                    .bin_clip(&e.bin_id)
                    .map(|b| b.length - 1)
                    .filter(|&l| l >= 0);
                let _ = t;
                (
                    Some(e),
                    e.chain.clone(),
                    e.bin_id.clone(),
                    e.in_frame,
                    e.out_frame,
                    max,
                )
            }
            AudioSource::New(m) => {
                let (kid, uuid) = bins.clip_for(doc, m, &mut next_id, &mut next_chain);
                let id = format!("chain{next_chain}");
                next_chain += 1;
                new_chains.push_str(&super::edit::chain_text(
                    fps,
                    &id,
                    &kid,
                    &uuid,
                    m,
                    Some(true),
                ));
                (None, id, kid, 0, m.length - 1, Some(m.length - 1))
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
        let at = p.at.max(0);
        let len = out_frame - in_frame + 1;
        let gain = p.gain_db.map(|db| {
            let volume_id = format!("filter{next_filter}");
            next_filter += 1;
            let limiter_id = p.limiter.then(|| {
                next_filter += 1;
                format!("filter{}", next_filter - 1)
            });
            GainWrite {
                db,
                volume_id,
                limiter_id,
                lufs: p.lufs,
            }
        });
        // An unchanged gain keeps the entry's filters as they are.
        let gain = match (gain, old) {
            (Some(g), Some(e))
                if doc.our_gain(e.node).map(|(_, d)| d) == Some(g.db)
                    && doc.our_limiter(e.node) == p.limiter
                    && doc.our_lufs(e.node) == p.lufs =>
            {
                None
            }
            (g, _) => g,
        };
        if let Some(e) = old {
            let t = tracks[p.track];
            let from = have.iter().find(|(_, _, h)| h.node == e.node).map(|h| h.1);
            if let Some(from) = from {
                moves.insert((from, e.start), (from == t).then_some(at));
            }
        }
        lanes[p.track].push((
            at,
            len,
            entry_text(doc, fps, in_frame, out_frame, &bin_id, old, &chain, gain),
            old.map(|e| e.node),
            in_frame,
            out_frame,
        ));
        ends[p.track] = ends[p.track].max(at + len);
    }

    for (k, &t) in tracks.iter().enumerate() {
        let lane = &mut lanes[k];
        lane.sort_by_key(|x| x.0);
        if lane.windows(2).any(|w| w[1].0 < w[0].0 + w[0].1) {
            return Err("internal error: overlapping audio items on one track".into());
        }
        let playlists = doc.tracks[t].playlists.clone();
        let before = splices.count();
        let empty: Lane = Vec::new();
        for (n, &pl) in playlists.iter().enumerate() {
            rewrite_playlist(doc, &mut splices, pl, n, if n == 0 { lane } else { &empty });
        }
        if splices.count() != before {
            if doc.mixes(t).iter().any(|m| !m.ours) {
                return Err(format!(
                    "Track {} has a crossfade made in Kdenlive; remove it there first.",
                    name(k)
                ));
            }
            set_attrs(
                doc,
                &mut splices,
                doc.tracks[t].tractor,
                &[("out", fps.timecode((ends[k] - 1).max(0)))],
            );
        }
    }

    // Chains of items that went, when nothing else plays them.
    let kept: HashSet<usize> = wanted
        .iter()
        .filter_map(|p| match p.source {
            AudioSource::Existing(i) => Some(i),
            AudioSource::New(_) => None,
        })
        .collect();
    let all: Vec<Entry> = (0..doc.tracks.len())
        .flat_map(|t| doc.track_entries(t))
        .collect();
    for (i, (_, _, e)) in have.iter().enumerate() {
        if kept.contains(&i) {
            continue;
        }
        let others = all.iter().any(|o| o.chain == e.chain && o.node != e.node);
        if !others {
            if let Some(ch) = doc.tree.by_id(&e.chain) {
                splices.replace(
                    line_of(&doc.text, doc.tree.node(ch).span.clone()),
                    String::new(),
                );
            }
        }
    }
    if !new_chains.is_empty() {
        let first = tracks
            .iter()
            .flat_map(|&t| doc.tracks[t].playlists.iter())
            .map(|&p| doc.tree.node(p).span.start)
            .min()
            .ok_or("the audio tracks have no playlists")?;
        splices.insert(line_of(&doc.text, first..first).start, new_chains);
    }
    bins.write(doc, &mut splices);

    // Groups the user made with these items follow them.
    let mut groups = doc.groups();
    if remap_groups(&mut groups, &moves) {
        set_property(
            doc,
            &mut splices,
            doc.sequence,
            "kdenlive:sequenceproperties.groups",
            &groups_text(&groups),
        );
    }

    let rest = (0..doc.tracks.len())
        .filter(|t| !tracks.contains(t))
        .map(|t| doc.track_end(t))
        .max()
        .unwrap_or(0);
    let total = rest.max(ends.iter().copied().max().unwrap_or(0));
    if total != doc.sequence_end() {
        set_sequence_length(doc, &mut splices, total);
    }
    Ok(Edited {
        text: splices.apply(&doc.text)?,
        notes,
    })
}
