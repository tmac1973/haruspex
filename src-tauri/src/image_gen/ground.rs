//! Whether a set's sprites can be seen on the ground drawn for them.
//!
//! A sprite on a tile is read by its lightness against the tile's, far more
//! than by hue. Measured on a dark-fantasy run whose sprites were near-black
//! (OKLab lightness 0.22): on floors at 0.19 they vanished, on floors at 0.33
//! to 0.36 they read clearly. The recipe stage was offering the sprites' own
//! colours to the ground then, which is how the two came out alike.

use image::{imageops, Rgba, RgbaImage};
use serde::Serialize;

/// The smallest lightness gap between a sprite and the ground that still
/// reads. The run above: 0.03 vanished, 0.09 was hard work, 0.11 and over read.
pub const MIN_GAP: f32 = 0.10;

/// How far from the sprites the suggested ground sits: well past `MIN_GAP`,
/// so a recipe aimed at it lands clear of the line.
const TARGET_GAP: f32 = 0.25;

/// Pixels at least this opaque are the sprite; softer edges are left out.
const OPAQUE: u8 = 128;

/// The set's sprites' lightness, and the ground lightness to aim for.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SpriteTone {
    /// The median of the sprites' median OKLab lightness, 0 black to 1 white.
    pub lightness: f32,
    /// The ground lightness to aim for: lighter than dark sprites, darker
    /// than light ones.
    pub target: f32,
    /// A grey at `target`, packed `0xRRGGBBAA`, to name it to a model in hex.
    pub target_grey: u32,
}

/// One tile measured against the set's sprites.
#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GroundContrast {
    /// The tile's median OKLab lightness.
    pub ground: f32,
    /// Each sprite's median lightness, in the order given.
    pub sprites: Vec<f32>,
    /// Sprites within `MIN_GAP` of the ground.
    pub blending: u32,
    /// Which ones, in the order given.
    pub blends: Vec<bool>,
    /// True when no more than half the sprites blend in.
    pub ok: bool,
    pub tone: SpriteTone,
}

