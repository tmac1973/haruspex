//! What a Kdenlive 26.08 project says, read off the span index.
//!
//! The parts Haruspex edits:
//!
//! - The **main sequence**: the tractor whose id is `kdenlive:docproperties.uuid`.
//!   Its `<track>`s are the black track, then one tractor per Kdenlive track in
//!   timeline order from the top audio track down to the top video track
//!   (A2, A1, V1, V2 in a default project). A track tractor's `<track>`s carry
//!   `hide="video"` on an audio track.
//! - Each track tractor has two playlists, A and B. Clips joined by a
//!   same-track mix sit on alternate playlists and overlap; the mix is a
//!   `<transition>` inside the track tractor.
//! - The **main track** is V1, the lowest video track, with A1, the audio track
//!   next to it. Haruspex edits only these two.
//! - A timeline clip is an `<entry>` pointing at a chain of its own, whose
//!   `kdenlive:id` and `kdenlive:control_uuid` name the bin clip it is an
//!   instance of. A clip's picture and sound are two entries, one per track,
//!   tied by an `AVSplit` group in `kdenlive:sequenceproperties.groups`, whose
//!   leaves are `"<track index>:<position>:-1"` with the track index counted
//!   from 0 over the track tractors (black excluded).
//! - Times are `HH:MM:SS.mmm`, converted at the profile's frame rate; `out` is
//!   the last frame shown, inclusive.

use super::xml::Tree;

/// The only document version Haruspex edits (Kdenlive 25.04–26.08).
pub const SUPPORTED_VERSION: &str = "1.1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

impl Fps {
    pub fn frames(&self, secs: f64) -> i64 {
        (secs * self.num as f64 / self.den as f64).round() as i64
    }

    pub fn secs(&self, frames: i64) -> f64 {
        frames as f64 * self.den as f64 / self.num as f64
    }

    fn rate(&self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// `HH:MM:SS.mmm`, the way MLT writes a time for Kdenlive. Whole hours and
    /// minutes are taken off in truncated frames before the seconds are
    /// divided out, so at 29.97 fps frame 58238 is `00:32:23.223`, not the
    /// `23.208` a plain division gives; `parse` undoes exactly this.
    pub fn timecode(&self, frames: i64) -> String {
        let fps = self.rate();
        let mut f = frames.max(0);
        let h = (f as f64 / (fps * 3600.0)) as i64;
        f -= (h as f64 * fps * 3600.0) as i64;
        let m = (f as f64 / (fps * 60.0)) as i64;
        f -= (m as f64 * fps * 60.0) as i64;
        let secs = f as f64 / fps;
        format!("{h:02}:{m:02}:{secs:06.3}")
    }

    /// A time as Kdenlive or MLT writes it: `HH:MM:SS.mmm`, or plain frames.
    pub fn parse(&self, t: &str) -> Option<i64> {
        let t = t.trim();
        if let Ok(f) = t.parse::<i64>() {
            return Some(f);
        }
        let mut parts = t.split(':');
        let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let fps = self.rate();
        let (h, m, s) = (
            h.parse::<f64>().ok()?,
            m.parse::<f64>().ok()?,
            s.parse::<f64>().ok()?,
        );
        Some((h * 3600.0 * fps) as i64 + (m * 60.0 * fps) as i64 + (s * fps).round() as i64)
    }
}

#[derive(Clone, Debug)]
pub struct Track {
    /// The track tractor's node.
    pub tractor: usize,
    /// Its two playlists, A then B.
    pub playlists: Vec<usize>,
    pub audio: bool,
}

/// One `<entry>` on a playlist, placed on the timeline.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub node: usize,
    /// 0 for playlist A, 1 for B.
    pub lane: usize,
    pub start: i64,
    pub in_frame: i64,
    pub out_frame: i64,
    pub chain: String,
    /// The bin clip's `kdenlive:id`.
    pub bin_id: String,
    /// Effects the user put on this clip.
    pub filters: usize,
}

impl Entry {
    pub fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }

    pub fn end(&self) -> i64 {
        self.start + self.len()
    }
}

/// A same-track mix: a transition inside a track tractor joining the clip that
/// ends in it to the one that starts at its `in`.
#[derive(Clone, Debug, PartialEq)]
pub struct Mix {
    pub node: usize,
    pub track: usize,
    pub in_frame: i64,
    pub out_frame: i64,
    /// Haruspex wrote it (`kdenlive:haruspex`), so Haruspex may rewrite it.
    /// Any other mix is the user's.
    pub ours: bool,
}

/// The property that marks a filter or transition as Haruspex's own.
pub const OURS: &str = "kdenlive:haruspex";

