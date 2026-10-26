//! Where a clip's picture changes shot, from ffmpeg's scene score.

use std::path::Path;
use std::time::Duration;

/// Cuts closer together than this are one change.
const MIN_GAP_SECS: f64 = 1.0;
/// The most cuts reported.
pub const MAX_CUTS: usize = 200;

/// `showinfo`'s `pts_time:` values.
pub fn parse_showinfo(stderr: &str) -> Vec<f64> {
    stderr
        .lines()
        .filter(|l| l.contains("Parsed_showinfo"))
        .filter_map(|l| l.split("pts_time:").nth(1))
        .filter_map(|v| v.split_whitespace().next()?.parse().ok())
        .collect()
}

/// Drop cuts within `MIN_GAP_SECS` of the one before, and keep at most
/// `MAX_CUTS`. True in the second place when some were left out.
pub fn tidy(mut cuts: Vec<f64>) -> (Vec<f64>, bool) {
    cuts.sort_by(f64::total_cmp);
    let mut out: Vec<f64> = Vec::new();
    for c in cuts {
        if out.last().is_none_or(|l| c - l >= MIN_GAP_SECS) {
            out.push(c);
        }
    }
    let capped = out.len() > MAX_CUTS;
    out.truncate(MAX_CUTS);
    (out, capped)
}

/// Shot changes in `file` scoring above `threshold` (0–1; 0.3 suits most footage).
pub async fn detect(ffmpeg: &str, file: &Path, threshold: f64) -> Result<(Vec<f64>, bool), String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(["-nostdin", "-hide_banner", "-nostats", "-i"])
        .arg(file)
        .args([
            "-map",
            "0:v:0",
            "-vf",
            &format!("select='gt(scene,{threshold})',showinfo"),
            "-an",
            "-f",
            "null",
            "-",
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(60 * 60), cmd.output())
        .await
        .map_err(|_| "finding the shot changes took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err("ffmpeg couldn't read the clip's picture".into());
    }
    Ok(tidy(parse_showinfo(&String::from_utf8_lossy(&out.stderr))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showinfo_times_are_read() {
        let err = "[Parsed_showinfo_1 @ 0x5] n:   0 pts:  61440 pts_time:5.005   duration: 512\n\
            frame= 1 fps=0.0\n\
            [Parsed_showinfo_1 @ 0x5] n:   1 pts: 122880 pts_time:10.01   duration: 512\n";
        assert_eq!(parse_showinfo(err), [5.005, 10.01]);
    }

    #[test]
    fn near_cuts_merge_and_lists_are_capped() {
        assert_eq!(tidy(vec![5.0, 5.4, 9.0]).0, [5.0, 9.0]);
        let (many, capped) = tidy((0..500).map(f64::from).collect());
        assert_eq!(many.len(), MAX_CUTS);
        assert!(capped);
    }

    /// Joins at known times are found.
    /// `cargo test -- --ignored scene_cuts_in_a_test_video --nocapture`
    #[tokio::test]
    #[ignore = "needs ffmpeg"]
    async fn scene_cuts_in_a_test_video() {
        let dir = crate::test_util::temp_dir("scenes");
        let file = dir.join("cuts.mp4");
        let ok = crate::test_util::host_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x240:r=25:d=2",
                "-f",
                "lavfi",
                "-i",
                "testsrc=s=320x240:r=25:d=2",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=320x240:r=25:d=2",
                "-filter_complex",
                "[0][1][2]concat=n=3:v=1",
            ])
            .arg(&file)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let (cuts, _) = detect("ffmpeg", &file, 0.3).await.unwrap();
        println!("{cuts:?}");
        assert_eq!(cuts.len(), 2);
        assert!((cuts[0] - 2.0).abs() < 0.1 && (cuts[1] - 4.0).abs() < 0.1);
        let frame = super::super::frames::extract_frame("ffmpeg", &file, 5.0, 64)
            .await
            .unwrap();
        let px = image::load_from_memory(&frame).unwrap().to_rgb8();
        let p = px.get_pixel(10, 10).0;
        assert!(p[2] > 200 && p[0] < 60, "blue at 5 s: {p:?}");
    }
}
