//! YouTube thumbnails: 1280×720 JPEG under 2 MB, from any picture.

use image::{imageops, DynamicImage, Rgb, RgbImage};
use std::io::Cursor;

pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;
/// YouTube's limit is 2 MB; a little under it.
pub const MAX_BYTES: usize = 2_000_000;

/// Fill 16:9 and crop the overflow (`cover`), or fit inside and pad with black
/// (`contain`).
pub fn fit(img: &DynamicImage, contain: bool) -> RgbImage {
    let src = img.to_rgb8();
    let (w, h) = (src.width().max(1) as f64, src.height().max(1) as f64);
    let scale = if contain {
        (WIDTH as f64 / w).min(HEIGHT as f64 / h)
    } else {
        (WIDTH as f64 / w).max(HEIGHT as f64 / h)
    };
    let (sw, sh) = (
        ((w * scale).round() as u32).max(1),
        ((h * scale).round() as u32).max(1),
    );
    let scaled = imageops::resize(&src, sw, sh, imageops::FilterType::Lanczos3);
    let mut out = RgbImage::from_pixel(WIDTH, HEIGHT, Rgb([0, 0, 0]));
    let x = (WIDTH as i64 - sw as i64) / 2;
    let y = (HEIGHT as i64 - sh as i64) / 2;
    imageops::overlay(&mut out, &scaled, x, y);
    out
}

/// JPEG at the best quality from 90 down to 60 that fits under `MAX_BYTES`.
pub fn encode(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut last = Vec::new();
    for quality in (60..=90).rev().step_by(5) {
        let mut out = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(img)
            .map_err(|e| format!("can't encode the thumbnail: {e}"))?;
        last = out.into_inner();
        if last.len() <= MAX_BYTES {
            return Ok(last);
        }
    }
    if last.len() <= MAX_BYTES {
        Ok(last)
    } else {
        Err("The thumbnail is over 2 MB even at low quality.".into())
    }
}

/// Any picture's bytes as a thumbnail's.
pub fn make(bytes: &[u8], contain: bool) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("not a picture: {e}"))?;
    encode(&fit(&img, contain))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        }))
    }

    #[test]
    fn every_shape_comes_out_1280_by_720() {
        for (w, h) in [(640, 480), (1920, 1080), (1080, 1920), (2560, 1080)] {
            for contain in [false, true] {
                let out = fit(&picture(w, h), contain);
                assert_eq!(
                    (out.width(), out.height()),
                    (WIDTH, HEIGHT),
                    "{w}×{h} {contain}"
                );
            }
        }
    }

    #[test]
    fn contain_pads_a_portrait_picture_and_cover_fills_it() {
        let portrait = picture(1080, 1920);
        assert_eq!(fit(&portrait, true).get_pixel(5, 360), &Rgb([0, 0, 0]));
        assert_ne!(fit(&portrait, false).get_pixel(5, 360), &Rgb([0, 0, 0]));
    }

    #[test]
    fn noisy_pictures_still_fit_under_two_megabytes() {
        let mut seed = 7u32;
        let noisy = RgbImage::from_fn(3840, 2160, |_, _| {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let b = seed.to_le_bytes();
            Rgb([b[0], b[1], b[2]])
        });
        let jpeg = encode(&fit(&DynamicImage::ImageRgb8(noisy), false)).unwrap();
        assert!(jpeg.len() <= MAX_BYTES, "{}", jpeg.len());
    }
}

#[cfg(test)]
mod real {
    /// `HARUSPEX_VIDEO_CLIP=… HARUSPEX_THUMB_OUT=/tmp/t.jpg cargo test -- --ignored thumbnail_of_a_real_clip`
    #[tokio::test]
    #[ignore = "needs ffmpeg and a clip"]
    async fn thumbnail_of_a_real_clip() {
        let clip = std::path::PathBuf::from(std::env::var("HARUSPEX_VIDEO_CLIP").unwrap());
        let png = super::super::frames::extract_frame("ffmpeg", &clip, 300.0, 3840)
            .await
            .unwrap();
        let jpeg = super::make(&png, false).unwrap();
        let img = image::load_from_memory(&jpeg).unwrap();
        assert_eq!((img.width(), img.height()), (super::WIDTH, super::HEIGHT));
        std::fs::write(std::env::var("HARUSPEX_THUMB_OUT").unwrap(), &jpeg).unwrap();
    }
}
