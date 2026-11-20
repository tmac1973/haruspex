//! What a Shotcut project says, read off the span index.
//!
//! The parts Haruspex reads and edits:
//!
//! - The **main tractor**: the `<tractor>` with `<property name="shotcut">1`.
//!   Its `<track>`s are the `background` playlist (black), then one playlist
//!   per Shotcut track, bottom to top for video (V1, V2, …) after the audio
//!   tracks' placement in Shotcut's own order. A playlist says what it is with
//!   `shotcut:video` or `shotcut:audio`, and `shotcut:name` names it.
//! - The **main track** is V1: the first video playlist after `background`.
//!   A Shotcut clip's picture and sound sit together on it, so V1 is the whole
//!   main track; Haruspex edits only V1.
//! - V1's children, in timeline order, are `<entry>`s (a clip), `<blank>`s (a
//!   gap) and entries whose producer is a transition `<tractor>` (one with
//!   `shotcut:transition`): a crossfade. A crossfade's tractor has two tracks,
//!   the tail of the clip before and the head of the clip after, so each clip's
//!   own entry is short by the crossfade at that side.
//! - Every timeline clip has a `<chain>` (or `<producer>`) of its own; its
//!   filters are inside it.
//! - Times are `HH:MM:SS.mmm` at the profile's frame rate, or plain frames;
//!   `out` is the last frame shown, inclusive.

use crate::video::mlt::fps::Fps;
use crate::video::mlt::xml::Tree;
use std::path::Path;

/// Marks a filter or crossfade as Haruspex's: Shotcut keeps properties it
/// doesn't know, so the marker survives the user saving in Shotcut.
pub const OURS: &str = "haruspex:ours";

/// A playlist on the main tractor.
#[derive(Clone, Debug, PartialEq)]
pub struct Track {
    /// The playlist element.
    pub node: usize,
    pub id: String,
    pub video: bool,
    /// "V1", "A1", as Shotcut shows it.
    pub name: String,
}

/// One child of the main track, in order.
#[derive(Clone, Debug, PartialEq)]
pub enum Slot {
    Clip(Entry),
    Blank { node: usize, len: i64 },
    Fade(Fade),
}

/// A clip's own `<entry>` on a playlist.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub node: usize,
    /// The chain or producer it plays.
    pub chain: String,
    pub in_frame: i64,
    pub out_frame: i64,
    /// Where it starts on the timeline.
    pub start: i64,
}

impl Entry {
    pub fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }
}

/// A crossfade on the main track: its entry and its tractor.
#[derive(Clone, Debug, PartialEq)]
pub struct Fade {
    /// The `<entry>` on the playlist pointing at the tractor.
    pub entry: usize,
    /// The transition `<tractor>`.
    pub tractor: usize,
    pub tractor_id: String,
    pub start: i64,
    pub len: i64,
    /// Haruspex made it.
    pub ours: bool,
    /// The clip before's chain and the frame its tail ends on.
    pub a_chain: String,
    pub a_out: i64,
    /// The clip after's chain and the frame its head starts on.
    pub b_chain: String,
    pub b_in: i64,
}

/// A clip on the main track as the user sees it: its entry, with the stretch
/// either crossfade around it plays added back.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub entry: Entry,
    pub chain: String,
    pub in_frame: i64,
    pub out_frame: i64,
    pub start: i64,
    /// Index into `Doc::fades` of the crossfade into it and out of it.
    pub fade_in: Option<usize>,
    pub fade_out: Option<usize>,
}

impl Item {
    pub fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }

    pub fn end(&self) -> i64 {
        self.start + self.len()
    }
}

