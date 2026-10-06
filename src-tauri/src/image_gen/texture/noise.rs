//! Noise that wraps at the tile edge, and the seeded generator behind it.
//!
//! Every field here is periodic over the tile: the lattice has a whole number
//! of cells across it, and distances are measured on a torus. That is what
//! makes a texture tile by construction rather than by repair — the seam pass
//! the image model needs exists because its output does not.

/// SplitMix64: small, fast, and the same sequence on every platform, so a
/// recipe and a seed always give the same pixels.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n.max(1) as u64) as usize
    }
}

/// One variant's seed from the entry's seed: distinct, and stable across runs.
pub fn variant_seed(seed: u64, k: u32) -> u64 {
    let mut r = Rng::new(seed ^ (k as u64).wrapping_mul(0xD1B5_4A32_D192_ED03));
    r.next_u64()
}

/// A `n`×`n` field of f32, row-major.
pub type Field = Vec<f32>;

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Value noise with `cells` lattice cells across an `n`-pixel tile, in 0..1.
pub fn value_noise(rng: &mut Rng, n: u32, cells: u32) -> Field {
    let c = cells.clamp(1, n) as usize;
    let lattice: Vec<f32> = (0..c * c).map(|_| rng.next_f32()).collect();
    let at = |x: usize, y: usize| lattice[(y % c) * c + (x % c)];
    let n_us = n as usize;
    // Per-axis lattice index and blend, shared by every row and column.
    let axis: Vec<(usize, f32)> = (0..n_us)
        .map(|i| {
            let t = i as f32 * c as f32 / n as f32;
            let i0 = t.floor() as usize;
            (i0, smooth(t - i0 as f32))
        })
        .collect();
    let mut out = vec![0.0; n_us * n_us];
    for (y, &(y0, fy)) in axis.iter().enumerate() {
        for (x, &(x0, fx)) in axis.iter().enumerate() {
            let a = at(x0, y0);
            let b = at(x0 + 1, y0);
            let cc = at(x0, y0 + 1);
            let d = at(x0 + 1, y0 + 1);
            let top = a + (b - a) * fx;
            let bottom = cc + (d - cc) * fx;
            out[y * n_us + x] = top + (bottom - top) * fy;
        }
    }
    out
}

/// Fractal value noise, rescaled to fill 0..1.
pub fn fbm(rng: &mut Rng, n: u32, cells: u32, octaves: u32) -> Field {
    let len = (n * n) as usize;
    let mut out = vec![0.0; len];
    let mut amp = 1.0;
    for o in 0..octaves.clamp(1, 6) {
        let c = (cells.max(1) << o).min(n);
        let layer = value_noise(rng, n, c);
        for (v, l) in out.iter_mut().zip(layer) {
            *v += amp * l;
        }
        amp *= 0.5;
    }
    normalize(&mut out);
    out
}

/// Stretch a field to exactly 0..1.
pub fn normalize(f: &mut [f32]) {
    let (lo, hi) = f
        .iter()
        .fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    let span = (hi - lo).max(1e-6);
    for v in f.iter_mut() {
        *v = (*v - lo) / span;
    }
}

/// Distance to the nearest and second-nearest of `cells`² jittered points,
/// measured on the torus. `f2 - f1` is small along the borders between cells,
/// which is where cracks and mortar between cobbles go.
pub fn worley(rng: &mut Rng, n: u32, cells: u32) -> (Field, Field) {
    let c = cells.clamp(1, n) as usize;
    let size = n as f32;
    let step = size / c as f32;
    let pts: Vec<(f32, f32)> = (0..c * c)
        .map(|i| {
            let (gx, gy) = ((i % c) as f32, (i / c) as f32);
            ((gx + rng.next_f32()) * step, (gy + rng.next_f32()) * step)
        })
        .collect();
    let wrap = |d: f32| {
        let d = d.abs();
        d.min(size - d)
    };
    let len = (n * n) as usize;
    let (mut f1, mut f2) = (vec![0.0; len], vec![0.0; len]);
    for y in 0..n {
        for x in 0..n {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let (mut a, mut b) = (f32::MAX, f32::MAX);
            for &(qx, qy) in &pts {
                let (dx, dy) = (wrap(px - qx), wrap(py - qy));
                let d = (dx * dx + dy * dy).sqrt();
                if d < a {
                    b = a;
                    a = d;
                } else if d < b {
                    b = d;
                }
            }
            let i = (y * n + x) as usize;
            f1[i] = a;
            f2[i] = b;
        }
    }
    (f1, f2)
}

/// Split `n` pixels into `count` cells that partition it exactly, so a
/// pattern of cells repeats with the tile. Returns (cell index, offset within
/// the cell) for pixel `x`.
pub fn cell_of(x: u32, n: u32, count: u32) -> (u32, u32) {
    let count = count.clamp(1, n);
    let cell = x * count / n;
    let start = (cell * n).div_ceil(count);
    (cell, x - start)
}

/// The length in pixels of cell `cell` when `n` is split into `count`.
pub fn cell_len(cell: u32, n: u32, count: u32) -> u32 {
    let count = count.clamp(1, n);
    let start = |c: u32| (c * n).div_ceil(count);
    start(cell + 1).min(n) - start(cell)
}

/// How many cells of about `size` pixels fit an `n`-pixel tile.
pub fn count_for(n: u32, size: f32) -> u32 {
    ((n as f32 / size.max(1.0)).round() as u32).clamp(1, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generator_repeats_for_a_seed_and_differs_across_seeds() {
        let a: Vec<u64> = (0..4).map(|_| Rng::new(7).next_u64()).collect();
        assert!(a.windows(2).all(|w| w[0] == w[1]));
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());
        assert_ne!(variant_seed(7, 0), variant_seed(7, 1));
    }

    #[test]
    fn value_noise_wraps() {
        // The pixel after the last column is the first column: compare the
        // seam to an interior step.
        let n = 32;
        let f = value_noise(&mut Rng::new(3), n, 4);
        let at = |x: u32, y: u32| f[(y * n + x) as usize];
        let seam: f32 = (0..n).map(|y| (at(n - 1, y) - at(0, y)).abs()).sum();
        let inner: f32 = (0..n).map(|y| (at(15, y) - at(16, y)).abs()).sum();
        assert!(seam <= inner * 2.0 + 0.5, "seam {seam} inner {inner}");
    }

    #[test]
    fn cells_partition_the_tile_exactly() {
        for n in [8, 16, 32, 64] {
            for count in [1, 3, 4, 5, 7] {
                let mut seen = vec![0u32; count as usize];
                for x in 0..n {
                    let (c, off) = cell_of(x, n, count);
                    assert!(c < count);
                    seen[c as usize] += 1;
                    if off == 0 {
                        assert!(x == 0 || cell_of(x - 1, n, count).0 + 1 == c);
                    }
                }
                assert!(seen.iter().all(|s| *s > 0));
            }
        }
    }

    #[test]
    fn worley_measures_on_the_torus() {
        let n = 32;
        let (f1, f2) = worley(&mut Rng::new(5), n, 3);
        assert!(f1.iter().zip(&f2).all(|(a, b)| a <= b));
        // No distance can exceed half the diagonal of the torus.
        assert!(f1.iter().all(|d| *d <= (n as f32) * 0.71));
    }
}
