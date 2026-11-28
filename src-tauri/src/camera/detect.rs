//! What the watcher's ffmpeg reports, and when it adds up to an event.
//!
//! The watcher's ffmpeg prints a `lavfi.scene_score=` line for each frame the
//! scene filter lets through (motion) and a `lavfi.astats.Overall.RMS_level=`
//! line for every [`LEVEL_FRAME_MS`] of sound. [`Detector`] turns those into
//! events: open on the first trigger, extend while triggers continue, close
//! after a quiet spell or at a maximum length, then ignore triggers for a
//! cooldown. While the camera is being turned ([`hold_motion`]) its picture
//! changes are not motion: the room didn't move, the camera did.

use crate::sync_util::LockExt;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use super::MotionSensitivity;

/// Picture changes are ignored for this long after the camera stops turning,
/// while the scene filter catches up with the new view.
pub(crate) const AFTER_TURN_MS: i64 = 4_000;

/// Until when (epoch ms) each camera's picture changes are ignored, by id.
static HELD: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

fn held() -> std::sync::MutexGuard<'static, HashMap<String, i64>> {
    HELD.lock_or_recover()
}

/// Ignore the camera's picture changes until `until` (epoch ms), replacing any
/// earlier hold.
pub(crate) fn hold_motion(camera_id: &str, until: i64) {
    held().insert(camera_id.to_string(), until);
}

/// Whether the camera's picture changes are being ignored at `now`.
pub(crate) fn motion_held(camera_id: &str, now: i64) -> bool {
    let mut map = held();
    match map.get(camera_id) {
        Some(&until) if now < until => true,
        Some(_) => {
            map.remove(camera_id);
            false
        }
        None => false,
    }
}

/// How much sound each level line covers: the watcher resamples to 16 kHz and
/// cuts it into frames of 1600 samples.
pub(crate) const LEVEL_FRAME_MS: u32 = 100;
/// Samples per level frame, at 16 kHz.
pub(crate) const LEVEL_FRAME_SAMPLES: u32 = 1600;

/// The scene-change score a frame must pass to count as motion.
pub(crate) fn scene_threshold(s: MotionSensitivity) -> f64 {
    match s {
        MotionSensitivity::Low => 0.08,
        MotionSensitivity::Medium => 0.04,
        MotionSensitivity::High => 0.02,
    }
}

/// One line of ffmpeg's metadata output that matters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Reading {
    /// A frame that changed enough, with its scene score.
    Scene(f64),
    /// One level frame's loudness, RMS in dBFS; silence is -120.
    Level(f64),
}

/// The reading on `line`, if it is one; the frame headers between them are
/// skipped.
pub(crate) fn parse_line(line: &str) -> Option<Reading> {
    let (key, value) = line.trim().split_once('=')?;
    let number = || {
        let v: f64 = value.trim().parse().ok()?;
        Some(if v.is_finite() { v.max(-120.0) } else { -120.0 })
    };
    match key {
        "lavfi.scene_score" => number().map(Reading::Scene),
        // `-inf` for digital silence, which `parse` reads as -inf.
        "lavfi.astats.Overall.RMS_level" => Some(Reading::Level(number().unwrap_or(-120.0))),
        _ => None,
    }
}

/// What set an event off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Trigger {
    Motion,
    Sound,
    Both,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Motion => "motion",
            Trigger::Sound => "sound",
            Trigger::Both => "both",
        }
    }
}

/// How long things take, in ms. Tests shorten them.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timings {
    /// An event closes after this long with no trigger.
    pub quiet_ms: i64,
    /// An event closes at this length however busy it is.
    pub max_ms: i64,
    /// Triggers are ignored for this long after an event closes.
    pub cooldown_ms: i64,
    /// How long sound must stay over the threshold to count.
    pub sound_ms: u32,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            quiet_ms: 10_000,
            max_ms: 60_000,
            cooldown_ms: 30_000,
            sound_ms: 500,
        }
    }
}