fn linear(c: u8) -> f32 {
    let c = c as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn encoded(l: f32) -> u8 {
    let c = if l <= 0.003_130_8 {
        12.92 * l
    } else {
        1.055 * l.powf(1.0 / 2.4) - 0.055
    };
    (c * 255.0).round().clamp(0.0, 255.0) as u8
}

/// OKLab lightness of an sRGB colour.
pub fn lightness(c: [u8; 4]) -> f32 {
    let (r, g, b) = (linear(c[0]), linear(c[1]), linear(c[2]));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s
}

/// The sRGB grey whose OKLab lightness is `l`, packed `0xRRGGBBAA`.
fn grey(l: f32) -> u32 {
    // A grey's OKLab lightness is the cube root of its linear value.
    let v = encoded(l.clamp(0.0, 1.0).powi(3)) as u32;
    (v << 24) | (v << 16) | (v << 8) | 0xff
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    Some(v[v.len() / 2])
}

/// The median lightness of an image's opaque pixels; None when it has none.
pub fn median_lightness(img: &RgbaImage) -> Option<f32> {
    median(
        img.pixels()
            .filter(|p| p.0[3] >= OPAQUE)
            .map(|p| lightness(p.0))
            .collect(),
    )
}

fn tone_of(lights: &[f32]) -> Option<SpriteTone> {
    let lightness = median(lights.to_vec())?;
    let target = if lightness < 0.5 {
        (lightness + TARGET_GAP).min(0.95)
    } else {
        (lightness - TARGET_GAP).max(0.05)
    };
    Some(SpriteTone {
        lightness,
        target,
        target_grey: grey(target),
    })
}

/// The tone of a set of sprites; None when none has an opaque pixel.
pub fn sprite_tone(sprites: &[RgbaImage]) -> Option<SpriteTone> {
    let lights: Vec<f32> = sprites.iter().filter_map(median_lightness).collect();
    tone_of(&lights)
}

/// How a tile measures against the sprites; None when either side is empty.
pub fn ground_contrast(tile: &RgbaImage, sprites: &[RgbaImage]) -> Option<GroundContrast> {
    let ground = median_lightness(tile)?;
    let lights: Vec<f32> = sprites.iter().filter_map(median_lightness).collect();
    let tone = tone_of(&lights)?;
    let blends: Vec<bool> = lights
        .iter()
        .map(|l| (l - ground).abs() < MIN_GAP)
        .collect();
    let blending = blends.iter().filter(|b| **b).count() as u32;
    Some(GroundContrast {
        ground,
        ok: blending * 2 <= lights.len() as u32,
        sprites: lights,
        blending,
        blends,
        tone,
    })
}

/// Cells of the 3×3 preview a sprite stands in: the diagonal, so six cells
/// still show the bare tile and what repeats.
const SPRITE_CELLS: [(u32, u32); 3] = [(0, 0), (1, 1), (2, 2)];

/// The tile laid 3×3 at `scale`, with up to three sprites stood on it, each
/// fitted inside its cell the way a game draws a sprite one tile big.
pub fn ground_preview(tile: &RgbaImage, scale: u32, sprites: &[RgbaImage]) -> RgbaImage {
    let scale = scale.max(1);
    let cell_w = tile.width() * scale;
    let cell_h = tile.height() * scale;
    let big = imageops::resize(tile, cell_w, cell_h, imageops::FilterType::Nearest);
    let mut out = RgbaImage::from_pixel(cell_w * 3, cell_h * 3, Rgba([0, 0, 0, 255]));
    for row in 0..3 {
        for col in 0..3 {
            imageops::replace(&mut out, &big, (col * cell_w) as i64, (row * cell_h) as i64);
        }
    }
    for (sprite, (col, row)) in sprites.iter().zip(SPRITE_CELLS) {
        if sprite.width() == 0 || sprite.height() == 0 {
            continue;
        }
        let fit = (cell_w as f32 * 0.9 / sprite.width() as f32)
            .min(cell_h as f32 * 0.9 / sprite.height() as f32);
        let w = ((sprite.width() as f32 * fit).round() as u32).max(1);
        let h = ((sprite.height() as f32 * fit).round() as u32).max(1);
        let small = imageops::resize(sprite, w, h, imageops::FilterType::Triangle);
        let x = col * cell_w + (cell_w - w) / 2;
        let y = row * cell_h + (cell_h - h) / 2;
        imageops::overlay(&mut out, &small, x as i64, y as i64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    /// A sprite: an opaque square in a transparent frame.
    fn sprite(c: [u8; 3]) -> RgbaImage {
        let mut img = solid(16, 16, [0, 0, 0, 0]);
        for y in 4..12 {
            for x in 4..12 {
                img.put_pixel(x, y, Rgba([c[0], c[1], c[2], 255]));
            }
        }
        img
    }

    #[test]
    fn lightness_runs_black_to_white() {
        assert!(lightness([0, 0, 0, 255]).abs() < 1e-3);
        assert!((lightness([255, 255, 255, 255]) - 1.0).abs() < 1e-3);
        // Green reads lighter than blue at the same channel value.
        assert!(lightness([0, 200, 0, 255]) > lightness([0, 0, 200, 255]));
    }

    #[test]
    fn grey_round_trips_its_lightness() {
        for l in [0.2_f32, 0.47, 0.8] {
            let c = grey(l).to_be_bytes();
            assert!((lightness(c) - l).abs() < 0.01, "{l}");
        }
    }

    #[test]
    fn transparent_pixels_are_not_the_sprite() {
        let s = sprite([255, 255, 255]);
        assert!((median_lightness(&s).unwrap() - 1.0).abs() < 1e-3);
        assert_eq!(median_lightness(&solid(4, 4, [9, 9, 9, 0])), None);
    }

    #[test]
    fn dark_sprites_on_dark_ground_blend() {
        let sprites = [
            sprite([40, 36, 38]),
            sprite([30, 30, 30]),
            sprite([50, 45, 40]),
        ];
        let floor = solid(32, 32, [34, 33, 33, 255]);
        let c = ground_contrast(&floor, &sprites).unwrap();
        assert_eq!(c.blending, 3);
        assert!(!c.ok);
        // Dark sprites ask for lighter ground.
        assert!(c.tone.target > c.tone.lightness + MIN_GAP);
        let lighter = solid(32, 32, [110, 108, 104, 255]);
        let c = ground_contrast(&lighter, &sprites).unwrap();
        assert_eq!(c.blending, 0);
        assert!(c.ok);
    }

    #[test]
    fn light_sprites_ask_for_darker_ground() {
        let tone = sprite_tone(&[sprite([230, 220, 200]), sprite([250, 250, 240])]).unwrap();
        assert!(tone.target < tone.lightness - MIN_GAP);
    }

    #[test]
    fn half_blending_still_passes() {
        let sprites = [sprite([30, 30, 30]), sprite([230, 230, 230])];
        let c = ground_contrast(&solid(8, 8, [30, 30, 30, 255]), &sprites).unwrap();
        assert_eq!(c.blending, 1);
        assert_eq!(c.blends, vec![true, false]);
        assert!(c.ok);
    }

    #[test]
    fn preview_stands_sprites_on_the_diagonal() {
        let tile = solid(8, 8, [100, 100, 100, 255]);
        let red = sprite([255, 0, 0]);
        let out = ground_preview(&tile, 4, &[red.clone(), red]);
        assert_eq!(out.dimensions(), (96, 96));
        // The first two diagonal cells' centres are sprite, the third bare.
        assert_eq!(out.get_pixel(16, 16).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(48, 48).0, [255, 0, 0, 255]);
        assert_eq!(out.get_pixel(80, 80).0, [100, 100, 100, 255]);
        // An off-diagonal cell is the bare tile.
        assert_eq!(out.get_pixel(48, 16).0, [100, 100, 100, 255]);
    }
}
