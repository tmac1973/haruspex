//! A clip's speed as MLT's `timewarp` producer, the same in Shotcut and
//! Kdenlive projects.
//!
//! A timewarp chain plays `warp_resource` at `warp_speed`; its `resource` is
//! `<speed>:<file>` and its `length` is the file's length divided by the
//! speed. Entries on a playlist count its frames, so an entry's in and out
//! are the source's frames divided by the speed: frame `n` of the chain
//! shows source frame `n × speed` (checked with melt). `warp_pitch=1` keeps
//! speech at its own pitch.
//!
//! Haruspex keeps a clip's in and out in source frames, so its tools never
//! see the difference; the readers multiply and the writers divide.

use crate::video::mlt::fps::Fps;

/// The slowest and fastest speeds a clip takes.
pub const MIN: f64 = 0.25;
pub const MAX: f64 = 4.0;

/// Whether two speeds are the same.
pub fn same(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

/// A speed as MLT writes it: `2`, `0.5`, `1.25`.
pub fn text(speed: f64) -> String {
    let s = format!("{speed:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// A source frame range `in..=out` as chain frames at `speed`.
pub fn to_chain(in_src: i64, out_src: i64, speed: f64) -> (i64, i64) {
    let in_w = (in_src as f64 / speed).round() as i64;
    let len = (((out_src - in_src + 1) as f64 / speed).round() as i64).max(1);
    (in_w, in_w + len - 1)
}

/// A chain frame range at `speed` as source frames.
pub fn to_source(in_w: i64, out_w: i64, speed: f64) -> (i64, i64) {
    let in_src = (in_w as f64 * speed).round() as i64;
    let out_src = (((out_w + 1) as f64 * speed).round() as i64 - 1).max(in_src);
    (in_src, out_src)
}

/// A chain's length in its own frames, for a source `len` frames long.
pub fn chain_length(len: i64, speed: f64) -> i64 {
    ((len as f64 / speed).floor() as i64).max(1)
}

/// The names of the properties a speed change rewrites.
const OWN: &[&str] = &[
    "length",
    "resource",
    "mlt_service",
    "warp_speed",
    "warp_resource",
    "warp_pitch",
    "shotcut:producer",
];

/// What a chain plays without its speed.
pub struct Plain<'a> {
    pub resource: &'a str,
    pub service: &'a str,
    /// The source's length, in frames.
    pub length: i64,
}

/// Rewrite one chain element's text to play `plain` at `speed`: its `out`
/// and the properties in `OWN` are replaced; everything else (filters, the
/// editors' own properties) stays. `shotcut` also keeps the plain service in
/// `shotcut:producer`, as Shotcut does.
pub fn rewrite(text: &str, plain: &Plain, speed: f64, fps: &Fps, shotcut: bool) -> String {
    let warped = !same(speed, 1.0);
    let len = if warped {
        chain_length(plain.length, speed)
    } else {
        plain.length
    };
    // The chain's own properties are the ones at its first child's depth;
    // its filters' properties sit deeper and are left alone.
    let lead = |l: &str| l.len() - l.trim_start().len();
    let indent: &str = text
        .lines()
        .skip(1)
        .find(|l| !l.trim().is_empty())
        .map(|l| &l[..lead(l)])
        .unwrap_or("  ");
    let mut kept: Vec<&str> = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        let own = lead(line) == indent.len()
            && OWN
                .iter()
                .any(|k| t.starts_with(&format!("<property name=\"{k}\"")));
        if !own {
            kept.push(line);
        }
    }
    let esc = crate::video::mlt::xml::escape;
    // Shotcut writes the length as a time, Kdenlive as frames.
    let len_text = if shotcut {
        fps.timecode(len)
    } else {
        len.to_string()
    };
    let mut props = vec![("length".to_string(), len_text)];
    if warped {
        let s = text_of(speed);
        props.push(("resource".into(), format!("{s}:{}", plain.resource)));
        props.push(("mlt_service".into(), "timewarp".into()));
        props.push(("warp_speed".into(), s));
        props.push(("warp_resource".into(), plain.resource.to_string()));
        props.push(("warp_pitch".into(), "1".into()));
        if shotcut {
            props.push(("shotcut:producer".into(), plain.service.to_string()));
        }
    } else {
        props.push(("resource".into(), plain.resource.to_string()));
        props.push(("mlt_service".into(), plain.service.to_string()));
    }
    let lines: Vec<String> = props
        .iter()
        .map(|(k, v)| format!("{indent}<property name=\"{k}\">{}</property>", esc(v)))
        .collect();
    let Some(open) = kept.first() else {
        return text.to_string();
    };
    let open = set_out(open, &fps.timecode(len - 1));
    let mut out = vec![open];
    out.extend(lines);
    out.extend(kept[1..].iter().map(|l| l.to_string()));
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

fn text_of(speed: f64) -> String {
    text(speed)
}

/// An opening tag with its `out` attribute set to `out`.
fn set_out(tag: &str, out: &str) -> String {
    if let Some(at) = tag.find(" out=\"") {
        let rest = &tag[at + 6..];
        if let Some(end) = rest.find('"') {
            return format!("{}{out}{}", &tag[..at + 6], &rest[end..]);
        }
    }
    tag.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAIN: &str = "  <chain id=\"chain3\" out=\"00:00:03.967\">\n    <property name=\"length\">00:00:04.000</property>\n    <property name=\"resource\">ep1/a.mp4</property>\n    <property name=\"mlt_service\">avformat-novalidate</property>\n    <property name=\"shotcut:caption\">a.mp4</property>\n    <filter id=\"filter1\">\n      <property name=\"mlt_service\">volume</property>\n    </filter>\n  </chain>\n";

    #[test]
    fn frames_go_to_the_chain_and_back() {
        assert_eq!(to_chain(10, 39, 2.0), (5, 19));
        assert_eq!(to_source(5, 19, 2.0), (10, 39));
        assert_eq!(to_chain(10, 39, 0.5), (20, 79));
        assert_eq!(to_source(20, 79, 0.5), (10, 39));
        assert_eq!(chain_length(100, 2.0), 50);
    }

    #[test]
    fn a_chain_is_warped_and_back_keeping_its_filters() {
        let fps = Fps { num: 30, den: 1 };
        let plain = Plain {
            resource: "ep1/a.mp4",
            service: "avformat-novalidate",
            length: 120,
        };
        let warped = rewrite(CHAIN, &plain, 2.0, &fps, true);
        assert!(warped.contains("out=\"00:00:01.967\""), "{warped}");
        assert!(warped.contains("<property name=\"resource\">2:ep1/a.mp4</property>"));
        assert!(warped.contains("<property name=\"mlt_service\">timewarp</property>"));
        assert!(warped.contains("<property name=\"warp_pitch\">1</property>"));
        assert!(
            warped.contains("<property name=\"shotcut:producer\">avformat-novalidate</property>")
        );
        assert!(warped.contains("<property name=\"length\">00:00:02.000</property>"));
        // The filter's own mlt_service line is indented deeper, and stays.
        assert!(warped.contains("      <property name=\"mlt_service\">volume</property>"));
        assert!(warped.contains("shotcut:caption"));
        let back = rewrite(&warped, &plain, 1.0, &fps, true);
        assert!(back.contains("<property name=\"resource\">ep1/a.mp4</property>"));
        assert!(back.contains("<property name=\"mlt_service\">avformat-novalidate</property>"));
        assert!(!back.contains("warp_"));
        assert!(back.contains("out=\"00:00:03.967\""));
    }
}
