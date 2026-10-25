//! Turning a wanted main track into byte-range edits of the project.
//!
//! The caller says what the main track should hold, in order: existing items
//! by index, possibly re-trimmed, and new clips by their probed media. This
//! works out the timeline from that, and changes only what it must:
//!
//! - the main track's playlists, and only those whose clips changed;
//! - the per-track chains of clips it adds or removes;
//! - a bin clip for media not in the bin yet;
//! - group leaves pointing at main-track clips that moved, and an `AVSplit`
//!   group for each clip it adds;
//! - the start of each same-track mix whose clips moved;
//! - the sequence's lengths.
//!
//! Everything else in the file is left as it was. A kept item keeps its whole
//! `<entry>`, effects included; only its `in` and `out` change.

use super::doc::{parse_leaf, Doc, Entry, Fps, Item};
use super::xml::{escape, Splices};
use std::collections::{HashMap, HashSet};

/// Media a new clip comes from, probed and hashed by the caller.
#[derive(Clone, Debug, PartialEq)]
pub struct Media {
    /// As the project's `resource` will say: relative to its root when inside
    /// it, absolute otherwise, forward slashes either way.
    pub resource: String,
    /// In project frames.
    pub length: i64,
    pub video_index: Option<u32>,
    pub audio_index: Option<u32>,
    pub file_size: u64,
    pub file_hash: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// The main-track item with this index in `Doc::items`.
    Existing(usize),
    New(Media),
}

/// One clip of the wanted main track. `None` keeps an existing item's point,
/// or is the start / end of new media.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub source: Source,
    pub in_frame: Option<i64>,
    pub out_frame: Option<i64>,
}

pub struct Edited {
    pub text: String,
    /// Things worth telling the model (a clamped trim, other tracks).
    pub notes: Vec<String>,
}

/// A clip as laid out: where each of its entries goes.
struct Laid {
    source: Source,
    start: i64,
    in_frame: i64,
    out_frame: i64,
    /// Lanes for the video and audio entries.
    video_lane: usize,
    audio_lane: usize,
    /// Set for a new clip once its chains are named.
    video_chain: Option<String>,
    audio_chain: Option<String>,
    bin_id: String,
}

impl Laid {
    fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }

    fn end(&self) -> i64 {
        self.start + self.len()
    }
}

/// The mixes joining main-track items, as `(first item, second item, frames)`.
fn item_mixes(doc: &Doc, items: &[Item]) -> Vec<(usize, usize, i64)> {
    let mut out = Vec::new();
    for track in [doc.main_video, doc.main_audio] {
        for mix in doc.mixes(track) {
            let b = items.iter().position(|i| i.start() == mix.in_frame);
            if let Some(b) = b.filter(|&b| b > 0) {
                // How far the two clips overlap now, which is what the layout
                // must keep; normally the mix's own length.
                let frames = (items[b - 1].end() - items[b].start()).max(0);
                if !out.iter().any(|&(_, ob, _)| ob == b) {
                    out.push((b - 1, b, frames));
                }
            }
        }
    }
    out
}

fn bin_length(doc: &Doc, item: &Item) -> Option<i64> {
    doc.bin_clip(&item.any().bin_id)
        .map(|b| b.length)
        .filter(|&l| l > 0)
}

