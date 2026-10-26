//! What a finished render is: its length, streams and loudness, and what is
//! wrong with it.

use super::loudness::MAX_GAIN;
use super::probe;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// YouTube normalises to about -14 LUFS; within a unit of that is fine.
pub const TARGET_LUFS: f64 = -14.0;
pub const LUFS_TOLERANCE: f64 = 1.0;
/// The highest true peak a render should have.
pub const MAX_TRUE_PEAK: f64 = -1.0;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    /// Integrated loudness, LUFS.
    pub lufs: f64,
    /// Loudness range, LU.
    pub lra: f64,
    /// True peak, dBTP. None for silence.
    pub true_peak_db: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RenderCheck {
    pub duration_secs: f64,
    pub expected_secs: f64,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_audio: bool,
    pub loudness: Option<Loudness>,
    pub problems: Vec<String>,
}

/// The `Summary:` block of ffmpeg's `ebur128` filter.
pub fn parse_ebur128(stderr: &str) -> Option<Loudness> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    let value = |label: &str| -> Option<f64> {
        let line = summary
            .lines()
            .find(|l| l.trim_start().starts_with(label))?;
        let v = line.split(':').nth(1)?.split_whitespace().next()?;
        if v == "-inf" {
            return Some(f64::NEG_INFINITY);
        }
        v.parse().ok()
    };
    let lufs = value("I:")?;
    let lra = value("LRA:").unwrap_or(0.0);
    let peak = value("Peak:").filter(|p| p.is_finite());
    Some(Loudness {
        lufs,
        lra,
        true_peak_db: peak,
    })
}