#[derive(Clone, Debug)]
pub struct Doc {
    pub text: String,
    pub tree: Tree,
    pub fps: Fps,
    pub width: u32,
    pub height: u32,
    /// The folder relative resources are read from: `<mlt root>`, or the
    /// project file's own folder, as melt reads it.
    pub root_dir: String,
    /// "26.6.25", from `<mlt title="Shotcut version …">`.
    pub version: String,
    /// The main `<tractor>`.
    pub main_tractor: usize,
    /// Every playlist on it but `background`, in its order.
    pub tracks: Vec<Track>,
    /// Index into `tracks` of V1.
    pub main: Option<usize>,
    pub slots: Vec<Slot>,
    pub fades: Vec<Fade>,
    pub items: Vec<Item>,
}

fn attr_i64(fps: &Fps, tree: &Tree, node: usize, name: &str) -> Option<i64> {
    tree.node(node).attr(name).and_then(|v| fps.parse(v))
}

impl Doc {
    /// Read a project. `file` is where it lives, for a project with no
    /// `root` attribute.
    pub fn parse(text: String, file: Option<&Path>) -> Result<Doc, String> {
        let tree = Tree::parse(&text).map_err(|e| e.replace("Kdenlive", "Shotcut"))?;
        let root = tree.node(tree.root);
        if root.name != "mlt" {
            return Err("not a Shotcut project: no <mlt> element".into());
        }
        let version = root
            .attr("title")
            .and_then(|t| t.strip_prefix("Shotcut version "))
            .unwrap_or("")
            .to_string();
        let root_dir = match root.attr("root") {
            Some(r) if !r.is_empty() => r.to_string(),
            _ => file
                .and_then(Path::parent)
                .map(crate::video::mlt::mlt_path)
                .unwrap_or_default(),
        };
        let profile = tree
            .children_named(tree.root, "profile")
            .next()
            .ok_or("not a Shotcut project: it has no profile")?;
        let p = tree.node(profile);
        let num = |k: &str| p.attr(k).and_then(|v| v.parse::<u32>().ok());
        let fps = Fps {
            num: num("frame_rate_num").ok_or("the profile has no frame rate")?,
            den: num("frame_rate_den").unwrap_or(1).max(1),
        };
        let width = num("width").unwrap_or(0);
        let height = num("height").unwrap_or(0);
        let main_tractor = tree
            .children_named(tree.root, "tractor")
            .find(|&t| tree.property(t, "shotcut") == Some("1"))
            .ok_or("not a Shotcut project: no main tractor (saved by Shotcut?)")?;

        let mut tracks = Vec::new();
        for t in tree.children_named(main_tractor, "track") {
            let Some(id) = tree.node(t).attr("producer") else {
                continue;
            };
            if id == "background" {
                continue;
            }
            let Some(pl) = tree.by_id(id) else { continue };
            if tree.node(pl).name != "playlist" {
                continue;
            }
            let video = tree.property(pl, "shotcut:video") == Some("1");
            let audio = tree.property(pl, "shotcut:audio") == Some("1");
            if !video && !audio {
                continue;
            }
            tracks.push(Track {
                node: pl,
                id: id.to_string(),
                video,
                name: tree.property(pl, "shotcut:name").unwrap_or("").to_string(),
            });
        }
        let main = tracks.iter().position(|t| t.video);

        let mut doc = Doc {
            text,
            tree,
            fps,
            width,
            height,
            root_dir,
            version,
            main_tractor,
            tracks,
            main,
            slots: Vec::new(),
            fades: Vec::new(),
            items: Vec::new(),
        };
        if let Some(m) = doc.main {
            doc.slots = doc.read_slots(doc.tracks[m].node)?;
            doc.fades = doc
                .slots
                .iter()
                .filter_map(|s| match s {
                    Slot::Fade(f) => Some(f.clone()),
                    _ => None,
                })
                .collect();
            doc.items = doc.read_items();
        }
        Ok(doc)
    }

