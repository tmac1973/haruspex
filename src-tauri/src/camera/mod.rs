//! Cameras: network (RTSP, with ONVIF for pan/tilt) and USB webcams, read with
//! ffmpeg for a single frame or a short clip of sound.
//!
//! The settings hold the cameras (`cameras` in the settings blob); commands get
//! a camera's config from the frontend, as the video commands get theirs. A
//! network camera's password is kept in the secret store under
//! `camera:<id>` and put into the stream URL only when ffmpeg is spawned.
//! Nothing built from that URL or from ffmpeg's output leaves this module
//! without going through [`Credentials::redact`].
//!
//! See `plan/archive/camera-integration/` for the design.

pub mod aim;
pub mod alert_mail;
pub(crate) mod calibrate;
pub mod capture;
pub mod commands;
pub(crate) mod detect;
pub mod onvif;
pub mod reference;
pub(crate) mod shared;
pub mod usb;
#[cfg(target_os = "linux")]
pub(crate) mod uvc;
pub mod watcher;

use serde::{Deserialize, Serialize};

/// One camera, as Settings → Cameras stores it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraConfig {
    pub id: String,
    /// What the user and the model call it ("Kitchen").
    pub name: String,
    pub source: CameraSource,
    pub permission: CameraPermission,
    pub ptz: PtzKind,
    #[serde(default)]
    pub onvif: Option<OnvifEndpoint>,
    #[serde(default)]
    pub watcher: WatcherConfig,
    /// What the last successful probe found.
    #[serde(default)]
    pub caps: Option<CameraCaps>,
    /// How far this camera's pan turns go, measured by Calibrate in
    /// Settings → Cameras. Only an ONVIF camera has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub calibration: Option<PtzCalibration>,
    /// What the user tells the assistant about this camera ("faces the living
    /// room; behind it is a wall"). Given to the model with the camera list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    /// Camera alerts: whether its events are judged, and what counts as
    /// normal for it. Off by default.
    #[serde(default)]
    pub alerts: AlertConfig,
}

/// What camera alerts treat as normal for one camera. The frontend keeps the
/// rules to 20 of 300 characters (`camera/alertConfig.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertConfig {
    pub enabled: bool,
    /// How many people are usually in view at once; more is unusual.
    pub usual_people: u32,
    /// The user's own rules, such as "tell me if the back door is left open".
    pub watch_rules: Vec<String>,
    /// The user's quiet hours; `None` uses the ones learned from the log.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub quiet_hours: Option<QuietHours>,
}

impl Default for AlertConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            usual_people: 1,
            watch_rules: Vec::new(),
            quiet_hours: None,
        }
    }
}

/// Which local hours are quiet, 24 per day kind, midnight first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct QuietHours {
    pub weekday: Vec<bool>,
    pub weekend: Vec<bool>,
}

/// A network camera's pan, measured in picture widths rather than degrees:
/// what one picture shows is the unit both the model and a sweep need, and
/// cameras on Thingino can't say what angle they're at.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PtzCalibration {
    /// How long one pulse (the shortest turn) runs, in ms.
    pub pulse_ms: u32,
    /// How far one pulse turns, in picture widths.
    pub views_per_pulse: f32,
    /// Pulses from the left end of its travel to the right end.
    pub range_pulses: u32,
    /// Pulses from the left end to its home position; `None` when home
    /// matched no step.
    pub home_pulses: Option<u32>,
    /// The same for tilting, in picture heights; `None` from a calibration
    /// made before tilt was measured, or on a camera that doesn't tilt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tilt: Option<TiltCalibration>,
    /// The part of the pan worth looking at, in pulses from the left end:
    /// a look-around sweeps only from `sweep_from` to `sweep_to`. `None` is
    /// the whole range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sweep: Option<SweepRange>,
    /// Home as set in Haruspex (Set home here): this many pulses from the
    /// camera's own home. Thingino ignores ONVIF's SetHomePosition, so going
    /// home is the camera's home and then these steps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub home_offset: Option<HomeOffset>,
}