/// An event that has closed. Times are epoch ms.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Closed {
    pub started_at: i64,
    pub ended_at: i64,
    pub trigger: Trigger,
}

/// What a reading or a tick did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Step {
    Nothing,
    /// An event opened at this time (epoch ms).
    Opened(i64),
    Closed(Closed),
}

#[derive(Clone, Copy, Debug)]
struct Open {
    started_at: i64,
    last_trigger: i64,
    motion: bool,
    sound: bool,
}

/// The trigger state machine for one camera. Every call takes the time now
/// (epoch ms), so tests can drive it with made-up times.
#[derive(Debug)]
pub(crate) struct Detector {
    timings: Timings,
    threshold_db: f64,
    /// Level frames over the threshold in a row.
    loud_frames: u32,
    open: Option<Open>,
    /// No event opens before this time.
    cooldown_until: i64,
}

impl Detector {
    pub fn new(timings: Timings, threshold_db: f64) -> Self {
        Self {
            timings,
            threshold_db,
            loud_frames: 0,
            open: None,
            cooldown_until: i64::MIN,
        }
    }

    #[cfg(test)]
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// When the open event started.
    pub fn opened_at(&self) -> Option<i64> {
        self.open.map(|o| o.started_at)
    }

    pub fn reading(&mut self, reading: Reading, now: i64) -> Step {
        match reading {
            Reading::Scene(_) => self.trigger(false, now),
            Reading::Level(db) => {
                if db >= self.threshold_db {
                    self.loud_frames = self.loud_frames.saturating_add(1);
                } else {
                    self.loud_frames = 0;
                }
                if self.loud_frames * LEVEL_FRAME_MS >= self.timings.sound_ms {
                    self.trigger(true, now)
                } else {
                    self.tick(now)
                }
            }
        }
    }

    fn trigger(&mut self, sound: bool, now: i64) -> Step {
        if let Step::Closed(c) = self.tick(now) {
            return Step::Closed(c);
        }
        match &mut self.open {
            Some(open) => {
                open.last_trigger = now;
                open.sound |= sound;
                open.motion |= !sound;
                Step::Nothing
            }
            None if now < self.cooldown_until => Step::Nothing,
            None => {
                self.open = Some(Open {
                    started_at: now,
                    last_trigger: now,
                    motion: !sound,
                    sound,
                });
                Step::Opened(now)
            }
        }
    }

    /// Close the open event if it has been quiet long enough or has run its
    /// maximum.
    pub fn tick(&mut self, now: i64) -> Step {
        let Some(open) = self.open else {
            return Step::Nothing;
        };
        let quiet = now - open.last_trigger >= self.timings.quiet_ms;
        let too_long = now - open.started_at >= self.timings.max_ms;
        if quiet || too_long {
            self.close(now).map_or(Step::Nothing, Step::Closed)
        } else {
            Step::Nothing
        }
    }

