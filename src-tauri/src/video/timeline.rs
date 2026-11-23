//! What a project's main track is, whatever editor made it: the clips the
//! tools place on it, and where a moment of a clip lands in the cut, for
//! transcripts, captions and chapters read in the video's own time.

use std::path::{Path, PathBuf};

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
    /// Another copy of that item, with chains of its own and its effects: a
    /// piece of a clip split in two.
    Piece(usize),
    New(Media),
}

/// How a clip's picture fills the frame when its shape differs.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum Fit {
    /// The whole picture, with bars where the shapes differ (MLT's own way).
    Letterbox,
    /// Filled edge to edge, the centre kept and the spare cut off.
    Fill,
    /// This region of the source, as fractions 0–1 of its frame.
    Crop { x: f64, y: f64, w: f64, h: f64 },
}

impl Fit {
    /// What is wrong with a crop region, or `None`.
    pub fn problem(&self) -> Option<String> {
        let Fit::Crop { x, y, w, h } = *self else {
            return None;
        };
        let ok = |v: f64| v.is_finite() && (0.0..=1.0).contains(&v);
        if ![x, y, w, h].into_iter().all(ok) || w <= 0.0 || h <= 0.0 {
            return Some(
                "A crop's x, y, w and h are fractions from 0 to 1, w and h above 0.".into(),
            );
        }
        if x + w > 1.0 + 1e-9 || y + h > 1.0 + 1e-9 {
            return Some("A crop must stay inside the picture: x + w and y + h at most 1.".into());
        }
        None
    }
}

/// A gain over a stretch of a clip's sound, in the clip's source frames
/// (`to_frame` the last one it covers). A gain of -60 dB or less is a mute.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GainRange {
    #[ts(type = "number")]
    pub from_frame: i64,
    #[ts(type = "number")]
    pub to_frame: i64,
    pub gain_db: f64,
}

/// One clip of the wanted main track. `None` keeps an existing item's point,
/// or is the start / end of new media.
#[derive(Clone, Debug, PartialEq)]
pub struct Placement {
    pub source: Source,
    pub in_frame: Option<i64>,
    pub out_frame: Option<i64>,
    /// A crossfade of this many frames from the clip before (Haruspex's own).
    pub mix_in: Option<i64>,
    /// The gain to set on its sound, in dB; `None` leaves what is there, and
    /// 0 removes Haruspex's.
    pub gain_db: Option<f64>,
    /// With `gain_db`: a Limiter after the gain, holding peaks at -1.5 dB.
    pub limiter: bool,
    /// How its picture fills the frame; `None` leaves what is there, and
    /// `Letterbox` removes Haruspex's crop.
    pub fit: Option<Fit>,
    /// Gains over stretches of its sound; `None` leaves what is there, and an
    /// empty list removes Haruspex's.
    pub gain_ranges: Option<Vec<GainRange>>,
    /// How fast it plays, 0.25–4; `None` leaves it as it is. Its in and out
    /// stay in source frames whatever the speed.
    pub speed: Option<f64>,
}

impl Placement {
    pub fn of(source: Source) -> Placement {
        Placement {
            source,
            in_frame: None,
            out_frame: None,
            mix_in: None,
            gain_db: None,
            limiter: false,
            fit: None,
            gain_ranges: None,
            speed: None,
        }
    }
}

/// Where a sound under the picture comes from.
#[derive(Clone, Debug, PartialEq)]
pub enum AudioSource {
    /// The audio-track item with this index in `ProjectDoc::audio_clips`.
    Existing(usize),
    New(Media),
}

/// One item of the wanted audio tracks: a sound placed at a time in the
/// video, under the picture, on a track of its own.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioPlacement {
    pub source: AudioSource,
    /// Where it starts on the timeline, in frames.
    pub at: i64,
    pub in_frame: Option<i64>,
    pub out_frame: Option<i64>,
    /// Index into the doc's audio tracks (`AudioClip::track`); one past the
    /// last asks for a new track.
    pub track: usize,
    /// As `Placement::gain_db`.
    pub gain_db: Option<f64>,
    pub limiter: bool,
    /// The loudness its gain aims at, kept with the gain; `None` is -14 LUFS.
    pub lufs: Option<f64>,
}

/// A clip on one of the audio tracks under the picture.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioClip {
    /// Index into the doc's audio tracks, bottom (nearest the main track) first.
    pub track: usize,
    /// "A1", "A2", as the editor shows it.
    pub track_name: String,
    pub resource: String,
    pub start: i64,
    pub in_frame: i64,
    pub out_frame: i64,
    /// The file's audio stream it plays, when it has one.
    pub stream: Option<u32>,
    pub gain_db: Option<f64>,
    pub limited: bool,
    pub lufs: Option<f64>,
}

