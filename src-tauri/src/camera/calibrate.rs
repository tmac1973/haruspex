//! Calibrate: measure how far a network camera's pan turns go, in picture
//! widths. Cameras on Thingino ignore the speed they're asked for and can't
//! say where they point, so the turn the app sends can move a Cinnado D1 half
//! its view; the only way to know is to look.
//!
//! The camera goes home, then steps left one pulse (the shortest turn) at a
//! time to the end of its travel, then right to the other end. Each step's
//! picture is lined up with the one before to see how far the scene slid; a
//! step that leaves it unchanged is an end. The left steps count where home
//! is. Home also sets the tilt, so every picture is at the same tilt. Tilt
//! is measured the same way afterwards, from home down and then up.

use super::aim::{route, settle_after_goto, Route, ONVIF_PULSE, ONVIF_SETTLE, ONVIF_SPEED};
use super::capture::{gray_frame, horizontal_shift, same_view, vertical_shift};
use super::onvif::ptz::Ptz;
use super::{CameraConfig, Credentials, PtzCalibration, TiltCalibration};

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
    // At the camera's own home, whatever home Haruspex keeps for it.
    super::aim::position::set(
        &cfg.id,
        result.as_ref().ok().map(super::aim::position::camera_home),
    );
    super::detect::hold_motion(&cfg.id, now() + super::detect::AFTER_TURN_MS);
    result
}

async fn measure(cfg: &CameraConfig, ffmpeg: &str, ptz: &Ptz) -> Result<PtzCalibration, String> {
    ptz.goto_home().await?;
    settle_after_goto(ptz).await;
    let mut shifts = Vec::new();
    let mut last = gray_frame(ffmpeg, cfg, W, H).await?;
    let home_pulses = walk(cfg, ffmpeg, ptz, Axis::Pan, -1.0, &mut last, &mut shifts).await?;
    let range_pulses = walk(cfg, ffmpeg, ptz, Axis::Pan, 1.0, &mut last, &mut shifts).await?;
    if range_pulses == 0 {
        return Err(
            "The camera's picture didn't change when it was turned, so it couldn't be measured."
                .into(),
        );
    }
    let tilt = measure_tilt(cfg, ffmpeg, ptz).await.ok().flatten();
    Ok(PtzCalibration {
        pulse_ms: ONVIF_PULSE.as_millis() as u32,
        views_per_pulse: per_pulse(&shifts, W),
        range_pulses,
        home_pulses: Some(home_pulses),
        tilt,
        sweep: None,
        home_offset: None,
    })
}

/// Tilt, measured from home up to the top, then from home again down to the
/// bottom. Never up after the bottom: a D1 on Thingino ignores every tilt up
/// once it has hit its bottom stop, until it goes home. `None` for a camera
/// whose picture doesn't move when tilted.
async fn measure_tilt(
    cfg: &CameraConfig,
    ffmpeg: &str,
    ptz: &Ptz,
) -> Result<Option<TiltCalibration>, String> {
    let mut shifts = Vec::new();
    let walk_from_home = async |sign: f32, shifts: &mut Vec<(i32, f64)>| {
        ptz.goto_home().await?;
        settle_after_goto(ptz).await;
        let mut last = gray_frame(ffmpeg, cfg, W, H).await?;
        walk(cfg, ffmpeg, ptz, Axis::Tilt, sign, &mut last, shifts).await
    };
    let up = walk_from_home(1.0, &mut shifts).await?;
    let down = walk_from_home(-1.0, &mut shifts).await?;
    let range_pulses = up + down;
    Ok((range_pulses > 0).then(|| TiltCalibration {
        views_per_pulse: per_pulse(&shifts, H),
        range_pulses,
        home_pulses: down,
    }))
}

#[derive(Clone, Copy)]
enum Axis {
    Pan,
    Tilt,
}

/// Step along `axis` (`sign` 1 is right or up) until the picture shows
/// nothing new; the steps it took. Each step's shift is added to `shifts`,
/// positive in the direction of travel.
///
/// Nothing new means a picture already seen on this walk, not only the one
/// before: at the top of its tilt a D1 flips between two views on every
/// pulse rather than stopping.
async fn walk(
    cfg: &CameraConfig,
    ffmpeg: &str,
    ptz: &Ptz,
    axis: Axis,
    sign: f32,
    last: &mut Vec<u8>,
    shifts: &mut Vec<(i32, f64)>,
) -> Result<u32, String> {
    let speed = ONVIF_SPEED * sign;
    let mut seen = vec![last.clone()];
    for step in 0..MAX_STEPS {
        match axis {
            Axis::Pan => ptz.move_by(speed, 0.0, ONVIF_PULSE).await?,
            Axis::Tilt => ptz.move_by(0.0, speed, ONVIF_PULSE).await?,
        }
        tokio::time::sleep(ONVIF_SETTLE).await;
        let picture = gray_frame(ffmpeg, cfg, W, H).await?;
        if seen.iter().any(|p| same_view(p, &picture)) {
            return Ok(step);
        }
        // Turning right slides the scene left (a positive shift); tilting up
        // slides it down (a negative one).
        let (s, r) = match axis {
            Axis::Pan => {
                let (s, r) = horizontal_shift(last, &picture, W);
                (s as f32 * sign, r)
            }
            Axis::Tilt => {
                let (s, r) = vertical_shift(last, &picture, W);
                (-(s as f32) * sign, r)
            }
        };
        shifts.push((s as i32, r));
        seen.push(picture.clone());
        *last = picture;
    }
    Err(format!(
        "The camera kept turning for {MAX_STEPS} steps without reaching an end, so it couldn't be measured."
    ))
}

/// How far one pulse moves the picture, in pictures `size` pixels across:
/// the middle of the shifts that lined up well.
pub(crate) fn per_pulse(shifts: &[(i32, f64)], size: usize) -> f32 {
    let mut good: Vec<f32> = shifts
        .iter()
        .filter(|(s, r)| *s > 0 && *r >= TRUSTED)
        .map(|(s, _)| *s as f32 / size as f32)
        .collect();
    good.sort_by(f32::total_cmp);
    if good.is_empty() {
        NO_OVERLAP_VIEWS
    } else {
        good[good.len() / 2]
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
        assert!((per_pulse(&shifts, W) - 86.0 / 160.0).abs() < 1e-6);
        assert!((per_pulse(&[(45, 0.8)], H) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn steps_too_big_to_line_up_count_as_a_whole_picture() {
        assert_eq!(per_pulse(&[(10, 0.2), (-30, 0.9)], W), 1.0);
    }
}
