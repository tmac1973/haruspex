//! Drawing a recipe: the base ramp, then each layer in order.
//!
//! Every layer is periodic over the tile — noise from `noise.rs`, cell
//! patterns from `cell_of`, which partitions the tile exactly — so the
//! texture tiles whatever the recipe says.

use image::{Rgba, RgbaImage};

use super::noise::{cell_len, cell_of, count_for, fbm, worley, Rng};
use super::recipe::{parse_color, Axis, Layer, TextureRecipe, DESIGN_SIZE};

const BAYER: [[f32; 4]; 4] = [
    [0.0, 8.0, 2.0, 10.0],
    [12.0, 4.0, 14.0, 6.0],
    [3.0, 11.0, 1.0, 9.0],
    [15.0, 7.0, 13.0, 5.0],
];

fn rgb(s: &str) -> [u8; 3] {
    // Validated before drawing; mid-grey only if a caller skipped that.
    parse_color(s).unwrap_or([128, 128, 128])
}

fn put(img: &mut RgbaImage, x: u32, y: u32, c: [u8; 3]) {
    img.put_pixel(x, y, Rgba([c[0], c[1], c[2], 255]));
}

/// Scale a 32-pixel-tile measure to the tile drawn, keeping at least `min`.
fn scaled(v: f32, n: u32, min: f32) -> f32 {
    (v * n as f32 / DESIGN_SIZE).max(min)
}

fn base(img: &mut RgbaImage, rng: &mut Rng, r: &TextureRecipe) {
    let n = img.width();
    let ramp: Vec<[u8; 3]> = r.base.ramp.iter().map(|c| rgb(c)).collect();
    let k = (ramp.len() - 1) as f32;
    let field = fbm(
        rng,
        n,
        r.base.cells.unwrap_or(4),
        r.base.octaves.unwrap_or(3),
    );
    let dither = r.base.dither.unwrap_or(true);
    for y in 0..n {
        for x in 0..n {
            let v = field[(y * n + x) as usize] * k;
            let lo = v.floor();
            let frac = v - lo;
            let threshold = if dither {
                BAYER[(y % 4) as usize][(x % 4) as usize] / 16.0
            } else {
                0.5
            };
            let i = if frac > threshold { lo + 1.0 } else { lo };
            put(img, x, y, ramp[(i as usize).min(ramp.len() - 1)]);
        }
    }
}

