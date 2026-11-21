//! A project's frame rate, and MLT's times written in it.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fps {
    pub num: u32,
    pub den: u32,
}

impl Fps {
    pub fn frames(&self, secs: f64) -> i64 {
        (secs * self.num as f64 / self.den as f64).round() as i64
    }

    pub fn secs(&self, frames: i64) -> f64 {
        frames as f64 * self.den as f64 / self.num as f64
    }

    fn rate(&self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// `HH:MM:SS.mmm`, the way MLT writes a time for Kdenlive. Whole hours and
    /// minutes are taken off in truncated frames before the seconds are
    /// divided out, so at 29.97 fps frame 58238 is `00:32:23.223`, not the
    /// `23.208` a plain division gives; `parse` undoes exactly this.
    pub fn timecode(&self, frames: i64) -> String {
        let fps = self.rate();
        let mut f = frames.max(0);
        let h = (f as f64 / (fps * 3600.0)) as i64;
        f -= (h as f64 * fps * 3600.0) as i64;
        let m = (f as f64 / (fps * 60.0)) as i64;
        f -= (m as f64 * fps * 60.0) as i64;
        let secs = f as f64 / fps;
        format!("{h:02}:{m:02}:{secs:06.3}")
    }

    /// A time as Kdenlive or MLT writes it: `HH:MM:SS.mmm`, or plain frames.
    pub fn parse(&self, t: &str) -> Option<i64> {
        let t = t.trim();
        if let Ok(f) = t.parse::<i64>() {
            return Some(f);
        }
        let mut parts = t.split(':');
        let (h, m, s) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let fps = self.rate();
        let (h, m, s) = (
            h.parse::<f64>().ok()?,
            m.parse::<f64>().ok()?,
            s.parse::<f64>().ok()?,
        );
        Some((h * 3600.0 * fps) as i64 + (m * 60.0 * fps) as i64 + (s * fps).round() as i64)
    }
}