    /// A playlist's children as slots, with where each starts.
    pub fn read_slots(&self, playlist: usize) -> Result<Vec<Slot>, String> {
        let tree = &self.tree;
        let fps = &self.fps;
        let mut at = 0i64;
        let mut out = Vec::new();
        for &c in &tree.node(playlist).children {
            let n = tree.node(c);
            match n.name.as_str() {
                "blank" => {
                    let len = attr_i64(fps, tree, c, "length").unwrap_or(0);
                    at += len;
                    out.push(Slot::Blank { node: c, len });
                }
                "entry" => {
                    let producer = n.attr("producer").unwrap_or("").to_string();
                    let in_frame = attr_i64(fps, tree, c, "in").unwrap_or(0);
                    let out_frame = attr_i64(fps, tree, c, "out").unwrap_or(in_frame);
                    let len = out_frame - in_frame + 1;
                    let target = tree.by_id(&producer);
                    let fade_tractor = target.filter(|&t| {
                        tree.node(t).name == "tractor"
                            && tree.property(t, "shotcut:transition").is_some()
                    });
                    if let Some(t) = fade_tractor {
                        let sides: Vec<usize> = tree.children_named(t, "track").collect();
                        if sides.len() != 2 {
                            return Err(format!(
                                "the crossfade {producer} doesn't have two clips in it"
                            ));
                        }
                        let side = |k: usize| {
                            let s = sides[k];
                            (
                                tree.node(s).attr("producer").unwrap_or("").to_string(),
                                attr_i64(fps, tree, s, "in").unwrap_or(0),
                                attr_i64(fps, tree, s, "out").unwrap_or(0),
                            )
                        };
                        let (a_chain, _, a_out) = side(0);
                        let (b_chain, b_in, _) = side(1);
                        out.push(Slot::Fade(Fade {
                            entry: c,
                            tractor: t,
                            tractor_id: producer,
                            start: at,
                            len,
                            ours: tree.property(t, OURS) == Some("1"),
                            a_chain,
                            a_out,
                            b_chain,
                            b_in,
                        }));
                    } else {
                        out.push(Slot::Clip(Entry {
                            node: c,
                            chain: producer,
                            in_frame,
                            out_frame,
                            start: at,
                        }));
                    }
                    at += len;
                }
                _ => {}
            }
        }
        Ok(out)
    }

    /// The main track's clips, each widened by the crossfades at its sides.
    fn read_items(&self) -> Vec<Item> {
        let mut items = Vec::new();
        let mut fade_no = 0usize;
        let mut last_fade: Option<usize> = None;
        let mut prev_was_fade = false;
        for slot in &self.slots {
            match slot {
                Slot::Fade(_) => {
                    if let Some(prev) = items.last_mut() {
                        let prev: &mut Item = prev;
                        if prev.fade_out.is_none() {
                            prev.fade_out = Some(fade_no);
                            prev.out_frame = self.fades[fade_no].a_out;
                        }
                    }
                    last_fade = Some(fade_no);
                    fade_no += 1;
                    prev_was_fade = true;
                }
                Slot::Blank { .. } => {
                    prev_was_fade = false;
                }
                Slot::Clip(e) => {
                    let fade_in = if prev_was_fade { last_fade } else { None };
                    let (in_frame, start) = match fade_in {
                        Some(f) => (self.fades[f].b_in, self.fades[f].start),
                        None => (e.in_frame, e.start),
                    };
                    items.push(Item {
                        entry: e.clone(),
                        chain: e.chain.clone(),
                        in_frame,
                        out_frame: e.out_frame,
                        start,
                        fade_in,
                        fade_out: None,
                    });
                    prev_was_fade = false;
                }
            }
        }
        items
    }

