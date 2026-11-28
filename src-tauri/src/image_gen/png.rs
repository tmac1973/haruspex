//! Pictures into pixels and back into PNG, for the image tools: one decode and
//! one encode, with errors that name the picture ("Could not read the mask").
//!
//! The encode uses fixed settings and writes no metadata, so the same pixels
//! always give the same bytes: a re-run must not dirty a committed asset.

use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbImage, RgbaImage};

/// `bytes`, in any format the `image` crate reads.
pub fn decode(bytes: &[u8], what: &str) -> Result<DynamicImage, String> {
    image::load_from_memory(bytes).map_err(|e| format!("Could not read the {what}: {e}"))
}

/// `bytes` as RGBA pixels.
pub fn decode_rgba(bytes: &[u8], what: &str) -> Result<RgbaImage, String> {
    decode(bytes, what).map(|i| i.to_rgba8())
}

/// `img` as an RGBA PNG.
pub fn encode_rgba(img: &RgbaImage, what: &str) -> Result<Vec<u8>, String> {
    write(
        img.as_raw(),
        img.width(),
        img.height(),
        ExtendedColorType::Rgba8,
        what,
    )
}

/// `img` as an RGB PNG: a quarter smaller for an opaque picture, and the only
/// kind some tools take.
pub fn encode_rgb(img: &RgbImage, what: &str) -> Result<Vec<u8>, String> {
    write(
        img.as_raw(),
        img.width(),
        img.height(),
        ExtendedColorType::Rgb8,
        what,
    )
}

fn write(
    raw: &[u8],
    width: u32,
    height: u32,
    color: ExtendedColorType,
    what: &str,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(raw, width, height, color)
        .map_err(|e| format!("Could not encode the {what}: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, Rgba};

    #[test]
    fn round_trips_rgba_and_rgb() {
        let rgba = RgbaImage::from_pixel(3, 2, Rgba([10, 20, 30, 128]));
        let back = decode_rgba(&encode_rgba(&rgba, "sprite").unwrap(), "sprite").unwrap();
        assert_eq!(back, rgba);

        let rgb = RgbImage::from_pixel(2, 2, Rgb([1, 2, 3]));
        let png = encode_rgb(&rgb, "tile").unwrap();
        assert_eq!(decode(&png, "tile").unwrap().to_rgb8(), rgb);
        assert!(!decode(&png, "tile").unwrap().color().has_alpha());
    }

    #[test]
    fn the_same_pixels_give_the_same_bytes() {
        let img = RgbaImage::from_pixel(4, 4, Rgba([200, 100, 50, 255]));
        assert_eq!(
            encode_rgba(&img, "a").unwrap(),
            encode_rgba(&img, "a").unwrap()
        );
    }

    #[test]
    fn names_the_picture_that_would_not_read() {
        let err = decode_rgba(b"not a picture", "mask").unwrap_err();
        assert!(err.starts_with("Could not read the mask: "), "{err}");
    }
}
