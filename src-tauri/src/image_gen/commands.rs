//! The Tauri commands the pipeline is driven through.
//!
//! No state, no filesystem, no network: bytes in, bytes out. Everything here
//! is a thin wrapper over a pure function so the behaviour lives somewhere
//! unit tests can reach it.

use image::{ImageEncoder, Rgba, RgbaImage};
use serde::Serialize;

use super::checks::{evaluate, CheckReport};
use super::normalize::{carries_alpha, chroma_key, dominant_border_color, harden_alpha, normalize};
use super::palette::{extract_palette, hue_spread};
use super::profile::{
    effective_profile, AssetKind, Background, NormalizeProfile, DEFAULT_ALPHA_THRESHOLD,
    PALETTE_HUE_DOMINANCE,
};
use super::sheet::contact_sheet;
use super::split::{split_sheet, SplitOptions};
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

/// Whether a palette is spread out enough to be worth imposing on a set.
///
/// The anchor's palette governs every asset, so one that has collapsed onto a
/// single hue does not make the set cohere — it makes every asset that
/// colour, whatever its prompt asked for.
#[tauri::command]
pub fn image_palette_spread(palette: Vec<u32>) -> PaletteSpread {
    let (dominant_fraction, buckets_used) = hue_spread(&palette);
    PaletteSpread {
        dominant_fraction,
        buckets_used: buckets_used as u32,
        ok: dominant_fraction <= PALETTE_HUE_DOMINANCE,
    }
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct PaletteSpread {
    /// Share of entries in the single most populated hue bucket.
    pub dominant_fraction: f32,
    /// How many of the twelve hue buckets have anything in them.
    #[ts(type = "number")]
    pub buckets_used: u32,
    pub ok: bool,
}

/// One sprite cut from a sheet, with where it sat.
#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SheetPiece {
    /// The piece alone, cropped to its box, as PNG.
    pub bytes: Vec<u8>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Area-weighted centre, in sheet pixels — what a caller assigns to a
    /// grid cell by.
    pub cx: f32,
    pub cy: f32,
    /// Opaque pixels; a merge of two sprites shows up as an outlier here.
    pub area: u32,
}

/// The pieces of one sheet, and how its background was removed.
#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SplitResult {
    pub pieces: Vec<SheetPiece>,
    /// True when the sheet came back opaque and its backdrop was keyed. Phase
    /// 17: 6 of 103 transparent-start generations did, all with the layout
    /// intact, so a keyed sheet is still usable — but the report counts them.
    pub keyed: bool,
    /// The sheet's palette when one was asked for, from the cut sheet — so the
    /// transparent canvas and any keyed backdrop cannot enter it. Empty
    /// otherwise.
    pub palette: Vec<u32>,
}

