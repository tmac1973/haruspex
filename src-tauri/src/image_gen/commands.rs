//! The Tauri commands the pipeline is driven through.
//!
//! No state, no filesystem, no network: bytes in, bytes out. Everything here
//! is a thin wrapper over a pure function so the behaviour lives somewhere
//! unit tests can reach it.

use image::{ImageEncoder, RgbaImage};
use serde::Serialize;

use super::checks::{evaluate, CheckReport};
use super::normalize::{dominant_border_color, normalize};
use super::palette::extract_palette;
use super::profile::{effective_profile, AssetKind, Background, NormalizeProfile};
use super::sheet::contact_sheet;
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
///
/// Passing a `background` excludes BOTH the colour the prompt asked for and
/// the colour the image actually has round its edge. Both, because models do
/// not comply: an anchor asked for on magenta comes back on whatever backdrop
/// the model preferred, and excluding only magenta spends a palette slot on a
/// backdrop no asset will ever use.
/// Judge one normalization's measurements against the profile's thresholds.
///
/// Takes the stats `image_normalize` already returned rather than an image:
/// `palette_distance` is only knowable during quantization, and re-opening
/// the output would be measuring evidence that has already been destroyed.
#[tauri::command]
pub fn image_check(stats: ImageStats, profile: NormalizeProfile, kind: AssetKind) -> CheckReport {
    evaluate(&stats, &effective_profile(&profile, kind))
}

/// Tile a run's assets into one sheet.
///
/// Takes decoded bytes rather than paths: the caller already reads through the
/// workdir-scoped fs commands, and a second path-resolution rule here is a
/// second place for a path escape to be got wrong.
#[tauri::command]
pub fn image_contact_sheet(images: Vec<Vec<u8>>, cell: u32) -> Result<Vec<u8>, String> {
    let decoded = images
        .iter()
        .map(|b| decode(b))
        .collect::<Result<Vec<_>, _>>()?;
    encode(&contact_sheet(&decoded, cell))
}

