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
pub fn rolled_by_half(img: &RgbaImage) -> RgbaImage {
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

/// The repaint mask for a texture rolled by half: a cross a quarter of the size
/// wide over the old seams, feathered, and doubled so its middle is solid
/// (a blurred band peaks below full strength, and at less than full strength
/// the old seam survives). White is repainted; black is kept.
pub fn seam_mask(w: u32, h: u32) -> image::GrayImage {
    let band_w = (w / 4).max(1);
    let band_h = (h / 4).max(1);
    let (x0, y0) = (w / 2 - band_w / 2, h / 2 - band_h / 2);
    let hard = image::GrayImage::from_fn(w, h, |x, y| {
        let inside = (x >= x0 && x < x0 + band_w) || (y >= y0 && y < y0 + band_h);
        image::Luma([if inside { 255 } else { 0 }])
    });
    // A 48 px blur at 1024, scaled to the size, as measured.
    let sigma = (w.min(h) as f32 / 1024.0) * 48.0;
    let soft = image::imageops::blur(&hard, sigma.max(1.0));
    image::GrayImage::from_fn(w, h, |x, y| {
        image::Luma([soft.get_pixel(x, y).0[0].saturating_mul(2)])
    })
}

/// `top` over `base` through `mask` (white = top). Outside the mask the base is
/// kept to the byte: those pixels are what makes the rolled texture wrap, and a
/// pass through the VAE would nudge them.
///
/// Inside it the repaint is first matched to the base's tone, per channel, over
/// the masked area: masked img2img can come back darker across the whole band
/// (water did, by about a tenth), which tiles as a grid of stripes even when
/// every detail joins up.
pub fn composite(base: &RgbaImage, top: &RgbaImage, mask: &image::GrayImage) -> RgbaImage {
    let shift = tone_shift(base, top, mask);
    RgbaImage::from_fn(base.width(), base.height(), |x, y| {
        let a = mask.get_pixel(x, y).0[0] as f32 / 255.0;
        let (b, t) = (base.get_pixel(x, y).0, top.get_pixel(x, y).0);
        let mix = |i: usize| {
            let t = (t[i] as f32 + shift[i]).clamp(0.0, 255.0);
            (t * a + b[i] as f32 * (1.0 - a)).round() as u8
        };
        image::Rgba([mix(0), mix(1), mix(2), 255])
    })
}

/// Per channel, what to add to `top` so its mask-weighted mean is `base`'s.
fn tone_shift(base: &RgbaImage, top: &RgbaImage, mask: &image::GrayImage) -> [f32; 3] {
    let (mut sb, mut st, mut w) = ([0f64; 3], [0f64; 3], 0f64);
    for ((b, t), m) in base.pixels().zip(top.pixels()).zip(mask.pixels()) {
        let a = m.0[0] as f64;
        w += a;
        for i in 0..3 {
            sb[i] += b.0[i] as f64 * a;
            st[i] += t.0[i] as f64 * a;
        }
    }
    if w == 0.0 {
        return [0.0; 3];
    }
    std::array::from_fn(|i| ((sb[i] - st[i]) / w) as f32)
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

    #[test]
    fn roll_moves_every_pixel_and_wraps() {
        let img = RgbaImage::from_fn(8, 4, |x, y| grey((x * 10 + y) as u8));
        let r = rolled_by_half(&img);
        assert_eq!(r.get_pixel(4, 2), img.get_pixel(0, 0));
        assert_eq!(r.get_pixel(0, 0), img.get_pixel(4, 2));
        assert_eq!(
            rolled_by_half(&r),
            img,
            "rolling by half twice is the identity"
        );
    }

    #[test]
    fn the_mask_covers_the_middle_cross_and_spares_the_corners() {
        let m = seam_mask(1024, 1024);
        assert_eq!(
            m.get_pixel(512, 512).0[0],
            255,
            "solid where the seams cross"
        );
        assert_eq!(m.get_pixel(512, 20).0[0], 255, "and along each arm");
        assert_eq!(m.get_pixel(100, 100).0[0], 0, "corners kept");
        let feather = m.get_pixel(512 - 128 - 40, 100).0[0];
        assert!(
            feather > 0 && feather < 255,
            "soft at the band's edge: {feather}"
        );
    }

    #[test]
    fn the_composite_keeps_the_base_exactly_outside_the_mask() {
        let base = RgbaImage::from_fn(16, 16, |x, y| grey((x * 7 + y * 3) as u8));
        let top = RgbaImage::from_pixel(16, 16, grey(250));
        let mask =
            image::GrayImage::from_fn(16, 16, |x, _| image::Luma([if x < 8 { 0 } else { 255 }]));
        let c = composite(&base, &top, &mask);
        for y in 0..16 {
            assert_eq!(c.get_pixel(3, y), base.get_pixel(3, y));
            assert_ne!(c.get_pixel(12, y), base.get_pixel(12, y));
        }
    }

    #[test]
    fn a_repaint_that_came_back_darker_is_brought_back_to_the_base_tone() {
        let base = RgbaImage::from_pixel(16, 16, grey(120));
        let top = RgbaImage::from_fn(16, 16, |x, _| grey(if x % 2 == 0 { 90 } else { 110 }));
        let mask = image::GrayImage::from_pixel(16, 16, image::Luma([255]));
        let c = composite(&base, &top, &mask);
        let mean = c.pixels().map(|p| p.0[0] as f32).sum::<f32>() / 256.0;
        assert!((mean - 120.0).abs() < 0.5, "tone restored: {mean}");
        assert_ne!(c.get_pixel(0, 0), c.get_pixel(1, 0), "detail kept");
    }

    /// The seam pass by hand, against a live engine (`measurements-phase-28.md`).
    /// HARUSPEX_SEAM_STEP=prepare turns each `<name>.base.png` in HARUSPEX_SEAM_DIR
    /// into `<name>.rolled.png` and `<name>.mask.png`; =finish blends each
    /// `<name>.repaint.png` into `<name>.tile.png` and prints both seam ratios.
    #[test]
    #[ignore]
    fn seam_pass() {
        let dir = std::path::PathBuf::from(std::env::var("HARUSPEX_SEAM_DIR").unwrap());
        let finish = std::env::var("HARUSPEX_SEAM_STEP").as_deref() == Ok("finish");
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            let Some(name) = p
                .to_string_lossy()
                .strip_suffix(".base.png")
                .map(String::from)
            else {
                continue;
            };
            let base = image::open(&p).unwrap().to_rgba8();
            let rolled = rolled_by_half(&base);
            let mask = seam_mask(base.width(), base.height());
            if finish {
                let top = image::open(format!("{name}.repaint.png"))
                    .unwrap()
                    .to_rgba8();
                let tile = composite(&rolled, &top, &mask);
                tile.save(format!("{name}.tile.png")).unwrap();
                println!(
                    "{:<24} base {:>5.2}  tile {:>5.2}",
                    std::path::Path::new(&name)
                        .file_name()
                        .unwrap()
                        .to_string_lossy(),
                    seam_ratio(&base),
                    seam_ratio(&tile)
                );
            } else {
                rolled.save(format!("{name}.rolled.png")).unwrap();
                mask.save(format!("{name}.mask.png")).unwrap();
            }
        }
    }
}
