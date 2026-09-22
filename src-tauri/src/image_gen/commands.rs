//! The three Tauri commands the pipeline is driven through.
//!
//! No state, no filesystem, no network: bytes in, bytes out. Everything here
//! is a thin wrapper over a pure function so the behaviour lives somewhere
//! unit tests can reach it.

use image::{ImageEncoder, RgbaImage};
use serde::Serialize;

use super::normalize::normalize;
use super::palette::extract_palette;
use super::profile::{effective_profile, AssetKind, NormalizeProfile};
use super::stats::ImageStats;

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NormalizeResult {
    pub bytes: Vec<u8>,
    pub stats: ImageStats,
}

fn decode(bytes: &[u8]) -> Result<RgbaImage, String> {
    image::load_from_memory(bytes)
        .map_err(|e| format!("Could not read the image: {e}"))
        .map(|i| i.to_rgba8())
}

/// Encode with fixed settings and no metadata, so the same pixels always give
/// the same bytes — a re-run must not dirty a committed asset.
fn encode(img: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Could not encode the image: {e}"))?;
    Ok(out)
}

/// Key, crop, downscale, quantize and outline one image.
#[tauri::command]
pub fn image_normalize(
    bytes: Vec<u8>,
    profile: NormalizeProfile,
    kind: AssetKind,
) -> Result<NormalizeResult, String> {
    let img = decode(&bytes)?;
    let (out, stats) = normalize(&img, &profile, kind)?;
    Ok(NormalizeResult {
        bytes: encode(&out)?,
        stats,
    })
}

/// The shared palette, from the style anchor.
#[tauri::command]
pub fn image_extract_palette(
    bytes: Vec<u8>,
    count: u32,
    exclude_color: Option<u32>,
    exclude_tolerance: Option<u8>,
) -> Result<Vec<u32>, String> {
    let img = decode(&bytes)?;
    let exclude = exclude_color.map(|c| (c, exclude_tolerance.unwrap_or(0)));
    Ok(extract_palette(&img, count, exclude))
}

/// The shipped defaults.
///
/// Exposed so the TypeScript side never carries a second copy of them. Every
/// number in `NormalizeProfile` was arrived at by measuring real output — the
/// entropy floor, the chroma tolerances, the generation-edge clamp — and a
/// duplicate set in another language would drift from the measurements the
/// day one of them changed.
#[tauri::command]
pub fn image_default_profile() -> NormalizeProfile {
    NormalizeProfile::default()
}

/// Resolve a profile's per-kind overrides.
///
/// Exposed so the TypeScript loop reads `reference_strength`, the background
/// colour and the generation edge from the SAME resolver that normalizes —
/// a second implementation in TS is how the two would drift.
#[tauri::command]
pub fn image_effective_profile(profile: NormalizeProfile, kind: AssetKind) -> NormalizeProfile {
    effective_profile(&profile, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn png(img: &RgbaImage) -> Vec<u8> {
        encode(img).unwrap()
    }

    #[test]
    fn a_non_image_is_reported_rather_than_panicking() {
        let err = image_normalize(
            b"not a png".to_vec(),
            NormalizeProfile::default(),
            AssetKind::Sprite,
        )
        .unwrap_err();
        assert!(err.contains("Could not read"), "{err}");
    }

    #[test]
    fn encoding_is_byte_stable_for_the_same_pixels() {
        // A re-run must not dirty a committed asset.
        let img = RgbaImage::from_pixel(8, 8, Rgba([10, 20, 30, 255]));
        assert_eq!(png(&img), png(&img));
    }

    #[test]
    fn normalize_round_trips_through_the_command() {
        let mut img = RgbaImage::from_pixel(64, 64, Rgba([0xFF, 0x00, 0xFF, 255]));
        for y in 16..48 {
            for x in 16..48 {
                img.put_pixel(x, y, Rgba([20, 90, 40, 255]));
            }
        }
        let r = image_normalize(png(&img), NormalizeProfile::default(), AssetKind::Sprite).unwrap();
        let out = decode(&r.bytes).unwrap();
        assert_eq!(out.dimensions(), (32, 32));
        assert!(r.stats.alpha > 0.0 && r.stats.alpha < 1.0);
    }

    #[test]
    fn the_effective_profile_command_agrees_with_the_resolver() {
        let base = NormalizeProfile::default();
        let via_command = image_effective_profile(base.clone(), AssetKind::Texture);
        let direct = effective_profile(&base, AssetKind::Texture);
        assert_eq!(via_command.crop.enabled, direct.crop.enabled);
        assert_eq!(via_command.checks.alpha_min, direct.checks.alpha_min);
    }

    #[test]
    fn the_default_profile_command_is_the_shipped_default() {
        let via_command = image_default_profile();
        let direct = NormalizeProfile::default();
        assert_eq!(via_command.target_size, direct.target_size);
        assert_eq!(via_command.checks.entropy_min, direct.checks.entropy_min);
        assert_eq!(via_command.background.color, direct.background.color);
        // The per-kind overrides must travel with it, or a caller building a
        // spec from this would ship a profile that crops textures.
        assert!(!via_command.by_kind.is_empty());
    }

    #[test]
    fn palette_extraction_honours_the_exclusion() {
        let mut img = RgbaImage::from_pixel(8, 8, Rgba([0xFF, 0x00, 0xFF, 255]));
        for x in 0..8 {
            img.put_pixel(x, 0, Rgba([20, 90, 40, 255]));
        }
        let with = image_extract_palette(png(&img), 4, Some(0xFF_00_FF_FF), Some(40)).unwrap();
        let without = image_extract_palette(png(&img), 4, None, None).unwrap();
        assert!(with.len() < without.len(), "{with:?} vs {without:?}");
    }
}
