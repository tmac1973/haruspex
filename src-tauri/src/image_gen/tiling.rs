//! Does a texture tile?
//!
//! One measurement: the step across the wrap edge against the steps between
//! neighbours inside, taken at the worse of the image and the image rolled by
//! half. A texture that tiles looks the same wherever the tile boundary falls,
//! and a repaired seam (offset and inpaint) moves the old edge to the middle,
//! so a check that only looked at the edges would pass a repair that failed.
//!
//! Three more were built and measured on fifty generated textures at 64 px
//! (`plan/local-image-generation/measurements-phase-23.md`) and dropped, because
//! ordinary texture content set them off: a border-against-middle brightness
//! check fired on large natural patches (grey pavement among green weeds), an
//! edge-line check on lane markings and slab joints, and a self-correlation
//! grid check scored a legitimate slab floor as high as a grid of copies. The
//! seam ratio separated what looked right (at most 1.8) from what did not
//! (4.3 and up).

use image::RgbaImage;

fn luma(img: &RgbaImage) -> Vec<f32> {
    img.pixels()
        .map(|p| 0.299 * p.0[0] as f32 + 0.587 * p.0[1] as f32 + 0.114 * p.0[2] as f32)
        .collect()
}

/// Mean absolute step across the wrap edge over the mean step inside. About 1
/// for a texture that wraps.
fn edge_ratio(img: &RgbaImage) -> f32 {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w < 3 || h < 3 {
        return 1.0;
    }
    let l = luma(img);
    let at = |x: usize, y: usize| l[y * w + x];

    let (mut inner, mut inner_n) = (0f64, 0usize);
    for y in 0..h {
        for x in 0..w - 1 {
            inner += (at(x + 1, y) - at(x, y)).abs() as f64;
            inner_n += 1;
        }
    }
    for y in 0..h - 1 {
        for x in 0..w {
            inner += (at(x, y + 1) - at(x, y)).abs() as f64;
            inner_n += 1;
        }
    }
    let mut wrap = 0f64;
    for y in 0..h {
        wrap += (at(0, y) - at(w - 1, y)).abs() as f64;
    }
    for x in 0..w {
        wrap += (at(x, 0) - at(x, h - 1)).abs() as f64;
    }
    let inner = inner / inner_n as f64;
    let wrap = wrap / (w + h) as f64;
    if inner < 1e-6 {
        // Flat: no seam to see, whatever the edge does.
        return if wrap < 1e-6 { 1.0 } else { f32::INFINITY };
    }
    (wrap / inner) as f32
}

/// The image shifted by half its size in both axes, wrapping round.
fn rolled_by_half(img: &RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    RgbaImage::from_fn(w, h, |x, y| {
        *img.get_pixel((x + w / 2) % w, (y + h / 2) % h)
    })
}

/// The seam ratio: the worse of the edge and the middle. About 1 for a texture
/// that tiles; the job's gate (`TEXTURE_SEAM_MAX`, 3) for one that visibly
/// does not.
pub fn seam_ratio(img: &RgbaImage) -> f32 {
    edge_ratio(img).max(edge_ratio(&rolled_by_half(img)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// The job's gate, `TEXTURE_SEAM_MAX` in `request.ts`.
    const SEAM_MAX: f32 = 3.0;

    /// Deterministic noise: a texture with no structure and no seam to hide.
    fn hash(x: u32, y: u32, seed: u32) -> u8 {
        let mut v = x.wrapping_mul(374_761_393) ^ y.wrapping_mul(668_265_263) ^ seed;
        v = (v ^ (v >> 13)).wrapping_mul(1_274_126_177);
        (v ^ (v >> 16)) as u8
    }

    fn grey(v: u8) -> Rgba<u8> {
        Rgba([v, v, v, 255])
    }

    /// Smooth noise that wraps at `size` by construction: noise blurred with a
    /// box that wraps round the edges.
    fn wrapping(size: u32) -> RgbaImage {
        let n = size as i64;
        let raw: Vec<f32> = (0..size * size)
            .map(|i| hash(i % size, i / size, 9) as f32)
            .collect();
        RgbaImage::from_fn(size, size, |x, y| {
            let mut sum = 0.0;
            for dy in -2i64..=2 {
                for dx in -2i64..=2 {
                    let xx = (x as i64 + dx).rem_euclid(n) as u32;
                    let yy = (y as i64 + dy).rem_euclid(n) as u32;
                    sum += raw[(yy * size + xx) as usize];
                }
            }
            grey((sum / 25.0) as u8)
        })
    }

    #[test]
    fn noise_tiles() {
        let img = RgbaImage::from_fn(64, 64, |x, y| grey(hash(x, y, 7)));
        assert!((0.8..1.2).contains(&seam_ratio(&img)));
    }

    #[test]
    fn a_smooth_texture_that_wraps_tiles() {
        assert!(
            seam_ratio(&wrapping(64)) < 1.5,
            "{}",
            seam_ratio(&wrapping(64))
        );
    }

    #[test]
    fn a_gradient_has_a_seam() {
        let img = RgbaImage::from_fn(64, 64, |x, y| grey((40 + 2 * x + y) as u8));
        assert!(seam_ratio(&img) > SEAM_MAX, "{}", seam_ratio(&img));
    }

    #[test]
    fn a_seam_moved_to_the_middle_is_still_a_seam() {
        // What a failed offset-and-inpaint leaves: clean edges, the old seam
        // through the middle.
        let img = rolled_by_half(&RgbaImage::from_fn(64, 64, |x, y| {
            grey((40 + 2 * x + y) as u8)
        }));
        assert!(edge_ratio(&img) < 1.5, "the edges themselves are clean");
        assert!(seam_ratio(&img) > SEAM_MAX);
    }

    #[test]
    fn flat_and_tiny_images_do_not_panic() {
        assert_eq!(seam_ratio(&RgbaImage::from_pixel(32, 32, grey(100))), 1.0);
        let _ = seam_ratio(&RgbaImage::from_pixel(2, 2, grey(100)));
    }

    /// Measure real textures: `HARUSPEX_TILE_DIR=<dir> cargo test --lib
    /// tiling::tests::measure -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure() {
        let dir = std::env::var("HARUSPEX_TILE_DIR").expect("HARUSPEX_TILE_DIR");
        let mut paths: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "png"))
            .collect();
        paths.sort();
        for p in paths {
            let img = image::open(&p).unwrap().to_rgba8();
            println!(
                "{:<36} seam {:>5.2}",
                p.file_stem().unwrap().to_string_lossy(),
                seam_ratio(&img)
            );
        }
    }
}
