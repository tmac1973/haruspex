//! Every tunable the normalization pipeline has, in one place.
//!
//! Later phases read from here and add nothing. That is deliberate: the
//! quality gate's thresholds, the reference weight and the pixel grid all
//! belong to *the style*, and the style is versioned with the entries it
//! governs. A field invented somewhere downstream would live outside that.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What kind of thing is being generated. The three the spec allows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AssetKind {
    Sprite,
    Texture,
    Icon,
}

/// Largest edge we will ask a backend to generate.
///
/// `target_size * upscale` is clamped to this. Without the clamp a
/// `target_size` of 512 — which the job config permits — asks for an 8192px
/// image no backend will serve.
pub const MAX_GENERATION_EDGE: u32 = 1024;

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Background {
    /// Packed `0xRRGGBBAA`. The colour the prompt asks for.
    pub color: u32,
    /// How far from the key still counts as background, in RGB distance.
    pub tolerance: u8,
    /// Fall back to the colour that dominates the image border when `color`
    /// is not actually present.
    ///
    /// This is not a nicety, it is what makes keying work at all. The prompt
    /// asks for a flat magenta background and SD1.5 simply does not comply —
    /// a sword asked for on `#FF00FF` came back on dark crimson, so the key
    /// matched nothing and every sprite arrived fully opaque with its
    /// background intact. Sampling the border needs no cooperation from the
    /// model, which is the same reason the rest of this module imposes
    /// coherence rather than requesting it.
    pub auto_detect: bool,
}

/// How much of the border one colour must cover before it is believed to be
/// the background.
///
/// A subject that fills the frame has no background to remove, and keying its
/// own edge colour would eat the subject. Requiring a clear majority means an
/// ambiguous image is left alone and fails the alpha check honestly instead.
pub const BORDER_DOMINANCE: f32 = 0.6;

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Crop {
    pub enabled: bool,
    /// Transparent pixels kept around the subject after cropping.
    pub margin: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Outline {
    pub enabled: bool,
    /// Packed `0xRRGGBBAA`.
    pub color: u32,
    pub width: u32,
}

/// What the quality gate compares an image's measured statistics against.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct CheckThresholds {
    /// Fraction of opaque pixels. Below this is a blank canvas.
    pub alpha_min: f32,
    /// Above this the background was never keyed out.
    pub alpha_max: f32,
    /// Shannon entropy over the SUBJECT's colours, in bits. Catches flat mush.
    pub entropy_min: f32,
    /// Fraction of pixels that were further than [`PALETTE_DISTANCE_CUTOFF`]
    /// from their palette entry *before* snapping. High means the generation
    /// was off-style and quantization papered over it.
    pub palette_distance_max: f32,
}

/// How far a pixel may sit from its palette entry before it counts as
/// off-palette, in plain RGB distance.
pub const PALETTE_DISTANCE_CUTOFF: f32 = 48.0;

/// Per-kind overrides. Every field optional; `None` means "use the base".
#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct KindOverride {
    pub crop_enabled: Option<bool>,
    pub outline_enabled: Option<bool>,
    pub background_auto: Option<bool>,
    pub alpha_min: Option<f32>,
    pub alpha_max: Option<f32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct NormalizeProfile {
    /// Output edge in pixels.
    pub target_size: u32,
    /// Generation happens at `target_size * upscale`; the downscale factor is
    /// exactly this number. See [`effective_upscale`] for the clamp.
    pub upscale: u32,
    /// How many colours [`crate::image_gen::palette::extract_palette`] returns.
    pub palette_size: u32,
    /// Empty until the style anchor fills it. Packed `0xRRGGBBAA`.
    pub palette: Vec<u32>,
    pub background: Background,
    pub crop: Crop,
    pub outline: Outline,
    /// How strongly a generation is pulled toward the anchor, 0..1.
    ///
    /// It lives here rather than on the request because it is a property of
    /// the style, and this is where style settings are versioned. Measured
    /// against SD1.5 IP-Adapter: 0.6 shifts the palette clearly while leaving
    /// the subject alone, 0.9 is strong, and past that the reference's own
    /// forms start appearing in the output.
    pub reference_strength: f32,
    pub checks: CheckThresholds,
    pub by_kind: BTreeMap<AssetKind, KindOverride>,
}

impl Default for NormalizeProfile {
    fn default() -> Self {
        let mut by_kind = BTreeMap::new();
        // A tiling texture is fully opaque, and cropping or outlining one
        // destroys the tiling it was generated for.
        by_kind.insert(
            AssetKind::Texture,
            KindOverride {
                crop_enabled: Some(false),
                outline_enabled: Some(false),
                // A texture's border IS content. Border sampling would find
                // the texture itself dominating the edge and key the whole
                // thing away — caught by a test the moment auto-detect landed.
                background_auto: Some(false),
                alpha_min: Some(0.999),
                alpha_max: Some(1.0),
            },
        );
        NormalizeProfile {
            target_size: 32,
            upscale: 16,
            palette_size: 16,
            palette: Vec::new(),
            background: Background {
                color: 0xFF_00_FF_FF,
                tolerance: 40,
                auto_detect: true,
            },
            crop: Crop {
                enabled: true,
                margin: 1,
            },
            outline: Outline {
                enabled: true,
                color: 0x1A_1A_1A_FF,
                width: 2,
            },
            reference_strength: 0.6,
            checks: CheckThresholds {
                alpha_min: 0.05,
                alpha_max: 0.95,
                // Calibrated against real SD1.5 output at 32px rather than
                // guessed. Measured: a good keyed sword 1.91, a good hat 3.27,
                // unkeyed full-frame sprites 2.9-3.7, cobblestone textures
                // 1.30-1.87, and a generation that came back as a stray fleck
                // 0.64. A floor of 2.0 — the original guess — rejects the good
                // sword and both good textures; 1.0 separates every good case
                // from every bad one with margin at both ends.
                entropy_min: 1.0,
                palette_distance_max: 0.15,
            },
            by_kind,
        }
    }
}