/// Lay the wanted clips out on the timeline.
fn layout(
    doc: &Doc,
    items: &[Item],
    wanted: &[Placement],
    notes: &mut Vec<String>,
) -> Result<Vec<Laid>, String> {
    let mixes = item_mixes(doc, items);
    let mut seen = HashSet::new();
    for p in wanted {
        if let Source::Existing(i) = p.source {
            if i >= items.len() {
                return Err(format!(
                    "There is no clip {} on the main track (it has {}).",
                    i + 1,
                    items.len()
                ));
            }
            if !seen.insert(i) {
                return Err(format!("Clip {} is listed twice.", i + 1));
            }
        }
    }
    for &(a, b, _) in &mixes {
        let pa = wanted.iter().position(|p| p.source == Source::Existing(a));
        let pb = wanted.iter().position(|p| p.source == Source::Existing(b));
        let together = matches!((pa, pb), (Some(x), Some(y)) if y == x + 1);
        let a_trimmed_end = pa.is_some_and(|x| {
            wanted[x]
                .out_frame
                .is_some_and(|o| o != items[a].any().out_frame)
        });
        let b_trimmed_start = pb.is_some_and(|y| {
            wanted[y]
                .in_frame
                .is_some_and(|i| i != items[b].any().in_frame)
        });
        if !together || a_trimmed_end || b_trimmed_start {
            return Err(format!(
                "Clips {} and {} are joined by a crossfade made in Kdenlive; remove it there first, \
                 or keep them together.",
                a + 1,
                b + 1
            ));
        }
    }

    let mut laid: Vec<Laid> = Vec::new();
    for (pos, p) in wanted.iter().enumerate() {
        let (default_in, default_out, max_out, bin_id, video_lane, audio_lane) = match &p.source {
            Source::Existing(i) => {
                let e = items[*i].any();
                let max = bin_length(doc, &items[*i]).map(|l| l - 1);
                (
                    e.in_frame,
                    e.out_frame,
                    max,
                    e.bin_id.clone(),
                    items[*i].video.as_ref().map_or(0, |v| v.lane),
                    items[*i].audio.as_ref().map_or(0, |a| a.lane),
                )
            }
            Source::New(m) => (0, m.length - 1, Some(m.length - 1), String::new(), 0, 0),
        };
        let mut in_frame = p.in_frame.unwrap_or(default_in).max(0);
        let mut out_frame = p.out_frame.unwrap_or(default_out);
        if let Some(max) = max_out {
            if out_frame > max {
                notes.push(format!(
                    "Clip {}: the end was past the clip's end, so it ends there.",
                    pos + 1
                ));
                out_frame = max;
            }
        }
        if out_frame < in_frame {
            return Err(format!("Clip {}: it would end before it starts.", pos + 1));
        }
        if in_frame > out_frame {
            in_frame = out_frame;
        }
        // Where it starts: after the one before, overlapping it by a mix, or
        // after the gap the user left between the two.
        let prev = laid.last();
        let start = match (prev, &p.source) {
            (None, Source::Existing(i)) if *i == 0 => items[0].start(),
            (None, _) => 0,
            (Some(prev), Source::Existing(i)) => {
                let prev_index = match prev.source {
                    Source::Existing(pi) => Some(pi),
                    Source::New(_) => None,
                };
                if let Some(&(_, _, frames)) = mixes
                    .iter()
                    .find(|&&(a, b, _)| Some(a) == prev_index && b == *i)
                {
                    prev.end() - frames
                } else if prev_index.is_some_and(|pi| pi + 1 == *i) {
                    let gap = items[*i].start() - items[*i - 1].end();
                    prev.end() + gap.max(0)
                } else {
                    prev.end()
                }
            }
            (Some(prev), Source::New(_)) => prev.end(),
        };
        laid.push(Laid {
            source: p.source.clone(),
            start,
            in_frame,
            out_frame,
            video_lane,
            audio_lane,
            video_chain: None,
            audio_chain: None,
            bin_id,
        });
    }
    Ok(laid)
}

/// The text of an element's start tag with some attributes set.
fn retag(doc: &Doc, node: usize, set: &[(&str, String)]) -> String {
    let n = doc.tree.node(node);
    let mut out = format!("<{}", n.name);
    for (k, v) in &n.attrs {
        let v = set
            .iter()
            .find(|(sk, _)| sk == k)
            .map(|(_, sv)| sv.as_str())
            .unwrap_or(v);
        out.push_str(&format!(" {k}=\"{}\"", escape(v)));
    }
    out.push_str(if n.self_closing() { "/>" } else { ">" });
    out
}

/// Replace a start tag's attributes, if any value differs.
fn set_attrs(doc: &Doc, splices: &mut Splices, node: usize, set: &[(&str, String)]) {
    let n = doc.tree.node(node);
    if set.iter().all(|(k, v)| n.attr(k) == Some(v.as_str())) {
        return;
    }
    let tag_end = if n.self_closing() {
        n.span.end
    } else {
        n.inner_start
    };
    splices.replace(n.span.start..tag_end, retag(doc, node, set));
}

/// Set a `<property>`'s value, if it differs.
fn set_property(doc: &Doc, splices: &mut Splices, owner: usize, name: &str, value: &str) {
    if let Some(p) = doc.tree.property_node(owner, name) {
        if doc.tree.node(p).text != value {
            splices.replace(
                doc.tree.node(p).span.clone(),
                format!(
                    "<property name=\"{}\">{}</property>",
                    escape(name),
                    escape(value)
                ),
            );
        }
    }
}

