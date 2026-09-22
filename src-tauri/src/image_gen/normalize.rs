//! The mechanical coherence pass: key, crop, downscale, quantize, outline.
//!
//! The order is load-bearing and asserted by a test. Keying after quantizing
//! would snap the background into the palette; outlining before downscaling
//! would give a border a fraction of a pixel wide.

use image::{Rgba, RgbaImage};

use super::palette::{extract_palette, quantize_to};
use super::profile::{
    effective_profile, is_background, pack, rgba, AssetKind, Background, NormalizeProfile,
    BORDER_DOMINANCE,
};
use super::stats::{entropy_bits, ImageStats};

/// Set alpha 0 on every pixel within `tolerance` of the key colour.
///
/// A threshold, not a matte. The prompt asks the model for a flat background
/// of exactly this colour, which makes removal deterministic, fast, and
/// testable against a fixture — none of which is true of a segmentation model.
pub fn chroma_key(img: &mut RgbaImage, key: u32, bg: &Background) {
    let k = rgba(key);
    for p in img.pixels_mut() {
        if p.0[3] == 0 {
            continue;
        }
        if is_background(p.0, k, bg) {
            p.0 = [0, 0, 0, 0];
        }
    }
}

/// Fraction of pixels that are not fully transparent.
fn opaque_fraction(img: &RgbaImage) -> f32 {
    let total = (img.width() * img.height()) as f32;
    if total == 0.0 {
        return 0.0;
    }
    img.pixels().filter(|p| p.0[3] != 0).count() as f32 / total
}

/// The colour covering most of the image border, if one clearly dominates.
///
/// Returns `None` when no colour holds at least [`BORDER_DOMINANCE`] of the
/// border — a subject that fills the frame has no background to find, and
/// keying its own edge colour would eat the subject.
pub fn dominant_border_color(img: &RgbaImage, bg: &Background) -> Option<u32> {
    let (w, h) = img.dimensions();
    if w < 2 || h < 2 {
        return None;
    }
    let mut border: Vec<[u8; 4]> = Vec::new();
    for x in 0..w {
        border.push(img.get_pixel(x, 0).0);
        border.push(img.get_pixel(x, h - 1).0);
    }
    for y in 1..h.saturating_sub(1) {
        border.push(img.get_pixel(0, y).0);
        border.push(img.get_pixel(w - 1, y).0);
    }
    let total = border.len() as f32;
    // Cluster by the SAME test the key will use, so "dominant" means "would
    // be removed together". Clustering on distance while keying on hue would
    // reject a lit backdrop as incoherent and then have been able to remove
    // it perfectly.
    let mut best: Option<(u32, f32)> = None;
    for candidate in &border {
        let n = border
            .iter()
            .filter(|c| is_background(**c, *candidate, bg))
            .count() as f32;
        if best.is_none_or(|(_, b)| n > b) {
            best = Some((pack(*candidate), n));
        }
    }
    best.filter(|(_, n)| n / total >= BORDER_DOMINANCE)
        .map(|(c, _)| c)
}

