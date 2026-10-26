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

/// A stretch of speech in the cut's time.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub index: usize,
}

/// Each span's transcribed speech, mapped into the cut. A segment that starts
/// before a trim is cut to it; one that starts after it is left out.
pub fn lines(
    spans: &[Span],
    transcript_for: impl Fn(&Path) -> Option<Vec<crate::whisper::Segment>>,
) -> (Vec<Line>, Vec<usize>) {
    let mut out = Vec::new();
    let mut missing = Vec::new();
    for span in spans {
        let Some(segments) = transcript_for(&span.file) else {
            missing.push(span.index);
            continue;
        };
        for s in segments {
            if s.end <= span.source_in || s.start >= span.source_out {
                continue;
            }
            let from = s.start.max(span.source_in);
            let to = s.end.min(span.source_out);
            out.push(Line {
                start: span.start + from - span.source_in,
                end: span.start + to - span.source_in,
                text: s.text,
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
}