/// The whole line an element sits on (its indent through its newline), for
/// removing it.
fn line_of(text: &str, span: std::ops::Range<usize>) -> std::ops::Range<usize> {
    let start = text[..span.start].rfind('\n').map_or(span.start, |i| i + 1);
    let start = if text[start..span.start].trim().is_empty() {
        start
    } else {
        span.start
    };
    let end = if text[span.end..].starts_with('\n') {
        span.end + 1
    } else {
        span.end
    };
    start..end
}

fn new_uuid() -> String {
    format!("{{{}}}", uuid::Uuid::new_v4())
}

/// A chain for new media, as Kdenlive writes one. `track` is `Some(audio?)`
/// for a timeline instance, `None` for the bin clip.
fn chain_text(
    fps: Fps,
    id: &str,
    kdenlive_id: &str,
    uuid: &str,
    m: &Media,
    track: Option<bool>,
) -> String {
    let clip_type = match (m.video_index, m.audio_index) {
        (Some(_), Some(_)) => 0,
        (None, Some(_)) => 1,
        _ => 2,
    };
    let idx = |i: Option<u32>| i.map_or("-1".to_string(), |i| i.to_string());
    let mut props = vec![
        ("length", m.length.to_string()),
        ("eof", "pause".into()),
        ("resource", m.resource.clone()),
        ("mlt_service", "avformat-novalidate".into()),
        ("seekable", "1".into()),
        ("audio_index", idx(m.audio_index)),
        ("video_index", idx(m.video_index)),
        ("vstream", "0".into()),
        ("astream", "0".into()),
        ("kdenlive:folderid", "-1".into()),
        ("kdenlive:id", kdenlive_id.into()),
        ("kdenlive:control_uuid", uuid.into()),
        ("mute_on_pause", "0".into()),
        ("kdenlive:clip_type", clip_type.to_string()),
        ("kdenlive:file_size", m.file_size.to_string()),
        ("kdenlive:file_hash", m.file_hash.clone()),
    ];
    match track {
        Some(true) => {
            props.push(("set.test_audio", "0".into()));
            props.push(("set.test_image", "1".into()));
        }
        Some(false) => {
            props.push(("set.test_audio", "1".into()));
            props.push(("set.test_image", "0".into()));
        }
        None => {}
    }
    let mut out = format!(
        " <chain id=\"{id}\" out=\"{}\">\n",
        fps.timecode(m.length - 1)
    );
    for (k, v) in props {
        out.push_str(&format!(
            "  <property name=\"{k}\">{}</property>\n",
            escape(&v)
        ));
    }
    out.push_str(" </chain>\n");
    out
}

/// One playlist's wanted contents: `(start, entry text, original entry)`.
type Lane = Vec<(i64, i64, String, Option<usize>, i64, i64)>;

/// Rewrite a playlist's clips, or leave it alone when nothing about them changed.
fn rewrite_playlist(doc: &Doc, splices: &mut Splices, playlist: usize, lane: usize, wanted: &Lane) {
    let current = doc.entries(playlist, lane);
    let same = current.len() == wanted.len()
        && current
            .iter()
            .zip(wanted)
            .all(|(c, (start, len, _, node, in_f, out_f))| {
                *node == Some(c.node)
                    && c.start == *start
                    && c.len() == *len
                    && c.in_frame == *in_f
                    && c.out_frame == *out_f
            })
        && doc
            .tree
            .node(playlist)
            .children
            .iter()
            .filter(|&&c| doc.tree.node(c).name == "blank")
            .count()
            == wanted
                .iter()
                .scan(0i64, |at, (start, len, ..)| {
                    let gap = *start > *at;
                    *at = start + len;
                    Some(gap)
                })
                .filter(|g| *g)
                .count();
    if same {
        return;
    }
    let mut body = String::new();
    let mut at = 0i64;
    for (start, len, text, ..) in wanted {
        if *start > at {
            body.push_str(&format!(
                "\n  <blank length=\"{}\"/>",
                doc.fps.timecode(start - at)
            ));
        }
        body.push_str("\n  ");
        body.push_str(text);
        at = start + len;
    }
    let n = doc.tree.node(playlist);
    if n.self_closing() {
        let open = retag(doc, playlist, &[]).replacen("/>", ">", 1);
        splices.replace(n.span.clone(), format!("{open}{body}\n </playlist>"));
        return;
    }
    // Keep its properties; replace everything after them.
    let from = doc
        .tree
        .children_named(playlist, "property")
        .last()
        .map_or(n.inner_start, |p| doc.tree.node(p).span.end);
    splices.replace(from..n.inner_end, format!("{body}\n "));
}

