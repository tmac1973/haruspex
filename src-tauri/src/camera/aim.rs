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
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraAimResult {
    /// The camera was already at, or reached, the end of its travel that way.
    /// Only a UVC webcam says; an ONVIF camera always reports false.
    pub at_limit: bool,
}

/// The ONVIF speed for every move: half of the camera's fastest.
pub(crate) const ONVIF_SPEED: f32 = 0.5;
/// How long a small, medium and large pan run at [`ONVIF_SPEED`], about 25°/s
/// on a Cinnado D1. Tilts run for the same share of their smaller angle.
const ONVIF_SMALL: Duration = Duration::from_millis(400);
const ONVIF_MEDIUM: Duration = Duration::from_millis(1200);
const ONVIF_LARGE: Duration = Duration::from_millis(2400);
/// The wait after an ONVIF camera stops, before a picture is taken.
const ONVIF_SETTLE: Duration = Duration::from_millis(1500);
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
pub(crate) async fn aim(config: &CameraConfig, aim: &Aim) -> Result<CameraAimResult, String> {
    // The camera's own turning isn't motion in the room: its watcher ignores
    // picture changes until the move has settled.
    let now = crate::time_util::now_ms;
    super::detect::hold_motion(&config.id, now() + TURN_HOLD_MS);
    let result = aim_routed(config, aim).await;
    super::detect::hold_motion(&config.id, now() + super::detect::AFTER_TURN_MS);
    result
}

/// Longer than any move takes, in case one never returns.
const TURN_HOLD_MS: i64 = 60_000;

async fn aim_routed(config: &CameraConfig, aim: &Aim) -> Result<CameraAimResult, String> {
    match route(config)? {
        Route::Onvif(endpoint) => {
            let creds = Credentials::for_source(&config.source).await?;
            let ptz = Ptz::open(endpoint, creds).await?;
            aim_onvif(&ptz, &endpoint.presets, aim).await?;
            Ok(CameraAimResult::default())
        }
        Route::Uvc(device) => aim_uvc(device, aim).await,
    }
}

async fn aim_onvif(ptz: &Ptz, saved: &[OnvifPreset], aim: &Aim) -> Result<(), String> {
    match aim {
        Aim::Move { direction, amount } => match onvif_move(*direction, *amount) {
            Some((pan, tilt, time)) => {
                ptz.move_by(pan, tilt, time).await?;
                tokio::time::sleep(ONVIF_SETTLE).await;
                Ok(())
            }
            None => {
                if let Err(e) = ptz.goto_home().await {
                    // Some cameras have no home position, only a preset called that.
                    let token = preset_token(ptz, saved, "home").await.map_err(|_| e)?;
                    ptz.goto_preset(&token).await?;
                }
                settle_after_goto(ptz).await;
                Ok(())
            }
        },
        Aim::Preset { preset } => {
            let token = preset_token(ptz, saved, preset).await?;
            ptz.goto_preset(&token).await?;
            settle_after_goto(ptz).await;
            Ok(())
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
async fn settle_after_goto(ptz: &Ptz) {
    let started = tokio::time::Instant::now();
    // A camera can still say idle just after the request.
    tokio::time::sleep(Duration::from_millis(300)).await;
    while started.elapsed() < ONVIF_GOTO_LIMIT {
        match ptz.status().await.map(|s| s.moving) {
            Ok(Some(true)) => tokio::time::sleep(Duration::from_millis(250)).await,
            Ok(Some(false)) => break,
            // Unknown: wait as long as a large turn takes.
            _ => {
                tokio::time::sleep(ONVIF_LARGE).await;
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