/// A clip on the main track: its picture and its sound, together.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub video: Option<Entry>,
    pub audio: Option<Entry>,
}

impl Item {
    pub fn any(&self) -> &Entry {
        self.video
            .as_ref()
            .or(self.audio.as_ref())
            .expect("an item has at least one entry")
    }

    pub fn start(&self) -> i64 {
        self.any().start
    }

    pub fn end(&self) -> i64 {
        self.video
            .iter()
            .chain(self.audio.iter())
            .map(Entry::end)
            .max()
            .unwrap_or(0)
    }

    pub fn filters(&self) -> usize {
        self.video
            .iter()
            .chain(self.audio.iter())
            .map(|e| e.filters)
            .sum()
    }
}

/// A bin clip: a `main_bin` entry's chain or producer.
#[derive(Clone, Debug, PartialEq)]
pub struct BinClip {
    pub node: usize,
    pub id: String,
    pub kdenlive_id: String,
    pub uuid: String,
    pub resource: String,
    pub length: i64,
}

pub struct Doc {
    pub text: String,
    pub tree: Tree,
    pub fps: Fps,
    pub width: u32,
    pub height: u32,
    pub root_dir: String,
    pub version: String,
    pub kdenlive_version: String,
    pub bin: usize,
    pub sequence: usize,
    pub project_tractor: Option<usize>,
    pub black: Option<usize>,
    pub tracks: Vec<Track>,
    /// Indexes into `tracks`.
    pub main_video: usize,
    pub main_audio: usize,
}

impl Doc {
    pub fn parse(text: String) -> Result<Doc, String> {
        let tree = Tree::parse(&text)?;
        let root = tree.node(tree.root);
        if root.name != "mlt" {
            return Err("not a Kdenlive project (no <mlt> element)".into());
        }
        let root_dir = root.attr("root").unwrap_or("").to_string();
        let profile = tree
            .children_named(tree.root, "profile")
            .next()
            .ok_or("the project has no profile")?;
        let p = tree.node(profile);
        let num = p.attr("frame_rate_num").and_then(|v| v.parse().ok());
        let den = p.attr("frame_rate_den").and_then(|v| v.parse().ok());
        let (Some(num), Some(den)) = (num, den) else {
            return Err("the project's profile has no frame rate".into());
        };
        if num == 0 || den == 0 {
            return Err("the project's profile has no frame rate".into());
        }
        let width = p.attr("width").and_then(|v| v.parse().ok()).unwrap_or(0);
        let height = p.attr("height").and_then(|v| v.parse().ok()).unwrap_or(0);
        let bin = tree.by_id("main_bin").ok_or("the project has no bin")?;
        let version = tree
            .property(bin, "kdenlive:docproperties.version")
            .unwrap_or("")
            .to_string();
        let kdenlive_version = tree
            .property(bin, "kdenlive:docproperties.kdenliveversion")
            .unwrap_or("")
            .to_string();
        let uuid = tree
            .property(bin, "kdenlive:docproperties.uuid")
            .ok_or("the project names no sequence (Kdenlive older than 23.04?)")?
            .to_string();
        let sequence = tree
            .by_id(&uuid)
            .ok_or("the project's main sequence is missing")?;
        let project_tractor = tree.nodes[tree.root]
            .children
            .iter()
            .copied()
            .find(|&c| tree.property(c, "kdenlive:projectTractor") == Some("1"));

        let mut black = None;
        let mut tracks = Vec::new();
        for t in tree.children_named(sequence, "track") {
            let Some(producer) = tree.node(t).attr("producer") else {
                continue;
            };
            let Some(target) = tree.by_id(producer) else {
                continue;
            };
            if tree.node(target).name != "tractor" {
                black = Some(target);
                continue;
            }
            let playlists: Vec<usize> = tree
                .children_named(target, "track")
                .filter_map(|tt| tree.node(tt).attr("producer"))
                .filter_map(|id| tree.by_id(id))
                .collect();
            let audio = tree
                .children_named(target, "track")
                .any(|tt| tree.node(tt).attr("hide") == Some("video"));
            tracks.push(Track {
                tractor: target,
                playlists,
                audio,
            });
        }
        let main_video = tracks
            .iter()
            .position(|t| !t.audio)
            .ok_or("the project has no video track")?;
        let main_audio = tracks[..main_video]
            .iter()
            .rposition(|t| t.audio)
            .ok_or("the project has no audio track below its first video track")?;
        Ok(Doc {
            text,
            tree,
            fps: Fps { num, den },
            width,
            height,
            root_dir,
            version,
            kdenlive_version,
            bin,
            sequence,
            project_tractor,
            black,
            tracks,
            main_video,
            main_audio,
        })
    }