/// The entry text for a laid clip on one track.
fn entry_text(doc: &Doc, fps: Fps, l: &Laid, old: Option<&Entry>, chain: &str) -> String {
    let in_tc = fps.timecode(l.in_frame);
    let out_tc = fps.timecode(l.out_frame);
    match old {
        Some(e) => {
            let n = doc.tree.node(e.node);
            let tag = retag(doc, e.node, &[("in", in_tc), ("out", out_tc)]);
            let rest = &doc.text[if n.self_closing() { n.span.end } else { n.inner_start }..n.span.end];
            format!("{tag}{rest}")
        }
        None => format!(
            "<entry in=\"{in_tc}\" out=\"{out_tc}\" producer=\"{chain}\">\n   <property name=\"kdenlive:id\">{}</property>\n  </entry>",
            l.bin_id
        ),
    }
}

/// Kdenlive's groups layout: four-space indents, a newline after the list.
fn groups_text(groups: &serde_json::Value) -> String {
    use serde::Serialize;
    let list = groups.as_array().map_or(0, Vec::len);
    if list == 0 {
        return "[\n]\n".into();
    }
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    groups.serialize(&mut ser).expect("JSON values serialise");
    let mut s = String::from_utf8(buf).expect("JSON is UTF-8");
    s.push('\n');
    s
}

/// Move main-track leaves to their clips' new positions, drop leaves of
/// removed clips, and drop groups left with one member.
fn remap_groups(value: &mut serde_json::Value, moves: &HashMap<(usize, i64), Option<i64>>) -> bool {
    use serde_json::Value;
    let mut changed = false;
    if let Some(children) = value.get_mut("children").and_then(Value::as_array_mut) {
        let mut keep = Vec::new();
        for mut c in children.drain(..) {
            if c.get("type").and_then(Value::as_str) == Some("Leaf") {
                let Some(data) = c.get("data").and_then(Value::as_str).map(str::to_string) else {
                    keep.push(c);
                    continue;
                };
                match parse_leaf(&data).and_then(|k| moves.get(&k).map(|m| (k, m))) {
                    Some((_, None)) => changed = true,
                    Some(((t, _), Some(p))) => {
                        let rest = data.splitn(3, ':').nth(2).unwrap_or("-1");
                        let next = format!("{t}:{p}:{rest}");
                        if next != data {
                            changed = true;
                            c["data"] = Value::String(next);
                        }
                        keep.push(c);
                    }
                    None => keep.push(c),
                }
            } else {
                changed |= remap_groups(&mut c, moves);
                let n = c
                    .get("children")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                if n >= 2 {
                    keep.push(c);
                } else {
                    changed = true;
                }
            }
        }
        *children = keep;
    }
    if let Some(list) = value.as_array_mut() {
        let mut keep = Vec::new();
        for mut g in list.drain(..) {
            changed |= remap_groups(&mut g, moves);
            if g.get("children")
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
                >= 2
            {
                keep.push(g);
            } else {
                changed = true;
            }
        }
        *list = keep;
    }
    changed
}

fn leaf(track: usize, pos: i64) -> serde_json::Value {
    serde_json::json!({ "data": format!("{track}:{pos}:-1"), "leaf": "clip", "type": "Leaf" })
}