/// Pulses from the camera's own home: right and up are positive.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HomeOffset {
    pub pan: i32,
    pub tilt: i32,
}

/// Where a look-around starts and ends, in pulses from the left end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SweepRange {
    pub from: u32,
    pub to: u32,
}

/// A network camera's tilt, measured in picture heights.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct TiltCalibration {
    /// How far one pulse tilts, in picture heights.
    pub views_per_pulse: f32,
    /// Pulses from the bottom of its travel to the top.
    pub range_pulses: u32,
    /// Pulses from the bottom to its home position.
    pub home_pulses: u32,
}

/// Where the picture and sound come from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CameraSource {
    /// A network camera's RTSP stream.
    #[serde(rename_all = "camelCase")]
    Rtsp {
        /// Without credentials: they are added when ffmpeg is spawned.
        url: String,
        /// A smaller stream, for the watcher.
        #[serde(default)]
        substream_url: Option<String>,
        #[serde(default)]
        username: String,
        /// The secret-store key of the password; `None` when there is none.
        #[serde(default)]
        password_ref: Option<String>,
    },
    /// A webcam: `/dev/videoN` on Linux, the device's name on macOS and
    /// Windows.
    #[serde(rename_all = "camelCase")]
    Usb {
        video_device: String,
        /// A PulseAudio source (or an ALSA `hw:` device) on Linux, an
        /// AVFoundation index on macOS, a DirectShow name on Windows.
        #[serde(default)]
        audio_device: Option<String>,
    },
}

/// Whether each use asks first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum CameraPermission {
    #[default]
    Ask,
    Allow,
}

/// How the camera is aimed, if it can be.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum PtzKind {
    #[default]
    None,
    Onvif,
    Uvc,
}

/// A camera's ONVIF service. Calls use the source's user name and password.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OnvifEndpoint {
    pub xaddr: String,
    pub profile_token: String,
    #[serde(default)]
    pub presets: Vec<OnvifPreset>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct OnvifPreset {
    pub token: String,
    pub name: String,
}

/// What a probe found in the stream.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraCaps {
    pub has_audio: bool,
    pub width: u32,
    pub height: u32,
    /// ffprobe's codec name, such as `h264`; empty when unknown.
    pub video_codec: String,
}

/// The ambient watcher's settings for one camera. Off by default.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct WatcherConfig {
    pub enabled: bool,
    /// When it runs; `None` is all day.
    pub active_hours: Option<ActiveHours>,
    pub motion_sensitivity: MotionSensitivity,
    /// How loud sound must be to count, in dBFS.
    pub sound_threshold_db: f64,
}

impl Default for WatcherConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            active_hours: None,
            motion_sensitivity: MotionSensitivity::Medium,
            sound_threshold_db: -35.0,
        }
    }
}

/// Local times as `HH:MM`; `end` before `start` runs past midnight.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHours {
    pub start: String,
    pub end: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MotionSensitivity {
    Low,
    #[default]
    Medium,
    High,
}

/// A camera's password, read from the secret store, and what must be blanked
/// out of anything shown or logged.
#[derive(Default)]
pub(crate) struct Credentials {
    pub username: String,
    pub password: String,
}

impl Credentials {
    /// The source's credentials, with the password read from the store.
    pub async fn for_source(source: &CameraSource) -> Result<Self, String> {
        match source {
            CameraSource::Rtsp {
                username,
                password_ref,
                ..
            } => {
                let password = match password_ref.as_deref().filter(|r| !r.is_empty()) {
                    Some(key) => {
                        crate::secrets::check_ref(key, "camera:")?;
                        crate::secrets::require(key, "camera password").await?
                    }
                    None => String::new(),
                };
                Ok(Self {
                    username: username.clone(),
                    password,
                })
            }
            CameraSource::Usb { .. } => Ok(Self::default()),
        }
    }

