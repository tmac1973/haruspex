//! How loud each stretch of a clip is, and the gain that brings it to
//! YouTube's -14 LUFS without clipping.
//!
//! Measured with ffmpeg's `ebur128` over exactly the part the cut uses, and
//! kept in `<episode>/.haruspex/loudness.json` until the clip changes, so a
//! second cut or a re-trim of the same range costs nothing.

use super::check::{parse_ebur128, TARGET_LUFS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Gains are kept within this many dB either way.
const MAX_GAIN: f64 = 20.0;
/// Quieter than this is silence, which gets no gain.
const SILENT_LUFS: f64 = -70.0;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Measured {
    pub lufs: f64,
    pub true_peak: Option<f64>,
}

/// Where a limiter holds the peaks: a little under YouTube's -1 dBTP, since a
/// sample-peak limiter lets inter-sample peaks through.
pub const LIMIT_DB: f64 = -1.5;
/// Limiting peaks by more than this squashes speech audibly; past it the
/// gain gives way and the clip stays a little quieter.
const MAX_LIMITING: f64 = 6.0;

/// A clip's gain, and whether its peaks need a limiter after it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gain {
    pub db: f64,
    pub limit: bool,
}

/// The gain for a measured stretch: to -14 LUFS, within ±20 dB. Speech is
/// peaky (a recording at -30 LUFS often peaks near -11 dB), so reaching -14
/// usually pushes peaks over the top: those get a limiter, and the gain is
/// lowered only as far as keeps the limiting within `MAX_LIMITING`. None for
/// silence.
pub fn gain_for(m: &Measured) -> Option<Gain> {
    if !m.lufs.is_finite() || m.lufs < SILENT_LUFS {
        return None;
    }
    let mut db = (TARGET_LUFS - m.lufs).clamp(-MAX_GAIN, MAX_GAIN);
    let mut limit = false;
    if let Some(peak) = m.true_peak {
        let over = peak + db - LIMIT_DB;
        if over > MAX_LIMITING {
            db -= over - MAX_LIMITING;
        }
        limit = peak + db > LIMIT_DB;
    }
    Some(Gain {
        db: (db * 10.0).round() / 10.0,
        limit,
    })
}

fn cache_path(episode_dir: &Path) -> PathBuf {
    episode_dir.join(".haruspex").join("loudness.json")
}

fn key(file: &Path, stream: u32, from: f64, to: f64) -> String {
    let meta = std::fs::metadata(file).ok();
    let size = meta.as_ref().map_or(0, |m| m.len());
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    format!(
        "{}|{size}|{mtime}|{stream}|{from:.3}|{to:.3}",
        file.display()
    )
}

fn load(episode_dir: &Path) -> HashMap<String, Measured> {
    std::fs::read_to_string(cache_path(episode_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(episode_dir: &Path, cache: &HashMap<String, Measured>) {
    let path = cache_path(episode_dir);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, text);
    }
}

/// One stretch to measure: a file's audio stream from `from` to `to` seconds.
#[derive(Clone, Debug)]
pub struct Stretch {
    pub file: PathBuf,
    pub stream: u32,
    pub from: f64,
    pub to: f64,
}

async fn measure_one(ffmpeg: &str, s: &Stretch) -> Result<Measured, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-nostats",
        "-ss",
        &format!("{:.3}", s.from),
        "-to",
        &format!("{:.3}", s.to),
        "-i",
    ])
    .arg(&s.file)
    .args([
        "-map",
        &format!("0:{}", s.stream),
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ])
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    super::no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(30 * 60), cmd.output())
        .await
        .map_err(|_| "measuring the loudness took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let l = parse_ebur128(&String::from_utf8_lossy(&out.stderr))
        .ok_or_else(|| format!("ffmpeg measured no loudness in {}", s.file.display()))?;
    Ok(Measured {
        lufs: l.lufs,
        true_peak: l.true_peak_db,
    })
}