impl NormalizeProfile {
    /// The upscale actually used, clamped so the generation edge never exceeds
    /// [`MAX_GENERATION_EDGE`].
    pub fn effective_upscale(&self) -> u32 {
        let cap = (MAX_GENERATION_EDGE / self.target_size.max(1)).max(1);
        self.upscale.clamp(1, cap)
    }
}

/// Resolve `by_kind` into a flat profile.
///
/// Every consumer calls this rather than reading `by_kind` itself, so per-kind
/// behaviour cannot drift between the place that normalizes and the place that
/// builds the request.
pub fn effective_profile(profile: &NormalizeProfile, kind: AssetKind) -> NormalizeProfile {
    let mut out = profile.clone();
    // Resolve the clamp here too, so a caller reading `upscale` off a resolved
    // profile gets the value that will actually be used. The alternative is
    // the TypeScript side re-implementing the clamp, which is precisely how
    // the thing that generates and the thing that normalizes come to disagree
    // about how big an image is.
    out.upscale = profile.effective_upscale();
    let Some(o) = profile.by_kind.get(&kind) else {
        out.by_kind.clear();
        return out;
    };
    if let Some(v) = o.crop_enabled {
        out.crop.enabled = v;
    }
    if let Some(v) = o.outline_enabled {
        out.outline.enabled = v;
    }
    if let Some(v) = o.background_auto {
        out.background.auto_detect = v;
    }
    if let Some(v) = o.alpha_min {
        out.checks.alpha_min = v;
    }
    if let Some(v) = o.alpha_max {
        out.checks.alpha_max = v;
    }
    // Resolved, so nothing downstream can apply them twice.
    out.by_kind.clear();
    out
}

/// Unpack `0xRRGGBBAA`.
pub fn rgba(packed: u32) -> [u8; 4] {
    [
        (packed >> 24) as u8,
        (packed >> 16) as u8,
        (packed >> 8) as u8,
        packed as u8,
    ]
}

/// Pack `[r, g, b, a]`.
pub fn pack(c: [u8; 4]) -> u32 {
    ((c[0] as u32) << 24) | ((c[1] as u32) << 16) | ((c[2] as u32) << 8) | c[3] as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texture_disables_crop_and_outline_and_expects_opacity() {
        let p = effective_profile(&NormalizeProfile::default(), AssetKind::Texture);
        assert!(!p.crop.enabled);
        assert!(!p.outline.enabled);
        assert!(!p.background.auto_detect, "a texture's border is content");
        assert_eq!(p.checks.alpha_min, 0.999);
        assert_eq!(p.checks.alpha_max, 1.0);
    }

    #[test]
    fn sprite_is_the_base_profile_unchanged() {
        let base = NormalizeProfile::default();
        let p = effective_profile(&base, AssetKind::Sprite);
        assert!(p.crop.enabled);
        assert!(p.outline.enabled);
        assert_eq!(p.checks.alpha_min, base.checks.alpha_min);
    }

    #[test]
    fn resolving_clears_the_overrides_so_they_cannot_apply_twice() {
        let p = effective_profile(&NormalizeProfile::default(), AssetKind::Texture);
        assert!(p.by_kind.is_empty());
        // Idempotent: resolving an already-resolved profile changes nothing.
        let again = effective_profile(&p, AssetKind::Texture);
        assert!(!again.crop.enabled);
    }

    #[test]
    fn upscale_is_clamped_so_the_generation_edge_stays_servable() {
        let mut p = NormalizeProfile::default();
        assert_eq!(p.target_size * p.effective_upscale(), 512);
        // 512 * 16 would be 8192, which no backend will serve.
        p.target_size = 512;
        assert_eq!(p.effective_upscale(), 2);
        assert_eq!(p.target_size * p.effective_upscale(), MAX_GENERATION_EDGE);
        // Never zero, however absurd the target.
        p.target_size = 4096;
        assert_eq!(p.effective_upscale(), 1);
    }

    #[test]
    fn resolving_also_resolves_the_upscale_clamp() {
        // A caller reading `upscale` off a resolved profile must get the value
        // that will actually be used, or it will ask a backend for an image
        // the normalizer never expected.
        let base = NormalizeProfile {
            target_size: 512,
            ..Default::default()
        };
        let p = effective_profile(&base, AssetKind::Sprite);
        assert_eq!(p.upscale, 2);
        assert_eq!(p.target_size * p.upscale, MAX_GENERATION_EDGE);
    }

    #[test]
    fn colors_round_trip_through_packing() {
        for c in [0xFF_00_FF_FF, 0x1A_1A_1A_FF, 0x00_00_00_00] {
            assert_eq!(pack(rgba(c)), c);
        }
    }
}
