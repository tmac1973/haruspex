//! Turning a wanted main track into byte-range edits of a Shotcut project.
//!
//! The same rules as the Kdenlive writer (`kdenlive::edit`), in Shotcut's
//! shape. It changes only:
//!
//! - the main track's playlist (V1), rewritten when its clips change;
//! - the chains of clips it adds (a new clip, or a piece of one split in two)
//!   and of clips it removes;
//! - Haruspex's own crossfades (tractors marked `haruspex:ours`) and gain and
//!   Limiter filters, which it rewrites freely; crossfades and filters the user
//!   made stay as they are;
//! - the main tractor's and the black background's lengths.
//!
//! Everything else in the file is left as it was, and a no-op edit gives the
//! text back unchanged.

use super::doc::{Doc, Slot, OURS, OURS_LUFS};
use crate::video::mlt::fps::Fps;
use crate::video::mlt::warp;
use crate::video::mlt::xml::{escape, Splices};
use crate::video::timeline::{Edited, Fit, GainRange, Media, Placement, Source};
use std::collections::HashSet;

/// The main track as placements: applying them changes nothing.
pub fn current(doc: &Doc) -> Vec<Placement> {
    doc.items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let mut p = Placement::of(Source::Existing(i));
            if let Some(f) = item.fade_in {
                if doc.fades[f].ours {
                    p.mix_in = Some(doc.fades[f].len);
                }
            }
            p
        })
        .collect()
}

/// A clip as laid out.
struct Laid {
    source: Source,
    /// The chain it plays: an existing one's id, or a new one's.
    chain: String,
    in_frame: i64,
    out_frame: i64,
    /// Blank frames before it (after the clip before, or the crossfade).
    gap: i64,
    /// The crossfade into it.
    fade: Option<FadeIn>,
    gain_db: Option<f64>,
    limiter: bool,
    fit: Option<Fit>,
    gain_ranges: Option<Vec<GainRange>>,
    /// The speed a new chain or a copy is made at, when it isn't the one it
    /// has: 1 takes a copy's speed off.
    warp: Option<f64>,
    /// Its source's whole length, in source frames.
    src_len: Option<i64>,
}

impl Laid {
    fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }
}

#[derive(Clone)]
enum FadeIn {
    /// One the user made, kept as it is: `Doc::fades` index.
    Users(usize),
    /// Haruspex's, this many frames; reusing an unchanged tractor when it can.
    Ours(i64),
}

/// A chain's whole length in frames, from its `length` property.
pub(super) fn chain_length(doc: &Doc, chain: &str) -> Option<i64> {
    let c = doc.chain(chain)?;
    doc.tree
        .property(c, "length")
        .and_then(|l| doc.fps.parse(l))
        .filter(|&l| l > 0)
}

/// The user's crossfades between items: (before, after, fade index).
fn user_fades(doc: &Doc) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    for (b, item) in doc.items.iter().enumerate() {
        if let Some(f) = item.fade_in.filter(|&f| !doc.fades[f].ours) {
            if b > 0 {
                out.push((b - 1, b, f));
            }
        }
    }
    out
}

