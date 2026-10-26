//! How a render is encoded: MP4, H.264 and AAC at the bitrates YouTube asks
//! for, and which hardware encoders work on this machine.
//!
//! The property names are melt's avformat consumer's, and the hardware ones
//! follow Kdenlive's own render presets (`/usr/share/kdenlive/export/profiles.xml`)
//! so a project rendered from Kdenlive with the matching preset comes out the
//! same.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// An encoder Settings → Video editing can offer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EncoderOption {
    /// ffmpeg's name: `libx264`, `h264_vaapi`, …
    pub id: String,
    pub label: String,
}

pub const SOFTWARE: &str = "libx264";

/// The hardware encoders worth trying on this OS.
pub fn hardware_candidates() -> &'static [(&'static str, &'static str)] {
    if cfg!(target_os = "macos") {
        &[("h264_videotoolbox", "VideoToolbox (Apple)")]
    } else if cfg!(windows) {
        &[
            ("h264_nvenc", "NVENC (NVIDIA)"),
            ("h264_amf", "AMF (AMD)"),
            ("h264_qsv", "Quick Sync (Intel)"),
        ]
    } else {
        &[
            ("h264_vaapi", "VA-API (AMD, Intel)"),
            ("h264_nvenc", "NVENC (NVIDIA)"),
            ("h264_qsv", "Quick Sync (Intel)"),
        ]
    }
}

/// YouTube's recommended upload bitrate for SDR H.264, in Mb/s.
pub fn max_rate_mbps(height: u32, fps: f64) -> u32 {
    let high = fps > 31.0;
    match height {
        h if h > 1440 => {
            if high {
                68
            } else {
                45
            }
        }
        h if h > 1080 => {
            if high {
                24
            } else {
                16
            }
        }
        _ => {
            if high {
                12
            } else {
                8
            }
        }
    }
}

/// The consumer properties for one render, after `-consumer avformat:<file>`.
pub fn consumer_args(encoder: &str, height: u32, fps: f64) -> Vec<String> {
    let rate = max_rate_mbps(height, fps);
    let gop = ((fps / 2.0).round() as u32).max(1);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).max(1))
        .unwrap_or(1);
    let mut args: Vec<String> = vec![
        "f=mp4".into(),
        "movflags=+faststart".into(),
        format!("vcodec={encoder}"),
    ];
    match encoder {
        "libx264" => args.extend([
            "preset=medium".into(),
            "crf=18".into(),
            format!("maxrate={rate}M"),
            format!("bufsize={}M", rate * 2),
            format!("g={gop}"),
            "bf=2".into(),
            "pix_fmt=yuv420p".into(),
        ]),
        "h264_vaapi" | "h264_amf" => {
            args.extend(["vq=20".into(), "video_global_quality=20".into()])
        }
        "h264_nvenc" => args.extend(["rc=constqp".into(), "vqp=20".into(), "vq=20".into()]),
        "h264_qsv" => args.extend(["vbr=off".into(), format!("vb={rate}M")]),
        "h264_videotoolbox" => args.extend(["pix_fmt=yuv420p".into(), format!("vb={rate}M")]),
        _ => {}
    }
    args.extend([
        "acodec=aac".into(),
        "ab=384k".into(),
        "ar=48000".into(),
        "channels=2".into(),
        format!("real_time=-{threads}"),
    ]);
    args
}

/// Whether melt can encode two seconds of black with `encoder`.
async fn works(melt: &str, encoder: &str, dir: &Path) -> bool {
    let out = dir.join(format!("encoder-test-{encoder}.mp4"));
    let mut cmd = tokio::process::Command::new(melt);
    cmd.args([
        "-profile",
        "atsc_1080p_30",
        "color:black",
        "out=59",
        "-consumer",
    ])
    .arg(format!("avformat:{}", out.display()))
    .args(consumer_args(encoder, 1080, 30.0))
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    super::no_window(&mut cmd);
    let ok = matches!(
        tokio::time::timeout(Duration::from_secs(20), cmd.status()).await,
        Ok(Ok(s)) if s.success()
    ) && std::fs::metadata(&out).is_ok_and(|m| m.len() > 0);
    let _ = std::fs::remove_file(&out);
    ok
}

/// libx264 and each hardware encoder that works here.
pub async fn test_encoders(melt: &str, scratch: &Path) -> Vec<EncoderOption> {
    let _ = std::fs::create_dir_all(scratch);
    let mut found = vec![EncoderOption {
        id: SOFTWARE.into(),
        label: "x264 (software)".into(),
    }];
    for (id, label) in hardware_candidates() {
        if works(melt, id, scratch).await {
            found.push(EncoderOption {
                id: (*id).into(),
                label: (*label).into(),
            });
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test -- --ignored encoders_here --nocapture`
    #[tokio::test]
    #[ignore = "needs melt"]
    async fn encoders_here() {
        let dir = crate::test_util::temp_dir("encoders");
        let found = test_encoders("melt", &dir).await;
        println!("{found:?}");
        assert_eq!(found[0].id, SOFTWARE);
    }

    #[test]
    fn bitrates_follow_youtube() {
        assert_eq!(max_rate_mbps(1080, 30.0), 8);
        assert_eq!(max_rate_mbps(1080, 29.97), 8);
        assert_eq!(max_rate_mbps(1080, 60.0), 12);
        assert_eq!(max_rate_mbps(1440, 60.0), 24);
        assert_eq!(max_rate_mbps(2160, 30.0), 45);
        assert_eq!(max_rate_mbps(2160, 60.0), 68);
    }

    #[test]
    fn x264_gets_quality_rate_cap_and_gop() {
        let a = consumer_args("libx264", 1080, 60.0);
        for want in [
            "vcodec=libx264",
            "crf=18",
            "maxrate=12M",
            "bufsize=24M",
            "g=30",
            "acodec=aac",
            "ab=384k",
            "movflags=+faststart",
        ] {
            assert!(a.iter().any(|x| x == want), "{want} in {a:?}");
        }
    }

    #[test]
    fn hardware_encoders_use_kdenlives_properties() {
        let v = consumer_args("h264_vaapi", 1080, 30.0);
        assert!(v.contains(&"video_global_quality=20".to_string()));
        let n = consumer_args("h264_nvenc", 1080, 30.0);
        assert!(n.contains(&"rc=constqp".to_string()));
        assert!(!n.iter().any(|x| x.starts_with("crf=")));
    }
}