/// Remove opaque islands far smaller than the largest one.
///
/// Keying is never perfect: a few pixels of background survive in the corners,
/// and a few specks of subject-coloured noise survive in the background. Those
/// specks cost nothing on their own and wreck the crop that follows — the
/// bounding box of "all opaque pixels" becomes the whole frame, so a sword
/// that should fill 32px is reduced to a smudge in one corner with the rest
/// of the image empty. Measured on real output: an SDXL sword at 8.7% alpha
/// cropped to nothing useful until the specks went.
///
/// A component survives if it is at least `min_fraction` of the largest one.
/// Relative rather than absolute, because a subject may legitimately be small
/// and still be the only thing there.
pub fn despeckle(img: &mut RgbaImage, min_fraction: f32) {
    let (w, h) = img.dimensions();
    let mut label = vec![u32::MAX; (w * h) as usize];
    let mut sizes: Vec<u32> = Vec::new();
    let idx = |x: u32, y: u32| (y * w + x) as usize;

    for y in 0..h {
        for x in 0..w {
            if img.get_pixel(x, y).0[3] == 0 || label[idx(x, y)] != u32::MAX {
                continue;
            }
            let id = sizes.len() as u32;
            let mut n = 0u32;
            let mut stack = vec![(x, y)];
            label[idx(x, y)] = id;
            while let Some((cx, cy)) = stack.pop() {
                n += 1;
                let neighbours = [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ];
                for (nx, ny) in neighbours {
                    if nx >= w || ny >= h {
                        continue;
                    }
                    if img.get_pixel(nx, ny).0[3] == 0 || label[idx(nx, ny)] != u32::MAX {
                        continue;
                    }
                    label[idx(nx, ny)] = id;
                    stack.push((nx, ny));
                }
            }
            sizes.push(n);
        }
    }

    let Some(&largest) = sizes.iter().max() else {
        return;
    };
    let floor = (largest as f32 * min_fraction).max(1.0);
    for y in 0..h {
        for x in 0..w {
            let l = label[idx(x, y)];
            if l != u32::MAX && (sizes[l as usize] as f32) < floor {
                img.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
    }
}

/// Tightest box around the opaque pixels, expanded by `margin`.
pub fn crop_to_content(img: &RgbaImage, margin: u32) -> Result<RgbaImage, String> {
    let (w, h) = img.dimensions();
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    for (x, y, p) in img.enumerate_pixels() {
        if p.0[3] == 0 {
            continue;
        }
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    if min_x > max_x {
        // Every pixel was keyed out. An error, not a zero-size crop: the
        // caller needs to know it has a blank image, not a malformed one.
        return Err("Nothing left after removing the background — the image is empty.".into());
    }
    let x0 = min_x.saturating_sub(margin);
    let y0 = min_y.saturating_sub(margin);
    let x1 = (max_x + margin).min(w - 1);
    let y1 = (max_y + margin).min(h - 1);
    Ok(image::imageops::crop_imm(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1).to_image())
}

/// Centre `img` on a transparent square whose side is a multiple of `target`.
///
/// A square so one downscale factor serves both axes — padding each axis to
/// its own multiple would give different factors and silently change the
/// aspect ratio of anything not already square.
fn pad_to_square_multiple(img: &RgbaImage, target: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    let longest = w.max(h).max(1);
    let side = longest.div_ceil(target.max(1)) * target.max(1);
    let mut out = RgbaImage::from_pixel(side, side, Rgba([0, 0, 0, 0]));
    let ox = (side - w) / 2;
    let oy = (side - h) / 2;
    for (x, y, p) in img.enumerate_pixels() {
        out.put_pixel(x + ox, y + oy, *p);
    }
    out
}

/// Downscale to `target` square by an exact integer factor, taking the MODAL
/// colour of each cell.
///
/// Modal, not mean. Averaging is what turns pixel art into mush: it invents
/// colours that are in no palette and blurs every hard edge the outline pass
/// is about to try to find.
pub fn downscale_integer(img: &RgbaImage, target: u32) -> RgbaImage {
    let target = target.max(1);
    let padded = pad_to_square_multiple(img, target);
    let side = padded.width();
    let factor = (side / target).max(1);
    let mut out = RgbaImage::from_pixel(target, target, Rgba([0, 0, 0, 0]));
    let mut counts: Vec<(u32, u32)> = Vec::with_capacity((factor * factor) as usize);
    for cy in 0..target {
        for cx in 0..target {
            counts.clear();
            for y in 0..factor {
                for x in 0..factor {
                    let p = padded.get_pixel(cx * factor + x, cy * factor + y);
                    // Fully transparent pixels collapse to one key, so a mostly
                    // empty cell resolves to empty rather than to whatever
                    // colour happened to sit behind the alpha.
                    let key = if p.0[3] == 0 { 0 } else { pack(p.0) };
                    match counts.iter_mut().find(|(k, _)| *k == key) {
                        Some((_, n)) => *n += 1,
                        None => counts.push((key, 1)),
                    }
                }
            }
            if let Some((key, _)) = counts.iter().copied().max_by_key(|(_, n)| *n) {
                out.put_pixel(
                    cx,
                    cy,
                    Rgba(if key == 0 { [0, 0, 0, 0] } else { rgba(key) }),
                );
            }
        }
    }
    out
}

/// Dilate the silhouette into a border of exactly `width` pixels.
///
/// The cheapest art direction available, and it does more for making unrelated
/// sprites look like one set than anything else in this file.
pub fn normalize_outline(img: &mut RgbaImage, color: u32, width: u32) {
    let c = rgba(color);
    let (w, h) = img.dimensions();
    for _ in 0..width {
        let mut edges: Vec<(u32, u32)> = Vec::new();
        for y in 0..h {
            for x in 0..w {
                if img.get_pixel(x, y).0[3] != 0 {
                    continue;
                }
                let touching = [
                    (x.wrapping_sub(1), y),
                    (x + 1, y),
                    (x, y.wrapping_sub(1)),
                    (x, y + 1),
                ]
                .iter()
                .any(|&(nx, ny)| nx < w && ny < h && img.get_pixel(nx, ny).0[3] != 0);
                if touching {
                    edges.push((x, y));
                }
            }
        }
        if edges.is_empty() {
            break;
        }
        for (x, y) in edges {
            img.put_pixel(x, y, Rgba(c));
        }
    }
}

/// Run the whole pass for one asset kind.
///
/// Returns the normalized image and the statistics the quality gate needs.
/// The stats come from here rather than from a later re-measurement because
/// palette distance is only knowable during quantization; afterwards every
/// pixel is in the palette by construction and the evidence is gone.
pub fn normalize(
    img: &RgbaImage,
    profile: &NormalizeProfile,
    kind: AssetKind,
) -> Result<(RgbaImage, ImageStats), String> {
    let p = effective_profile(profile, kind);
    let mut work = img.clone();

    // The configured key first; the border when that did not do the job.
    //
    // "Did not do the job" is measured against the same threshold the quality
    // gate uses for "the background was never removed", not against "removed
    // nothing at all". An earlier version tried the fallback only when the key
    // matched zero pixels, and a handful of stray hits — a few background-hued
    // pixels inside the subject — were enough to suppress the border detection
    // that was doing all the actual work. Two of three SDXL sprites came out
    // fully opaque because of it.
    chroma_key(&mut work, p.background.color, &p.background);
    if p.background.auto_detect && opaque_fraction(&work) > p.checks.alpha_max {
        if let Some(found) = dominant_border_color(&work, &p.background) {
            chroma_key(&mut work, found, &p.background);
        }
    }
    if p.crop.enabled {
        // Before cropping, not after: the specks are what break the crop.
        despeckle(&mut work, p.crop.min_island_fraction);
        work = crop_to_content(&work, p.crop.margin)?;
    }
    work = downscale_integer(&work, p.target_size);

    // An empty palette means the style anchor has not run yet. Measuring
    // against a palette derived from this one image would report a flattering
    // zero, so derive one and measure honestly.
    let palette = if p.palette.is_empty() {
        extract_palette(
            &work,
            p.palette_size,
            Some((p.background.color, p.background.tolerance)),
        )
    } else {
        p.palette.clone()
    };
    let palette_distance = quantize_to(&mut work, &palette);

    if p.outline.enabled {
        normalize_outline(&mut work, p.outline.color, p.outline.width);
    }

    let stats = ImageStats {
        alpha: opaque_fraction(&work),
        entropy: entropy_bits(&work),
        palette_distance,
    };
    Ok((work, stats))
}

#[cfg(test)]
mod tests {
    use super::super::profile::{pack, Outline};
    use super::*;

    const KEY: u32 = 0xFF_00_FF_FF;

    fn keyed(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(rgba(KEY)))
    }

    fn block(img: &mut RgbaImage, x0: u32, y0: u32, x1: u32, y1: u32, c: [u8; 4]) {
        for y in y0..=y1 {
            for x in x0..=x1 {
                img.put_pixel(x, y, Rgba(c));
            }
        }
    }

    #[test]
    fn chroma_key_removes_the_background_and_nothing_else() {
        let mut img = keyed(4, 4);
        img.put_pixel(1, 1, Rgba([20, 90, 40, 255]));
        chroma_key(&mut img, KEY, &NormalizeProfile::default().background);
        assert_eq!(img.get_pixel(0, 0).0[3], 0);
        assert_eq!(img.get_pixel(1, 1).0, [20, 90, 40, 255]);
    }

    #[test]
    fn a_pixel_of_a_different_hue_survives() {
        let mut img = keyed(2, 2);
        img.put_pixel(0, 0, Rgba([20, 200, 60, 255]));
        chroma_key(&mut img, KEY, &NormalizeProfile::default().background);
        assert_ne!(img.get_pixel(0, 0).0[3], 0);
    }

    #[test]
    fn the_same_hue_at_a_different_brightness_is_still_background() {
        // The case that matters on real output. A studio-lit backdrop is one
        // colour with a gradient across it: measured on an SDXL generation it
        // ran from rgb(122,5,73) to rgb(204,51,142), an RGB distance of ~110,
        // while its hue moved 4 degrees. Distance alone removes a third of it
        // and leaves the rest as confetti round the subject.
        let mut img = keyed(4, 4);
        for (i, c) in [[122, 5, 73, 255], [204, 51, 142, 255], [159, 12, 101, 255]]
            .into_iter()
            .enumerate()
        {
            img.put_pixel(i as u32, 0, Rgba(c));
        }
        let mut bg = NormalizeProfile::default().background;
        // Keyed against the backdrop actually found, as auto-detection does.
        bg.color = pack([186, 2, 105, 255]);
        chroma_key(&mut img, bg.color, &bg);
        for i in 0..3u32 {
            assert_eq!(img.get_pixel(i, 0).0[3], 0, "gradient sample {i} survived");
        }
    }

    #[test]
    fn a_pale_subject_is_not_eaten_by_hue_matching() {
        // The saturation floor. A pale pink bottle shares magenta's hue and
        // must survive, or widening the net to span a gradient would start
        // removing subjects.
        let mut img = keyed(4, 4);
        img.put_pixel(0, 0, Rgba([245, 225, 238, 255]));
        chroma_key(&mut img, KEY, &NormalizeProfile::default().background);
        assert_ne!(img.get_pixel(0, 0).0[3], 0);
    }

    #[test]
    fn crop_finds_the_subject_and_honours_the_margin() {
        let mut img = RgbaImage::from_pixel(16, 16, Rgba([0, 0, 0, 0]));
        block(&mut img, 6, 6, 9, 9, [1, 2, 3, 255]);
        assert_eq!(crop_to_content(&img, 0).unwrap().dimensions(), (4, 4));
        assert_eq!(crop_to_content(&img, 2).unwrap().dimensions(), (8, 8));
    }

    #[test]
    fn crop_reports_an_empty_image_rather_than_a_zero_size_one() {
        let img = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 0]));
        assert!(crop_to_content(&img, 0).unwrap_err().contains("empty"));
    }

    #[test]
    fn downscale_picks_a_source_colour_and_never_invents_one() {
        // The test that proves MODAL selection, and it only proves it because
        // the stripes STRADDLE the cell grid: 8px stripes against a 16px cell,
        // so each cell holds two colours in equal measure. A mean would return
        // their average — a third colour in no palette, which is exactly how
        // pixel art turns to mush.
        //
        // An earlier version of this test used 16px blocks aligned to the 16px
        // cells. Every cell was uniform, mean and mode agreed, and the test
        // passed against a deliberately broken averaging implementation.
        const RED: [u8; 4] = [255, 0, 0, 255];
        const BLUE: [u8; 4] = [0, 0, 255, 255];
        let mut img = RgbaImage::from_pixel(512, 512, Rgba(RED));
        for x in 0..512u32 {
            if (x / 8) % 2 == 1 {
                for y in 0..512u32 {
                    img.put_pixel(x, y, Rgba(BLUE));
                }
            }
        }
        let out = downscale_integer(&img, 32);
        assert_eq!(out.dimensions(), (32, 32));
        for p in out.pixels() {
            assert!(
                p.0 == RED || p.0 == BLUE,
                "invented a colour that was not in the source: {:?}",
                p.0
            );
        }
    }

    #[test]
    fn downscale_reproduces_aligned_blocks_exactly() {
        let mut img = RgbaImage::from_pixel(512, 512, Rgba([0, 0, 0, 255]));
        for by in 0..32u32 {
            for bx in 0..32u32 {
                let c = if (bx + by) % 2 == 0 {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 255, 255]
                };
                block(&mut img, bx * 16, by * 16, bx * 16 + 15, by * 16 + 15, c);
            }
        }
        let out = downscale_integer(&img, 32);
        for y in 0..32u32 {
            for x in 0..32u32 {
                let want = if (x + y) % 2 == 0 {
                    [255, 0, 0, 255]
                } else {
                    [0, 0, 255, 255]
                };
                assert_eq!(out.get_pixel(x, y).0, want, "at {x},{y}");
            }
        }
    }

    #[test]
    fn downscale_keeps_the_aspect_ratio_by_padding_to_a_square() {
        // Padding each axis to its own multiple would give different factors
        // and silently squash anything not already square.
        let mut img = RgbaImage::from_pixel(100, 50, Rgba([0, 0, 0, 0]));
        block(&mut img, 0, 0, 99, 49, [9, 9, 9, 255]);
        let out = downscale_integer(&img, 32);
        assert_eq!(out.dimensions(), (32, 32));
        // The content occupies a wide band, not the whole square.
        let opaque_rows: Vec<u32> = (0..32)
            .filter(|y| (0..32).any(|x| out.get_pixel(x, *y).0[3] != 0))
            .collect();
        assert!(opaque_rows.len() < 32, "content should not fill the square");
    }

    #[test]
    fn outline_is_exactly_the_requested_width() {
        let mut img = RgbaImage::from_pixel(16, 16, Rgba([0, 0, 0, 0]));
        block(&mut img, 6, 6, 9, 9, [200, 30, 30, 255]);
        normalize_outline(&mut img, 0x1A_1A_1A_FF, 2);
        // Two rings: row 4 is the outer edge of a 2px border around y=6.
        assert_eq!(img.get_pixel(7, 4).0, rgba(0x1A_1A_1A_FF));
        assert_eq!(img.get_pixel(7, 5).0, rgba(0x1A_1A_1A_FF));
        assert_eq!(img.get_pixel(7, 3).0[3], 0, "border must not be 3px");
    }

    #[test]
    fn the_key_colour_never_survives_into_the_palette() {
        // The order assertion. Keying after quantizing would snap the
        // background into the palette and then it could never be removed.
        let mut img = keyed(64, 64);
        block(&mut img, 16, 16, 47, 47, [20, 90, 40, 255]);
        let (out, _) = normalize(&img, &NormalizeProfile::default(), AssetKind::Sprite).unwrap();
        for p in out.pixels() {
            if p.0[3] == 0 {
                continue;
            }
            let [r, g, b, _] = p.0;
            assert!(!(r > 200 && g < 60 && b > 200), "key survived: {:?}", p.0);
        }
    }

    #[test]
    fn a_sprite_comes_out_cropped_outlined_and_the_right_size() {
        let mut img = keyed(64, 64);
        block(&mut img, 20, 20, 43, 43, [20, 90, 40, 255]);
        let (out, stats) =
            normalize(&img, &NormalizeProfile::default(), AssetKind::Sprite).unwrap();
        assert_eq!(out.dimensions(), (32, 32));
        assert!(stats.alpha > 0.0 && stats.alpha < 1.0);
        let has_outline = out.pixels().any(|p| pack(p.0) == 0x1A_1A_1A_FF);
        assert!(has_outline, "a sprite should get its border");
    }

    #[test]
    fn a_texture_is_neither_cropped_nor_outlined() {
        // Either would destroy the tiling it was generated for. This is the
        // failure that would be easiest to ship unnoticed: the output still
        // looks like a texture, and it stops tiling.
        let mut img = RgbaImage::from_pixel(64, 64, Rgba([90, 90, 90, 255]));
        block(&mut img, 0, 0, 31, 31, [120, 110, 100, 255]);
        let (out, stats) =
            normalize(&img, &NormalizeProfile::default(), AssetKind::Texture).unwrap();
        assert_eq!(out.dimensions(), (32, 32));
        assert_eq!(stats.alpha, 1.0, "a texture stays fully opaque");
        let has_outline = out.pixels().any(|p| pack(p.0) == 0x1A_1A_1A_FF);
        assert!(!has_outline, "a texture must not be outlined");
    }

    #[test]
    fn an_all_background_image_fails_rather_than_returning_a_blank() {
        let img = keyed(32, 32);
        let err = normalize(&img, &NormalizeProfile::default(), AssetKind::Sprite).unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn a_configured_palette_is_used_verbatim() {
        let p = NormalizeProfile {
            palette: vec![0x00_00_00_FF, 0xFF_FF_FF_FF],
            outline: Outline {
                enabled: false,
                ..NormalizeProfile::default().outline
            },
            ..Default::default()
        };
        let mut img = keyed(64, 64);
        block(&mut img, 16, 16, 47, 47, [200, 200, 200, 255]);
        let (out, _) = normalize(&img, &p, AssetKind::Sprite).unwrap();
        for px in out.pixels() {
            if px.0[3] == 0 {
                continue;
            }
            assert!(p.palette.contains(&pack([px.0[0], px.0[1], px.0[2], 255])));
        }
    }
}