impl AudioClip {
    pub fn len(&self) -> i64 {
        self.out_frame - self.in_frame + 1
    }
}

/// The current audio tracks as placements: applying them changes nothing.
pub fn current_audio(clips: &[AudioClip]) -> Vec<AudioPlacement> {
    clips
        .iter()
        .enumerate()
        .map(|(i, c)| AudioPlacement {
            source: AudioSource::Existing(i),
            at: c.start,
            in_frame: None,
            out_frame: None,
            track: c.track,
            gain_db: None,
            limiter: false,
            lufs: None,
        })
        .collect()
}

/// Put each placement on a track where it overlaps nothing: the one it is on
/// when it still fits there, else the lowest that fits, else a new one.
/// Items already on a track choose first, so adding a sound leaves them be.
/// `lens` is each placement's length in frames; the project has `tracks`
/// audio tracks already.
pub fn assign_audio_tracks(wanted: &mut [AudioPlacement], lens: &[i64], tracks: usize) {
    let mut order: Vec<usize> = (0..wanted.len()).collect();
    order.sort_by_key(|&k| {
        let new = matches!(wanted[k].source, AudioSource::New(_));
        (new, wanted[k].at, k)
    });
    let mut busy: Vec<Vec<(i64, i64)>> = vec![Vec::new(); tracks];
    let fits = |busy: &Vec<Vec<(i64, i64)>>, t: usize, a: i64, b: i64| {
        busy.get(t)
            .is_none_or(|spans| spans.iter().all(|&(x, y)| b <= x || a >= y))
    };
    for k in order {
        let (a, b) = (wanted[k].at, wanted[k].at + lens[k].max(1));
        let preferred = wanted[k].track;
        let t = if preferred < busy.len() && fits(&busy, preferred, a, b) {
            preferred
        } else {
            (0..=busy.len())
                .find(|&t| fits(&busy, t, a, b))
                .unwrap_or(busy.len())
        };
        if busy.len() <= t {
            busy.resize(t + 1, Vec::new());
        }
        busy[t].push((a, b));
        wanted[k].track = t;
    }
}

#[derive(Debug)]
pub struct Edited {
    pub text: String,
    /// Things worth telling the model (a clamped trim, other tracks).
    pub notes: Vec<String>,
}

/// A main-track clip as the tools that measure or cut it see it.
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    /// As the project's `resource` says it.
    pub resource: String,
    /// In project frames; `out_frame` is the last one shown.
    pub in_frame: i64,
    pub out_frame: i64,
    pub audio: Option<ClipAudio>,
    /// The gain ranges Haruspex set on its sound.
    pub gain_ranges: Vec<GainRange>,
    /// The fit Haruspex set on its picture; `None` is letterbox.
    pub fit: Option<Fit>,
    /// How fast it plays; its in and out are source frames all the same.
    pub speed: f64,
}

/// The sound of a clip, when it has any on the main track.
#[derive(Clone, Debug, PartialEq)]
pub struct ClipAudio {
    /// The file's audio stream it plays.
    pub stream: u32,
    pub in_frame: i64,
    pub out_frame: i64,
}

/// One main-track item in seconds: where it sits and which stretch of which
/// file it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    /// 1-based, as the tools number clips.
    pub index: usize,
    pub file: PathBuf,
    pub start: f64,
    pub source_in: f64,
    pub source_out: f64,
    /// How fast it plays: a second of the cut shows this many of the source.
    pub speed: f64,
    /// On an audio track under the picture; `index` then counts those items.
    pub audio: bool,
}

/// The audio-track clips as spans, numbered from 1 in time order as the
/// tools list them.
pub fn audio_spans(
    clips: &[AudioClip],
    root_dir: &str,
    fps: crate::video::mlt::fps::Fps,
) -> Vec<Span> {
    let mut order: Vec<&AudioClip> = clips.iter().collect();
    order.sort_by_key(|c| (c.start, c.track));
    order
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let p = Path::new(&c.resource);
            Span {
                index: i + 1,
                file: if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    Path::new(root_dir).join(p)
                },
                start: fps.secs(c.start),
                source_in: fps.secs(c.in_frame),
                source_out: fps.secs(c.out_frame + 1),
                speed: 1.0,
                audio: true,
            }
        })
        .collect()
}