/// Measure every stretch, four at a time, from the cache where it can.
/// `progress` hears (done, total).
pub async fn measure_all(
    ffmpeg: &str,
    episode_dir: &Path,
    stretches: &[Stretch],
    progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> Result<Vec<Measured>, String> {
    let mut cache = load(episode_dir);
    let keys: Vec<String> = stretches
        .iter()
        .map(|s| key(&s.file, s.stream, s.from, s.to))
        .collect();
    let mut out: Vec<Option<Measured>> = keys.iter().map(|k| cache.get(k).copied()).collect();
    let todo: Vec<usize> = (0..stretches.len()).filter(|&i| out[i].is_none()).collect();
    let total = todo.len();
    for (n, chunk) in todo.chunks(4).enumerate() {
        progress(n * 4, total);
        let measured = futures_util::future::join_all(
            chunk.iter().map(|&i| measure_one(ffmpeg, &stretches[i])),
        )
        .await;
        for (&i, m) in chunk.iter().zip(measured) {
            let m = m?;
            cache.insert(keys[i].clone(), m);
            out[i] = Some(m);
        }
    }
    save(episode_dir, &cache);
    Ok(out
        .into_iter()
        .map(|m| m.expect("every stretch measured"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gains_reach_minus_14_limiting_peaks_when_needed() {
        let g = |lufs, peak| {
            gain_for(&Measured {
                lufs,
                true_peak: peak,
            })
        };
        // Headroom to spare: plain gain.
        assert_eq!(
            g(-20.0, Some(-12.0)),
            Some(Gain {
                db: 6.0,
                limit: false
            })
        );
        // Peaks would pass -1.5: full gain, and a limiter.
        assert_eq!(
            g(-20.0, Some(-4.0)),
            Some(Gain {
                db: 6.0,
                limit: true
            })
        );
        // Speech as OBS records it: -30.8 LUFS peaking at -13.3.
        assert_eq!(
            g(-30.8, Some(-13.3)),
            Some(Gain {
                db: 16.8,
                limit: true
            })
        );
        // So peaky that full gain would limit by 10 dB: it gives way to 6.
        assert_eq!(
            g(-30.0, Some(-7.5)),
            Some(Gain {
                db: 12.0,
                limit: true
            })
        );
        // Too loud comes down, with no limiter needed.
        assert_eq!(
            g(-9.5, Some(0.5)),
            Some(Gain {
                db: -4.5,
                limit: false
            })
        );
        // Very quiet is capped at +20; silence gets nothing.
        assert_eq!(
            g(-50.0, None),
            Some(Gain {
                db: 20.0,
                limit: false
            })
        );
        assert_eq!(g(-80.0, None), None);
    }

    #[test]
    fn the_cache_follows_the_file_and_the_range() {
        let dir = crate::test_util::temp_dir("loudness_cache");
        let f = dir.join("a.wav");
        std::fs::write(&f, b"x").unwrap();
        assert_ne!(key(&f, 1, 0.0, 10.0), key(&f, 1, 0.0, 11.0));
        let k = key(&f, 1, 0.0, 10.0);
        let mut c = HashMap::new();
        c.insert(
            k.clone(),
            Measured {
                lufs: -20.0,
                true_peak: None,
            },
        );
        save(&dir, &c);
        assert_eq!(load(&dir).get(&k).map(|m| m.lufs), Some(-20.0));
        std::fs::write(&f, b"longer").unwrap();
        assert_ne!(key(&f, 1, 0.0, 10.0), k);
    }

    /// `cargo test -- --ignored measure_real_tones --nocapture`
    #[tokio::test]
    #[ignore = "needs ffmpeg"]
    async fn measure_real_tones() {
        let dir = crate::test_util::temp_dir("loudness_real");
        let f = dir.join("t.m4a");
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=f=440:d=6,volume=0.1",
                "-ac",
                "2",
            ])
            .arg(&f)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let s = Stretch {
            file: f,
            stream: 0,
            from: 1.0,
            to: 5.0,
        };
        let m = measure_all("ffmpeg", &dir, &[s.clone(), s], &|_, _| {})
            .await
            .unwrap();
        println!("{m:?} gain {:?}", gain_for(&m[0]));
        assert!(m[0].lufs < -30.0 && m[0].lufs > -50.0);
        assert!(gain_for(&m[0]).unwrap().db > 5.0);
    }
}