/// Measure a file's first audio stream.
pub async fn measure(ffmpeg: &str, file: &Path) -> Result<Loudness, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostats", "-hide_banner", "-i"])
        .arg(file)
        .args([
            "-map",
            "0:a:0",
            "-af",
            "ebur128=peak=true",
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(30 * 60), cmd.output())
        .await
        .map_err(|_| "measuring the loudness took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    parse_ebur128(&String::from_utf8_lossy(&out.stderr))
        .ok_or_else(|| "ffmpeg reported no loudness".to_string())
}

/// The problems worth reporting, from what was measured.
pub fn problems(
    duration: f64,
    expected: f64,
    has_audio: bool,
    loudness: Option<&Loudness>,
    frame: f64,
    at_limit: &[String],
) -> Vec<String> {
    let mut out = Vec::new();
    // A frame either way is rounding; more is a real difference.
    if (duration - expected).abs() > (2.0 * frame).max(0.5) {
        out.push(format!(
            "The render is {duration:.1} s long, but the project is {expected:.1} s."
        ));
    }
    if !has_audio {
        out.push("The render has no sound.".into());
    }
    if let Some(l) = loudness {
        let quiet = l.lufs < TARGET_LUFS - LUFS_TOLERANCE;
        if l.lufs.is_finite() && quiet && !at_limit.is_empty() {
            out.push(format!(
                "Loudness is {:.1} LUFS, under YouTube's {TARGET_LUFS} ±{LUFS_TOLERANCE}, and \
                 video_normalize can't raise it: {} already {} the most gain allowed \
                 (+{MAX_GAIN} dB). Tell the user that footage is too quiet to bring up.",
                l.lufs,
                at_limit.join(", "),
                if at_limit.len() == 1 { "has" } else { "have" }
            ));
        } else if l.lufs.is_finite() && (l.lufs - TARGET_LUFS).abs() > LUFS_TOLERANCE {
            out.push(format!(
                "Loudness is {:.1} LUFS, outside YouTube's {TARGET_LUFS} ±{LUFS_TOLERANCE}; video_normalize evens it out.",
                l.lufs
            ));
        }
        if !l.lufs.is_finite() || l.lufs < -60.0 {
            out.push("The sound is silent.".into());
        }
        if l.true_peak_db.is_some_and(|p| p > MAX_TRUE_PEAK) {
            out.push(format!(
                "The true peak is {:.1} dBTP, above {MAX_TRUE_PEAK}: loud parts may clip.",
                l.true_peak_db.unwrap_or_default()
            ));
        }
    }
    out
}

/// Check a finished render against the project it came from.
pub async fn check(
    ffprobe: &str,
    ffmpeg: &str,
    file: &Path,
    expected_secs: f64,
    at_limit: &[String],
) -> Result<RenderCheck, String> {
    let info = probe::probe_file(ffprobe, file, file.display().to_string()).await?;
    let has_audio = !info.audio.is_empty();
    let loudness = if has_audio {
        Some(measure(ffmpeg, file).await?)
    } else {
        None
    };
    let (width, height, fps) = info.video.as_ref().map_or((0, 0, 0.0), |v| {
        (
            v.width,
            v.height,
            if v.fps_den > 0 {
                v.fps_num as f64 / v.fps_den as f64
            } else {
                0.0
            },
        )
    });
    let frame = if fps > 0.0 { 1.0 / fps } else { 0.04 };
    Ok(RenderCheck {
        duration_secs: info.duration_secs,
        expected_secs,
        size_bytes: info.size_bytes,
        width,
        height,
        fps,
        has_audio,
        problems: problems(
            info.duration_secs,
            expected_secs,
            has_audio,
            loudness.as_ref(),
            frame,
            at_limit,
        ),
        loudness,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TONE: &str = "[Parsed_ebur128_0 @ 0x55] t: 2.9 TARGET:-23 LUFS M: -21.0 S:-21.0 I: -21.1 LUFS\n\
        [Parsed_ebur128_0 @ 0x55] Summary:\n\n  Integrated loudness:\n    I:         -21.1 LUFS\n    Threshold: -31.1 LUFS\n\n  \
        Loudness range:\n    LRA:        20.0 LU\n    Threshold: -41.1 LUFS\n\n  True peak:\n    Peak:      -16.5 dBFS\n";

    const SILENT: &str = "Summary:\n  Integrated loudness:\n    I:         -70.0 LUFS\n  Loudness range:\n    LRA:         0.0 LU\n  True peak:\n    Peak:       -inf dBFS\n";

    #[test]
    fn the_summary_is_read_not_the_running_lines() {
        let l = parse_ebur128(TONE).unwrap();
        assert_eq!(
            l,
            Loudness {
                lufs: -21.1,
                lra: 20.0,
                true_peak_db: Some(-16.5)
            }
        );
        let s = parse_ebur128(SILENT).unwrap();
        assert_eq!(s.true_peak_db, None);
        assert_eq!(parse_ebur128("no summary"), None);
    }

    #[test]
    fn problems_name_what_is_wrong() {
        let ok = Loudness {
            lufs: -14.3,
            lra: 6.0,
            true_peak_db: Some(-1.5),
        };
        assert!(problems(120.0, 120.01, true, Some(&ok), 1.0 / 60.0, &[]).is_empty());
        let p = problems(110.0, 120.0, true, Some(&ok), 1.0 / 60.0, &[]);
        assert!(p[0].contains("110.0 s long"));
        let quiet = Loudness {
            lufs: -21.1,
            lra: 6.0,
            true_peak_db: Some(-0.2),
        };
        let p = problems(120.0, 120.0, true, Some(&quiet), 1.0 / 60.0, &[]);
        assert!(p.iter().any(|x| x.contains("-21.1 LUFS")));
        assert!(p.iter().any(|x| x.contains("true peak")));
        assert!(p.iter().any(|x| x.contains("video_normalize evens it out")));
        assert!(problems(120.0, 120.0, false, None, 0.04, &[])[0].contains("no sound"));
    }

    #[test]
    fn a_gain_at_its_bound_is_not_sent_back_to_normalise() {
        let quiet = Loudness {
            lufs: -17.2,
            lra: 9.0,
            true_peak_db: Some(-1.4),
        };
        let at_limit = ["raw/02-demo.mp4".to_string()];
        let p = problems(50.0, 50.0, true, Some(&quiet), 1.0 / 60.0, &at_limit);
        assert_eq!(p.len(), 1);
        assert!(p[0].contains("can't raise it: raw/02-demo.mp4 already has"));
        assert!(!p[0].contains("evens it out"));
        // Too loud: normalising still helps, whatever the bound.
        let loud = Loudness {
            lufs: -9.0,
            ..quiet
        };
        let p = problems(50.0, 50.0, true, Some(&loud), 1.0 / 60.0, &at_limit);
        assert!(p[0].contains("evens it out"));
    }
}