    /// Why Haruspex can't edit this project, if it can't.
    pub fn editable(&self) -> Result<(), String> {
        let gpu = self
            .tree
            .property(self.main_tractor, "shotcut:processingMode")
            .is_some_and(|m| m.contains("Gpu"))
            || self.tree.nodes.iter().any(|n| {
                n.name == "property"
                    && n.attr("name") == Some("mlt_service")
                    && n.text.starts_with("movit.")
            });
        if gpu {
            return Err(
                "This project uses Shotcut's GPU processing, which Haruspex can't render. \
                 Switch it to Native in Shotcut's Settings → Processing Mode and save."
                    .into(),
            );
        }
        let Some(m) = self.main else {
            return Err("This Shotcut project has no video track.".into());
        };
        if self.tree.property(self.tracks[m].node, "shotcut:lock") == Some("1") {
            return Err(format!(
                "Track {} is locked in Shotcut. Unlock it there and save first.",
                self.tracks[m].name
            ));
        }
        Ok(())
    }

    /// The chain or producer element an id names.
    pub fn chain(&self, id: &str) -> Option<usize> {
        self.tree.by_id(id)
    }

    pub fn resource(&self, chain: &str) -> String {
        self.chain(chain)
            .and_then(|c| self.tree.property(c, "resource"))
            .unwrap_or("")
            .to_string()
    }

    /// A chain's stream index for `audio_index` / `video_index`; `None` when
    /// it has none (`-1`).
    pub fn stream(&self, chain: &str, which: &str) -> Option<u32> {
        let c = self.chain(chain)?;
        match self.tree.property(c, which) {
            Some(v) => v
                .trim()
                .parse::<i64>()
                .ok()
                .filter(|&i| i >= 0)
                .map(|i| i as u32),
            // Not said: MLT picks the first, and a file with none has none.
            None => Some(if which == "audio_index" { 1 } else { 0 }),
        }
    }

    /// Filters directly in a chain.
    pub fn filters(&self, chain: &str) -> Vec<usize> {
        self.chain(chain)
            .map(|c| self.tree.children_named(c, "filter").collect())
            .unwrap_or_default()
    }

    /// Haruspex's filters in a chain.
    pub fn our_filters(&self, chain: &str) -> Vec<usize> {
        self.filters(chain)
            .into_iter()
            .filter(|&f| self.tree.property(f, OURS) == Some("1"))
            .collect()
    }

    /// The gain Haruspex set on a chain, in dB.
    pub fn our_gain(&self, chain: &str) -> Option<f64> {
        self.our_filters(chain).into_iter().find_map(|f| {
            (self.tree.property(f, "mlt_service") == Some("volume"))
                .then(|| self.tree.property(f, "level"))
                .flatten()
                .and_then(|l| l.rsplit('=').next()?.trim().parse::<f64>().ok())
        })
    }

    pub fn our_limiter(&self, chain: &str) -> bool {
        self.our_filters(chain)
            .into_iter()
            .any(|f| self.tree.property(f, "mlt_service") == Some("avfilter.alimiter"))
    }

    /// Clips on a playlist that isn't the main one: (entry, chain) pairs.
    pub fn track_entries(&self, track: usize) -> Vec<Entry> {
        self.read_slots(self.tracks[track].node)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|s| match s {
                Slot::Clip(e) => Some(e),
                _ => None,
            })
            .collect()
    }

    /// Where the main track ends, in frames: the longest track.
    pub fn sequence_end(&self) -> i64 {
        (0..self.tracks.len())
            .map(|t| {
                self.read_slots(self.tracks[t].node)
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
            .unwrap_or(0)
    }

    /// Markers the user put on the timeline.
    pub fn markers(&self) -> usize {
        self.tree
            .children_named(self.main_tractor, "properties")
            .find(|&p| self.tree.node(p).attr("name") == Some("shotcut:markers"))
            .map(|p| self.tree.children_named(p, "properties").count())
            .unwrap_or(0)
    }

    /// The highest `<prefix>N` id in the file.
    pub fn max_id_number(&self, prefix: &str) -> i64 {
        self.tree
            .nodes
            .iter()
            .filter_map(|n| n.attr("id"))
            .filter_map(|id| id.strip_prefix(prefix)?.parse::<i64>().ok())
            .max()
            .unwrap_or(-1)
    }
}
