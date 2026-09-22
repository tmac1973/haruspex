//! Extracting a shared palette, and snapping an image to one.
//!
//! This is the layer that makes a set look like a set. Reference conditioning
//! gets a generation into the right neighbourhood; forcing every asset through
//! the same sixteen colours is what actually makes forty sprites look like one
//! game, and it works whether or not the backend could condition at all.

use image::RgbaImage;

use super::profile::{
    hue_saturation, pack, rgba, PALETTE_DISTANCE_CUTOFF, PALETTE_GREY_SATURATION,
};

/// Perceptually weighted squared distance. Green dominates luminance, so a
/// plain Euclidean metric over-values blue and picks visibly wrong entries.
fn distance_sq(a: [u8; 4], b: [u8; 4]) -> f32 {
    let dr = a[0] as f32 - b[0] as f32;
    let dg = a[1] as f32 - b[1] as f32;
    let db = a[2] as f32 - b[2] as f32;
    0.30 * dr * dr + 0.59 * dg * dg + 0.11 * db * db
}

fn luminance(c: [u8; 4]) -> f32 {
    0.2126 * c[0] as f32 + 0.7152 * c[1] as f32 + 0.0722 * c[2] as f32
}

/// Extract `n` colours by median cut, skipping transparent pixels and anything
/// within `tolerance` of `exclude`.
///
/// `exclude` is the chroma key. It must never enter the palette: keying
/// happens per entry later, and a palette containing the key colour would snap
/// real pixels onto it and punch holes in the subject.
///
/// Returned sorted by luminance, so the same input always gives the same
/// ordered palette and a committed one is diffable.
pub fn extract_palette(img: &RgbaImage, n: u32, exclude: Option<(u32, u8)>) -> Vec<u32> {
    let n = n.max(1) as usize;
    let mut pixels: Vec<[u8; 4]> = Vec::new();
    for p in img.pixels() {
        let c = p.0;
        if c[3] == 0 {
            continue;
        }
        if let Some((key, tol)) = exclude {
            let k = rgba(key);
            let d = ((c[0] as f32 - k[0] as f32).powi(2)
                + (c[1] as f32 - k[1] as f32).powi(2)
                + (c[2] as f32 - k[2] as f32).powi(2))
            .sqrt();
            if d <= tol as f32 {
                continue;
            }
        }
        pixels.push(c);
    }
    if pixels.is_empty() {
        return Vec::new();
    }

    let mut boxes: Vec<Vec<[u8; 4]>> = vec![pixels];
    while boxes.len() < n {
        // Split the box with the widest single-channel spread; that is the one
        // whose colours are least well described by one average.
        let Some((idx, channel)) = boxes
            .iter()
            .enumerate()
            .filter(|(_, b)| b.len() > 1)
            .map(|(i, b)| {
                let mut best = (0usize, 0u8);
                for ch in 0..3 {
                    let mut lo = 255u8;
                    let mut hi = 0u8;
                    for c in b {
                        lo = lo.min(c[ch]);
                        hi = hi.max(c[ch]);
                    }
                    let spread = hi - lo;
                    if spread >= best.1 {
                        best = (ch, spread);
                    }
                }
                (i, best.0, best.1)
            })
            .max_by_key(|(_, _, spread)| *spread)
            .map(|(i, ch, _)| (i, ch))
        else {
            break;
        };

        let mut b = boxes.swap_remove(idx);
        b.sort_by_key(|c| c[channel]);
        let mid = b.len() / 2;
        let right = b.split_off(mid);
        boxes.push(b);
        boxes.push(right);
    }

    let mut out: Vec<u32> = boxes
        .into_iter()
        .filter(|b| !b.is_empty())
        .map(|b| {
            let len = b.len() as u32;
            let sum = b.iter().fold([0u32; 3], |mut acc, c| {
                acc[0] += c[0] as u32;
                acc[1] += c[1] as u32;
                acc[2] += c[2] as u32;
                acc
            });
            pack([
                (sum[0] / len) as u8,
                (sum[1] / len) as u8,
                (sum[2] / len) as u8,
                255,
            ])
        })
        .collect();
    out.sort_by(|a, b| {
        luminance(rgba(*a))
            .partial_cmp(&luminance(rgba(*b)))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    out.dedup();
    out
}

/// How spread out a palette's hues are.
///
/// Returns the fraction of entries in the single most populated hue bucket,
/// and how many buckets have anything in them. Twelve 30-degree buckets;
/// greys are excluded, because a deliberately desaturated palette is a style
/// rather than a collapse.
///
/// This exists because the anchor's palette is imposed on every asset in the
/// set. One that has collapsed onto a single hue does not make the set
/// cohere, it makes every asset that colour — and nothing downstream can
/// recover, because quantization has by then thrown the evidence away.
pub fn hue_spread(palette: &[u32]) -> (f32, usize) {
    if palette.is_empty() {
        return (0.0, 0);
    }
    let mut buckets = [0u32; 12];
    for c in palette {
        let (h, s) = hue_saturation(rgba(*c));
        if s < PALETTE_GREY_SATURATION {
            continue;
        }
        buckets[((h / 30.0) as usize).min(11)] += 1;
    }
    let top = *buckets.iter().max().unwrap_or(&0);
    let used = buckets.iter().filter(|b| **b > 0).count();
    (top as f32 / palette.len() as f32, used)
}

/// Snap every pixel to its nearest palette entry.
///
/// Returns the fraction of opaque pixels that were further than
/// [`PALETTE_DISTANCE_CUTOFF`] from the entry they were snapped to. That
/// number is only knowable here, before snapping — afterwards the evidence is
/// gone — which is why the quality gate is handed a measurement rather than
/// asked to re-derive one from the output.
///
/// No dithering. Dithering is how you keep detail through a palette reduction,
/// and detail is exactly what defeats the uniformity this exists to create.
pub fn quantize_to(img: &mut RgbaImage, palette: &[u32]) -> f32 {
    if palette.is_empty() {
        return 0.0;
    }
    let entries: Vec<[u8; 4]> = palette.iter().map(|p| rgba(*p)).collect();
    let cutoff_sq = PALETTE_DISTANCE_CUTOFF * PALETTE_DISTANCE_CUTOFF;
    let mut opaque = 0u64;
    let mut far = 0u64;
    for p in img.pixels_mut() {
        if p.0[3] == 0 {
            continue;
        }
        opaque += 1;
        let mut best = 0usize;
        let mut best_d = f32::MAX;
        for (i, e) in entries.iter().enumerate() {
            let d = distance_sq(p.0, *e);
            if d < best_d {
                best_d = d;
                best = i;
            }
        }
        // The cutoff is plain RGB distance, so compare against an unweighted
        // measure rather than the weighted one used for choosing.
        let chosen = entries[best];
        let plain = (p.0[0] as f32 - chosen[0] as f32).powi(2)
            + (p.0[1] as f32 - chosen[1] as f32).powi(2)
            + (p.0[2] as f32 - chosen[2] as f32).powi(2);
        if plain > cutoff_sq {
            far += 1;
        }
        let alpha = p.0[3];
        p.0 = [chosen[0], chosen[1], chosen[2], alpha];
    }
    if opaque == 0 {
        0.0
    } else {
        far as f32 / opaque as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    #[test]
    fn extraction_is_deterministic_for_the_same_input() {
        let mut img = solid(8, 8, [10, 200, 30, 255]);
        img.put_pixel(0, 0, Rgba([200, 10, 10, 255]));
        img.put_pixel(1, 0, Rgba([10, 10, 200, 255]));
        let a = extract_palette(&img, 4, None);
        let b = extract_palette(&img, 4, None);
        assert_eq!(a, b);
        assert!(!a.is_empty());
    }

    #[test]
    fn extraction_is_sorted_by_luminance() {
        let mut img = solid(4, 4, [0, 0, 0, 255]);
        img.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        img.put_pixel(1, 0, Rgba([128, 128, 128, 255]));
        let p = extract_palette(&img, 3, None);
        let lums: Vec<f32> = p.iter().map(|c| luminance(rgba(*c))).collect();
        assert!(lums.windows(2).all(|w| w[0] <= w[1]), "{lums:?}");
    }

    #[test]
    fn extraction_skips_the_chroma_key() {
        // Keying happens per entry later; a palette holding the key colour
        // would snap real pixels onto it and punch holes in the subject.
        let mut img = solid(8, 8, [0xFF, 0x00, 0xFF, 255]);
        for x in 0..4 {
            img.put_pixel(x, 0, Rgba([20, 90, 40, 255]));
        }
        let p = extract_palette(&img, 4, Some((0xFF_00_FF_FF, 40)));
        for c in &p {
            let [r, g, b, _] = rgba(*c);
            assert!(!(r > 200 && g < 60 && b > 200), "key leaked in: {c:08X}");
        }
    }

    #[test]
    fn extraction_skips_transparent_pixels() {
        let img = solid(4, 4, [10, 10, 10, 0]);
        assert!(extract_palette(&img, 4, None).is_empty());
    }

    #[test]
    fn a_collapsed_palette_is_reported_as_one_hue() {
        // The failure this exists for: an anchor that rendered a scene had
        // its ground keyed away as background, leaving foliage, and 31 of 32
        // entries came back green. Every asset was then quantized into it,
        // and a shopping cart came out as a bush.
        let greens: Vec<u32> = (0..16)
            .map(|i| pack([0x20 + i * 4, 0x70 + i * 6, 0x20 + i * 3, 255]))
            .collect();
        let (dominant, used) = hue_spread(&greens);
        assert!(dominant > 0.6, "dominant {dominant}");
        assert!(used <= 2, "used {used}");
    }

    #[test]
    fn a_varied_palette_is_reported_as_spread_out() {
        let mixed = vec![
            pack([0xc0, 0x30, 0x30, 255]),
            pack([0xc0, 0x90, 0x30, 255]),
            pack([0xb0, 0xc0, 0x30, 255]),
            pack([0x30, 0xc0, 0x50, 255]),
            pack([0x30, 0xb0, 0xc0, 255]),
            pack([0x30, 0x40, 0xc0, 255]),
            pack([0x90, 0x30, 0xc0, 255]),
            pack([0xc0, 0x30, 0x90, 255]),
        ];
        let (dominant, used) = hue_spread(&mixed);
        assert!(dominant <= 0.3, "dominant {dominant}");
        assert!(used >= 6, "used {used}");
    }

    #[test]
    fn a_desaturated_palette_is_not_a_collapsed_one() {
        // "Cold concrete greys, dusty beige" is a style, not a failure.
        // Counting greys as one enormous hue bucket would reject it.
        let greys: Vec<u32> = (0..12)
            .map(|i| {
                let v = 0x20 + i * 16;
                pack([v, v, v, 255])
            })
            .collect();
        let (dominant, used) = hue_spread(&greys);
        assert_eq!(dominant, 0.0, "greys must not count toward any hue");
        assert_eq!(used, 0);
    }

    #[test]
    fn an_empty_palette_reports_nothing_rather_than_dividing_by_zero() {
        assert_eq!(hue_spread(&[]), (0.0, 0));
    }

    #[test]
    fn quantize_maps_every_pixel_into_the_palette_and_keeps_alpha() {
        let palette = vec![0x00_00_00_FF, 0xFF_FF_FF_FF];
        let mut img = solid(4, 4, [200, 200, 200, 128]);
        quantize_to(&mut img, &palette);
        for p in img.pixels() {
            assert!(palette.contains(&pack([p.0[0], p.0[1], p.0[2], 255])));
            assert_eq!(p.0[3], 128, "alpha must survive quantization");
        }
    }

    #[test]
    fn quantize_reports_zero_distance_for_in_palette_input() {
        let palette = vec![0x10_20_30_FF];
        let mut img = solid(4, 4, [0x10, 0x20, 0x30, 255]);
        assert_eq!(quantize_to(&mut img, &palette), 0.0);
    }

    #[test]
    fn quantize_reports_high_distance_for_off_palette_input() {
        // The failure a palette-only design would otherwise hide: the output
        // is perfectly in-palette and the generation was nothing like it.
        let palette = vec![0x00_00_00_FF];
        let mut img = solid(4, 4, [255, 255, 255, 255]);
        assert_eq!(quantize_to(&mut img, &palette), 1.0);
    }

    #[test]
    fn quantize_with_no_palette_leaves_the_image_alone() {
        let before = solid(4, 4, [1, 2, 3, 255]);
        let mut img = before.clone();
        assert_eq!(quantize_to(&mut img, &[]), 0.0);
        assert_eq!(img.as_raw(), before.as_raw());
    }

    #[test]
    fn nearest_entry_is_chosen_by_a_luminance_weighted_metric() {
        // Plain Euclidean would pick the blue; green carries the luminance.
        let palette = vec![0x00_00_FF_FF, 0x00_FF_00_FF];
        let mut img = solid(1, 1, [0, 200, 60, 255]);
        quantize_to(&mut img, &palette);
        assert_eq!(pack(img.get_pixel(0, 0).0), 0x00_FF_00_FF);
    }
}