    /// Close the open event now, as when the stream ends.
    pub fn close(&mut self, now: i64) -> Option<Closed> {
        let open = self.open.take()?;
        self.cooldown_until = now + self.timings.cooldown_ms;
        self.loud_frames = 0;
        let trigger = match (open.motion, open.sound) {
            (true, true) => Trigger::Both,
            (false, true) => Trigger::Sound,
            _ => Trigger::Motion,
        };
        Some(Closed {
            started_at: open.started_at,
            ended_at: now,
            trigger,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_lines_are_read() {
        assert_eq!(
            parse_line("lavfi.scene_score=0.123400"),
            Some(Reading::Scene(0.1234))
        );
        assert_eq!(
            parse_line("lavfi.astats.Overall.RMS_level=-23.5\n"),
            Some(Reading::Level(-23.5))
        );
        assert_eq!(
            parse_line("lavfi.astats.Overall.RMS_level=-inf"),
            Some(Reading::Level(-120.0))
        );
        assert_eq!(
            parse_line("lavfi.astats.Overall.RMS_level=nan"),
            Some(Reading::Level(-120.0))
        );
        assert_eq!(parse_line("frame:12   pts:19200   pts_time:1.2"), None);
        assert_eq!(parse_line("lavfi.scene_score=oops"), None);
        assert_eq!(parse_line(""), None);
    }

    fn detector() -> Detector {
        Detector::new(Timings::default(), -35.0)
    }

    fn loud(d: &mut Detector, from: i64, frames: i64) -> Vec<Step> {
        (0..frames)
            .map(|i| d.reading(Reading::Level(-20.0), from + i * 100))
            .collect()
    }

    #[test]
    fn motion_opens_extends_and_closes_after_quiet() {
        let mut d = detector();
        assert_eq!(d.reading(Reading::Scene(0.5), 1_000), Step::Opened(1_000));
        assert_eq!(d.reading(Reading::Scene(0.5), 6_000), Step::Nothing);
        assert_eq!(d.tick(15_999), Step::Nothing);
        assert_eq!(
            d.tick(16_000),
            Step::Closed(Closed {
                started_at: 1_000,
                ended_at: 16_000,
                trigger: Trigger::Motion
            })
        );
        assert!(!d.is_open());
    }

    #[test]
    fn sound_must_last_half_a_second() {
        let mut d = detector();
        // Four loud frames (0.4 s), a quiet one, four more: nothing.
        assert!(loud(&mut d, 0, 4).iter().all(|s| *s == Step::Nothing));
        assert_eq!(d.reading(Reading::Level(-60.0), 400), Step::Nothing);
        assert!(loud(&mut d, 500, 4).iter().all(|s| *s == Step::Nothing));
        assert!(!d.is_open());
        // The fifth in a row opens it.
        assert_eq!(d.reading(Reading::Level(-35.0), 900), Step::Opened(900));
        assert_eq!(d.reading(Reading::Scene(0.1), 1_000), Step::Nothing);
        let closed = d.close(2_000).unwrap();
        assert_eq!(closed.trigger, Trigger::Both);
        let mut d = detector();
        loud(&mut d, 0, 5);
        assert_eq!(d.close(600).unwrap().trigger, Trigger::Sound);
    }

    #[test]
    fn continuing_speech_keeps_the_event_open_up_to_the_maximum() {
        let mut d = detector();
        let steps = loud(&mut d, 0, 600);
        assert_eq!(steps[4], Step::Opened(400));
        assert!(steps[5..].iter().all(|s| *s == Step::Nothing));
        // 60 s after it opened, it closes even though the talking goes on.
        let step = d.reading(Reading::Level(-20.0), 60_400);
        assert_eq!(
            step,
            Step::Closed(Closed {
                started_at: 400,
                ended_at: 60_400,
                trigger: Trigger::Sound
            })
        );
    }

    #[test]
    fn a_cooldown_follows_each_event() {
        let mut d = detector();
        d.reading(Reading::Scene(0.5), 0);
        assert!(matches!(d.tick(10_000), Step::Closed(_)));
        assert_eq!(d.reading(Reading::Scene(0.5), 39_999), Step::Nothing);
        assert!(!d.is_open());
        assert_eq!(d.reading(Reading::Scene(0.5), 40_000), Step::Opened(40_000));
        assert_eq!(d.opened_at(), Some(40_000));
        // Closing with nothing open is nothing.
        let mut idle = detector();
        assert_eq!(idle.close(5), None);
        assert_eq!(idle.tick(5), Step::Nothing);
    }

    #[test]
    fn a_hold_ignores_motion_until_it_ends() {
        hold_motion("held-cam", 1_000);
        assert!(motion_held("held-cam", 999));
        assert!(!motion_held("held-cam", 1_000));
        assert!(!motion_held("other-cam", 0));
    }

    #[test]
    fn sensitivity_lowers_the_scene_threshold() {
        assert!(
            scene_threshold(MotionSensitivity::High) < scene_threshold(MotionSensitivity::Medium)
        );
        assert_eq!(scene_threshold(MotionSensitivity::Low), 0.08);
    }
}
