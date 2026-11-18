//! Linear resampling of a live stream, chunk by chunk, to whisper's 16 kHz.

/// Resamples from a device's native rate to 16 kHz across chunk boundaries,
/// giving the same samples `audio::resample_linear` gives on the whole
/// buffer (bar the very last one, which waits for the next chunk).
pub struct StreamResampler {
    /// Source samples per output sample.
    ratio: f64,
    /// Outputs produced so far; the next one sits at `produced * ratio`.
    produced: u64,
    /// Absolute source index of the next chunk's first sample.
    base: u64,
    /// The previous chunk's last sample (source index `base - 1`).
    last: f32,
}

impl StreamResampler {
    pub fn new(from_rate: u32, to_rate: u32) -> Self {
        Self {
            ratio: from_rate as f64 / to_rate as f64,
            produced: 0,
            base: 0,
            last: 0.0,
        }
    }

    /// Append the resampled `input` to `out`.
    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.ratio == 1.0 {
            out.extend_from_slice(input);
            return;
        }
        let end = self.base + input.len() as u64;
        let at = |i: u64| -> f32 {
            if i < self.base {
                self.last
            } else {
                input[(i - self.base) as usize]
            }
        };
        loop {
            let pos = self.produced as f64 * self.ratio;
            let idx = pos.floor() as u64;
            if idx + 1 >= end {
                break;
            }
            let frac = (pos - idx as f64) as f32;
            let (a, b) = (at(idx), at(idx + 1));
            out.push(a + (b - a) * frac);
            self.produced += 1;
        }
        self.last = input[input.len() - 1];
        self.base = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::resample_linear;

    #[test]
    fn chunked_matches_whole_buffer() {
        let input: Vec<f32> = (0..4800).map(|i| ((i as f32) * 0.013).sin()).collect();
        let whole = resample_linear(&input, 48_000, 16_000);
        let mut r = StreamResampler::new(48_000, 16_000);
        let mut out = Vec::new();
        for chunk in [&input[..1000], &input[1000..1001], &input[1001..]] {
            r.push(chunk, &mut out);
        }
        assert!(
            whole.len() - out.len() <= 1,
            "{} vs {}",
            whole.len(),
            out.len()
        );
        for (a, b) in whole.iter().zip(&out) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn uneven_ratio_matches_too() {
        let input: Vec<f32> = (0..4410).map(|i| ((i as f32) * 0.021).cos()).collect();
        let whole = resample_linear(&input, 44_100, 16_000);
        let mut r = StreamResampler::new(44_100, 16_000);
        let mut out = Vec::new();
        for chunk in input.chunks(333) {
            r.push(chunk, &mut out);
        }
        assert!(whole.len() - out.len() <= 1);
        for (a, b) in whole.iter().zip(&out) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn sixteen_khz_passes_through() {
        let mut r = StreamResampler::new(16_000, 16_000);
        let mut out = Vec::new();
        r.push(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }
}
