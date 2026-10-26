//! Captions (SRT) and YouTube chapters from the cut's transcript.

use super::kdenlive::timeline_map::Line;
use serde::{Deserialize, Serialize};

/// Characters per caption line, and lines per caption.
const LINE_CHARS: usize = 42;
const MAX_LINES: usize = 2;
/// The longest a caption stays up.
const MAX_CUE_SECS: f64 = 7.0;

/// `00:01:02,500`.
fn srt_time(secs: f64) -> String {
    let ms = (secs.max(0.0) * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

/// Words into lines of at most `LINE_CHARS`, a long word on a line of its own.
fn wrap(words: &[&str]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for w in words {
        match lines.last_mut() {
            Some(l) if l.len() + 1 + w.len() <= LINE_CHARS => {
                l.push(' ');
                l.push_str(w);
            }
            _ => lines.push((*w).to_string()),
        }
    }
    lines
}

/// One line of speech as one or more captions: at most two lines of text and
/// seven seconds each, the time shared out by words.
fn cues(line: &Line) -> Vec<(f64, f64, String)> {
    let words: Vec<&str> = line.text.split_whitespace().collect();
    if words.is_empty() {
        return Vec::new();
    }
    let wrapped = wrap(&words);
    let by_text = wrapped.len().div_ceil(MAX_LINES);
    let duration = (line.end - line.start).max(0.0);
    let by_time = (duration / MAX_CUE_SECS).ceil() as usize;
    let pieces = by_text.max(by_time).max(1).min(words.len());
    let per = words.len().div_ceil(pieces);
    let chunks: Vec<&[&str]> = words.chunks(per).collect();
    let total = words.len() as f64;
    let mut at = line.start;
    chunks
        .iter()
        .map(|chunk| {
            let span = duration * chunk.len() as f64 / total;
            let cue = (at, at + span, wrap(chunk).join("\n"));
            at += span;
            cue
        })
        .collect()
}

/// The SRT for the cut's speech.
pub fn srt(lines: &[Line]) -> String {
    let mut out = String::new();
    let mut n = 0;
    for line in lines {
        for (start, end, text) in cues(line) {
            n += 1;
            out.push_str(&format!(
                "{n}\n{} --> {}\n{text}\n\n",
                srt_time(start),
                srt_time(end)
            ));
        }
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub title: String,
    /// Seconds into the video.
    pub at_secs: f64,
}

/// `1:23`, or `1:02:03` past an hour, as YouTube reads chapter times.
pub fn chapter_time(secs: f64) -> String {
    let t = secs.max(0.0).floor() as u64;
    if t >= 3600 {
        format!("{}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60)
    } else {
        format!("{}:{:02}", t / 60, t % 60)
    }
}

/// YouTube's rules for chapters: the first at 0:00, at least three, each at
/// least ten seconds long, in order. Every problem, for the model to fix.
pub fn check_chapters(chapters: &[Chapter], total_secs: f64) -> Vec<String> {
    let mut problems = Vec::new();
    if chapters.len() < 3 {
        problems.push("YouTube needs at least 3 chapters.".into());
    }
    if chapters.first().is_some_and(|c| c.at_secs.floor() != 0.0) {
        problems.push("The first chapter must start at 0:00.".into());
    }
    for (i, c) in chapters.iter().enumerate() {
        if c.title.trim().is_empty() {
            problems.push(format!("Chapter {} has no title.", i + 1));
        }
        let next = chapters.get(i + 1).map_or(total_secs, |n| n.at_secs);
        if next <= c.at_secs {
            problems.push(format!("Chapter {} is not before the one after it.", i + 1));
        } else if next - c.at_secs < 10.0 {
            problems.push(format!(
                "Chapter {} ({} {}) is shorter than 10 seconds.",
                i + 1,
                chapter_time(c.at_secs),
                c.title.trim()
            ));
        }
    }
    problems
}

/// The text block for a video's description.
pub fn chapters_text(chapters: &[Chapter]) -> String {
    chapters
        .iter()
        .map(|c| format!("{} {}", chapter_time(c.at_secs), c.title.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start: f64, end: f64, text: &str) -> Line {
        Line {
            start,
            end,
            text: text.into(),
            index: 1,
        }
    }

    #[test]
    fn short_lines_are_one_cue() {
        let s = srt(&[line(1.0, 2.5, "Hello and welcome.")]);
        assert_eq!(
            s,
            "1\n00:00:01,000 --> 00:00:02,500\nHello and welcome.\n\n"
        );
    }

    #[test]
    fn long_or_slow_speech_is_split_and_wrapped() {
        let words = "word ".repeat(40);
        let c = cues(&line(0.0, 20.0, &words));
        assert!(c.len() >= 3, "{c:?}");
        for (start, end, text) in &c {
            assert!(end - start <= MAX_CUE_SECS + 1e-9);
            assert!(text.lines().count() <= MAX_LINES);
            assert!(text.lines().all(|l| l.len() <= LINE_CHARS));
        }
        assert!((c.last().unwrap().1 - 20.0).abs() < 1e-9);
    }

    #[test]
    fn srt_times_format() {
        assert_eq!(srt_time(3723.4567), "01:02:03,457");
    }

    #[test]
    fn chapters_follow_youtubes_rules() {
        let ok = [
            Chapter {
                title: "Intro".into(),
                at_secs: 0.0,
            },
            Chapter {
                title: "Building".into(),
                at_secs: 65.0,
            },
            Chapter {
                title: "Outro".into(),
                at_secs: 3700.0,
            },
        ];
        assert!(check_chapters(&ok, 3800.0).is_empty());
        assert_eq!(
            chapters_text(&ok),
            "0:00 Intro\n1:05 Building\n1:01:40 Outro"
        );
        let bad = [
            Chapter {
                title: "Intro".into(),
                at_secs: 3.0,
            },
            Chapter {
                title: "Too soon".into(),
                at_secs: 8.0,
            },
        ];
        let p = check_chapters(&bad, 100.0);
        assert!(p.iter().any(|x| x.contains("at least 3")));
        assert!(p.iter().any(|x| x.contains("0:00")));
        assert!(p.iter().any(|x| x.contains("shorter than 10")));
    }
}
