//! Editing part of a picture, or past its edges: the canvas an edit runs on,
//! the mask that says where it may change, and the paste-back that holds it
//! to that.
//!
//! The chat model names a rectangle (`Area`) or how far to grow each side
//! (`Extend`), as fractions of the picture, since it can't paint a mask.
//! Backends that take a mask are sent this one; every edit, on every backend,
//! is then pasted back over the canvas through it, so pixels outside it are
//! the original's even on an edit model that redraws the whole picture.

use image::imageops::FilterType;
use image::{GrayImage, Luma, RgbaImage};
use serde::Deserialize;

/// The largest edge an extended canvas may have.
pub const MAX_EDGE: u32 = 4096;

/// A rectangle to change, as fractions of the picture (0–1).
#[derive(Clone, Copy, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct MaskArea {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// How far to grow each side, as fractions of the picture's own size (0–1).
#[derive(Clone, Copy, Debug, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct MaskExtend {
    #[serde(default)]
    pub left: f32,
    #[serde(default)]
    pub right: f32,
    #[serde(default)]
    pub top: f32,
    #[serde(default)]
    pub bottom: f32,
}

pub struct Prepared {
    pub canvas: RgbaImage,
    pub mask: GrayImage,
}

/// A rectangle in pixels: left, top, right, bottom (exclusive).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    l: u32,
    t: u32,
    r: u32,
    b: u32,
}

fn fraction(v: f32, what: &str) -> Result<f32, String> {
    if v.is_finite() && (0.0..=1.0).contains(&v) {
        Ok(v)
    } else {
        Err(format!("{what} must be between 0 and 1."))
    }
}

/// The soft edge, in pixels: wide enough to hide the seam, narrow enough to
/// keep the change where it was asked for.
fn feather(width: u32, height: u32) -> f32 {
    (width.min(height) as f32 * 0.04).round().max(8.0)
}

