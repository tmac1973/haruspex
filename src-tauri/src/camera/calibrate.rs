//! Calibrate: measure how far a network camera's pan turns go, in picture
//! widths. Cameras on Thingino ignore the speed they're asked for and can't
//! say where they point, so the turn the app sends can move a Cinnado D1 half
//! its view; the only way to know is to look.
//!
//! The camera goes home, then steps left one pulse (the shortest turn) at a
//! time to the end of its travel, then right to the other end. Each step's
//! picture is lined up with the one before to see how far the scene slid; a
//! step that leaves it unchanged is an end. The left steps count where home
//! is. Home also sets the tilt, so every picture is at the same tilt.

use super::aim::{route, settle_after_goto, Route, ONVIF_PULSE, ONVIF_SETTLE, ONVIF_SPEED};
use super::capture::{gray_frame, horizontal_shift, same_view};
use super::onvif::ptz::Ptz;
use super::{CameraConfig, Credentials, PtzCalibration};

/// The pictures compared, small enough to grab quickly.
const W: usize = 160;
const H: usize = 90;
/// The most steps taken one way before giving up on finding its end.
const MAX_STEPS: u32 = 40;
/// A line-up this good or better is trusted as a measurement.
const TRUSTED: f64 = 0.5;
/// When no step overlapped its neighbour enough to measure, each pulse turned
/// at least most of a picture.
const NO_OVERLAP_VIEWS: f32 = 1.0;
/// The watcher ignores picture changes this long, for the whole run.
const HOLD_MS: i64 = 5 * 60 * 1000;

/// Measure the camera's pan. Takes about a minute on a D1.
pub(crate) async fn calibrate(cfg: &CameraConfig, ffmpeg: &str) -> Result<PtzCalibration, String> {
    let Route::Onvif(endpoint) = route(cfg)? else {
        return Err("Only a network camera with ONVIF pan/tilt is calibrated.".into());
    };
    let ptz = Ptz::open(endpoint, Credentials::for_source(&cfg.source).await?).await?;
    let now = crate::time_util::now_ms;
    super::detect::hold_motion(&cfg.id, now() + HOLD_MS);
    let result = measure(cfg, ffmpeg, &ptz).await;
    // Home either way, so a failed run doesn't leave it facing a wall.
    let _ = ptz.goto_home().await;
    super::detect::hold_motion(&cfg.id, now() + super::detect::AFTER_TURN_MS);
    result
}

async fn measure(cfg: &CameraConfig, ffmpeg: &str, ptz: &Ptz) -> Result<PtzCalibration, String> {
    ptz.goto_home().await?;
    settle_after_goto(ptz).await;
    let mut shifts = Vec::new();
    let mut last = gray_frame(ffmpeg, cfg, W, H).await?;
    let home_pulses = walk(cfg, ffmpeg, ptz, -ONVIF_SPEED, &mut last, &mut shifts).await?;
    let range_pulses = walk(cfg, ffmpeg, ptz, ONVIF_SPEED, &mut last, &mut shifts).await?;
    if range_pulses == 0 {
        return Err(
            "The camera's picture didn't change when it was turned, so it couldn't be measured."
                .into(),
        );
    }
    Ok(summarize(&shifts, range_pulses, Some(home_pulses)))
}

/// Step one way (`pan` is the speed and its sign the direction) until the
/// picture stops changing; the steps it took. Each step's shift is added to
/// `shifts`, measured the same way round whichever way it turned.
async fn walk(
    cfg: &CameraConfig,
    ffmpeg: &str,
    ptz: &Ptz,
    pan: f32,
    last: &mut Vec<u8>,
    shifts: &mut Vec<(i32, f64)>,
) -> Result<u32, String> {
    for step in 0..MAX_STEPS {
        ptz.move_by(pan, 0.0, ONVIF_PULSE).await?;
        tokio::time::sleep(ONVIF_SETTLE).await;
        let picture = gray_frame(ffmpeg, cfg, W, H).await?;
        if same_view(last, &picture) {
            return Ok(step);
        }
        let (s, r) = horizontal_shift(last, &picture, W);
        shifts.push((if pan < 0.0 { -s } else { s }, r));
        *last = picture;
    }
    Err(format!(
        "The camera kept turning for {MAX_STEPS} steps without reaching an end, so it couldn't be measured."
    ))
}

/// The calibration from the steps' measured shifts (pixels of a `W`-wide
/// picture, and how well each lined up).
pub(crate) fn summarize(
    shifts: &[(i32, f64)],
    range_pulses: u32,
    home_pulses: Option<u32>,
) -> PtzCalibration {
    let mut good: Vec<f32> = shifts
        .iter()
        .filter(|(s, r)| *s > 0 && *r >= TRUSTED)
        .map(|(s, _)| *s as f32 / W as f32)
        .collect();
    good.sort_by(f32::total_cmp);
    let views_per_pulse = if good.is_empty() {
        NO_OVERLAP_VIEWS
    } else {
        good[good.len() / 2]
    };
    PtzCalibration {
        pulse_ms: ONVIF_PULSE.as_millis() as u32,
        views_per_pulse,
        range_pulses,
        home_pulses,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pulse_is_the_middle_of_the_trusted_shifts() {
        // From the D1: shifts of a 160-wide picture, poorly lined-up ones left out.
        let shifts = [
            (120, 0.37),
            (75, 0.11),
            (91, 0.64),
            (79, 0.4),
            (86, 0.72),
            (54, 0.75),
        ];
        let cal = summarize(&shifts, 9, Some(2));
        assert!((cal.views_per_pulse - 86.0 / 160.0).abs() < 1e-6);
        assert_eq!(cal.range_pulses, 9);
        assert_eq!(cal.home_pulses, Some(2));
        assert_eq!(cal.pulse_ms, ONVIF_PULSE.as_millis() as u32);
    }

    #[test]
    fn steps_too_big_to_line_up_count_as_a_whole_picture() {
        assert_eq!(
            summarize(&[(10, 0.2), (-30, 0.9)], 4, None).views_per_pulse,
            1.0
        );
    }
}
