//! Drawing a recipe: the base ramp, then each layer in order.
//!
//! Every layer is periodic over the tile — noise from `noise.rs`, cell
//! patterns from `cell_of`, which partitions the tile exactly — so the
//! texture tiles whatever the recipe says.

use image::{Rgba, RgbaImage};

use super::noise::{cell_len, cell_of, count_for, fbm, worley, Rng};
use super::recipe::{parse_color, Axis, Layer, TextureRecipe, DESIGN_SIZE};
use super::shade::{jitter_cells, relief_cut, relief_raised, NONE};

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
            relief,
        } => {
            let c = rgb(color);
            let (f1, f2) = worley(rng, n, *cells);
            // Where the cracks run is broken up by a second field, so they
            // are not a complete net of cells.
            let keep = fbm(rng, n, 2, 2);
            let w = scaled(width.unwrap_or(0.8), n, 0.6);
            let mut groove = vec![false; (n * n) as usize];
            for i in 0..(n * n) as usize {
                if f2[i] - f1[i] < w && keep[i] > *coverage {
                    put(img, i as u32 % n, i as u32 / n, c);
                    groove[i] = true;
                }
            }
            if let Some(r) = relief.filter(|r| *r > 0.0) {
                relief_cut(img, &groove, r);
            }
        }
        Layer::Blotches {
            color,
            cells,
            threshold,
            relief,
        } => {
            let c = rgb(color);
            // Never coarser than 4 cells: a field with a period of 2 repeats
            // visibly when the tile is laid 2×2 — the prototype's park.
            let f = fbm(rng, n, (*cells).max(4), 2);
            let mut patch = vec![NONE; (n * n) as usize];
            for (i, v) in f.iter().enumerate() {
                if v > threshold {
                    put(img, i as u32 % n, i as u32 / n, c);
                    patch[i] = 0;
                }
            }
            if let Some(r) = relief.filter(|r| *r > 0.0) {
                relief_raised(img, &patch, r);
            }
        }
        Layer::Bricks {
            w,
            h,
            gap,
            offset,
            colors,
            mortar,
            relief,
            jitter,
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
            let mut cell = vec![NONE; (n * n) as usize];
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
                        cell[(y * n + x) as usize] = row * cols + col;
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
            if let Some(j) = jitter.filter(|j| *j > 0.0) {
                jitter_cells(img, &cell, j, rng);
            }
            if let Some(r) = relief.filter(|r| *r > 0.0) {
                relief_raised(img, &cell, r);
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

#[cfg(test)]
mod tests {
    use super::super::recipe::{BaseLayer, WallFace};
    use super::*;

    const BLACK: [u8; 3] = [0, 0, 0];
    const WHITE: [u8; 3] = [255, 255, 255];
    const RED: [u8; 3] = [255, 0, 0];

    /// A recipe whose base is one flat colour, so whatever a layer paints
    /// stands out exactly.
    fn flat(layers: Vec<Layer>) -> TextureRecipe {
        TextureRecipe {
            base: BaseLayer {
                ramp: vec!["#000000".into(), "#000000".into()],
                cells: None,
                octaves: None,
                dither: Some(false),
            },
            layers,
            wall_face: None,
        }
    }

    fn rgb_at(img: &RgbaImage, x: u32, y: u32) -> [u8; 3] {
        let p = img.get_pixel(x, y).0;
        [p[0], p[1], p[2]]
    }

    fn all_pixels(img: &RgbaImage, c: [u8; 3]) -> bool {
        img.pixels().all(|p| [p[0], p[1], p[2]] == c)
    }

    #[test]
    fn draw_is_n_by_n_opaque_and_repeats_for_a_seed() {
        let r = TextureRecipe {
            base: BaseLayer {
                ramp: vec!["#202020".into(), "#808080".into(), "#e0e0e0".into()],
                cells: Some(4),
                octaves: Some(3),
                dither: Some(true),
            },
            layers: vec![Layer::Speckle {
                color: "#ff0000".into(),
                amount: 0.1,
            }],
            wall_face: None,
        };
        for n in [8, 16, 32, 64] {
            let img = draw(&r, n, 5);
            assert_eq!(img.dimensions(), (n, n));
            assert!(img.pixels().all(|p| p[3] == 255));
            assert_eq!(img.as_raw(), draw(&r, n, 5).as_raw());
        }
        assert_ne!(draw(&r, 32, 5).as_raw(), draw(&r, 32, 6).as_raw());
    }

    #[test]
    fn base_uses_only_ramp_colours_and_spans_the_ramp() {
        let ramp = [[16, 16, 16], [128, 64, 32], [240, 240, 240]];
        for dither in [false, true] {
            let r = TextureRecipe {
                base: BaseLayer {
                    ramp: vec!["#101010".into(), "#804020".into(), "#f0f0f0".into()],
                    cells: Some(4),
                    octaves: Some(2),
                    dither: Some(dither),
                },
                layers: vec![],
                wall_face: None,
            };
            let img = draw(&r, 32, 3);
            assert!(img.pixels().all(|p| ramp.contains(&[p[0], p[1], p[2]])));
            // The field is normalized to 0..1, so both ends of the ramp show.
            for c in [ramp[0], ramp[2]] {
                assert!(img.pixels().any(|p| [p[0], p[1], p[2]] == c), "{c:?}");
            }
        }
    }

    #[test]
    fn a_single_shade_ramp_and_an_unparseable_colour_draw_flat() {
        let mut r = flat(vec![]);
        r.base.ramp = vec!["#336699".into()];
        r.base.dither = Some(true);
        assert!(all_pixels(&draw(&r, 16, 1), [0x33, 0x66, 0x99]));

        // Unvalidated colours fall back to mid grey rather than panicking.
        r.base.ramp = vec!["orange".into(), "nope".into()];
        assert!(all_pixels(&draw(&r, 16, 1), [128, 128, 128]));
    }

    #[test]
    fn speckle_amount_bounds_paint_nothing_or_everything() {
        let none = flat(vec![Layer::Speckle {
            color: "#ffffff".into(),
            amount: 0.0,
        }]);
        assert!(all_pixels(&draw(&none, 32, 1), BLACK));
        let all = flat(vec![Layer::Speckle {
            color: "#ffffff".into(),
            amount: 1.0,
        }]);
        assert!(all_pixels(&draw(&all, 32, 1), WHITE));

        let some = flat(vec![Layer::Speckle {
            color: "#ffffff".into(),
            amount: 0.25,
        }]);
        let img = draw(&some, 64, 1);
        let lit = img.pixels().filter(|p| p[0] == 255).count() as f32 / (64.0 * 64.0);
        assert!((0.18..0.32).contains(&lit), "{lit}");
    }

    #[test]
    fn grid_puts_seams_on_exact_cell_starts_and_scales_with_the_tile() {
        let r = flat(vec![Layer::Grid {
            step: 8.0,
            width: Some(1.0),
            color: "#ffffff".into(),
        }]);
        let img = draw(&r, 32, 1);
        for y in 0..32 {
            for x in 0..32 {
                let want = if x % 8 == 0 || y % 8 == 0 {
                    WHITE
                } else {
                    BLACK
                };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }
        // At 64 px the same recipe has four 16-px cells with 2-px seams.
        let img = draw(&r, 64, 1);
        for y in 0..64 {
            for x in 0..64 {
                let want = if x % 16 < 2 || y % 16 < 2 {
                    WHITE
                } else {
                    BLACK
                };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }
    }

    #[test]
    fn bevel_lights_the_second_row_and_darkens_each_cells_last() {
        let r = flat(vec![Layer::Bevel {
            step: 8.0,
            light: "#ffffff".into(),
            dark: "#ff0000".into(),
        }]);
        let img = draw(&r, 32, 1);
        for y in 0..32 {
            for x in 0..32 {
                let want = if x % 8 == 7 || y % 8 == 7 {
                    RED
                } else if x % 8 == 1 || y % 8 == 1 {
                    WHITE
                } else {
                    BLACK
                };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }
    }

    #[test]
    fn stripes_paint_their_band_solid_dashed_or_worn_away() {
        let stripe = |axis, dash, wear| {
            flat(vec![Layer::Stripes {
                axis,
                pos: 4.0,
                width: 2.0,
                dash,
                color: "#ffffff".into(),
                wear,
            }])
        };
        let img = draw(&stripe(Axis::X, None, None), 32, 1);
        for y in 0..32 {
            for x in 0..32 {
                let want = if (4..6).contains(&y) { WHITE } else { BLACK };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }

        // Axis Y runs top to bottom, so the band is columns; dashes of 4 on
        // and 4 off give a period of 8 that divides the tile.
        let img = draw(&stripe(Axis::Y, Some([4.0, 4.0]), None), 32, 1);
        for y in 0..32 {
            for x in 0..32 {
                let want = if (4..6).contains(&x) && y % 8 < 4 {
                    WHITE
                } else {
                    BLACK
                };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }

        assert!(all_pixels(
            &draw(&stripe(Axis::X, None, Some(1.0)), 32, 1),
            BLACK
        ));
    }

    #[test]
    fn bricks_lay_mortar_at_cell_starts_and_blend_the_face_with_the_base() {
        let bricks = |h, offset| {
            flat(vec![Layer::Bricks {
                w: 8.0,
                h,
                gap: 1.0,
                offset,
                colors: vec!["#c8c8c8".into()],
                mortar: "#ff0000".into(),
                relief: None,
                jitter: None,
            }])
        };
        // Stack bond: mortar on every 8th row and column, faces half brick
        // and half the black base under them.
        let img = draw(&bricks(8.0, false), 32, 1);
        for y in 0..32 {
            for x in 0..32 {
                let want = if x % 8 == 0 || y % 8 == 0 {
                    RED
                } else {
                    [100, 100, 100]
                };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }

        // Running bond: odd rows shift by half a brick.
        let img = draw(&bricks(8.0, true), 32, 1);
        for y in 1..32 {
            if y % 8 == 0 {
                continue;
            }
            let joint = if (y / 8) % 2 == 1 { 4 } else { 0 };
            for x in 0..32 {
                let want = if x % 8 == joint { RED } else { [100, 100, 100] };
                assert_eq!(rgb_at(&img, x, y), want, "({x},{y})");
            }
        }

        // Three rows would put two unshifted rows together across the seam,
        // so running bond drops to two: bed joints at rows 0 and 16 only.
        let img = draw(&bricks(32.0 / 3.0, true), 32, 1);
        let bed: Vec<u32> = (0..32)
            .filter(|&y| (0..32).all(|x| rgb_at(&img, x, y) == RED))
            .collect();
        assert_eq!(bed, vec![0, 16]);
    }

    #[test]
    fn thresholded_layers_paint_nothing_at_the_top_of_their_range() {
        // fbm is normalized to 0..1 and sin to -1..1, so a threshold at the
        // top paints nothing and one below the bottom paints everything.
        let blotch = |threshold| {
            flat(vec![Layer::Blotches {
                color: "#ffffff".into(),
                cells: 4,
                threshold,
                relief: None,
            }])
        };
        assert!(all_pixels(&draw(&blotch(1.0), 32, 2), BLACK));
        assert!(all_pixels(&draw(&blotch(-0.1), 32, 2), WHITE));
        let img = draw(&blotch(0.5), 32, 2);
        assert!(img.pixels().any(|p| p[0] == 255) && img.pixels().any(|p| p[0] == 0));

        let waves = |threshold| {
            flat(vec![Layer::Waves {
                color: "#ffffff".into(),
                freq: 4,
                threshold,
            }])
        };
        assert!(all_pixels(&draw(&waves(1.0), 32, 2), BLACK));
        assert!(all_pixels(&draw(&waves(-1.1), 32, 2), WHITE));

        let cracks = |coverage| {
            flat(vec![Layer::Cracks {
                color: "#ffffff".into(),
                cells: 3,
                coverage,
                width: None,
                relief: None,
            }])
        };
        assert!(all_pixels(&draw(&cracks(1.0), 32, 2), BLACK));
        let img = draw(&cracks(-0.1), 32, 2);
        assert!(img.pixels().any(|p| p[0] == 255) && img.pixels().any(|p| p[0] == 0));
    }

    #[test]
    fn layers_wrap_at_the_tile_edge() {
        // A step that does not divide the tile is rounded to a whole number
        // of cells, so the seam is on the first column and never doubled by
        // one on the last column across the wrap.
        for step in [5.0, 7.0, 9.0, 11.0] {
            let r = flat(vec![Layer::Grid {
                step,
                width: Some(1.0),
                color: "#ffffff".into(),
            }]);
            let img = draw(&r, 32, 1);
            let seam_col = |x: u32| (0..32).all(|y| rgb_at(&img, x, y) == WHITE);
            assert!(seam_col(0), "step {step}");
            assert!(!seam_col(31), "step {step}: double seam across the wrap");
        }
    }

    #[test]
    fn a_wall_face_darkens_only_its_bottom_rows() {
        let mut r = flat(vec![]);
        r.base.ramp = vec!["#c8c8c8".into()];
        r.wall_face = Some(WallFace {
            height: 8.0,
            shade: 0.5,
        });
        for (n, rows) in [(32u32, 8u32), (64, 16)] {
            let img = draw(&r, n, 1);
            for y in 0..n {
                let want = if y >= n - rows { [100; 3] } else { [200; 3] };
                for x in 0..n {
                    assert_eq!(rgb_at(&img, x, y), want, "n {n} ({x},{y})");
                }
            }
        }
        // A face taller than the tile shades all of it rather than panicking.
        r.wall_face = Some(WallFace {
            height: 100.0,
            shade: 0.0,
        });
        assert!(all_pixels(&draw(&r, 16, 1), BLACK));
    }

    fn lum(img: &RgbaImage, x: u32, y: u32) -> f64 {
        let p = img.get_pixel(x, y).0;
        p[0] as f64 + p[1] as f64 + p[2] as f64
    }

    fn mean(v: &[f64]) -> f64 {
        v.iter().sum::<f64>() / v.len().max(1) as f64
    }

    fn bricks(relief: Option<f32>, jitter: Option<f32>) -> TextureRecipe {
        let mut r = flat(vec![Layer::Bricks {
            w: 8.0,
            h: 8.0,
            gap: 1.0,
            offset: false,
            colors: vec!["#808080".into()],
            mortar: "#000000".into(),
            relief,
            jitter,
        }]);
        r.base.ramp = vec!["#808080".into(), "#808080".into()];
        r
    }

    #[test]
    fn relief_lights_the_top_left_of_each_brick() {
        let img = draw(&bricks(Some(1.0), None), 32, 3);
        let mortar = |x: u32, y: u32| rgb_at(&img, x, y) == BLACK;
        let (mut lit, mut shaded, mut inside) = (vec![], vec![], vec![]);
        for y in 0..32 {
            for x in 0..32 {
                if mortar(x, y) {
                    continue;
                }
                let up = mortar(x, (y + 31) % 32);
                let down = mortar(x, (y + 1) % 32);
                if up {
                    lit.push(lum(&img, x, y));
                } else if down {
                    shaded.push(lum(&img, x, y));
                } else if !mortar((x + 31) % 32, y) && !mortar((x + 1) % 32, y) {
                    inside.push(lum(&img, x, y));
                }
            }
        }
        assert!(
            mean(&lit) > mean(&inside),
            "lit {} inside {}",
            mean(&lit),
            mean(&inside)
        );
        assert!(
            mean(&shaded) < mean(&inside),
            "shaded {} inside {}",
            mean(&shaded),
            mean(&inside)
        );
    }

    #[test]
    fn relief_cuts_cracks_in() {
        let crack = |relief| {
            let mut r = flat(vec![Layer::Cracks {
                color: "#000000".into(),
                cells: 3,
                coverage: 0.0,
                width: None,
                relief,
            }]);
            r.base.ramp = vec!["#808080".into(), "#808080".into()];
            draw(&r, 32, 4)
        };
        let (plain, cut) = (crack(None), crack(Some(1.0)));
        // Below a crack pixel, on the plain base: the lip catches the light.
        let mut lips = vec![];
        for y in 0..32 {
            for x in 0..32 {
                let below = (y + 1) % 32;
                if rgb_at(&plain, x, y) == BLACK && rgb_at(&plain, x, below) != BLACK {
                    lips.push(lum(&cut, x, below) - lum(&plain, x, below));
                }
            }
        }
        assert!(!lips.is_empty());
        assert!(mean(&lips) > 0.0);
    }

    #[test]
    fn jitter_changes_brick_shades_only_when_set() {
        let none = draw(&bricks(None, None), 32, 5);
        assert_eq!(
            none.as_raw(),
            draw(&bricks(None, Some(0.0)), 32, 5).as_raw()
        );
        assert_eq!(
            none.as_raw(),
            draw(&bricks(Some(0.0), None), 32, 5).as_raw()
        );
        let jittered = draw(&bricks(None, Some(1.0)), 32, 5);
        // Brick interiors: one colour without jitter, several with it.
        let shades = |img: &RgbaImage| {
            let mut set = std::collections::HashSet::new();
            for y in (4..32).step_by(8) {
                for x in (4..32).step_by(8) {
                    set.insert(rgb_at(img, x, y));
                }
            }
            set.len()
        };
        assert_eq!(shades(&none), 1);
        assert!(shades(&jittered) > 1);
    }
}