fn layer(img: &mut RgbaImage, rng: &mut Rng, l: &Layer) {
    let n = img.width();
    match l {
        Layer::Speckle { color, amount } => {
            let c = rgb(color);
            for y in 0..n {
                for x in 0..n {
                    if rng.next_f32() < *amount {
                        put(img, x, y, c);
                    }
                }
            }
        }
        Layer::Cracks {
            color,
            cells,
            coverage,
            width,
        } => {
            let c = rgb(color);
            let (f1, f2) = worley(rng, n, *cells);
            // Where the cracks run is broken up by a second field, so they
            // are not a complete net of cells.
            let keep = fbm(rng, n, 2, 2);
            let w = scaled(width.unwrap_or(0.8), n, 0.6);
            for i in 0..(n * n) as usize {
                if f2[i] - f1[i] < w && keep[i] > *coverage {
                    put(img, i as u32 % n, i as u32 / n, c);
                }
            }
        }
        Layer::Blotches {
            color,
            cells,
            threshold,
        } => {
            let c = rgb(color);
            // Never coarser than 4 cells: a field with a period of 2 repeats
            // visibly when the tile is laid 2×2 — the prototype's park.
            let f = fbm(rng, n, (*cells).max(4), 2);
            for (i, v) in f.iter().enumerate() {
                if v > threshold {
                    put(img, i as u32 % n, i as u32 / n, c);
                }
            }
        }
        Layer::Bricks {
            w,
            h,
            gap,
            offset,
            colors,
            mortar,
        } => {
            let cols = count_for(n, scaled(*w, n, 2.0));
            let mut rows = count_for(n, scaled(*h, n, 2.0));
            // Running bond alternates rows, so an odd count would put two
            // unshifted rows together across the seam.
            if *offset && rows % 2 == 1 && rows > 1 {
                rows -= 1;
            }
            let gap = scaled(*gap, n, 0.0).round() as u32;
            let shades: Vec<[u8; 3]> = colors.iter().map(|c| rgb(c)).collect();
            let ids: Vec<usize> = (0..cols * rows).map(|_| rng.below(shades.len())).collect();
            let m = rgb(mortar);
            let brick_w = n / cols;
            for y in 0..n {
                let (row, oy) = cell_of(y, n, rows);
                // Odd rows shift by half a brick: running bond.
                let shift = if *offset && row % 2 == 1 {
                    brick_w / 2
                } else {
                    0
                };
                for x in 0..n {
                    let (col, ox) = cell_of((x + shift) % n, n, cols);
                    if oy < gap || ox < gap {
                        put(img, x, y, m);
                    } else {
                        let p = img.get_pixel(x, y).0;
                        let s = shades[ids[(row * cols + col) as usize]];
                        // Half the brick's own colour, half the base under it,
                        // so the material's grain shows through.
                        let mix = |a: u8, b: u8| ((a as u16 + b as u16) / 2) as u8;
                        put(
                            img,
                            x,
                            y,
                            [mix(p[0], s[0]), mix(p[1], s[1]), mix(p[2], s[2])],
                        );
                    }
                }
            }
        }
        Layer::Stripes {
            axis,
            pos,
            width,
            dash,
            color,
            wear,
        } => {
            let c = rgb(color);
            let pos = scaled(*pos, n, 0.0).round() as u32;
            let width = scaled(*width, n, 1.0).round() as u32;
            let dash = dash.map(|[on, off]| {
                let period = count_for(n, scaled(on + off, n, 2.0));
                let on_frac = on / (on + off);
                (period, on_frac)
            });
            let wear = wear.unwrap_or(0.0);
            for y in 0..n {
                for x in 0..n {
                    let (along, across) = if *axis == Axis::X { (x, y) } else { (y, x) };
                    if across < pos || across >= pos + width {
                        continue;
                    }
                    if let Some((period, on_frac)) = dash {
                        let (cell, off) = cell_of(along, n, period);
                        let len = cell_len(cell, n, period);
                        if off as f32 >= (on_frac * len as f32).round().max(1.0) {
                            continue;
                        }
                    }
                    if rng.next_f32() < wear {
                        continue;
                    }
                    put(img, x, y, c);
                }
            }
        }
        Layer::Waves {
            color,
            freq,
            threshold,
        } => {
            let c = rgb(color);
            let phase = fbm(rng, n, 4, 2);
            // Waves per 32-pixel tile, like every other measure: a whole number
            // per tile so it wraps, and fewer on a smaller tile so they are
            // not finer than a pixel can show.
            let freq = scaled(*freq as f32, n, 1.0).round();
            let tau = std::f32::consts::TAU;
            for y in 0..n {
                for x in 0..n {
                    let ph = phase[(y * n + x) as usize] * tau;
                    let s = (tau * (y as f32) * freq / n as f32 + ph).sin();
                    if s > *threshold {
                        put(img, x, y, c);
                    }
                }
            }
        }
        Layer::Grid { step, width, color } => {
            let c = rgb(color);
            let count = count_for(n, scaled(*step, n, 2.0));
            let w = scaled(width.unwrap_or(1.0), n, 1.0).round() as u32;
            for y in 0..n {
                for x in 0..n {
                    if cell_of(x, n, count).1 < w || cell_of(y, n, count).1 < w {
                        put(img, x, y, c);
                    }
                }
            }
        }
        Layer::Bevel { step, light, dark } => {
            let (lc, dc) = (rgb(light), rgb(dark));
            let count = count_for(n, scaled(*step, n, 4.0));
            let last = |v: u32| {
                let (cell, off) = cell_of(v, n, count);
                let next = if v + 1 < n {
                    cell_of(v + 1, n, count).0
                } else {
                    cell + 1
                };
                (off, next != cell)
            };
            for y in 0..n {
                for x in 0..n {
                    let (ox, xend) = last(x);
                    let (oy, yend) = last(y);
                    if xend || yend {
                        put(img, x, y, dc);
                    } else if ox == 1 || oy == 1 {
                        put(img, x, y, lc);
                    }
                }
            }
        }
    }
}

/// Draw `r` at `n`×`n` from `seed`. Unvalidated recipes are drawn as best
/// they can be; `validate` is the gate.
pub fn draw(r: &TextureRecipe, n: u32, seed: u64) -> RgbaImage {
    let mut img = RgbaImage::new(n, n);
    let mut rng = Rng::new(seed);
    base(&mut img, &mut rng, r);
    for l in &r.layers {
        layer(&mut img, &mut rng, l);
    }
    if let Some(face) = &r.wall_face {
        let rows = scaled(face.height, n, 1.0).round() as u32;
        for y in n.saturating_sub(rows)..n {
            for x in 0..n {
                let p = img.get_pixel(x, y).0;
                let d = |v: u8| (v as f32 * face.shade).round() as u8;
                put(&mut img, x, y, [d(p[0]), d(p[1]), d(p[2])]);
            }
        }
    }
    img
}