/// Which item shows the cut at `t` seconds, and the moment of its source.
pub fn source_at(spans: &[Span], t: f64) -> Option<(&Span, f64)> {
    spans
        .iter()
        .rev()
        .find(|s| t >= s.start && t < s.start + (s.source_out - s.source_in) / s.speed)
        .map(|s| (s, s.source_in + (t - s.start) * s.speed))
}

/// A stretch of speech in the cut's time.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub index: usize,
    /// From an audio-track item, as `Span::audio`.
    pub audio: bool,
    /// The words of it this piece plays, in the cut's time.
    pub words: Vec<crate::whisper::Word>,
}

/// Shorter than this, a stretch of speech left by a cut is a sliver, not a line.
const MIN_LINE_SECS: f64 = 0.3;

/// Each span's transcribed speech, mapped into the cut. Main-track and
/// audio-track spans of one file are told apart. A segment shows once,
/// in the piece that plays most of it (a clip split by a cut would otherwise
/// say its sentence twice), clipped to that piece; slivers are left out.
pub fn lines(
    spans: &[Span],
    transcript_for: impl Fn(&Path) -> Option<Vec<crate::whisper::Segment>>,
) -> (Vec<Line>, Vec<(usize, bool)>) {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    let mut transcripts: std::collections::HashMap<PathBuf, Option<Vec<crate::whisper::Segment>>> =
        std::collections::HashMap::new();
    for span in spans {
        let segments = transcripts
            .entry(span.file.clone())
            .or_insert_with(|| transcript_for(&span.file));
        if segments.is_none() {
            missing.push((span.index, span.audio));
        }
    }
    let overlap = |span: &Span, s: &crate::whisper::Segment| {
        (s.end.min(span.source_out) - s.start.max(span.source_in)).max(0.0)
    };
    for (file, segments) in &transcripts {
        let Some(segments) = segments else { continue };
        for audio in [false, true] {
            let pieces: Vec<&Span> = spans
                .iter()
                .filter(|s| &s.file == file && s.audio == audio)
                .collect();
            for s in segments {
                let best = pieces
                    .iter()
                    .filter(|p| overlap(p, s) > 0.0)
                    .max_by(|a, b| overlap(a, s).total_cmp(&overlap(b, s)));
                let Some(span) = best else { continue };
                if overlap(span, s) < MIN_LINE_SECS {
                    continue;
                }
                let from = s.start.max(span.source_in);
                let to = s.end.min(span.source_out);
                let cut = |t: f64| span.start + (t.clamp(from, to) - span.source_in) / span.speed;
                // A word belongs to this piece when its middle plays in it.
                let words = s
                    .words
                    .iter()
                    .filter(|w| (from..=to).contains(&((w.start + w.end) / 2.0)))
                    .map(|w| crate::whisper::Word {
                        start: cut(w.start),
                        end: cut(w.end),
                        text: w.text.clone(),
                    })
                    .collect();
                out.push(Line {
                    start: cut(from),
                    end: cut(to),
                    text: s.text.clone(),
                    index: span.index,
                    audio,
                    words,
                });
            }
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    (out, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_that_overlaps_goes_on_another_track_and_kept_items_stay() {
        let p = |source: AudioSource, at: i64, track: usize| AudioPlacement {
            source,
            at,
            in_frame: None,
            out_frame: None,
            track,
            gain_db: None,
            limiter: false,
            lufs: None,
        };
        let media = Media {
            resource: "bed.wav".into(),
            length: 100,
            video_index: None,
            audio_index: Some(0),
            file_size: 0,
            file_hash: String::new(),
        };
        // A voice already on A1 at 30; a bed from 0 joins it.
        let mut w = vec![
            p(AudioSource::Existing(0), 30, 0),
            p(AudioSource::New(media.clone()), 0, 0),
            p(AudioSource::New(media), 200, 0),
        ];
        assign_audio_tracks(&mut w, &[20, 100, 100], 1);
        let tracks: Vec<usize> = w.iter().map(|x| x.track).collect();
        assert_eq!(tracks, [0, 1, 0]);
        // One on a track that no longer exists moves to the lowest free.
        let mut w = vec![p(AudioSource::Existing(0), 0, 3)];
        assign_audio_tracks(&mut w, &[10], 1);
        assert_eq!(w[0].track, 0);
    }
    use crate::whisper::Segment;

    #[test]
    fn a_fast_clip_maps_the_cut_to_more_of_its_source() {
        let mut fast = span(1, "a.mp4", 10.0, 4.0, 12.0);
        fast.speed = 2.0;
        // 8 s of source at 2× is 4 s of the cut, 10–14 s.
        let (_, at) = source_at(std::slice::from_ref(&fast), 11.0).unwrap();
        assert_eq!(at, 6.0);
        assert!(source_at(std::slice::from_ref(&fast), 14.5).is_none());
    }

    fn span(index: usize, file: &str, start: f64, source_in: f64, source_out: f64) -> Span {
        Span {
            index,
            file: PathBuf::from(file),
            start,
            source_in,
            source_out,
            speed: 1.0,
            audio: false,
        }
    }

    #[test]
    fn the_cut_maps_back_to_its_sources() {
        let spans = [
            span(1, "/a.mp4", 0.0, 10.0, 20.0),
            span(2, "/b.mp4", 10.0, 0.0, 5.0),
        ];
        let (s, at) = source_at(&spans, 4.0).unwrap();
        assert_eq!((s.index, at), (1, 14.0));
        let (s, at) = source_at(&spans, 12.5).unwrap();
        assert_eq!((s.index, at), (2, 2.5));
        assert!(source_at(&spans, 15.0).is_none());
    }

    #[test]
    fn a_clip_split_in_two_maps_both_halves() {
        // a.mp4 0–10 then 20–30 (a silence cut out), b.mp4 not transcribed.
        let spans = [
            span(1, "/a.mp4", 0.0, 0.0, 10.0),
            span(2, "/a.mp4", 10.0, 20.0, 30.0),
            span(3, "/b.mp4", 20.0, 0.0, 5.0),
        ];
        let segs = vec![
            Segment {
                start: 1.0,
                end: 3.0,
                text: "one".into(),
                words: vec![],
            },
            Segment {
                start: 9.0,
                end: 12.0,
                text: "across the cut".into(),
                words: vec![],
            },
            Segment {
                start: 14.0,
                end: 16.0,
                text: "cut out".into(),
                words: vec![],
            },
            Segment {
                start: 21.0,
                end: 24.0,
                text: "two".into(),
                words: vec![],
            },
        ];
        let (lines, missing) = lines(&spans, |f| (f == Path::new("/a.mp4")).then(|| segs.clone()));
        let got: Vec<(f64, f64, &str)> = lines
            .iter()
            .map(|l| (l.start, l.end, l.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (1.0, 3.0, "one"),
                (9.0, 10.0, "across the cut"),
                (11.0, 14.0, "two")
            ]
        );
        assert_eq!(missing, [(3, false)]);
    }

    #[test]
    fn words_go_with_the_piece_that_plays_them_in_the_cuts_time() {
        // 2–4 s of the source cut out; the second piece plays at double speed.
        let mut second = span(2, "/a.mp4", 2.0, 4.0, 10.0);
        second.speed = 2.0;
        let spans = [span(1, "/a.mp4", 0.0, 0.0, 2.0), second];
        let w = |start: f64, end: f64, text: &str| crate::whisper::Word {
            start,
            end,
            text: text.into(),
        };
        let segs = vec![Segment {
            start: 0.5,
            end: 8.0,
            text: "one two three four".into(),
            words: vec![
                w(0.5, 1.0, "one"),
                w(2.5, 3.0, "two"),
                w(5.0, 6.0, "three"),
                w(7.0, 8.0, "four"),
            ],
        }];
        let (lines, _) = lines(&spans, |_| Some(segs.clone()));
        assert_eq!(lines.len(), 1);
        let got: Vec<(f64, f64, &str)> = lines[0]
            .words
            .iter()
            .map(|w| (w.start, w.end, w.text.as_str()))
            .collect();
        // "one" plays in the first piece and "two" was cut out with 2–4 s.
        assert_eq!(got, [(2.5, 3.0, "three"), (3.5, 4.0, "four")]);
    }

    #[test]
    fn a_sentence_split_by_a_cut_shows_once_and_slivers_go() {
        // A silence cut 1.7–3.8 s out of a sentence that runs 0–8.9 s.
        let spans = [
            span(1, "/a.mp4", 0.0, 0.0, 1.7),
            span(2, "/a.mp4", 1.7, 3.8, 40.0),
        ];
        let segs = vec![
            Segment {
                start: 0.0,
                end: 8.9,
                text: "the sentence".into(),
                words: vec![],
            },
            Segment {
                start: 1.6,
                end: 1.75,
                text: "know,".into(),
                words: vec![],
            },
        ];
        let (lines, _) = lines(&spans, |_| Some(segs.clone()));
        let got: Vec<(usize, &str)> = lines.iter().map(|l| (l.index, l.text.as_str())).collect();
        assert_eq!(got, [(2, "the sentence")]);
        assert!((lines[0].start - 1.7).abs() < 1e-9);
    }
}