#[tauri::command]
pub fn image_extract_palette(
    bytes: Vec<u8>,
    count: u32,
    background: Option<Background>,
) -> Result<Vec<u32>, String> {
    let img = decode(&bytes)?;
    let Some(bg) = background else {
        return Ok(extract_palette(&img, count, None));
    };
    let mut palette = extract_palette(&img, count, Some((bg.color, bg.tolerance)));
    if let Some(found) = dominant_border_color(&img, &bg) {
        // Re-extract with the real backdrop excluded, rather than dropping an
        // entry afterwards: removing one leaves a palette short of the size
        // the caller asked for, which is a colour the set will never get back.
        palette = extract_palette(&img, count, Some((found, bg.tolerance)));
    }
    Ok(palette)
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
    use crate::image_gen::checks::CheckName;
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

    /// A keyed sprite: a subject on the profile's magenta, as a generation
    /// that went right would arrive.
    fn sprite_fixture() -> Vec<u8> {
        let mut img = RgbaImage::from_pixel(256, 256, Rgba([0xFF, 0x00, 0xFF, 255]));
        for y in 80..176 {
            for x in 80..176 {
                // Some structure, or entropy has nothing to measure.
                let v = (((x / 8) + (y / 8)) % 5) as u8;
                img.put_pixel(x, y, Rgba([40 + v * 30, 90 + v * 20, 60 + v * 10, 255]));
            }
        }
        png(&img)
    }

    fn checked(bytes: Vec<u8>, kind: AssetKind) -> CheckReport {
        let profile = NormalizeProfile::default();
        let stats = image_normalize(bytes, profile.clone(), kind).unwrap().stats;
        image_check(stats, profile, kind)
    }

    #[test]
    fn a_keyed_sprite_passes_the_gate() {
        // The whole gate is only worth anything if a good generation gets
        // through it. Run end to end so the stats are real ones.
        let r = checked(sprite_fixture(), AssetKind::Sprite);
        assert!(r.passed, "{:?} {:?}", r.failed, r.stats);
    }

    #[test]
    fn a_blank_generation_never_reaches_the_gate() {
        // Normalization refuses it outright rather than handing the gate an
        // empty image to judge. The loop records the entry as failed on the
        // message, so the two halves together still cover the case.
        let img = RgbaImage::from_pixel(256, 256, Rgba([0xFF, 0x00, 0xFF, 255]));
        let err =
            image_normalize(png(&img), NormalizeProfile::default(), AssetKind::Sprite).unwrap_err();
        assert!(err.contains("the image is empty"), "{err}");
    }

    #[test]
    fn a_nearly_empty_subject_fails_alpha_coverage() {
        // What a blank generation actually looks like once something survives
        // the key: a sparse scrawl whose bounding box is mostly nothing.
        let mut img = RgbaImage::from_pixel(256, 256, Rgba([0xFF, 0x00, 0xFF, 255]));
        for i in 0..96 {
            img.put_pixel(80 + i, 80 + i, Rgba([20, 90, 40, 255]));
            img.put_pixel(81 + i, 80 + i, Rgba([20, 90, 40, 255]));
        }
        let r = checked(png(&img), AssetKind::Sprite);
        assert!(
            r.failed.contains(&CheckName::AlphaLow),
            "{:?} {:?}",
            r.failed,
            r.stats
        );
    }

    #[test]
    fn a_sprite_whose_key_never_fired_fails_the_upper_bound() {
        // A full-frame composition with no background to remove: opaque
        // everywhere, which is the isolation-scaffold failure.
        let mut img = RgbaImage::new(256, 256);
        for (x, y, p) in img.enumerate_pixels_mut() {
            let v = (((x / 8) + (y / 8)) % 5) as u8;
            *p = Rgba([30 + v * 40, 60 + v * 30, 20 + v * 25, 255]);
        }
        let r = checked(png(&img), AssetKind::Sprite);
        assert!(r.failed.contains(&CheckName::AlphaHigh), "{:?}", r.failed);
    }

    #[test]
    fn flat_grey_mush_fails_entropy() {
        // The most common bad generation. Keyed against magenta so it is not
        // rejected for alpha before entropy gets a look.
        let mut img = RgbaImage::from_pixel(256, 256, Rgba([0xFF, 0x00, 0xFF, 255]));
        for y in 80..176 {
            for x in 80..176 {
                img.put_pixel(x, y, Rgba([128, 128, 128, 255]));
            }
        }
        let r = checked(png(&img), AssetKind::Sprite);
        assert!(
            r.failed.contains(&CheckName::Entropy),
            "{:?} {:?}",
            r.failed,
            r.stats
        );
    }

    #[test]
    fn a_texture_is_judged_opaque_and_a_keyed_one_is_not() {
        // A tiling texture is meant to fill its frame. The same bytes pass as
        // a sprite and fail as a texture, which is the per-kind branch doing
        // its job.
        let bytes = sprite_fixture();
        assert!(checked(bytes.clone(), AssetKind::Sprite).passed);
        let t = checked(bytes, AssetKind::Texture);
        assert!(t.failed.contains(&CheckName::AlphaLow), "{:?}", t.failed);
    }

    #[test]
    fn the_contact_sheet_command_round_trips_real_pngs() {
        let one = png(&RgbaImage::from_pixel(32, 32, Rgba([200, 30, 40, 255])));
        let two = png(&RgbaImage::from_pixel(32, 32, Rgba([30, 200, 40, 255])));
        let out = image_contact_sheet(vec![one, two], 128).unwrap();
        let img = image::load_from_memory(&out).unwrap().to_rgba8();
        assert_eq!((img.width(), img.height()), (256, 128));
    }

    #[test]
    fn the_contact_sheet_command_says_which_image_it_could_not_read() {
        let err = image_contact_sheet(vec![b"not a png".to_vec()], 64).unwrap_err();
        assert!(err.contains("Could not read"), "{err}");
    }

    #[test]
    fn palette_extraction_honours_the_exclusion() {
        let mut img = RgbaImage::from_pixel(8, 8, Rgba([0xFF, 0x00, 0xFF, 255]));
        for x in 0..8 {
            img.put_pixel(x, 0, Rgba([20, 90, 40, 255]));
        }
        let bg = NormalizeProfile::default().background;
        let with = image_extract_palette(png(&img), 4, Some(bg)).unwrap();
        let without = image_extract_palette(png(&img), 4, None).unwrap();
        assert!(with.len() < without.len(), "{with:?} vs {without:?}");
    }

    #[test]
    fn palette_extraction_also_drops_the_backdrop_the_model_actually_used() {
        // The case that happens. The prompt asked for magenta; the model
        // produced crimson. Excluding only magenta spends a palette slot on a
        // backdrop no asset will ever use.
        let crimson = [150, 20, 60, 255];
        let mut img = RgbaImage::from_pixel(16, 16, Rgba(crimson));
        for y in 6..10 {
            for x in 6..10 {
                img.put_pixel(x, y, Rgba([20, 200, 90, 255]));
            }
        }
        let bg = NormalizeProfile::default().background;
        let palette = image_extract_palette(png(&img), 4, Some(bg)).unwrap();
        for c in &palette {
            let [r, g, b, _] = super::super::profile::rgba(*c);
            let near_crimson = (r as i32 - crimson[0] as i32).abs() < 40
                && (g as i32 - crimson[1] as i32).abs() < 40
                && (b as i32 - crimson[2] as i32).abs() < 40;
            assert!(!near_crimson, "the real backdrop leaked in: {c:08X}");
        }
        assert!(!palette.is_empty(), "the subject should still be there");
    }
}
