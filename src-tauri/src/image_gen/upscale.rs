//! Finishing an ESRGAN upscale: the size asked for, and the source's alpha.
//!
//! Both engines upscale RGB only. sd-server's `/sdcpp/v1/upscale` decodes its
//! input as three channels and ComfyUI's `ImageUpscaleWithModel` takes an
//! IMAGE, which has none either, so a transparent sprite came back on black.
//! The model's colours are kept and the source's own alpha, scaled smoothly to
//! the new size, is put back over them. A ×2 is the model's ×4 halved, since
//! Real-ESRGAN x4plus only does ×4.

use image::imageops::FilterType;
use image::RgbaImage;

use super::png::{decode_rgba, encode_rgb, encode_rgba};

/// The largest edge a finished upscale may have, as sd-server's own limit.
pub const MAX_EDGE: u32 = 8192;

pub struct Finished {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn has_alpha(img: &RgbaImage) -> bool {
    img.pixels().any(|p| p.0[3] < 255)
}

/// `upscaled` at `width`×`height`, with `source`'s alpha when it has any.
pub fn finish_upscale(
    upscaled: &[u8],
    source: &[u8],
    width: u32,
    height: u32,
) -> Result<Finished, String> {
    if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
        return Err(format!(
            "{width}×{height} is not a size to upscale to (at most {MAX_EDGE} a side)."
        ));
    }
    let mut out = decode_rgba(upscaled, "upscaled picture")?;
    if out.dimensions() != (width, height) {
        out = image::imageops::resize(&out, width, height, FilterType::Lanczos3);
    }
    let src = decode_rgba(source, "original picture")?;
    let alpha = has_alpha(&src);
    if alpha {
        let mask = image::imageops::resize(&src, width, height, FilterType::Triangle);
        for (px, m) in out.pixels_mut().zip(mask.pixels()) {
            px.0[3] = m.0[3];
        }
    }
    let png = if alpha {
        encode_rgba(&out, "upscaled picture")?
    } else {
        // Opaque: three channels, a quarter smaller.
        encode_rgb(
            &image::DynamicImage::ImageRgba8(out).to_rgb8(),
            "upscaled picture",
        )?
    };
    Ok(Finished { png, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn png(img: &RgbaImage) -> Vec<u8> {
        encode_rgba(img, "sprite").unwrap()
    }

    /// A sprite: an opaque square on a transparent field.
    fn sprite(size: u32) -> RgbaImage {
        RgbaImage::from_fn(size, size, |x, y| {
            let inside =
                (size / 4..size * 3 / 4).contains(&x) && (size / 4..size * 3 / 4).contains(&y);
            if inside {
                Rgba([200, 20, 20, 255])
            } else {
                Rgba([0, 0, 0, 0])
            }
        })
    }

    #[test]
    fn puts_back_the_alpha_the_upscaler_dropped() {
        let source = sprite(16);
        // What the engines send back: the colours, fully opaque, at ×4.
        let upscaled = RgbaImage::from_pixel(64, 64, Rgba([200, 20, 20, 255]));
        let done = finish_upscale(&png(&upscaled), &png(&source), 64, 64).unwrap();
        let img = image::load_from_memory(&done.png).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (64, 64));
        assert_eq!(img.get_pixel(0, 0).0[3], 0, "the field stays transparent");
        assert_eq!(img.get_pixel(32, 32).0[3], 255, "the square stays opaque");
    }

    #[test]
    fn halves_a_four_times_upscale_for_two_times() {
        let source = RgbaImage::from_pixel(10, 8, Rgba([1, 2, 3, 255]));
        let upscaled = RgbaImage::from_pixel(40, 32, Rgba([1, 2, 3, 255]));
        let done = finish_upscale(&png(&upscaled), &png(&source), 20, 16).unwrap();
        let img = image::load_from_memory(&done.png).unwrap();
        assert_eq!((img.width(), img.height()), (20, 16));
        // Opaque in, three channels out.
        assert_eq!(img.color(), image::ColorType::Rgb8);
    }

    #[test]
    fn refuses_a_size_past_the_engines_limit() {
        let one = png(&RgbaImage::from_pixel(1, 1, Rgba([0, 0, 0, 255])));
        assert!(finish_upscale(&one, &one, 9000, 10).is_err());
        assert!(finish_upscale(&one, &one, 0, 10).is_err());
        assert!(finish_upscale(b"not a png", &one, 4, 4).is_err());
    }
}
