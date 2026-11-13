//! Aiming a pan/tilt camera: a direction and an amount, or a preset, sent to
//! the camera over ONVIF (network cameras) or UVC (USB webcams, Linux only).
//!
//! Amounts are angles: small, medium and large are 10°, 30° and 60° of pan and
//! 10°, 20° and 40° of tilt. ONVIF only moves at a speed for a time, so an
//! angle becomes a duration at half speed; UVC takes the angle itself, in
//! arc-seconds. After a move the camera is given a moment to settle, so the
//! picture taken next is still.

use super::onvif::ptz::Ptz;
use super::{CameraConfig, CameraSource, Credentials, OnvifPreset, PtzKind};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Where to point the camera.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(untagged)]
pub enum Aim {
    /// Turn left or right by a number of pulses, the shortest turn a network
    /// camera makes (see [`PtzCalibration`](super::PtzCalibration)). First, so
    /// a `Move` without `pulses` never reads as one.
    Pulses {
        direction: AimDirection,
        pulses: u32,
    },
    /// Turn by an amount, or back to the middle (`home`).
    Move {
        direction: AimDirection,
        #[serde(default)]
        amount: AimAmount,
    },
    /// Go to a position saved on the camera, by its name.
    Preset { preset: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum AimDirection {
    Left,
    Right,
    Up,
    Down,
    Home,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum AimAmount {
    Small,
    #[default]
    Medium,
    Large,
}

/// What `camera_aim` did.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraAimResult {
    /// The camera was already at, or reached, the end of its travel that way.
    /// A UVC webcam says so itself; a network camera's turn counts when its
    /// picture didn't change ([`Self::unmoved`]).
    pub at_limit: bool,
    /// The picture was the same before and after the turn: the camera didn't
    /// move, most likely because it was already as far as it goes that way.
    /// Only checked on a network camera, and only when ffmpeg is at hand.
    pub unmoved: bool,
    /// How far a calibrated network camera turned: picture widths for a pan,
    /// picture heights for a tilt.
    pub turned_views: Option<f32>,
    /// A tilt that didn't move was tried again from home, so the pan is back
    /// at home too.
    pub rehomed: bool,
    /// Where a calibrated camera now points, in pulses from the left end of
    /// its pan, while that is known: since it last went home and only turned
    /// by calibrated steps.
    pub pan_pulses: Option<u32>,
}

/// The ONVIF speed for every move: half of the camera's fastest.
pub(crate) const ONVIF_SPEED: f32 = 0.5;
/// How long a small, medium and large pan run at [`ONVIF_SPEED`], about 25°/s
/// on a Cinnado D1. Tilts run for the same share of their smaller angle.
const ONVIF_SMALL: Duration = Duration::from_millis(400);
/// One pulse: the shortest turn, which Calibrate measures.
pub(crate) const ONVIF_PULSE: Duration = ONVIF_SMALL;
/// The pause between the pulses of one turn.
const PULSE_GAP: Duration = Duration::from_millis(300);
/// What each amount aims for on a calibrated camera, in picture widths.
const VIEWS: [(AimAmount, f32); 3] = [
    (AimAmount::Small, 0.25),
    (AimAmount::Medium, 0.5),
    (AimAmount::Large, 1.0),
];
const ONVIF_MEDIUM: Duration = Duration::from_millis(1200);
const ONVIF_LARGE: Duration = Duration::from_millis(2400);
/// The wait after an ONVIF camera stops, before a picture is taken.
pub(crate) const ONVIF_SETTLE: Duration = Duration::from_millis(1500);
/// The wait after a preset or home move on a camera that can't say whether
/// it is still moving: a Cinnado D1 on Thingino takes 4 to 5 s to get home.
const ONVIF_GOTO_UNKNOWN: Duration = Duration::from_secs(5);
/// The longest a preset or home move is waited for.
const ONVIF_GOTO_LIMIT: Duration = Duration::from_secs(8);
/// The wait after a UVC webcam is set.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const UVC_SETTLE: Duration = Duration::from_secs(1);
/// UVC pan and tilt are in arc-seconds.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) const ARC_SECONDS_PER_DEGREE: f64 = 3600.0;

pub(crate) const CANT_MOVE: &str = "This camera can't move.";
pub(crate) const USB_LINUX_ONLY: &str = "Pan/tilt on a USB webcam works on Linux only.";

/// Degrees of pan for an amount.
pub(crate) fn pan_degrees(amount: AimAmount) -> f64 {
    match amount {
        AimAmount::Small => 10.0,
        AimAmount::Medium => 30.0,
        AimAmount::Large => 60.0,
    }
}

/// Degrees of tilt for an amount.
pub(crate) fn tilt_degrees(amount: AimAmount) -> f64 {
    match amount {
        AimAmount::Small => 10.0,
        AimAmount::Medium => 20.0,
        AimAmount::Large => 40.0,
    }
}

/// The signed turn, in degrees, as (pan, tilt): positive pan is right,
/// positive tilt is up. `None` for home, which isn't relative.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn turn_degrees(direction: AimDirection, amount: AimAmount) -> Option<(f64, f64)> {
    match direction {
        AimDirection::Left => Some((-pan_degrees(amount), 0.0)),
        AimDirection::Right => Some((pan_degrees(amount), 0.0)),
        AimDirection::Up => Some((0.0, tilt_degrees(amount))),
        AimDirection::Down => Some((0.0, -tilt_degrees(amount))),
        AimDirection::Home => None,
    }
}

/// An ONVIF continuous move for a direction: the pan and tilt velocities and
/// how long to run them. `None` for home.
pub(crate) fn onvif_move(
    direction: AimDirection,
    amount: AimAmount,
) -> Option<(f32, f32, Duration)> {
    let pan_time = match amount {
        AimAmount::Small => ONVIF_SMALL,
        AimAmount::Medium => ONVIF_MEDIUM,
        AimAmount::Large => ONVIF_LARGE,
    };
    // Tilt angles are smaller than pan angles at the same speed.
    let tilt_time = pan_time.mul_f64(tilt_degrees(amount) / pan_degrees(amount));
    match direction {
        AimDirection::Left => Some((-ONVIF_SPEED, 0.0, pan_time)),
        AimDirection::Right => Some((ONVIF_SPEED, 0.0, pan_time)),
        AimDirection::Up => Some((0.0, ONVIF_SPEED, tilt_time)),
        AimDirection::Down => Some((0.0, -ONVIF_SPEED, tilt_time)),
        AimDirection::Home => None,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// One UVC axis: the range the webcam gives, in arc-seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AxisRange {
    pub min: i64,
    pub max: i64,
    pub step: i64,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl AxisRange {
    /// `value` inside the range, on a step.
    pub fn clamp(&self, value: i64) -> i64 {
        let value = value.clamp(self.min, self.max);
        if self.step <= 1 {
            return value;
        }
        let snapped =
            self.min + ((value - self.min) as f64 / self.step as f64).round() as i64 * self.step;
        // Rounding up can step past the top when the range isn't a whole number of steps.
        if snapped > self.max {
            snapped - self.step
        } else {
            snapped
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Where a UVC axis goes: `current` moved by `degrees`, kept in range; home is
/// 0. The flag is true when the range stopped it short.
pub(crate) fn uvc_axis_target(range: AxisRange, current: i64, degrees: Option<f64>) -> (i64, bool) {
    let wanted = match degrees {
        Some(d) => current.saturating_add((d * ARC_SECONDS_PER_DEGREE).round() as i64),
        None => 0,
    };
    let target = range.clamp(wanted);
    // Short by more than a step counts; a step's rounding doesn't.
    let short = (wanted - target).abs() >= range.step.max(1) && degrees.is_some_and(|d| d != 0.0);
    (target, short)
}

/// The saved preset with this name, ignoring case and spaces at the ends.
pub(crate) fn find_preset<'a>(presets: &'a [OnvifPreset], name: &str) -> Option<&'a OnvifPreset> {
    let wanted = name.trim();
    presets
        .iter()
        .find(|p| p.name.trim().eq_ignore_ascii_case(wanted))
}

/// How a camera is aimed, worked out from its config before anything moves.
#[derive(Debug, PartialEq)]
pub(crate) enum Route<'a> {
    Onvif(&'a super::OnvifEndpoint),
    Uvc(&'a str),
}

pub(crate) fn route(config: &CameraConfig) -> Result<Route<'_>, String> {
    match (config.ptz, &config.source) {
        (PtzKind::None, _) => Err(CANT_MOVE.into()),
        (PtzKind::Onvif, CameraSource::Rtsp { .. }) => {
            config.onvif.as_ref().map(Route::Onvif).ok_or_else(|| {
                "This camera has no ONVIF service. Find it again under Settings → Cameras.".into()
            })
        }
        (PtzKind::Uvc, CameraSource::Usb { video_device, .. }) => {
            if cfg!(target_os = "linux") {
                Ok(Route::Uvc(video_device))
            } else {
                Err(USB_LINUX_ONLY.into())
            }
        }
        _ => Err(CANT_MOVE.into()),
    }
}

/// Aim the camera and wait for it to settle.
/// `ffmpeg`, when given, is used to check that a network camera's turn moved
/// its picture: a camera on Thingino can't say where it points.
pub(crate) async fn aim(
    config: &CameraConfig,
    aim: &Aim,
    ffmpeg: Option<&str>,
) -> Result<CameraAimResult, String> {
    // The camera's own turning isn't motion in the room: its watcher ignores
    // picture changes until the move has settled.
    let now = crate::time_util::now_ms;
    super::detect::hold_motion(&config.id, now() + TURN_HOLD_MS);
    let turns = match aim {
        Aim::Move { direction, .. } => *direction != AimDirection::Home,
        // A calibrated sweep knows how far its steps go and how many there
        // are, so it skips two pictures a step (about 3 s on a D1).
        Aim::Pulses { .. } => config.calibration.is_none(),
        Aim::Preset { .. } => false,
    };
    let compare = match ffmpeg {
        Some(f) if turns && matches!(route(config), Ok(Route::Onvif(_))) => Some(f),
        _ => None,
    };
    let before = match compare {
        Some(f) => super::capture::fingerprint(f, config).await.ok(),
        None => None,
    };
    let mut result = aim_routed(config, aim).await;
    match (compare, before, direction_of(aim)) {
        (Some(f), Some(before), Some(direction)) if result.is_ok() => {
            let after = super::capture::fingerprint(f, config).await.ok();
            let stuck = after
                .as_ref()
                .is_some_and(|a| super::capture::same_view(&before, a));
            // A D1 at the top of its tilt flips back to the view before the
            // last turn instead of stopping: that's the end of its travel too.
            let bounced = !stuck
                && after
                    .as_ref()
                    .is_some_and(|a| last_turn::lands_before(&config.id, direction, a));
            last_turn::record(&config.id, direction, before);
            if stuck || bounced {
                result = Ok(CameraAimResult {
                    unmoved: true,
                    at_limit: true,
                    ..Default::default()
                });
            }
            // A D1 on Thingino ignores every tilt up once it has hit its
            // bottom stop, until it goes home: try once more from home.
            if stuck && is_tilt(aim) {
                last_turn::forget(&config.id);
                result = retilt_from_home(f, config, aim).await;
            }
        }
        // Home, a preset or an unchecked turn: the last view no longer counts.
        _ => last_turn::forget(&config.id),
    }
    if let Ok(done) = result.as_mut() {
        done.pan_pulses = position::after(config, aim, done);
    }
    super::detect::hold_motion(&config.id, now() + super::detect::AFTER_TURN_MS);
    result
}

/// Where each calibrated camera points: pulses from the left end of its pan.
/// Known from when it goes home (or is calibrated, which ends at home) until
/// a turn this can't count, such as a preset or an uncalibrated move.
pub(crate) mod position {
    use super::{pulses_for, Aim, AimDirection, CameraAimResult};
    use crate::camera::CameraConfig;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    static AT: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(Default::default);

    fn at() -> std::sync::MutexGuard<'static, HashMap<String, u32>> {
        AT.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn set(camera_id: &str, pulses: Option<u32>) {
        match pulses {
            Some(p) => at().insert(camera_id.to_string(), p),
            None => at().remove(camera_id),
        };
    }

    /// Where the camera points after `aim` did `done`, and remember it.
    pub(super) fn after(config: &CameraConfig, aim: &Aim, done: &CameraAimResult) -> Option<u32> {
        let cal = config.calibration.as_ref()?;
        let home = || cal.home_pulses;
        let id = &config.id;
        let now = at().get(id).copied();
        let next = match aim {
            Aim::Preset { .. } => None,
            Aim::Move {
                direction: AimDirection::Home,
                ..
            } => home(),
            _ if done.rehomed => home(),
            Aim::Move {
                direction: AimDirection::Up | AimDirection::Down,
                ..
            }
            | Aim::Pulses {
                direction: AimDirection::Up | AimDirection::Down,
                ..
            } => now,
            Aim::Move { direction, amount } => step(
                now,
                *direction,
                pulses_for(*amount, cal.views_per_pulse),
                cal.range_pulses,
                done,
            ),
            Aim::Pulses { direction, pulses } => step(
                now,
                *direction,
                (*pulses).clamp(1, 20),
                cal.range_pulses,
                done,
            ),
        };
        set(id, next);
        next
    }

    /// `pulses` left or right from `now`, kept inside the range; a turn that
    /// didn't move ends at that end of the range whatever `now` was.
    fn step(
        now: Option<u32>,
        direction: AimDirection,
        pulses: u32,
        range: u32,
        done: &CameraAimResult,
    ) -> Option<u32> {
        let right = direction == AimDirection::Right;
        if done.unmoved {
            return Some(if right { range } else { 0 });
        }
        let now = now?;
        Some(if right {
            (now + pulses).min(range)
        } else {
            now.saturating_sub(pulses)
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn steps_stay_in_the_range_and_a_stuck_turn_is_at_its_end() {
            let moved = CameraAimResult::default();
            let stuck = CameraAimResult {
                unmoved: true,
                ..Default::default()
            };
            assert_eq!(step(Some(5), AimDirection::Right, 2, 9, &moved), Some(7));
            assert_eq!(step(Some(8), AimDirection::Right, 2, 9, &moved), Some(9));
            assert_eq!(step(Some(1), AimDirection::Left, 2, 9, &moved), Some(0));
            assert_eq!(step(None, AimDirection::Left, 1, 9, &moved), None);
            assert_eq!(step(None, AimDirection::Left, 1, 9, &stuck), Some(0));
            assert_eq!(step(Some(3), AimDirection::Right, 1, 9, &stuck), Some(9));
        }
    }
}

fn direction_of(aim: &Aim) -> Option<AimDirection> {
    match aim {
        Aim::Move { direction, .. } | Aim::Pulses { direction, .. } => {
            (*direction != AimDirection::Home).then_some(*direction)
        }
        Aim::Preset { .. } => None,
    }
}

/// Each camera's last checked turn: its direction and the picture before it.
mod last_turn {
    use super::AimDirection;
    use crate::camera::capture::same_view;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    /// By camera id: the direction and the picture before it.
    type Turns = HashMap<String, (AimDirection, Vec<u8>)>;

    static LAST: LazyLock<Mutex<Turns>> = LazyLock::new(Default::default);

    fn last() -> std::sync::MutexGuard<'static, Turns> {
        LAST.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn record(camera_id: &str, direction: AimDirection, before: Vec<u8>) {
        last().insert(camera_id.to_string(), (direction, before));
    }

    pub(super) fn forget(camera_id: &str) {
        last().remove(camera_id);
    }

    /// Whether a turn `direction` ended on the view from before the last turn,
    /// which went the same way.
    pub(super) fn lands_before(camera_id: &str, direction: AimDirection, after: &[u8]) -> bool {
        last()
            .get(camera_id)
            .is_some_and(|(d, before)| *d == direction && same_view(before, after))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_turn_back_to_the_last_view_the_same_way_is_a_bounce() {
            let (a, b) = (vec![1, 2, 3, 4], vec![4, 1, 3, 2]);
            record("bounce-cam", AimDirection::Up, a.clone());
            assert!(lands_before("bounce-cam", AimDirection::Up, &a));
            assert!(!lands_before("bounce-cam", AimDirection::Up, &b));
            // Down and back up again is a real turn.
            assert!(!lands_before("bounce-cam", AimDirection::Down, &a));
            forget("bounce-cam");
            assert!(!lands_before("bounce-cam", AimDirection::Up, &a));
        }
    }
}

fn is_tilt(aim: &Aim) -> bool {
    matches!(
        aim,
        Aim::Move {
            direction: AimDirection::Up | AimDirection::Down,
            ..
        } | Aim::Pulses {
            direction: AimDirection::Up | AimDirection::Down,
            ..
        }
    )
}

/// Whether the camera's picture is still `before`.
async fn moved_nowhere(ffmpeg: &str, config: &CameraConfig, before: &[u8]) -> bool {
    match super::capture::fingerprint(ffmpeg, config).await {
        Ok(after) => super::capture::same_view(before, &after),
        Err(_) => false,
    }
}

/// Send the camera home, then tilt again; `rehomed` either way.
async fn retilt_from_home(
    ffmpeg: &str,
    config: &CameraConfig,
    aim: &Aim,
) -> Result<CameraAimResult, String> {
    let home = Aim::Move {
        direction: AimDirection::Home,
        amount: AimAmount::Medium,
    };
    aim_routed(config, &home).await?;
    let before = super::capture::fingerprint(ffmpeg, config).await.ok();
    let mut done = aim_routed(config, aim).await?;
    done.rehomed = true;
    if let Some(before) = before {
        if moved_nowhere(ffmpeg, config, &before).await {
            done.unmoved = true;
            done.at_limit = true;
            done.turned_views = None;
        }
    }
    Ok(done)
}

/// Longer than any move takes, in case one never returns.
const TURN_HOLD_MS: i64 = 60_000;

async fn aim_routed(config: &CameraConfig, aim: &Aim) -> Result<CameraAimResult, String> {
    match route(config)? {
        Route::Onvif(endpoint) => {
            let creds = Credentials::for_source(&config.source).await?;
            let ptz = Ptz::open(endpoint, creds).await?;
            let turned_views =
                aim_onvif(&ptz, &endpoint.presets, aim, config.calibration.as_ref()).await?;
            Ok(CameraAimResult {
                turned_views,
                ..Default::default()
            })
        }
        Route::Uvc(device) => aim_uvc(device, aim).await,
    }
}

/// The pulses a calibrated camera turns for `amount`: as near its picture
/// widths as whole pulses get, and at least one.
pub(crate) fn pulses_for(amount: AimAmount, views_per_pulse: f32) -> u32 {
    let target = VIEWS
        .iter()
        .find(|(a, _)| *a == amount)
        .map_or(0.5, |(_, v)| *v);
    if views_per_pulse <= 0.0 {
        return 1;
    }
    ((target / views_per_pulse).round() as u32).max(1)
}

/// Turn left or right `pulses` times.
async fn pulse(ptz: &Ptz, direction: AimDirection, pulses: u32) -> Result<(), String> {
    let (pan, tilt) = match direction {
        AimDirection::Left => (-ONVIF_SPEED, 0.0),
        AimDirection::Right => (ONVIF_SPEED, 0.0),
        AimDirection::Up => (0.0, ONVIF_SPEED),
        AimDirection::Down => (0.0, -ONVIF_SPEED),
        AimDirection::Home => return Err("Home is not a step.".into()),
    };
    for i in 0..pulses {
        if i > 0 {
            tokio::time::sleep(PULSE_GAP).await;
        }
        ptz.move_by(pan, tilt, ONVIF_PULSE).await?;
    }
    tokio::time::sleep(ONVIF_SETTLE).await;
    Ok(())
}

/// How far one pulse moves the picture in `direction` on a calibrated
/// camera: picture widths for a pan, heights for a tilt.
fn per_pulse(calibration: Option<&super::PtzCalibration>, direction: AimDirection) -> Option<f32> {
    let cal = calibration?;
    match direction {
        AimDirection::Left | AimDirection::Right => Some(cal.views_per_pulse),
        AimDirection::Up | AimDirection::Down => cal.tilt.as_ref().map(|t| t.views_per_pulse),
        AimDirection::Home => None,
    }
}

/// Aim an ONVIF camera; how far it turned, in pictures, when `calibration`
/// says.
async fn aim_onvif(
    ptz: &Ptz,
    saved: &[OnvifPreset],
    aim: &Aim,
    calibration: Option<&super::PtzCalibration>,
) -> Result<Option<f32>, String> {
    match aim {
        Aim::Pulses { direction, pulses } => {
            let pulses = (*pulses).clamp(1, 20);
            pulse(ptz, *direction, pulses).await?;
            Ok(per_pulse(calibration, *direction).map(|v| v * pulses as f32))
        }
        Aim::Move { direction, amount } if per_pulse(calibration, *direction).is_some() => {
            let views = per_pulse(calibration, *direction).expect("checked above");
            let pulses = pulses_for(*amount, views);
            pulse(ptz, *direction, pulses).await?;
            Ok(Some(views * pulses as f32))
        }
        Aim::Move { direction, amount } => match onvif_move(*direction, *amount) {
            Some((pan, tilt, time)) => {
                ptz.move_by(pan, tilt, time).await?;
                tokio::time::sleep(ONVIF_SETTLE).await;
                Ok(None)
            }
            None => {
                if let Err(e) = ptz.goto_home().await {
                    // Some cameras have no home position, only a preset called that.
                    let token = preset_token(ptz, saved, "home").await.map_err(|_| e)?;
                    ptz.goto_preset(&token).await?;
                }
                settle_after_goto(ptz).await;
                Ok(None)
            }
        },
        Aim::Preset { preset } => {
            let token = preset_token(ptz, saved, preset).await?;
            ptz.goto_preset(&token).await?;
            settle_after_goto(ptz).await;
            Ok(None)
        }
    }
}

/// The token of the preset named `name`: from the saved list, or from the
/// camera when it was saved since.
async fn preset_token(ptz: &Ptz, saved: &[OnvifPreset], name: &str) -> Result<String, String> {
    if let Some(p) = find_preset(saved, name) {
        return Ok(p.token.clone());
    }
    let fresh = ptz.presets().await?;
    if let Some(p) = find_preset(&fresh, name) {
        return Ok(p.token.clone());
    }
    let names: Vec<&str> = fresh.iter().map(|p| p.name.as_str()).collect();
    Err(if names.is_empty() {
        format!(
            "No preset is called \"{}\". This camera has no presets.",
            name.trim()
        )
    } else {
        format!(
            "No preset is called \"{}\". The presets are: {}.",
            name.trim(),
            names.join(", ")
        )
    })
}

/// Wait for a preset or home move to finish, as far as the camera says, then
/// let it settle. A camera that doesn't report movement gets a fixed wait.
pub(crate) async fn settle_after_goto(ptz: &Ptz) {
    let started = tokio::time::Instant::now();
    // A camera can still say idle just after the request.
    tokio::time::sleep(Duration::from_millis(300)).await;
    while started.elapsed() < ONVIF_GOTO_LIMIT {
        match ptz.status().await.map(|s| s.moving) {
            Ok(Some(true)) => tokio::time::sleep(Duration::from_millis(250)).await,
            Ok(Some(false)) => break,
            // Unknown: wait as long as the slowest move seen takes.
            _ => {
                tokio::time::sleep(ONVIF_GOTO_UNKNOWN).await;
                break;
            }
        }
    }
    tokio::time::sleep(ONVIF_SETTLE).await;
}

#[cfg(target_os = "linux")]
async fn aim_uvc(device: &str, aim: &Aim) -> Result<CameraAimResult, String> {
    let (direction, amount) = match aim {
        Aim::Move { direction, amount } => (*direction, *amount),
        Aim::Preset { .. } => return Err("A USB webcam has no presets.".into()),
        // A sweep only steps a calibrated network camera; a webcam knows its angles.
        Aim::Pulses { direction, .. } => (*direction, AimAmount::Small),
    };
    let device = device.to_string();
    let result = tokio::task::spawn_blocking(move || {
        super::uvc::aim(&device, turn_degrees(direction, amount))
    })
    .await
    .map_err(|_| "The webcam's pan/tilt controls couldn't be read.".to_string())??;
    tokio::time::sleep(UVC_SETTLE).await;
    Ok(result)
}

#[cfg(not(target_os = "linux"))]
async fn aim_uvc(_device: &str, _aim: &Aim) -> Result<CameraAimResult, String> {
    Err(USB_LINUX_ONLY.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_calibrated_turn_is_whole_pulses_near_its_picture_widths() {
        // A D1 pulse is about half a picture.
        assert_eq!(pulses_for(AimAmount::Small, 0.54), 1);
        assert_eq!(pulses_for(AimAmount::Medium, 0.54), 1);
        assert_eq!(pulses_for(AimAmount::Large, 0.54), 2);
        // A camera whose pulse is a tenth of a picture.
        assert_eq!(pulses_for(AimAmount::Small, 0.1), 3);
        assert_eq!(pulses_for(AimAmount::Large, 0.1), 10);
        assert_eq!(pulses_for(AimAmount::Large, 0.0), 1);
    }

    #[test]
    fn pulses_and_moves_read_apart() {
        let pulses: Aim = serde_json::from_str(r#"{"direction":"right","pulses":2}"#).unwrap();
        assert_eq!(
            pulses,
            Aim::Pulses {
                direction: AimDirection::Right,
                pulses: 2
            }
        );
        let mv: Aim = serde_json::from_str(r#"{"direction":"left","amount":"large"}"#).unwrap();
        assert!(matches!(mv, Aim::Move { .. }));
    }
    use crate::camera::{CameraPermission, OnvifEndpoint, WatcherConfig};

    const ALL: [AimAmount; 3] = [AimAmount::Small, AimAmount::Medium, AimAmount::Large];

    #[test]
    fn amounts_are_the_planned_angles() {
        let pan: Vec<f64> = ALL.iter().map(|a| pan_degrees(*a)).collect();
        let tilt: Vec<f64> = ALL.iter().map(|a| tilt_degrees(*a)).collect();
        assert_eq!(pan, [10.0, 30.0, 60.0]);
        assert_eq!(tilt, [10.0, 20.0, 40.0]);
        assert_eq!(
            turn_degrees(AimDirection::Left, AimAmount::Medium),
            Some((-30.0, 0.0))
        );
        assert_eq!(
            turn_degrees(AimDirection::Down, AimAmount::Large),
            Some((0.0, -40.0))
        );
        assert_eq!(turn_degrees(AimDirection::Home, AimAmount::Small), None);
    }

    #[test]
    fn onvif_pans_run_the_planned_times_at_half_speed() {
        let ms = |d: AimDirection, a: AimAmount| {
            let (pan, tilt, t) = onvif_move(d, a).unwrap();
            (pan, tilt, t.as_millis())
        };
        assert_eq!(ms(AimDirection::Left, AimAmount::Small), (-0.5, 0.0, 400));
        assert_eq!(ms(AimDirection::Right, AimAmount::Medium), (0.5, 0.0, 1200));
        assert_eq!(ms(AimDirection::Right, AimAmount::Large), (0.5, 0.0, 2400));
        // The same 25°/s: 10°, 20° and 40° of tilt.
        assert_eq!(ms(AimDirection::Up, AimAmount::Small), (0.0, 0.5, 400));
        assert_eq!(ms(AimDirection::Down, AimAmount::Medium), (0.0, -0.5, 800));
        assert_eq!(ms(AimDirection::Up, AimAmount::Large), (0.0, 0.5, 1600));
        assert!(onvif_move(AimDirection::Home, AimAmount::Large).is_none());
    }

    const OBSBOT: AxisRange = AxisRange {
        min: -468_000,
        max: 468_000,
        step: 3600,
    };

    #[test]
    fn uvc_moves_by_arc_seconds_and_clamps() {
        // 30° left of the middle.
        assert_eq!(uvc_axis_target(OBSBOT, 0, Some(-30.0)), (-108_000, false));
        // 60° right from 100° right stops at the end, and says so.
        assert_eq!(
            uvc_axis_target(OBSBOT, 360_000, Some(60.0)),
            (468_000, true)
        );
        assert_eq!(
            uvc_axis_target(OBSBOT, 468_000, Some(10.0)),
            (468_000, true)
        );
        // Home is the middle, never "short".
        assert_eq!(uvc_axis_target(OBSBOT, 200_000, None), (0, false));
        // An axis that isn't asked to move stays, even off a step.
        assert_eq!(uvc_axis_target(OBSBOT, 7200, Some(0.0)), (7200, false));
    }

    #[test]
    fn uvc_values_land_on_a_step() {
        let r = AxisRange {
            min: -100,
            max: 95,
            step: 10,
        };
        assert_eq!(r.clamp(34), 30);
        assert_eq!(r.clamp(36), 40);
        assert_eq!(r.clamp(500), 90);
        assert_eq!(r.clamp(-500), -100);
        let any = AxisRange {
            min: -5,
            max: 5,
            step: 0,
        };
        assert_eq!(any.clamp(3), 3);
    }

    #[test]
    fn presets_match_by_name_without_case() {
        let presets = vec![
            OnvifPreset {
                token: "0".into(),
                name: "Door".into(),
            },
            OnvifPreset {
                token: "7".into(),
                name: "HOME".into(),
            },
        ];
        assert_eq!(find_preset(&presets, " door ").unwrap().token, "0");
        assert_eq!(find_preset(&presets, "home").unwrap().token, "7");
        assert!(find_preset(&presets, "Window").is_none());
    }

    fn config(ptz: PtzKind, source: CameraSource, onvif: Option<OnvifEndpoint>) -> CameraConfig {
        CameraConfig {
            id: "c1".into(),
            name: "Kitchen".into(),
            source,
            permission: CameraPermission::Allow,
            ptz,
            onvif,
            watcher: WatcherConfig::default(),
            caps: None,
            calibration: None,
            note: None,
        }
    }

    fn rtsp() -> CameraSource {
        CameraSource::Rtsp {
            url: "rtsp://cam/ch0".into(),
            substream_url: None,
            username: String::new(),
            password_ref: None,
        }
    }

    fn usb() -> CameraSource {
        CameraSource::Usb {
            video_device: "/dev/video0".into(),
            audio_device: None,
        }
    }

    #[test]
    fn each_camera_goes_the_right_way() {
        let endpoint = OnvifEndpoint {
            xaddr: "http://cam/onvif/device_service".into(),
            profile_token: "Profile_0".into(),
            presets: vec![],
        };
        let net = config(PtzKind::Onvif, rtsp(), Some(endpoint.clone()));
        assert_eq!(route(&net), Ok(Route::Onvif(&endpoint)));
        let lost = config(PtzKind::Onvif, rtsp(), None);
        assert!(route(&lost).unwrap_err().contains("Find it again"));
        assert_eq!(
            route(&config(PtzKind::None, rtsp(), None)),
            Err(CANT_MOVE.into())
        );
        // A kind that doesn't fit the source can't move either.
        assert_eq!(
            route(&config(PtzKind::Uvc, rtsp(), None)),
            Err(CANT_MOVE.into())
        );
        assert_eq!(
            route(&config(PtzKind::Onvif, usb(), Some(endpoint))),
            Err(CANT_MOVE.into())
        );
        let webcam = config(PtzKind::Uvc, usb(), None);
        if cfg!(target_os = "linux") {
            assert_eq!(route(&webcam), Ok(Route::Uvc("/dev/video0")));
        } else {
            assert_eq!(route(&webcam), Err(USB_LINUX_ONLY.into()));
        }
    }

    #[test]
    fn an_aim_reads_either_shape() {
        let turn: Aim = serde_json::from_str(r#"{"direction":"left"}"#).unwrap();
        assert_eq!(
            turn,
            Aim::Move {
                direction: AimDirection::Left,
                amount: AimAmount::Medium
            }
        );
        let big: Aim = serde_json::from_str(r#"{"direction":"up","amount":"large"}"#).unwrap();
        assert_eq!(
            big,
            Aim::Move {
                direction: AimDirection::Up,
                amount: AimAmount::Large
            }
        );
        let preset: Aim = serde_json::from_str(r#"{"preset":"Door"}"#).unwrap();
        assert_eq!(
            preset,
            Aim::Preset {
                preset: "Door".into()
            }
        );
        assert!(serde_json::from_str::<Aim>(r#"{"direction":"sideways"}"#).is_err());
    }
}