/// Make the main track hold `wanted`.
pub fn apply(doc: &Doc, wanted: &[Placement]) -> Result<Edited, String> {
    doc.editable()?;
    let fps = doc.fps;
    let items = doc.items();
    let mut notes = Vec::new();
    let mut laid = layout(doc, &items, wanted, &mut notes)?;
    let mut splices = Splices::default();

    // New media: a bin clip when the bin has none for it, and a chain per track.
    let mut next_id = doc.max_kdenlive_id() + 1;
    let mut next_chain = doc.max_id_number("chain") + 1;
    let mut new_chains = String::new();
    let mut new_bin_chains = String::new();
    let mut new_bin_entries = String::new();
    let bin = doc.bin_clips();
    let mut added_bin: HashMap<String, (String, String)> = HashMap::new();
    for l in laid.iter_mut() {
        let Source::New(m) = &l.source else { continue };
        let existing = bin
            .iter()
            .find(|b| b.resource == m.resource)
            .map(|b| (b.kdenlive_id.clone(), b.uuid.clone()))
            .or_else(|| added_bin.get(&m.resource).cloned());
        let (kid, uuid) = match existing {
            Some(found) => found,
            None => {
                let kid = next_id.to_string();
                next_id += 1;
                let uuid = new_uuid();
                let id = format!("chain{next_chain}");
                next_chain += 1;
                new_bin_chains.push_str(&chain_text(fps, &id, &kid, &uuid, m, None));
                new_bin_entries.push_str(&format!(
                    "\n  <entry in=\"{}\" out=\"{}\" producer=\"{id}\"/>",
                    fps.timecode(0),
                    fps.timecode(m.length - 1)
                ));
                added_bin.insert(m.resource.clone(), (kid.clone(), uuid.clone()));
                (kid, uuid)
            }
        };
        l.bin_id = kid.clone();
        if m.audio_index.is_some() {
            let id = format!("chain{next_chain}");
            next_chain += 1;
            new_chains.push_str(&chain_text(fps, &id, &kid, &uuid, m, Some(true)));
            l.audio_chain = Some(id);
        }
        if m.video_index.is_some() {
            let id = format!("chain{next_chain}");
            next_chain += 1;
            new_chains.push_str(&chain_text(fps, &id, &kid, &uuid, m, Some(false)));
            l.video_chain = Some(id);
        }
    }

    // The playlists.
    for (track, is_audio) in [(doc.main_audio, true), (doc.main_video, false)] {
        let playlists = doc.tracks[track].playlists.clone();
        let mut lanes: Vec<Lane> = vec![Vec::new(); playlists.len().max(1)];
        for l in &laid {
            let (old, chain, lane) = match &l.source {
                Source::Existing(i) => {
                    let e = if is_audio {
                        items[*i].audio.as_ref()
                    } else {
                        items[*i].video.as_ref()
                    };
                    let Some(e) = e else { continue };
                    (Some(e), e.chain.clone(), e.lane)
                }
                Source::New(_) => {
                    let chain = if is_audio {
                        &l.audio_chain
                    } else {
                        &l.video_chain
                    };
                    let Some(chain) = chain else { continue };
                    (
                        None,
                        chain.clone(),
                        if is_audio { l.audio_lane } else { l.video_lane },
                    )
                }
            };
            let lane = lane.min(lanes.len() - 1);
            lanes[lane].push((
                l.start,
                l.len(),
                entry_text(doc, fps, l, old, &chain),
                old.map(|e| e.node),
                l.in_frame,
                l.out_frame,
            ));
        }
        for (lane, &pl) in playlists.iter().enumerate() {
            rewrite_playlist(doc, &mut splices, pl, lane, &lanes[lane]);
        }
    }

    // Chains of clips that went, when nothing else uses them.
    let kept: HashSet<usize> = laid
        .iter()
        .filter_map(|l| match l.source {
            Source::Existing(i) => Some(i),
            Source::New(_) => None,
        })
        .collect();
    let all_entries: Vec<Entry> = (0..doc.tracks.len())
        .flat_map(|t| doc.track_entries(t))
        .collect();
    for (i, item) in items.iter().enumerate() {
        if kept.contains(&i) {
            continue;
        }
        for e in item.video.iter().chain(item.audio.iter()) {
            let others = all_entries
                .iter()
                .filter(|o| o.chain == e.chain && o.node != e.node)
                .count();
            if others == 0 {
                if let Some(ch) = doc.tree.by_id(&e.chain) {
                    splices.replace(
                        line_of(&doc.text, doc.tree.node(ch).span.clone()),
                        String::new(),
                    );
                }
            }
        }
    }
    if !new_chains.is_empty() {
        let first = doc.tracks[doc.main_audio]
            .playlists
            .iter()
            .chain(doc.tracks[doc.main_video].playlists.iter())
            .map(|&p| doc.tree.node(p).span.start)
            .min()
            .ok_or("the main track has no playlists")?;
        let at = line_of(&doc.text, first..first).start;
        splices.insert(at, new_chains);
    }
    if !new_bin_chains.is_empty() {
        let at = line_of(&doc.text, doc.tree.node(doc.bin).span.clone()).start;
        splices.insert(at, new_bin_chains);
        let bin_node = doc.tree.node(doc.bin);
        let last = bin_node
            .children
            .last()
            .map_or(bin_node.inner_start, |&c| doc.tree.node(c).span.end);
        splices.insert(last, new_bin_entries);
    }

    // Groups: moved leaves follow their clips; new clips get an AVSplit.
    let mut moves: HashMap<(usize, i64), Option<i64>> = HashMap::new();
    let new_start: HashMap<usize, i64> = laid
        .iter()
        .filter_map(|l| match l.source {
            Source::Existing(i) => Some((i, l.start)),
            Source::New(_) => None,
        })
        .collect();
    for (i, item) in items.iter().enumerate() {
        let to = new_start.get(&i).copied();
        if let Some(v) = &item.video {
            moves.insert((doc.main_video, v.start), to);
        }
        if let Some(a) = &item.audio {
            moves.insert((doc.main_audio, a.start), to);
        }
    }
    let mut groups = doc.groups();
    let mut groups_changed = remap_groups(&mut groups, &moves);
    for l in &laid {
        if matches!(l.source, Source::New(_)) && l.video_chain.is_some() && l.audio_chain.is_some()
        {
            if let Some(list) = groups.as_array_mut() {
                list.push(serde_json::json!({
                    "children": [leaf(doc.main_video, l.start), leaf(doc.main_audio, l.start)],
                    "type": "AVSplit"
                }));
                groups_changed = true;
            }
        }
    }
    if groups_changed {
        set_property(
            doc,
            &mut splices,
            doc.sequence,
            "kdenlive:sequenceproperties.groups",
            &groups_text(&groups),
        );
    }

    // Mixes follow the clip that starts in them.
    for track in [doc.main_video, doc.main_audio] {
        for mix in doc.mixes(track) {
            let Some(b) = items.iter().position(|i| i.start() == mix.in_frame) else {
                continue;
            };
            if let Some(&start) = new_start.get(&b) {
                let frames = mix.out_frame - mix.in_frame;
                set_attrs(
                    doc,
                    &mut splices,
                    mix.node,
                    &[
                        ("in", fps.timecode(start)),
                        ("out", fps.timecode(start + frames)),
                    ],
                );
            }
        }
    }

    // Lengths.
    let main_end = laid.iter().map(Laid::end).max().unwrap_or(0);
    let video_end = laid
        .iter()
        .filter(|l| {
            l.video_chain.is_some()
                || matches!(l.source, Source::Existing(i) if items[i].video.is_some())
        })
        .map(Laid::end)
        .max()
        .unwrap_or(0);
    let audio_end = laid
        .iter()
        .filter(|l| {
            l.audio_chain.is_some()
                || matches!(l.source, Source::Existing(i) if items[i].audio.is_some())
        })
        .map(Laid::end)
        .max()
        .unwrap_or(0);
    let others = (0..doc.tracks.len())
        .filter(|&t| t != doc.main_video && t != doc.main_audio)
        .map(|t| doc.track_end(t))
        .max()
        .unwrap_or(0);
    let total = main_end.max(others);
    if others > 0 {
        notes.push("Clips on other tracks did not move.".into());
    }
    let last = |end: i64| fps.timecode((end - 1).max(0));
    set_attrs(
        doc,
        &mut splices,
        doc.tracks[doc.main_video].tractor,
        &[("out", last(video_end))],
    );
    set_attrs(
        doc,
        &mut splices,
        doc.tracks[doc.main_audio].tractor,
        &[("out", last(audio_end))],
    );
    set_attrs(doc, &mut splices, doc.sequence, &[("out", last(total))]);
    set_property(
        doc,
        &mut splices,
        doc.sequence,
        "kdenlive:duration",
        &fps.timecode(total),
    );
    set_property(
        doc,
        &mut splices,
        doc.sequence,
        "kdenlive:maxduration",
        &total.to_string(),
    );
    if let Some(pt) = doc.project_tractor {
        set_attrs(doc, &mut splices, pt, &[("out", last(total))]);
        if let Some(t) = doc.tree.children_named(pt, "track").next() {
            set_attrs(doc, &mut splices, t, &[("out", last(total))]);
        }
    }
    if let Some(black) = doc.black {
        let current = doc
            .tree
            .node(black)
            .attr("out")
            .and_then(|o| fps.parse(o))
            .unwrap_or(0);
        if current < total {
            set_attrs(
                doc,
                &mut splices,
                black,
                &[("out", fps.timecode(total + fps.frames(300.0)))],
            );
        }
    }

    Ok(Edited {
        text: splices.apply(&doc.text)?,
        notes,
    })
}

/// The current main track as placements that change nothing.
pub fn current(doc: &Doc) -> Vec<Placement> {
    (0..doc.items().len())
        .map(|i| Placement {
            source: Source::Existing(i),
            in_frame: None,
            out_frame: None,
        })
        .collect()
}