    pub fn editable(&self) -> Result<(), String> {
        if self.version == SUPPORTED_VERSION {
            return Ok(());
        }
        Err(format!(
            "This project was saved by a Kdenlive version Haruspex can't edit yet (document \
             version {}). Opening it is fine; editing is not.",
            if self.version.is_empty() {
                "unknown"
            } else {
                &self.version
            }
        ))
    }

    /// Every entry on one playlist, placed.
    pub fn entries(&self, playlist: usize, lane: usize) -> Vec<Entry> {
        let mut at = 0i64;
        let mut out = Vec::new();
        for &c in &self.tree.node(playlist).children {
            let n = self.tree.node(c);
            match n.name.as_str() {
                "blank" => {
                    at += n
                        .attr("length")
                        .and_then(|l| self.fps.parse(l))
                        .unwrap_or(0);
                }
                "entry" => {
                    let in_frame = n.attr("in").and_then(|t| self.fps.parse(t)).unwrap_or(0);
                    let out_frame = n
                        .attr("out")
                        .and_then(|t| self.fps.parse(t))
                        .unwrap_or(in_frame);
                    let chain = n.attr("producer").unwrap_or("").to_string();
                    let bin_id = self
                        .tree
                        .property(c, "kdenlive:id")
                        .map(str::to_string)
                        .or_else(|| {
                            self.tree
                                .by_id(&chain)
                                .and_then(|ch| self.tree.property(ch, "kdenlive:id"))
                                .map(str::to_string)
                        })
                        .unwrap_or_default();
                    // The user's effects: Haruspex's own gain and limiter aren't.
                    let filters = self
                        .tree
                        .children_named(c, "filter")
                        .filter(|&f| self.tree.property(f, OURS) != Some("1"))
                        .count();
                    let e = Entry {
                        node: c,
                        lane,
                        start: at,
                        in_frame,
                        out_frame,
                        chain,
                        bin_id,
                        filters,
                    };
                    at = e.end();
                    out.push(e);
                }
                _ => {}
            }
        }
        out
    }

    /// Every entry on a track, both lanes, by start.
    pub fn track_entries(&self, track: usize) -> Vec<Entry> {
        let mut all: Vec<Entry> = self.tracks[track]
            .playlists
            .iter()
            .enumerate()
            .flat_map(|(lane, &pl)| self.entries(pl, lane))
            .collect();
        all.sort_by_key(|e| (e.start, e.lane));
        all
    }

    /// Where a track's last clip ends.
    pub fn track_end(&self, track: usize) -> i64 {
        self.track_entries(track)
            .iter()
            .map(Entry::end)
            .max()
            .unwrap_or(0)
    }

    /// Same-track mixes on a track.
    pub fn mixes(&self, track: usize) -> Vec<Mix> {
        let tractor = self.tracks[track].tractor;
        self.tree
            .children_named(tractor, "transition")
            .map(|t| {
                let n = self.tree.node(t);
                Mix {
                    node: t,
                    track,
                    in_frame: n.attr("in").and_then(|v| self.fps.parse(v)).unwrap_or(0),
                    out_frame: n.attr("out").and_then(|v| self.fps.parse(v)).unwrap_or(0),
                    ours: self.tree.property(t, OURS) == Some("1"),
                }
            })
            .collect()
    }

    /// Haruspex's own filters on an entry: its Volume and Limiter.
    pub fn our_filters(&self, entry: usize) -> Vec<usize> {
        self.tree
            .children_named(entry, "filter")
            .filter(|&f| self.tree.property(f, OURS) == Some("1"))
            .collect()
    }

    /// Whether Haruspex put a Limiter on an entry.
    pub fn our_limiter(&self, entry: usize) -> bool {
        self.our_filters(entry)
            .into_iter()
            .any(|f| self.tree.property(f, "mlt_service") == Some("avfilter.alimiter"))
    }

    /// The gain Haruspex set on an entry (its tagged Volume filter), in dB.
    pub fn our_gain(&self, entry: usize) -> Option<(usize, f64)> {
        self.tree
            .children_named(entry, "filter")
            .find(|&f| {
                self.tree.property(f, OURS) == Some("1")
                    && self.tree.property(f, "mlt_service") == Some("volume")
            })
            .and_then(|f| {
                let level = self.tree.property(f, "level")?;
                // "00:00:00.000=3" (a keyframe), or a plain number.
                let value = level.rsplit('=').next()?.trim().parse::<f64>().ok()?;
                Some((f, value))
            })
    }

    /// The highest number in any element id of the form `<prefix><n>`,
    /// nested ones too (filters live inside entries).
    pub fn max_nested_id(&self, prefix: &str) -> i64 {
        self.tree
            .nodes
            .iter()
            .filter_map(|n| n.attr("id")?.strip_prefix(prefix)?.parse::<i64>().ok())
            .max()
            .unwrap_or(-1)
    }

