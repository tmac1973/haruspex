//! Light and shade on a drawn layer: relief under a fixed top-left light,
//! and a little per-cell variety.
//!
//! Every neighbour lookup wraps at the tile edge, so shading keeps a texture
//! tiling. Only `jitter_cells` draws random numbers, and the layers call it
//! only when jitter is asked for, so a recipe without it consumes the same
//! numbers it always has and draws the same pixels.

use image::{Rgba, RgbaImage};

use super::noise::Rng;

/// A pixel in no cell: mortar, a seam, or the background.
pub const NONE: u32 = u32::MAX;

/// How strongly full relief lightens a lit edge.
const LIGHT: f32 = 0.35;
/// How strongly full relief darkens a shaded edge.
const SHADE: f32 = 0.35;
/// How dark full relief makes the inside wall of a groove.
const GROOVE: f32 = 0.25;
/// How far full jitter moves a cell's shade, either way.
const JITTER: f32 = 0.15;

fn map(img: &mut RgbaImage, x: u32, y: u32, f: impl Fn(f32) -> f32) {
    let p = img.get_pixel(x, y).0;
    let c = |v: u8| f(v as f32).round().clamp(0.0, 255.0) as u8;
    img.put_pixel(x, y, Rgba([c(p[0]), c(p[1]), c(p[2]), p[3]]));
}

/// Mix toward white by `t`.
fn lighten(img: &mut RgbaImage, x: u32, y: u32, t: f32) {
    map(img, x, y, |v| v + (255.0 - v) * t);
}

/// Scale toward black by `t`.
fn darken(img: &mut RgbaImage, x: u32, y: u32, t: f32) {
    map(img, x, y, |v| v * (1.0 - t));
}

/// The four neighbours of `(x, y)`, wrapping: up, left, down, right.
fn around(x: u32, y: u32, n: u32) -> [(u32, u32); 4] {
    [
        (x, (y + n - 1) % n),
        ((x + n - 1) % n, y),
        (x, (y + 1) % n),
        ((x + 1) % n, y),
    ]
}

/// Raised cells: an edge whose upper or left neighbour is another cell
/// catches the light; one whose lower or right neighbour is another cell is
/// in shade. `cells` holds a cell id per pixel, [`NONE`] outside any cell.
pub fn relief_raised(img: &mut RgbaImage, cells: &[u32], relief: f32) {
    let n = img.width();
    let at = |x: u32, y: u32| cells[(y * n + x) as usize];
    for y in 0..n {
        for x in 0..n {
            let id = at(x, y);
            if id == NONE {
                continue;
            }
            let [up, left, down, right] = around(x, y, n).map(|(a, b)| at(a, b));
            if up != id || left != id {
                lighten(img, x, y, LIGHT * relief);
            } else if down != id || right != id {
                darken(img, x, y, SHADE * relief);
            }
        }
    }
}

/// A groove cut in: the lip below or right of it catches the light, and the
/// groove's own far wall is in shade. `groove` marks the groove's pixels.
pub fn relief_cut(img: &mut RgbaImage, groove: &[bool], relief: f32) {
    let n = img.width();
    let at = |x: u32, y: u32| groove[(y * n + x) as usize];
    for y in 0..n {
        for x in 0..n {
            let [up, left, down, right] = around(x, y, n).map(|(a, b)| at(a, b));
            if at(x, y) {
                if !down || !right {
                    darken(img, x, y, GROOVE * relief);
                }
            } else if up || left {
                lighten(img, x, y, LIGHT * relief);
            }
        }
    }
}

/// Each cell a little lighter or darker than its colour, one factor per id.
pub fn jitter_cells(img: &mut RgbaImage, cells: &[u32], jitter: f32, rng: &mut Rng) {
    let mut factors = std::collections::HashMap::new();
    let n = img.width();
    for y in 0..n {
        for x in 0..n {
            let id = cells[(y * n + x) as usize];
            if id == NONE {
                continue;
            }
            let f = *factors
                .entry(id)
                .or_insert_with(|| 1.0 + jitter * JITTER * (2.0 * rng.next_f32() - 1.0));
            map(img, x, y, |v| v * f);
        }
    }
}