/// Normalize a real generated image and write the result next to it.
///
/// Fixtures prove the arithmetic; they cannot tell you whether a 512px
/// diffusion output survives the pass and still reads as the thing it was.
/// Every bug found in the ComfyUI workflows was invisible to unit tests and
/// obvious the moment real bytes went through, so this exists to make that
/// check one command rather than a scratch script.
///
///   HARUSPEX_NORM_IN=/path/a.png HARUSPEX_NORM_KIND=sprite \
///     cargo test --lib normalize_a_real_image -- --ignored --nocapture
#[cfg(test)]
mod live {
    use super::super::profile::AssetKind;
    use super::*;

    #[test]
    #[ignore = "needs a real generated PNG; set HARUSPEX_NORM_IN"]
    fn normalize_a_real_image() {
        let Ok(path) = std::env::var("HARUSPEX_NORM_IN") else {
            eprintln!("set HARUSPEX_NORM_IN to a PNG");
            return;
        };
        let kind = match std::env::var("HARUSPEX_NORM_KIND").as_deref() {
            Ok("texture") => AssetKind::Texture,
            Ok("icon") => AssetKind::Icon,
            _ => AssetKind::Sprite,
        };
        let img = image::open(&path)
            .expect("could not read the input")
            .to_rgba8();
        let (out, stats) = normalize(&img, &NormalizeProfile::default(), kind)
            .unwrap_or_else(|e| panic!("normalize failed: {e}"));
        let dest = format!("{path}.normalized.png");
        out.save(&dest).expect("could not write the output");
        println!(
            "{} {:?} -> {} {}x{}  alpha {:.3}  entropy {:.2} bits  off-palette {:.3}",
            path,
            kind,
            dest,
            out.width(),
            out.height(),
            stats.alpha,
            stats.entropy,
            stats.palette_distance
        );
    }
}