    /// `url` with the user name and password in it, percent-encoded. A URL
    /// that doesn't parse, or credentials that are empty, leave it as it is.
    pub fn inject(&self, url: &str) -> String {
        if self.username.is_empty() && self.password.is_empty() {
            return url.to_string();
        }
        let Ok(mut parsed) = url::Url::parse(url) else {
            return url.to_string();
        };
        if parsed.set_username(&self.username).is_err() {
            return url.to_string();
        }
        let password = (!self.password.is_empty()).then_some(self.password.as_str());
        if parsed.set_password(password).is_err() {
            return url.to_string();
        }
        parsed.to_string()
    }

    /// `text` with the password blanked out, raw and percent-encoded, and any
    /// URL's user info with it.
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_string();
        if !self.password.is_empty() {
            let encoded = urlencoding::encode(&self.password).into_owned();
            // Longest first, so the encoded form isn't half-replaced.
            let mut forms = vec![encoded, self.password.clone()];
            forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
            for form in &forms {
                out = out.replace(form.as_str(), crate::text_util::REDACTED);
            }
        }
        crate::text_util::redact_secrets(&out, &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(user: &str, pass: &str) -> Credentials {
        Credentials {
            username: user.into(),
            password: pass.into(),
        }
    }

    #[test]
    fn credentials_go_into_the_url() {
        let c = creds("root", "p@ss:w/rd");
        assert_eq!(
            c.inject("rtsp://192.168.1.184:554/ch0"),
            "rtsp://root:p%40ss%3Aw%2Frd@192.168.1.184:554/ch0"
        );
        assert_eq!(
            Credentials::default().inject("rtsp://cam/ch0"),
            "rtsp://cam/ch0"
        );
        assert_eq!(
            creds("admin", "").inject("rtsp://cam/ch0"),
            "rtsp://admin@cam/ch0"
        );
    }

    #[test]
    fn a_password_never_survives_redaction() {
        for pass in ["abc", "p@ss:w/rd", "longer-secret-123"] {
            let c = creds("root", pass);
            let url = c.inject("rtsp://192.168.1.184:554/ch0");
            let err = format!("[rtsp @ 0x1] method DESCRIBE failed: 401 Unauthorized ({url})");
            let shown = c.redact(&err);
            assert!(!shown.contains(pass), "{shown}");
            assert!(!shown.contains(&*urlencoding::encode(pass)), "{shown}");
            assert!(shown.contains("401 Unauthorized"));
            let bare = c.redact(&format!("wrong password {pass} given"));
            assert!(!bare.contains(pass), "{bare}");
        }
    }

    #[test]
    fn an_old_camera_gets_the_watcher_defaults() {
        let json = r#"{"id":"c1","name":"Kitchen","permission":"ask","ptz":"none",
            "source":{"kind":"rtsp","url":"rtsp://cam/ch0"}}"#;
        let cfg: CameraConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.watcher, WatcherConfig::default());
        assert_eq!(cfg.watcher.sound_threshold_db, -35.0);
        assert_eq!(
            cfg.source,
            CameraSource::Rtsp {
                url: "rtsp://cam/ch0".into(),
                substream_url: None,
                username: String::new(),
                password_ref: None
            }
        );
        assert!(cfg.caps.is_none() && cfg.onvif.is_none());
        assert_eq!(cfg.alerts, AlertConfig::default());
        assert_eq!(cfg.alerts.usual_people, 1);
    }

    #[test]
    fn alert_settings_round_trip_and_leave_out_unset_quiet_hours() {
        let json = r#"{"id":"c1","name":"Kitchen","permission":"ask","ptz":"none",
            "source":{"kind":"rtsp","url":"rtsp://cam/ch0"},
            "alerts":{"enabled":true,"usualPeople":3,"watchRules":["door open"]}}"#;
        let cfg: CameraConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.alerts.enabled);
        assert_eq!(cfg.alerts.watch_rules, ["door open"]);
        let out = serde_json::to_string(&cfg.alerts).unwrap();
        assert!(!out.contains("quietHours"), "{out}");
    }
}
