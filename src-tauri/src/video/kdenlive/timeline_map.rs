//! Where a moment of a clip lands in the cut, for transcripts, captions and
//! chapters read in the video's own time.

use super::doc::Doc;
use std::path::{Path, PathBuf};

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
}

/// The main track's items as spans, in order.
pub fn spans(doc: &Doc) -> Vec<Span> {
    let fps = doc.fps;
    doc.items()
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let e = item.any();
            let resource = doc
                .tree
                .by_id(&e.chain)
                .and_then(|c| doc.tree.property(c, "resource"))
                .unwrap_or("");
            let p = Path::new(resource);
            let file = if p.is_absolute() {
                p.to_path_buf()
            } else {
                Path::new(&doc.root_dir).join(p)
            };
            Span {
                index: i + 1,
                file,
                start: fps.secs(e.start),
                source_in: fps.secs(e.in_frame),
                source_out: fps.secs(e.out_frame + 1),
            }
        })
        .collect()
}

/// Which item shows the cut at `t` seconds, and the moment of its source.
pub fn source_at(spans: &[Span], t: f64) -> Option<(&Span, f64)> {
    spans
        .iter()
        .rev()
        .find(|s| t >= s.start && t < s.start + (s.source_out - s.source_in))
        .map(|s| (s, s.source_in + t - s.start))
}

/// A stretch of speech in the cut's time.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub index: usize,
}

/// Shorter than this, a stretch of speech left by a cut is a sliver, not a line.
const MIN_LINE_SECS: f64 = 0.3;

/// Each span's transcribed speech, mapped into the cut. A segment shows once,
/// in the piece that plays most of it (a clip split by a cut would otherwise
/// say its sentence twice), clipped to that piece; slivers are left out.
pub fn lines(
    spans: &[Span],
    transcript_for: impl Fn(&Path) -> Option<Vec<crate::whisper::Segment>>,
) -> (Vec<Line>, Vec<usize>) {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    let mut transcripts: std::collections::HashMap<PathBuf, Option<Vec<crate::whisper::Segment>>> =
        std::collections::HashMap::new();
    for span in spans {
        let segments = transcripts
            .entry(span.file.clone())
            .or_insert_with(|| transcript_for(&span.file));
        if segments.is_none() {
            missing.push(span.index);
        }
    }
    let overlap = |span: &Span, s: &crate::whisper::Segment| {
        (s.end.min(span.source_out) - s.start.max(span.source_in)).max(0.0)
    };
    for (file, segments) in &transcripts {
        let Some(segments) = segments else { continue };
        let pieces: Vec<&Span> = spans.iter().filter(|s| &s.file == file).collect();
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
            out.push(Line {
                start: span.start + from - span.source_in,
                end: span.start + to - span.source_in,
                text: s.text.clone(),
                index: span.index,
            });
        }
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    (out, missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::whisper::Segment;

    fn span(index: usize, file: &str, start: f64, source_in: f64, source_out: f64) -> Span {
        Span {
            index,
            file: PathBuf::from(file),
            start,
            source_in,
            source_out,
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
            },
            Segment {
                start: 9.0,
                end: 12.0,
                text: "across the cut".into(),
            },
            Segment {
                start: 14.0,
                end: 16.0,
                text: "cut out".into(),
            },
            Segment {
                start: 21.0,
                end: 24.0,
                text: "two".into(),
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
        assert_eq!(missing, [3]);
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
            },
            Segment {
                start: 1.6,
                end: 1.75,
                text: "know,".into(),
            },
        ];
        let (lines, _) = lines(&spans, |_| Some(segs.clone()));
        let got: Vec<(usize, &str)> = lines.iter().map(|l| (l.index, l.text.as_str())).collect();
        assert_eq!(got, [(2, "the sentence")]);
        assert!((lines[0].start - 1.7).abs() < 1e-9);
    }
}