    /// The `"track:position"` pairs of every `AVSplit` group.
    pub fn groups(&self) -> serde_json::Value {
        self.tree
            .property(self.sequence, "kdenlive:sequenceproperties.groups")
            .and_then(|g| serde_json::from_str(g).ok())
            .unwrap_or(serde_json::Value::Array(Vec::new()))
    }

    /// The main track's clips, picture and sound paired, by start.
    pub fn items(&self) -> Vec<Item> {
        let video = self.track_entries(self.main_video);
        let mut audio = self.track_entries(self.main_audio);
        let pairs = av_pairs(&self.groups(), self.main_video, self.main_audio);
        let mut items = Vec::new();
        for v in video {
            let partner = audio
                .iter()
                .position(|a| pairs.contains(&(v.start, a.start)) && a.bin_id == v.bin_id)
                .or_else(|| {
                    audio
                        .iter()
                        .position(|a| a.start == v.start && a.bin_id == v.bin_id)
                });
            let a = partner.map(|i| audio.remove(i));
            items.push(Item {
                video: Some(v),
                audio: a,
            });
        }
        items.extend(audio.into_iter().map(|a| Item {
            video: None,
            audio: Some(a),
        }));
        items.sort_by_key(|i| i.start());
        items
    }

    /// Bin clips, by `kdenlive:id`.
    pub fn bin_clips(&self) -> Vec<BinClip> {
        self.tree
            .children_named(self.bin, "entry")
            .filter_map(|e| self.tree.node(e).attr("producer"))
            .filter_map(|id| self.tree.by_id(id).map(|n| (id, n)))
            .filter(|(_, n)| self.tree.node(*n).name != "tractor")
            .map(|(id, n)| BinClip {
                node: n,
                id: id.to_string(),
                kdenlive_id: self.tree.property(n, "kdenlive:id").unwrap_or("").into(),
                uuid: self
                    .tree
                    .property(n, "kdenlive:control_uuid")
                    .unwrap_or("")
                    .into(),
                resource: self.tree.property(n, "resource").unwrap_or("").into(),
                length: self
                    .tree
                    .property(n, "length")
                    .and_then(|l| l.parse().ok())
                    .unwrap_or(0),
            })
            .collect()
    }

    pub fn bin_clip(&self, kdenlive_id: &str) -> Option<BinClip> {
        self.bin_clips()
            .into_iter()
            .find(|b| b.kdenlive_id == kdenlive_id)
    }

    /// The highest `kdenlive:id` in use.
    pub fn max_kdenlive_id(&self) -> i64 {
        self.tree
            .nodes
            .iter()
            .filter(|n| n.name == "property" && n.attr("name") == Some("kdenlive:id"))
            .filter_map(|n| n.text.trim().parse::<i64>().ok())
            .max()
            .unwrap_or(0)
    }

    /// The highest number in an id of the form `<prefix><n>`.
    pub fn max_id_number(&self, prefix: &str) -> i64 {
        self.tree.nodes[self.tree.root]
            .children
            .iter()
            .filter_map(|&c| self.tree.node(c).attr("id"))
            .filter_map(|id| id.strip_prefix(prefix)?.parse::<i64>().ok())
            .max()
            .unwrap_or(-1)
    }

    /// Where the whole sequence ends: the furthest clip end on any track.
    pub fn sequence_end(&self) -> i64 {
        (0..self.tracks.len())
            .map(|t| self.track_end(t))
            .max()
            .unwrap_or(0)
    }
}

/// `(video position, audio position)` for each `AVSplit` group joining the two
/// main tracks.
fn av_pairs(groups: &serde_json::Value, video: usize, audio: usize) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    let Some(list) = groups.as_array() else {
        return out;
    };
    for g in list {
        if g.get("type").and_then(|t| t.as_str()) != Some("AVSplit") {
            continue;
        }
        let leaves: Vec<(usize, i64)> = g
            .get("children")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .filter_map(|l| parse_leaf(l.get("data")?.as_str()?))
            .collect();
        let v = leaves.iter().find(|(t, _)| *t == video).map(|(_, p)| *p);
        let a = leaves.iter().find(|(t, _)| *t == audio).map(|(_, p)| *p);
        if let (Some(v), Some(a)) = (v, a) {
            out.push((v, a));
        }
    }
    out
}

/// `"2:152:-1"` → (2, 152).
pub fn parse_leaf(data: &str) -> Option<(usize, i64)> {
    let mut parts = data.split(':');
    let track = parts.next()?.parse().ok()?;
    let pos = parts.next()?.parse().ok()?;
    Some((track, pos))
}