/// Cut a generated sheet into its sprites, in reading order.
///
/// Soft edges are hardened first at `alpha_threshold` (the profile's, or the
/// default), so a fringe pixel cannot bridge two neighbours. A sheet that came
/// back opaque is keyed first when `background` is given — by the colour that
/// dominates its border, since a model asked for transparency names no
/// backdrop — and is otherwise one piece, which the caller reads as a failed
/// sheet.
///
/// With `palette_size`, also extracts the sheet's palette: the style anchor
/// is a sheet, and its palette is what every later asset is quantized to.
#[tauri::command]
pub fn image_split_sheet(
    bytes: Vec<u8>,
    alpha_threshold: Option<u8>,
    background: Option<Background>,
    palette_size: Option<u32>,
) -> Result<SplitResult, String> {
    let mut img = decode(&bytes)?;
    let mut keyed = false;
    if !carries_alpha(&img) {
        if let Some(bg) = background {
            if let Some(found) = dominant_border_color(&img, &bg) {
                chroma_key(&mut img, found, &bg);
                keyed = true;
            }
        }
    }
    harden_alpha(&mut img, alpha_threshold.unwrap_or(DEFAULT_ALPHA_THRESHOLD));
    let pieces = split_sheet(&img, SplitOptions::default())
        .into_iter()
        .map(|p| {
            Ok(SheetPiece {
                bytes: encode(&p.image)?,
                x: p.x,
                y: p.y,
                width: p.width,
                height: p.height,
                cx: p.cx,
                cy: p.cy,
                area: p.area,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    // After keying and hardening: only the subjects' own pixels are opaque.
    let palette = palette_size
        .map(|n| extract_palette(&img, n, None))
        .unwrap_or_default();
    Ok(SplitResult {
        pieces,
        keyed,
        palette,
    })
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

    // KEY THE IMAGE FIRST, then take the palette from what survives.
    //
    // Excluding a single colour is not enough, and the first real run proved
    // it: the style anchor's backdrop was a mottled dusty pink covering most
    // of the frame, so median cut — which allocates boxes by pixel population
    // — spent ten of its fourteen entries on near-identical shades of it.
    // Every asset then quantized toward pink and failed the palette-distance
    // check as wildly off-style.
    //
    // Excluding the "dominant border colour" did not save it either: the
    // sheet had a dark vignette at its very edge, so the border vote returned
    // #3f0819 while the actual field was #b3597a.
    //
    // Keying is the honest operation. It is exactly what every asset gets,
    // and `extract_palette` already skips transparent pixels — so the palette
    // ends up describing the pixels that will actually survive, whatever
    // shade the backdrop turned out to be.
    let mut keyed = img.clone();
    let key = if bg.auto_detect {
        dominant_border_color(&img, &bg).unwrap_or(bg.color)
    } else {
        bg.color
    };
    chroma_key(&mut keyed, key, &bg);

    let palette = extract_palette(&keyed, count, Some((key, bg.tolerance)));
    // A key that removed everything leaves nothing to describe. Fall back to
    // the unkeyed image rather than handing back an empty palette, which
    // would silently disable quantization for the whole set.
    if palette.is_empty() {
        // Nothing survived the key. Excluding it a second time would return
        // empty again, so take the image as it is: a palette containing the
        // backdrop is poor, and a palette of nothing silently disables
        // quantization for the whole set, which is worse.
        return Ok(extract_palette(&img, count, None));
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
/// A fully transparent PNG, for starting a transparent generation from.
///
/// Ming-Image gives alpha only when sampling starts from the latent of a
/// transparent canvas (plus its RGBA phrase); the ComfyUI graph builds that
/// canvas itself, and the bundled engine takes it as an img2img init image.
#[tauri::command]
pub fn image_clear_canvas(width: u32, height: u32) -> Result<Vec<u8>, String> {
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err(format!(
            "A canvas of {width}x{height} is not one to generate at."
        ));
    }
    encode(&RgbaImage::from_pixel(
        width,
        height,
        Rgba([128, 128, 128, 0]),
    ))
}

#[tauri::command]
pub fn image_default_profile() -> NormalizeProfile {
    NormalizeProfile::default()
}

/// Resolve a profile's per-kind overrides.
///
/// Exposed so the TypeScript loop reads the background colour and the
/// generation edge from the SAME resolver that normalizes —
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

    /// Two squares on a flat grey backdrop, as an opaque sheet comes back.
    fn opaque_sheet() -> RgbaImage {
        let mut img = RgbaImage::from_pixel(200, 100, Rgba([128, 128, 128, 255]));
        for y in 20..80 {
            for x in 20..80 {
                img.put_pixel(x, y, Rgba([20, 90, 40, 255]));
                img.put_pixel(x + 100, y, Rgba([90, 40, 20, 255]));
            }
        }
        img
    }

    #[test]
    fn a_transparent_sheet_is_cut_without_keying() {
        let mut img = opaque_sheet();
        for p in img.pixels_mut() {
            if p.0 == [128, 128, 128, 255] {
                p.0 = [0, 0, 0, 0];
            }
        }
        let r = image_split_sheet(
            png(&img),
            None,
            Some(NormalizeProfile::default().background),
            None,
        )
        .unwrap();
        assert!(!r.keyed);
        assert_eq!(r.pieces.len(), 2);
    }

    #[test]
    fn an_opaque_sheet_is_keyed_by_its_border_and_says_so() {
        let r = image_split_sheet(
            png(&opaque_sheet()),
            None,
            Some(NormalizeProfile::default().background),
            Some(8),
        )
        .unwrap();
        assert!(r.keyed);
        assert_eq!(r.pieces.len(), 2);
        // The keyed grey backdrop never reaches the palette; the subjects do.
        assert!(!r.palette.contains(&0x80_80_80_FF), "{:x?}", r.palette);
        assert!(r.palette.contains(&0x14_5A_28_FF), "{:x?}", r.palette);
    }

    #[test]
    fn an_opaque_sheet_without_a_background_to_key_is_one_piece() {
        // The caller reads one piece as a failed sheet; nothing is guessed.
        let r = image_split_sheet(png(&opaque_sheet()), None, None, None).unwrap();
        assert!(r.palette.is_empty());
        assert!(!r.keyed);
        assert_eq!(r.pieces.len(), 1);
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
    fn palette_extraction_is_not_swamped_by_a_mottled_backdrop() {
        // The failure that lost a whole run. Median cut allocates boxes by
        // pixel POPULATION, so a backdrop covering most of the frame takes
        // most of the palette — and because it is mottled rather than flat,
        // excluding one colour leaves the rest of its family behind. Ten of
        // fourteen entries came back as near-identical shades of one pink,
        // every asset quantized toward it, and all four failed the
        // palette-distance check as wildly off-style.
        let mut img = RgbaImage::new(64, 64);
        // A mottled backdrop: ONE HUE across a wide brightness range, which
        // is what a diffusion model actually paints. The spread matters — the
        // darkest and lightest shades here are ~94 apart in plain RGB, well
        // beyond the tolerance, so excluding a single colour provably leaves
        // most of the family behind. Keying catches them all because it keys
        // on hue with saturation and value floors, not on distance alone.
        for (x, y, p) in img.enumerate_pixels_mut() {
            let t = 0.6 + 0.4 * (((x / 4 + y / 4) % 5) as f32 / 4.0);
            *p = Rgba([
                (0xb3 as f32 * t) as u8,
                (0x59 as f32 * t) as u8,
                (0x79 as f32 * t) as u8,
                255,
            ]);
        }
        // A small subject in colours nothing like it.
        for y in 26..38 {
            for x in 26..38 {
                img.put_pixel(x, y, Rgba([20, 150, 30, 255]));
            }
        }
        for y in 28..32 {
            for x in 40..46 {
                img.put_pixel(x, y, Rgba([240, 230, 210, 255]));
            }
        }

        let bg = NormalizeProfile::default().background;
        let palette = image_extract_palette(png(&img), 8, Some(bg)).unwrap();
        assert!(!palette.is_empty());
        for c in &palette {
            let [r, g, b, _] = super::super::profile::rgba(*c);
            let backdrop = r > 150 && (0x40..0x90).contains(&g) && (0x60..0xa0).contains(&b);
            assert!(!backdrop, "the backdrop took a palette slot: {c:08X}");
        }
    }

    #[test]
    fn palette_extraction_survives_a_key_that_removes_everything() {
        // A palette of nothing silently disables quantization for the whole
        // set, which is worse than a palette containing the backdrop.
        let img = RgbaImage::from_pixel(16, 16, Rgba([0xb3, 0x59, 0x79, 255]));
        let bg = NormalizeProfile::default().background;
        assert!(!image_extract_palette(png(&img), 4, Some(bg))
            .unwrap()
            .is_empty());
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

    #[test]
    fn a_clear_canvas_is_fully_transparent_at_the_size_asked() {
        let png = image_clear_canvas(64, 32).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (64, 32));
        assert!(img.pixels().all(|p| p.0[3] == 0));
        assert!(image_clear_canvas(0, 32).is_err());
    }
}