/// 0 at the edge of the soft band, 1 at its far side, eased.
fn ease(d: f32, band: f32) -> f32 {
    let t = (1.0 - d / band).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The canvas and mask for an edit of `src`: `extend` grows the canvas, its
/// new strips filled with the picture's edges blurred outward (colour for the
/// model to continue from); `area` is a rectangle of the picture to change.
/// One of the two must be given; both may.
pub fn prepare(
    src: &RgbaImage,
    area: Option<MaskArea>,
    extend: Option<MaskExtend>,
) -> Result<Prepared, String> {
    if area.is_none() && extend.is_none() {
        return Err("Give an area to change or how far to extend.".into());
    }
    let (w, h) = src.dimensions();
    let ext = extend.unwrap_or_default();
    let side = |v: f32, of: u32, what: &str| -> Result<u32, String> {
        Ok((fraction(v, what)? * of as f32).round() as u32)
    };
    let (l, r) = (side(ext.left, w, "left")?, side(ext.right, w, "right")?);
    let (t, b) = (side(ext.top, h, "top")?, side(ext.bottom, h, "bottom")?);
    let (cw, ch) = (w + l + r, h + t + b);
    if cw > MAX_EDGE || ch > MAX_EDGE {
        return Err(format!(
            "Extended, the picture would be {cw}×{ch}; at most {MAX_EDGE} a side."
        ));
    }
    let original = Rect {
        l,
        t,
        r: l + w,
        b: t + h,
    };
    let area = match area {
        Some(a) => {
            let (x, y) = (fraction(a.x, "x")?, fraction(a.y, "y")?);
            let (aw, ah) = (fraction(a.width, "width")?, fraction(a.height, "height")?);
            let px = |f: f32, of: u32| (f * of as f32).round() as u32;
            let rect = Rect {
                l: l + px(x, w),
                t: t + px(y, h),
                r: l + px((x + aw).min(1.0), w),
                b: t + px((y + ah).min(1.0), h),
            };
            if rect.r <= rect.l || rect.b <= rect.t {
                return Err("The area to change is empty.".into());
            }
            Some(rect)
        }
        None => None,
    };

    let canvas = if (l, r, t, b) == (0, 0, 0, 0) {
        src.clone()
    } else {
        extended_canvas(src, cw, ch, l, t)
    };

    let band = feather(cw, ch);
    let grown = [l > 0, r > 0, t > 0, b > 0];
    let mask = GrayImage::from_fn(cw, ch, |x, y| {
        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
        let mut m: f32 = 0.0;
        if let Some(a) = area {
            // Fully changeable inside, fading out over the band around it.
            let dx = (a.l as f32 - fx).max(fx - a.r as f32).max(0.0);
            let dy = (a.t as f32 - fy).max(fy - a.b as f32).max(0.0);
            m = m.max(ease((dx * dx + dy * dy).sqrt(), band));
        }
        if grown.iter().any(|g| *g) {
            let o = original;
            let inside = x >= o.l && x < o.r && y >= o.t && y < o.b;
            if !inside {
                m = 1.0;
            } else {
                // Inside the picture, fading in from each side that grew.
                let edges = [
                    (grown[0], fx - o.l as f32),
                    (grown[1], o.r as f32 - fx),
                    (grown[2], fy - o.t as f32),
                    (grown[3], o.b as f32 - fy),
                ];
                for (g, d) in edges {
                    if g {
                        m = m.max(ease(d, band));
                    }
                }
            }
        }
        Luma([(m * 255.0).round() as u8])
    });
    Ok(Prepared { canvas, mask })
}

/// `src` placed at (`l`, `t`) on a `cw`×`ch` canvas, the rest its nearest
/// edge pixels blurred: blurred at an eighth of the size, which is as soft
/// and much quicker.
fn extended_canvas(src: &RgbaImage, cw: u32, ch: u32, l: u32, t: u32) -> RgbaImage {
    let (w, h) = src.dimensions();
    let clamped = RgbaImage::from_fn(cw, ch, |x, y| {
        let sx = (x as i64 - l as i64).clamp(0, w as i64 - 1) as u32;
        let sy = (y as i64 - t as i64).clamp(0, h as i64 - 1) as u32;
        *src.get_pixel(sx, sy)
    });
    let small = image::imageops::resize(
        &clamped,
        (cw / 8).max(1),
        (ch / 8).max(1),
        FilterType::Triangle,
    );
    let blurred = image::imageops::blur(&small, 3.0);
    let mut canvas = image::imageops::resize(&blurred, cw, ch, FilterType::Triangle);
    image::imageops::replace(&mut canvas, src, l as i64, t as i64);
    canvas
}

/// The edit pasted over `canvas` through `mask`: the model's pixels where the
/// mask is white, the canvas's where it is black, blended between. The edit is
/// scaled to the canvas first, since a model returns the size it likes.
pub fn composite(canvas: &RgbaImage, edited: &RgbaImage, mask: &GrayImage) -> RgbaImage {
    let (w, h) = canvas.dimensions();
    let edited = if edited.dimensions() == (w, h) {
        edited.clone()
    } else {
        image::imageops::resize(edited, w, h, FilterType::Lanczos3)
    };
    let mask = if mask.dimensions() == (w, h) {
        mask.clone()
    } else {
        image::imageops::resize(mask, w, h, FilterType::Triangle)
    };
    RgbaImage::from_fn(w, h, |x, y| {
        let m = mask.get_pixel(x, y).0[0] as u32;
        let (a, b) = (canvas.get_pixel(x, y).0, edited.get_pixel(x, y).0);
        let mix = |i: usize| ((a[i] as u32 * (255 - m) + b[i] as u32 * m + 127) / 255) as u8;
        image::Rgba([mix(0), mix(1), mix(2), mix(3)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    fn area(x: f32, y: f32, w: f32, h: f32) -> Option<MaskArea> {
        Some(MaskArea {
            x,
            y,
            width: w,
            height: h,
        })
    }

    #[test]
    fn an_area_is_white_inside_black_far_outside_and_soft_between() {
        let p = prepare(
            &solid(400, 400, [9, 9, 9, 255]),
            area(0.25, 0.25, 0.5, 0.5),
            None,
        )
        .unwrap();
        assert_eq!(p.canvas.dimensions(), (400, 400));
        assert_eq!(p.mask.get_pixel(200, 200).0[0], 255);
        assert_eq!(p.mask.get_pixel(100, 200).0[0], 255);
        assert_eq!(p.mask.get_pixel(10, 10).0[0], 0);
        // The band (16 px here) fades out just outside the rectangle.
        let edge = p.mask.get_pixel(92, 200).0[0];
        assert!(edge > 0 && edge < 255, "{edge}");
        assert_eq!(p.mask.get_pixel(80, 200).0[0], 0);
    }

    #[test]
    fn extending_grows_the_canvas_and_masks_the_new_strip_and_a_seam() {
        let src = solid(200, 100, [200, 10, 10, 255]);
        let ext = MaskExtend {
            right: 0.5,
            ..Default::default()
        };
        let p = prepare(&src, None, Some(ext)).unwrap();
        assert_eq!(p.canvas.dimensions(), (300, 100));
        // The picture itself is untouched on the canvas, and its edge colour
        // carries into the new strip.
        assert_eq!(p.canvas.get_pixel(10, 50).0, [200, 10, 10, 255]);
        assert_eq!(p.canvas.get_pixel(290, 50).0, [200, 10, 10, 255]);
        assert_eq!(p.mask.get_pixel(250, 50).0[0], 255);
        assert_eq!(p.mask.get_pixel(10, 50).0[0], 0);
        // Fading in from the side that grew, not from the others.
        let seam = p.mask.get_pixel(196, 50).0[0];
        assert!(seam > 0 && seam < 255, "{seam}");
        assert_eq!(p.mask.get_pixel(100, 2).0[0], 0);
    }

    #[test]
    fn refuses_nonsense() {
        let src = solid(10, 10, [0; 4]);
        assert!(prepare(&src, None, None).is_err());
        assert!(prepare(&src, area(0.5, 0.5, 0.0, 0.2), None).is_err());
        assert!(prepare(&src, area(-0.1, 0.0, 0.5, 0.5), None).is_err());
        let huge = MaskExtend {
            left: 1.0,
            right: 1.0,
            ..Default::default()
        };
        assert!(prepare(&solid(2000, 10, [0; 4]), None, Some(huge)).is_err());
    }

    #[test]
    fn the_paste_back_keeps_the_original_outside_the_mask() {
        let canvas = solid(100, 100, [10, 20, 30, 255]);
        // A model's answer at another size, all of it changed.
        let edited = solid(64, 64, [250, 250, 250, 255]);
        let p = prepare(&canvas, area(0.5, 0.0, 0.5, 1.0), None).unwrap();
        let out = composite(&canvas, &edited, &p.mask);
        assert_eq!(out.dimensions(), (100, 100));
        assert_eq!(out.get_pixel(5, 50).0, [10, 20, 30, 255]);
        assert_eq!(out.get_pixel(90, 50).0, [250, 250, 250, 255]);
        let mid = out.get_pixel(46, 50).0[0];
        assert!(mid > 10 && mid < 250, "{mid}");
    }
}
