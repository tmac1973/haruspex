//! What normalization measured on its way past.
//!
//! These numbers exist because the quality gate cannot re-derive them.
//! `palette_distance` is only knowable during quantization — afterwards every
//! pixel is in the palette by construction — so the gate is handed a
//! measurement and compares it to a threshold rather than re-opening an image
//! whose evidence has already been destroyed.

use image::RgbaImage;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageStats {
    /// Fraction of pixels that are not fully transparent.
    pub alpha: f32,
    /// Shannon entropy over the output's colours, in bits per pixel.
    pub entropy: f32,
    /// Fraction of opaque pixels that were off-palette before snapping.
    pub palette_distance: f32,
}

/// Shannon entropy of the SUBJECT's colour histogram, in bits.
///
/// Over a 16-colour palette the ceiling is 4 bits, reached when every colour
/// is equally common. A flat grey generation — the most frequent bad output a
/// model produces — scores near zero, which is what the gate's floor catches.
///
/// Transparent pixels are excluded entirely rather than counted as one
/// bucket. Counting them measures "how varied is the canvas", and a correctly
/// keyed sprite is mostly canvas: a perfectly good sword came out at 1.07
/// bits and would have been rejected for the crime of having its background
/// removed. What the check is for is whether the SUBJECT has any content, so
/// the subject is what it measures.
pub fn entropy_bits(img: &RgbaImage) -> f32 {
    let mut counts: Vec<(u32, u32)> = Vec::new();
    let mut total = 0u32;
    for p in img.pixels() {
        if p.0[3] == 0 {
            continue;
        }
        let key = ((p.0[0] as u32) << 24) | ((p.0[1] as u32) << 16) | ((p.0[2] as u32) << 8) | 0xFF;
        match counts.iter_mut().find(|(k, _)| *k == key) {
            Some((_, n)) => *n += 1,
            None => counts.push((key, 1)),
        }
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    let total = total as f32;
    -counts
        .iter()
        .map(|(_, n)| {
            let p = *n as f32 / total;
            p * p.log2()
        })
        .sum::<f32>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    #[test]
    fn a_flat_image_has_no_entropy() {
        let img = RgbaImage::from_pixel(8, 8, Rgba([128, 128, 128, 255]));
        assert_eq!(entropy_bits(&img), 0.0);
    }

    #[test]
    fn two_equally_common_colours_are_one_bit() {
        let mut img = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        for x in 0..4 {
            for y in 0..2 {
                img.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        assert!((entropy_bits(&img) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn transparent_pixels_are_ignored_entirely() {
        // Not counted as a bucket: a keyed sprite is mostly transparent, and
        // counting the background crushes the score of a perfectly good
        // sprite for the crime of having had its background removed.
        let mut small = RgbaImage::from_pixel(32, 32, Rgba([0, 0, 0, 0]));
        let mut big = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 0]));
        for (img, side) in [(&mut small, 32u32), (&mut big, 4u32)] {
            let _ = side;
            img.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
            img.put_pixel(1, 0, Rgba([0, 0, 255, 255]));
        }
        // Same subject, wildly different amounts of background: same score.
        assert!((entropy_bits(&small) - entropy_bits(&big)).abs() < 1e-5);
        assert!((entropy_bits(&small) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn a_fully_transparent_image_scores_zero() {
        let img = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 0]));
        assert_eq!(entropy_bits(&img), 0.0);
    }

    #[test]
    fn an_empty_image_scores_zero_rather_than_panicking() {
        assert_eq!(entropy_bits(&RgbaImage::new(0, 0)), 0.0);
    }
}
