//! Where a recording is quiet, from ffmpeg's `silencedetect`.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SilenceRange {
    pub start: f64,
    pub end: f64,
}

impl SilenceRange {
    pub fn len(&self) -> f64 {
        self.end - self.start
    }
}

/// `silencedetect`'s report. A silence still open at the end runs to `duration`.
pub fn parse(stderr: &str, duration: Option<f64>) -> Vec<SilenceRange> {
    let mut out = Vec::new();
    let mut open: Option<f64> = None;
    for line in stderr.lines() {
        if let Some(v) = line.split("silence_start:").nth(1) {
            open = v.split_whitespace().next().and_then(|n| n.parse().ok());
        } else if let Some(v) = line.split("silence_end:").nth(1) {
            let end = v
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<f64>().ok());
            if let (Some(start), Some(end)) = (open.take(), end) {
                out.push(SilenceRange {
                    start: start.max(0.0),
                    end,
                });
            }
        }
    }
    if let (Some(start), Some(end)) = (open, duration) {
        if end > start {
            out.push(SilenceRange { start, end });
        }
    }
    out
}

/// Silences of at least `min_secs` quieter than `noise_db` in `file`'s first
/// audio stream, optionally only between `from` and `to` seconds.
pub async fn detect(
    ffmpeg: &str,
    file: &Path,
    noise_db: f64,
    min_secs: f64,
    window: Option<(f64, f64)>,
) -> Result<Vec<SilenceRange>, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-nostats"]);
    if let Some((from, to)) = window {
        cmd.args(["-ss", &format!("{from:.3}"), "-to", &format!("{to:.3}")]);
    }
    cmd.arg("-i")
        .arg(file)
        .args([
            "-map",
            "0:a:0",
            "-af",
            &format!("silencedetect=noise={noise_db}dB:d={min_secs}"),
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(30 * 60), cmd.output())
        .await
        .map_err(|_| "finding the silences took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let duration = window.map(|(f, t)| t - f);
    let offset = window.map_or(0.0, |(f, _)| f);
    Ok(parse(&String::from_utf8_lossy(&out.stderr), duration)
        .into_iter()
        .map(|s| SilenceRange {
            start: s.start + offset,
            end: s.end + offset,
        })
        .collect())
}

/// Chunk boundaries for transcribing `duration` seconds in pieces of about
/// `every`: at the middle of the silence nearest each mark, within `reach`,
/// or the mark itself when there is none.
pub fn chunk_points(duration: f64, silences: &[SilenceRange], every: f64, reach: f64) -> Vec<f64> {
    let mut points = vec![0.0];
    let mut mark = every;
    while mark < duration - reach.min(every / 2.0) {
        let best = silences
            .iter()
            .map(|s| (s.start + s.end) / 2.0)
            .filter(|m| (m - mark).abs() <= reach && *m > *points.last().unwrap_or(&0.0) + 1.0)
            .min_by(|a, b| (a - mark).abs().total_cmp(&(b - mark).abs()));
        points.push(best.unwrap_or(mark));
        mark = points.last().copied().unwrap_or(mark) + every;
    }
    points.push(duration);
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = "[silencedetect @ 0x5] silence_start: 3.41\n\
        [silencedetect @ 0x5] silence_end: 5.9 | silence_duration: 2.49\n\
        size=N/A time=00:00:10.00\n\
        [silencedetect @ 0x5] silence_start: 8.25\n";

    #[test]
    fn ranges_parse_and_an_open_one_runs_to_the_end() {
        let r = parse(OUT, Some(10.0));
        assert_eq!(
            r,
            [
                SilenceRange {
                    start: 3.41,
                    end: 5.9
                },
                SilenceRange {
                    start: 8.25,
                    end: 10.0
                }
            ]
        );
        assert_eq!(parse(OUT, None).len(), 1);
    }

    #[test]
    fn chunks_cut_in_silences_near_each_mark() {
        let s = [
            SilenceRange {
                start: 290.0,
                end: 292.0,
            },
            SilenceRange {
                start: 610.0,
                end: 612.0,
            },
        ];
        let p = chunk_points(1000.0, &s, 300.0, 30.0);
        assert_eq!(p, [0.0, 291.0, 611.0, 911.0, 1000.0]);
        // Nothing near a mark: the mark.
        assert_eq!(
            chunk_points(700.0, &[], 300.0, 30.0),
            [0.0, 300.0, 600.0, 700.0]
        );
        // Short audio: one chunk.
        assert_eq!(chunk_points(120.0, &[], 300.0, 30.0), [0.0, 120.0]);
    }
}
