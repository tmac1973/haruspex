//! Gain over a stretch of a clip's sound: one MLT `volume` filter per range,
//! the same in Shotcut and Kdenlive projects (each adds its own tag).
//!
//! A filter's `in` / `out` are the clip's source frames, on a Shotcut chain
//! and on a Kdenlive entry alike, so a trim never moves a range. Its `level`
//! is keyframed from the filter's `in`: 0 dB, the range's gain one frame
//! later, and back to 0 dB over the frame after the range, so the edges ramp
//! instead of clicking. MLT applies gain per frame, so one frame is the
//! shortest ramp there is. The range itself is kept in Haruspex's own
//! properties, so it reads back exactly.

use crate::video::mlt::fps::Fps;
use crate::video::timeline::GainRange;

pub const FROM: &str = "haruspex:range_from";
pub const TO: &str = "haruspex:range_to";
pub const DB: &str = "haruspex:range_db";

/// A range's filter: its `in` and `out` attributes, and its properties.
pub fn filter(range: &GainRange, fps: &Fps) -> (i64, i64, Vec<(&'static str, String)>) {
    let from = range.from_frame.max(0);
    let to = range.to_frame.max(from);
    let start = (from - 1).max(0);
    let end = to + 1;
    let len = end - start;
    let g = db_text(range.gain_db);
    let mut keys = Vec::new();
    if from > start {
        keys.push(format!("{}=0", fps.timecode(0)));
    }
    keys.push(format!("{}={g}", fps.timecode(from - start)));
    keys.push(format!("{}={g}", fps.timecode(to - start)));
    keys.push(format!("{}=0", fps.timecode(len)));
    let props = vec![
        ("window", "75".to_string()),
        ("max_gain", "20dB".to_string()),
        ("level", keys.join(";")),
        ("channel_mask", "-1".to_string()),
        ("mlt_service", "volume".to_string()),
        (FROM, from.to_string()),
        (TO, to.to_string()),
        (DB, g),
    ];
    (start, end, props)
}

fn db_text(db: f64) -> String {
    let g = format!("{db:.2}");
    g.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The range a filter of ours holds, when it is one.
pub fn read(prop: impl Fn(&str) -> Option<String>) -> Option<GainRange> {
    let num = |k: &str| prop(k)?.trim().parse::<f64>().ok();
    Some(GainRange {
        from_frame: num(FROM)? as i64,
        to_frame: num(TO)? as i64,
        gain_db: num(DB)?,
    })
}

/// Whether a filter of ours is a gain range.
pub fn is_range(prop: impl Fn(&str) -> Option<String>) -> bool {
    prop(FROM).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_ramps_in_over_the_frame_before_and_out_over_the_frame_after() {
        let fps = Fps { num: 25, den: 1 };
        let r = GainRange {
            from_frame: 25,
            to_frame: 37,
            gain_db: -70.0,
        };
        let (start, end, props) = filter(&r, &fps);
        assert_eq!((start, end), (24, 38));
        let level = &props.iter().find(|(k, _)| *k == "level").unwrap().1;
        assert_eq!(
            level,
            "00:00:00.000=0;00:00:00.040=-70;00:00:00.520=-70;00:00:00.560=0"
        );
        let back = read(|k| props.iter().find(|(p, _)| *p == k).map(|(_, v)| v.clone()));
        assert_eq!(back, Some(r));
    }

    #[test]
    fn a_range_from_the_first_frame_starts_at_its_gain() {
        let fps = Fps { num: 25, den: 1 };
        let (start, _, props) = filter(
            &GainRange {
                from_frame: 0,
                to_frame: 4,
                gain_db: -6.5,
            },
            &fps,
        );
        assert_eq!(start, 0);
        let level = &props.iter().find(|(k, _)| *k == "level").unwrap().1;
        assert!(level.starts_with("00:00:00.000=-6.5;"), "{level}");
    }
}