fn layout(
    doc: &Doc,
    wanted: &[Placement],
    notes: &mut Vec<String>,
    next_chain: &mut i64,
) -> Result<Vec<Laid>, String> {
    let items = &doc.items;
    let fades = user_fades(doc);
    let mut seen = HashSet::new();
    for p in wanted {
        match p.source {
            Source::Piece(i) if i >= items.len() => {
                return Err(format!("There is no clip {} on the main track.", i + 1));
            }
            Source::Existing(i) => {
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
            _ => {}
        }
    }
    for &(a, b, _) in &fades {
        let pa = wanted.iter().position(|p| p.source == Source::Existing(a));
        let pb = wanted.iter().position(|p| p.source == Source::Existing(b));
        let together = matches!((pa, pb), (Some(x), Some(y)) if y == x + 1);
        let src = |k: usize| {
            let it = &items[k];
            warp::to_source(it.in_frame, it.out_frame, doc.speed(&it.chain))
        };
        let a_trimmed_end = pa.is_some_and(|x| wanted[x].out_frame.is_some_and(|o| o != src(a).1));
        let b_trimmed_start = pb.is_some_and(|y| wanted[y].in_frame.is_some_and(|i| i != src(b).0));
        let respeeds = |k: Option<usize>, i: usize| {
            k.is_some_and(|k| {
                wanted[k]
                    .speed
                    .is_some_and(|s| !warp::same(s, doc.speed(&items[i].chain)))
            })
        };
        if !together || a_trimmed_end || b_trimmed_start || respeeds(pa, a) || respeeds(pb, b) {
            return Err(format!(
                "Clips {} and {} are joined by a crossfade made in Shotcut; remove it there first, \
                 or keep them together.",
                a + 1,
                b + 1
            ));
        }
    }

    let mut laid: Vec<Laid> = Vec::new();
    for (pos, p) in wanted.iter().enumerate() {
        // The speed it has now, and the one it will have.
        let old_speed = match &p.source {
            Source::Existing(i) | Source::Piece(i) => doc.speed(&items[*i].chain),
            Source::New(_) => 1.0,
        };
        let speed = p.speed.unwrap_or(old_speed);
        // A clip whose speed changes plays a new chain, as a piece does.
        let source = match &p.source {
            Source::Existing(i) if !warp::same(speed, old_speed) => Source::Piece(*i),
            s => s.clone(),
        };
        // In source frames, as placements say them.
        let (default_in, default_out, src_len, chain) = match &source {
            Source::Existing(i) | Source::Piece(i) => {
                let it = &items[*i];
                let (a, b) = warp::to_source(it.in_frame, it.out_frame, old_speed);
                let len =
                    chain_length(doc, &it.chain).map(|l| (l as f64 * old_speed).round() as i64);
                let chain = if matches!(source, Source::Existing(_)) {
                    it.chain.clone()
                } else {
                    *next_chain += 1;
                    format!("chain{next_chain}")
                };
                (a, b, len, chain)
            }
            Source::New(m) => {
                *next_chain += 1;
                (
                    0,
                    m.length - 1,
                    Some(m.length),
                    format!("chain{next_chain}"),
                )
            }
        };
        let mut in_frame = p.in_frame.unwrap_or(default_in).max(0);
        let mut out_frame = p.out_frame.unwrap_or(default_out);
        if let Some(max) = src_len.map(|l| l - 1) {
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
        // From here on, the chain's own frames.
        let (mut in_frame, mut out_frame) = warp::to_chain(in_frame, out_frame, speed);
        if let Some(most) = src_len.map(|l| warp::chain_length(l, speed) - 1) {
            out_frame = out_frame.min(most);
            in_frame = in_frame.min(out_frame);
        }
        // A new chain is made at its speed; a copy is changed to it.
        let warp = match &source {
            Source::New(_) => (!warp::same(speed, 1.0)).then_some(speed),
            Source::Piece(_) => (!warp::same(speed, old_speed)).then_some(speed),
            Source::Existing(_) => None,
        };
        let prev = laid.last();
        let users = match (prev, &source) {
            (Some(prev), Source::Existing(i)) => match prev.source {
                Source::Existing(pi) => fades
                    .iter()
                    .find(|&&(a, b, _)| a == pi && b == *i)
                    .map(|&(_, _, f)| f),
                _ => None,
            },
            _ => None,
        };
        let len = out_frame - in_frame + 1;
        let fade = match (users, prev, p.mix_in.filter(|&d| d > 0)) {
            (Some(f), _, _) => Some(FadeIn::Users(f)),
            (None, Some(prev), Some(want)) => {
                // A fade on each side may take at most half, so every clip
                // keeps a frame of its own.
                let most = (prev.len().min(len) - 1) / 2;
                if want > most {
                    notes.push(format!(
                        "Clip {}: the crossfade is shortened to half the shorter clip.",
                        pos + 1
                    ));
                }
                Some(want.min(most)).filter(|&d| d > 0).map(FadeIn::Ours)
            }
            _ => None,
        };
        // The gap the user left before it, when it follows the clip it
        // followed before (or leads the track, as it did).
        let gap = match (&source, prev) {
            _ if fade.is_some() => 0,
            (Source::Existing(i), None) if *i == 0 => {
                if items[0].fade_in.is_none() {
                    items[0].start
                } else {
                    0
                }
            }
            (Source::Existing(i), Some(prev)) => match prev.source {
                Source::Existing(pi) if pi + 1 == *i => (items[*i].start - items[pi].end()).max(0),
                _ => 0,
            },
            _ => 0,
        };
        laid.push(Laid {
            source: source.clone(),
            warp,
            src_len,
            chain,
            in_frame,
            out_frame,
            gap,
            fade,
            gain_db: p.gain_db,
            limiter: p.limiter,
            fit: p.fit,
            gain_ranges: p.gain_ranges.clone(),
        });
    }
    // A clip can't give more than its length to the crossfades at its sides.
    for k in 0..laid.len() {
        let fade_len = |f: &Option<FadeIn>| match f {
            Some(FadeIn::Ours(n)) => *n,
            Some(FadeIn::Users(i)) => doc.fades[*i].len,
            None => 0,
        };
        let inn = fade_len(&laid[k].fade);
        let out = laid.get(k + 1).map_or(0, |n| fade_len(&n.fade));
        if inn + out >= laid[k].len() {
            return Err(format!(
                "Clip {} is too short for the crossfades on both sides of it.",
                k + 1
            ));
        }
    }
    Ok(laid)
}

pub(super) fn tc(fps: &Fps, frames: i64) -> String {
    fps.timecode(frames.max(0))
}

/// Haruspex's Gain / Volume filter, as Shotcut writes its own.
pub(super) fn gain_filter(id: &str, gain_db: f64) -> String {
    gain_filter_for(id, gain_db, None)
}

/// The gain filter, keeping the loudness it aims at when that isn't -14 LUFS.
pub(super) fn gain_filter_for(id: &str, gain_db: f64, lufs: Option<f64>) -> String {
    let g = format!("{gain_db:.2}");
    let g = g.trim_end_matches('0').trim_end_matches('.');
    let target = lufs.map_or(String::new(), |l| {
        format!("\x20     <property name=\"{OURS_LUFS}\">{l}</property>\n")
    });
    format!(
        "    <filter id=\"{id}\">\n\
         \x20     <property name=\"window\">75</property>\n\
         \x20     <property name=\"max_gain\">20dB</property>\n\
         \x20     <property name=\"level\">{g}</property>\n\
         \x20     <property name=\"channel_mask\">-1</property>\n\
         \x20     <property name=\"mlt_service\">volume</property>\n\
         \x20     <property name=\"shotcut:filter\">audioGain</property>\n\
         \x20     <property name=\"{OURS}\">1</property>\n\
         {target}\
         \x20   </filter>\n"
    )
}

/// Haruspex's crop for a fit, as Shotcut writes its Crop: Source filter;
/// nothing for letterbox.
pub(super) fn fit_filter(id: &str, fit: Fit, width: u32, height: u32) -> String {
    let Some(props) = crate::video::mlt::fit::properties(fit, width, height) else {
        return String::new();
    };
    let mut out = format!("    <filter id=\"{id}\">\n");
    for (k, v) in props {
        out.push_str(&format!("      <property name=\"{k}\">{v}</property>\n"));
    }
    out.push_str("      <property name=\"shotcut:filter\">crop</property>\n");
    out.push_str(&format!("      <property name=\"{OURS}\">1</property>\n"));
    out.push_str("    </filter>\n");
    out
}

/// Haruspex's gain-range filters, as Shotcut writes a keyframed Gain / Volume.
pub(super) fn range_filters(next_filter: &mut i64, ranges: &[GainRange], fps: &Fps) -> String {
    let mut out = String::new();
    for r in ranges {
        let (start, end, props) = crate::video::mlt::gain_range::filter(r, fps);
        *next_filter += 1;
        out.push_str(&format!(
            "    <filter id=\"filter{next_filter}\" in=\"{}\" out=\"{}\">\n",
            tc(fps, start),
            tc(fps, end)
        ));
        for (k, v) in props {
            out.push_str(&format!("      <property name=\"{k}\">{v}</property>\n"));
        }
        out.push_str("      <property name=\"shotcut:filter\">audioGain</property>\n");
        out.push_str(&format!("      <property name=\"{OURS}\">1</property>\n"));
        out.push_str("    </filter>\n");
    }
    out
}

/// Haruspex's Limiter: `avfilter.alimiter` holding peaks at -1.5 dB, the same
/// as in Kdenlive projects. Shotcut's own Limiter is a LADSPA plugin melt
/// here doesn't have, so Shotcut keeps this one but doesn't list it.
pub(super) fn limiter_filter(id: &str) -> String {
    let limit = format!("{:.3}", 10f64.powf(crate::video::loudness::LIMIT_DB / 20.0));
    let props = [
        ("av.level_in", "1"),
        ("av.level_out", "1"),
        ("av.limit", limit.as_str()),
        ("av.attack", "5"),
        ("av.release", "50"),
        ("av.asc", "0"),
        ("av.asc_level", "0.5"),
        ("av.level", "0"),
        ("mlt_service", "avfilter.alimiter"),
        (OURS, "1"),
    ];
    let mut out = format!("    <filter id=\"{id}\">\n");
    for (k, v) in props {
        out.push_str(&format!("      <property name=\"{k}\">{v}</property>\n"));
    }
    out.push_str("    </filter>\n");
    out
}

/// A chain for new media, as Shotcut writes one.
pub(super) fn new_chain(fps: &Fps, id: &str, m: &Media) -> String {
    let caption = m.resource.rsplit('/').next().unwrap_or(&m.resource);
    let index = |i: Option<u32>| i.map_or("-1".to_string(), |i| i.to_string());
    format!(
        "  <chain id=\"{id}\" out=\"{out}\">\n\
         \x20   <property name=\"length\">{len}</property>\n\
         \x20   <property name=\"eof\">pause</property>\n\
         \x20   <property name=\"resource\">{res}</property>\n\
         \x20   <property name=\"mlt_service\">avformat-novalidate</property>\n\
         \x20   <property name=\"seekable\">1</property>\n\
         \x20   <property name=\"audio_index\">{audio}</property>\n\
         \x20   <property name=\"video_index\">{video}</property>\n\
         \x20   <property name=\"shotcut:hash\">{hash}</property>\n\
         \x20   <property name=\"shotcut:caption\">{caption}</property>\n\
         \x20 </chain>\n",
        out = tc(fps, m.length - 1),
        len = tc(fps, m.length),
        res = escape(&m.resource),
        audio = index(m.audio_index),
        video = index(m.video_index),
        hash = escape(&m.file_hash),
        caption = escape(caption),
    )
}

/// The text of an element's start tag with some attributes set, adding any it
/// didn't have.
pub(super) fn retag(doc: &Doc, node: usize, set: &[(&str, String)]) -> String {
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
    for (k, v) in set {
        if n.attr(k).is_none() {
            out.push_str(&format!(" {k}=\"{}\"", escape(v)));
        }
    }
    out.push_str(if n.self_closing() { "/>" } else { ">" });
    out
}

/// Replace a start tag's attributes, if any value differs.
pub(super) fn set_attrs(doc: &Doc, splices: &mut Splices, node: usize, set: &[(&str, String)]) {
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

/// The span of an element with the indentation before it, so removing it
/// leaves no blank line.
pub(super) fn whole_line(text: &str, span: std::ops::Range<usize>) -> std::ops::Range<usize> {
    let line_start = text[..span.start].rfind('\n').map_or(0, |i| i + 1);
    let start = if text[line_start..span.start].trim().is_empty() {
        line_start
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

/// Rename every `id="…"` inside a copied element: the chain to `chain`, its
/// filters to new filter ids.
pub(super) fn copy_chain(text: &str, old_id: &str, chain: &str, next_filter: &mut i64) -> String {
    let mut out = text.replacen(
        &format!("id=\"{}\"", escape(old_id)),
        &format!("id=\"{chain}\""),
        1,
    );
    while let Some(at) = out.find("<filter id=\"filter") {
        // Only ids not renamed yet: mark renamed ones with a placeholder.
        let rest = &out[at + 12..];
        let end = rest.find('"').map_or(0, |e| e + at + 12);
        *next_filter += 1;
        out.replace_range(
            at..end + 1,
            &format!("<filter\u{1}id=\"filter{next_filter}\""),
        );
    }
    out.replace("<filter\u{1}id=", "<filter id=")
}

pub fn apply(doc: &Doc, wanted: &[Placement]) -> Result<Edited, String> {
    doc.editable()?;
    let main = doc.main.ok_or("This Shotcut project has no video track.")?;
    let fps = doc.fps;
    let text = &doc.text;
    let mut notes = Vec::new();
    let mut next_chain = doc
        .max_id_number("chain")
        .max(doc.max_id_number("producer"));
    let mut next_filter = doc.max_id_number("filter");
    let mut next_tractor = doc.max_id_number("tractor");
    let mut next_transition = doc.max_id_number("transition");
    let laid = layout(doc, wanted, &mut notes, &mut next_chain)?;

    let mut splices = Splices::default();
    let playlist = doc.tracks[main].node;
    let insert_at = whole_line(text, doc.tree.node(playlist).span.clone()).start;

    // New chains: new media, and pieces copied from their clip.
    let mut chain_text = String::new();
    for l in &laid {
        match &l.source {
            Source::New(m) => {
                let mut c = new_chain(&fps, &l.chain, m);
                if let Some(g) = l.gain_db.filter(|&g| g != 0.0) {
                    let mut filters = String::new();
                    next_filter += 1;
                    filters.push_str(&gain_filter(&format!("filter{next_filter}"), g));
                    if l.limiter {
                        next_filter += 1;
                        filters.push_str(&limiter_filter(&format!("filter{next_filter}")));
                    }
                    c = c.replacen("  </chain>\n", &format!("{filters}  </chain>\n"), 1);
                }
                if let Some(fit) = l.fit {
                    next_filter += 1;
                    let f = fit_filter(&format!("filter{next_filter}"), fit, doc.width, doc.height);
                    c = c.replacen("  </chain>\n", &format!("{f}  </chain>\n"), 1);
                }
                if let Some(ranges) = &l.gain_ranges {
                    let f = range_filters(&mut next_filter, ranges, &fps);
                    c = c.replacen("  </chain>\n", &format!("{f}  </chain>\n"), 1);
                }
                if let Some(speed) = l.warp {
                    let plain = warp::Plain {
                        resource: &m.resource,
                        service: "avformat-novalidate",
                        length: m.length,
                    };
                    c = warp::rewrite(&c, &plain, speed, &fps, true);
                }
                chain_text.push_str(&c);
            }
            Source::Piece(i) => {
                let old = &doc.items[*i].chain;
                let node = doc.chain(old).ok_or("a clip's chain is missing")?;
                let span = doc.tree.node(node).span.clone();
                let mut original = text[span.clone()].to_string();
                // The copy drops our filters it replaces; the wanted ones go back on.
                let mut dropped = Vec::new();
                if l.gain_db.is_some() {
                    dropped.extend(doc.our_sound_filters(old));
                }
                if l.fit.is_some() {
                    dropped.extend(doc.our_fit_filter(old));
                }
                if l.gain_ranges.is_some() {
                    dropped.extend(doc.our_range_filters(old));
                }
                if !dropped.is_empty() {
                    let mut s = Splices::default();
                    for f in dropped {
                        let r = whole_line(text, doc.tree.node(f).span.clone());
                        s.replace((r.start - span.start)..(r.end - span.start), String::new());
                    }
                    original = s.apply(&original)?;
                }
                let mut c = copy_chain(&original, old, &l.chain, &mut next_filter);
                if let Some(g) = l.gain_db.filter(|&g| g != 0.0) {
                    let mut filters = String::new();
                    next_filter += 1;
                    filters.push_str(&gain_filter(&format!("filter{next_filter}"), g));
                    if l.limiter {
                        next_filter += 1;
                        filters.push_str(&limiter_filter(&format!("filter{next_filter}")));
                    }
                    let at = c.rfind("</chain>").unwrap_or(c.len());
                    let line = c[..at].rfind('\n').map_or(at, |n| n + 1);
                    c.insert_str(line, &filters);
                }
                if let Some(fit) = l.fit {
                    next_filter += 1;
                    let f = fit_filter(&format!("filter{next_filter}"), fit, doc.width, doc.height);
                    let at = c.rfind("</chain>").unwrap_or(c.len());
                    let line = c[..at].rfind('\n').map_or(at, |n| n + 1);
                    c.insert_str(line, &f);
                }
                if let Some(ranges) = &l.gain_ranges {
                    let f = range_filters(&mut next_filter, ranges, &fps);
                    let at = c.rfind("</chain>").unwrap_or(c.len());
                    let line = c[..at].rfind('\n').map_or(at, |n| n + 1);
                    c.insert_str(line, &f);
                }
                if let (Some(speed), Some(length)) = (l.warp, l.src_len) {
                    let resource = doc.resource(old);
                    let service = doc.plain_service(old);
                    let plain = warp::Plain {
                        resource: &resource,
                        service: &service,
                        length,
                    };
                    c = warp::rewrite(&c, &plain, speed, &fps, true);
                }
                chain_text.push_str("  ");
                chain_text.push_str(&c);
                chain_text.push('\n');
            }
            Source::Existing(_) => {}
        }
    }

    // Gains on kept clips' own chains.
    for l in &laid {
        let (Source::Existing(_), Some(g)) = (&l.source, l.gain_db) else {
            continue;
        };
        let unchanged = doc.our_gain(&l.chain) == Some(g) && doc.our_limiter(&l.chain) == l.limiter
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
            let mut filters = String::new();
            next_filter += 1;
            filters.push_str(&gain_filter(&format!("filter{next_filter}"), g));
            if l.limiter {
                next_filter += 1;
                filters.push_str(&limiter_filter(&format!("filter{next_filter}")));
            }
            let line = text[..n.inner_end]
                .rfind('\n')
                .map_or(n.inner_end, |i| i + 1);
            splices.insert(line, filters);
        }
    }

    // Fits on kept clips' own chains.
    for l in &laid {
        let (Source::Existing(_), Some(fit)) = (&l.source, l.fit) else {
            continue;
        };
        let now = doc.our_fit(&l.chain).unwrap_or(Fit::Letterbox);
        if now == fit {
            continue;
        }
        if let Some(f) = doc.our_fit_filter(&l.chain) {
            splices.replace(
                whole_line(text, doc.tree.node(f).span.clone()),
                String::new(),
            );
        }
        if fit != Fit::Letterbox {
            let node = doc.chain(&l.chain).ok_or("a clip's chain is missing")?;
            let n = doc.tree.node(node);
            next_filter += 1;
            let line = text[..n.inner_end]
                .rfind('\n')
                .map_or(n.inner_end, |i| i + 1);
            splices.insert(
                line,
                fit_filter(&format!("filter{next_filter}"), fit, doc.width, doc.height),
            );
        }
    }

    // Gain ranges on kept clips' own chains.
    for l in &laid {
        let (Source::Existing(_), Some(ranges)) = (&l.source, &l.gain_ranges) else {
            continue;
        };
        if doc.our_gain_ranges(&l.chain) == *ranges {
            continue;
        }
        for f in doc.our_range_filters(&l.chain) {
            splices.replace(
                whole_line(text, doc.tree.node(f).span.clone()),
                String::new(),
            );
        }
        if !ranges.is_empty() {
            let node = doc.chain(&l.chain).ok_or("a clip's chain is missing")?;
            let n = doc.tree.node(node);
            let line = text[..n.inner_end]
                .rfind('\n')
                .map_or(n.inner_end, |i| i + 1);
            splices.insert(line, range_filters(&mut next_filter, ranges, &fps));
        }
    }

    // Crossfades: keep the user's and unchanged ones of ours, write the rest.
    let mut kept_tractors: HashSet<usize> = HashSet::new();
    let mut fade_ids: Vec<Option<String>> = vec![None; laid.len()];
    let mut tractor_text = String::new();
    for k in 0..laid.len() {
        let Some(fade) = laid[k].fade.clone() else {
            continue;
        };
        let (prev, this) = (&laid[k - 1], &laid[k]);
        match fade {
            FadeIn::Users(f) => {
                kept_tractors.insert(doc.fades[f].tractor);
                fade_ids[k] = Some(doc.fades[f].tractor_id.clone());
            }
            FadeIn::Ours(len) => {
                let same = doc.fades.iter().find(|f| {
                    f.ours
                        && f.len == len
                        && f.a_chain == prev.chain
                        && f.a_out == prev.out_frame
                        && f.b_chain == this.chain
                        && f.b_in == this.in_frame
                });
                if let Some(f) = same {
                    kept_tractors.insert(f.tractor);
                    fade_ids[k] = Some(f.tractor_id.clone());
                    continue;
                }
                next_tractor += 1;
                let id = format!("tractor{next_tractor}");
                let last = tc(&fps, len - 1);
                next_transition += 1;
                let luma = next_transition;
                next_transition += 1;
                let mix = next_transition;
                tractor_text.push_str(&format!(
                    "  <tractor id=\"{id}\" in=\"00:00:00.000\" out=\"{last}\">\n\
                     \x20   <property name=\"shotcut:transition\">lumaMix</property>\n\
                     \x20   <property name=\"{OURS}\">1</property>\n\
                     \x20   <track producer=\"{a}\" in=\"{a_in}\" out=\"{a_out}\"/>\n\
                     \x20   <track producer=\"{b}\" in=\"{b_in}\" out=\"{b_out}\"/>\n\
                     \x20   <transition id=\"transition{luma}\" out=\"{last}\">\n\
                     \x20     <property name=\"a_track\">0</property>\n\
                     \x20     <property name=\"b_track\">1</property>\n\
                     \x20     <property name=\"factory\">loader</property>\n\
                     \x20     <property name=\"mlt_service\">luma</property>\n\
                     \x20     <property name=\"alpha_over\">1</property>\n\
                     \x20     <property name=\"fix_background_alpha\">1</property>\n\
                     \x20   </transition>\n\
                     \x20   <transition id=\"transition{mix}\" out=\"{last}\">\n\
                     \x20     <property name=\"a_track\">0</property>\n\
                     \x20     <property name=\"b_track\">1</property>\n\
                     \x20     <property name=\"start\">-1</property>\n\
                     \x20     <property name=\"accepts_blanks\">1</property>\n\
                     \x20     <property name=\"mlt_service\">mix</property>\n\
                     \x20   </transition>\n\
                     \x20 </tractor>\n",
                    a = escape(&prev.chain),
                    a_in = tc(&fps, prev.out_frame - len + 1),
                    a_out = tc(&fps, prev.out_frame),
                    b = escape(&this.chain),
                    b_in = tc(&fps, this.in_frame),
                    b_out = tc(&fps, this.in_frame + len - 1),
                ));
                fade_ids[k] = Some(id);
            }
        }
    }

    // The main track's new children.
    let fade_len = |k: usize| match &laid.get(k).and_then(|l| l.fade.clone()) {
        Some(FadeIn::Ours(n)) => *n,
        Some(FadeIn::Users(f)) => doc.fades[*f].len,
        None => 0,
    };
    #[derive(PartialEq)]
    enum Want {
        Blank(i64),
        Fade(String, i64),
        Clip(String, i64, i64),
    }
    let mut slots: Vec<Want> = Vec::new();
    for (k, l) in laid.iter().enumerate() {
        if l.gap > 0 {
            slots.push(Want::Blank(l.gap));
        }
        if let Some(id) = &fade_ids[k] {
            slots.push(Want::Fade(id.clone(), fade_len(k)));
        }
        slots.push(Want::Clip(
            l.chain.clone(),
            l.in_frame + fade_len(k),
            l.out_frame - fade_len(k + 1),
        ));
    }
    let have: Vec<Want> = doc
        .slots
        .iter()
        .map(|s| match s {
            Slot::Blank { len, .. } => Want::Blank(*len),
            Slot::Fade(f) => Want::Fade(f.tractor_id.clone(), f.len),
            Slot::Clip(e) => Want::Clip(e.chain.clone(), e.in_frame, e.out_frame),
        })
        .collect();
    let track_changed = slots != have;
    if track_changed {
        let pl = doc.tree.node(playlist);
        // Its own properties stay; the clips after them are rewritten.
        let body_start = doc
            .tree
            .children_named(playlist, "property")
            .last()
            .map_or(pl.inner_start, |p| doc.tree.node(p).span.end);
        let mut body = String::new();
        for s in &slots {
            body.push_str("\n    ");
            match s {
                Want::Blank(n) => body.push_str(&format!("<blank length=\"{}\"/>", tc(&fps, *n))),
                Want::Fade(id, n) => body.push_str(&format!(
                    "<entry producer=\"{}\" in=\"00:00:00.000\" out=\"{}\"/>",
                    escape(id),
                    tc(&fps, n - 1)
                )),
                Want::Clip(chain, i, o) => body.push_str(&format!(
                    "<entry producer=\"{}\" in=\"{}\" out=\"{}\"/>",
                    escape(chain),
                    tc(&fps, *i),
                    tc(&fps, *o)
                )),
            }
        }
        if slots.is_empty() {
            body.push_str(&format!("\n    <blank length=\"{}\"/>", tc(&fps, 1)));
        }
        body.push_str("\n  ");
        if pl.self_closing() {
            return Err("internal error: the main playlist has no body".into());
        }
        splices.replace(body_start..pl.inner_end, body);
    }

    // Old crossfades of ours no longer used go, and so do chains no clip uses.
    for f in &doc.fades {
        if f.ours && !kept_tractors.contains(&f.tractor) {
            splices.replace(
                whole_line(text, doc.tree.node(f.tractor).span.clone()),
                String::new(),
            );
        }
    }
    if track_changed {
        let used: HashSet<&str> = laid.iter().map(|l| l.chain.as_str()).collect();
        let main_span = doc.tree.node(playlist).span.clone();
        let removed_tractors: Vec<std::ops::Range<usize>> = doc
            .fades
            .iter()
            .filter(|f| f.ours && !kept_tractors.contains(&f.tractor))
            .map(|f| doc.tree.node(f.tractor).span.clone())
            .collect();
        let inside = |at: usize, r: &std::ops::Range<usize>| r.start <= at && at < r.end;
        for item in &doc.items {
            if used.contains(item.chain.as_str()) {
                continue;
            }
            let elsewhere = doc.tree.nodes.iter().any(|n| {
                n.attr("producer") == Some(item.chain.as_str())
                    && !inside(n.span.start, &main_span)
                    && !removed_tractors.iter().any(|r| inside(n.span.start, r))
            });
            if elsewhere {
                continue;
            }
            if let Some(c) = doc.chain(&item.chain) {
                splices.replace(
                    whole_line(text, doc.tree.node(c).span.clone()),
                    String::new(),
                );
            }
        }
    }
    if !chain_text.is_empty() || !tractor_text.is_empty() {
        splices.insert(insert_at, format!("{chain_text}{tractor_text}"));
    }

    // Lengths: the main tractor and the black background cover the longest
    // track.
    let main_end: i64 = laid
        .iter()
        .enumerate()
        .map(|(k, l)| l.gap + l.len() - fade_len(k))
        .sum();
    let others = (0..doc.tracks.len())
        .filter(|&t| t != main)
        .map(|t| {
            doc.track_entries(t)
                .iter()
                .map(|e| e.start + e.len())
                .max()
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    // The audio tracks are Haruspex's too, and follow the main track.
    let others_video = (0..doc.tracks.len())
        .filter(|&t| t != main && doc.tracks[t].video)
        .any(|t| !doc.track_entries(t).is_empty());
    if others_video && track_changed {
        notes.push("Clips on other tracks did not move.".into());
    }
    let total = main_end.max(others).max(1);
    if total != doc.sequence_end().max(1) || track_changed {
        set_length(doc, &mut splices, total);
    }

    let text = splices.apply(text)?;
    Ok(Edited { text, notes })
}

/// Make the main tractor and the black background `total` frames long.
pub(super) fn set_length(doc: &Doc, splices: &mut Splices, total: i64) {
    let fps = doc.fps;
    let last = tc(&fps, total - 1);
    set_attrs(
        doc,
        splices,
        doc.main_tractor,
        &[("in", "00:00:00.000".to_string()), ("out", last.clone())],
    );
    if let Some(black) = doc.tree.by_id("black") {
        set_attrs(doc, splices, black, &[("out", last.clone())]);
        if let Some(p) = doc.tree.property_node(black, "length") {
            let n = doc.tree.node(p);
            splices.replace(n.inner_start..n.inner_end, tc(&fps, total));
        }
    }
    if let Some(bg) = doc.tree.by_id("background") {
        if let Some(e) = doc.tree.children_named(bg, "entry").next() {
            set_attrs(doc, splices, e, &[("out", last)]);
        }
    }
}
