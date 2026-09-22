//! The quality gate's mechanical half: thresholds against measurements.
//!
//! Pure by construction. It takes the [`ImageStats`] that `image_normalize`
//! already produced and compares them to the thresholds already on the
//! profile — it never re-opens the image, because `palette_distance` is only
//! knowable during quantization and no longer exists in the normalized output.
//!
//! This exists because of a bug found the hard way elsewhere in the codebase:
//! a stage that trusts its producer reports success for work that never
//! happened. A generation that came back blank is still a PNG.

use serde::{Deserialize, Serialize};

use super::profile::NormalizeProfile;
use super::stats::ImageStats;

/// One failed check, named for the FAILURE rather than the statistic.
///
/// `AlphaLow` and `AlphaHigh` are separate variants because they mean opposite
/// things — nothing opaque at all, versus a key that did not fire — and the
/// retry table amends the prompt in opposite directions for them. A single
/// `Alpha` variant would make that mapping unwritable.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CheckName {
    AlphaLow,
    AlphaHigh,
    Entropy,
    PaletteDistance,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct CheckReport {
    pub passed: bool,
    pub stats: ImageStats,
    pub failed: Vec<CheckName>,
}

/// Compare one normalization's measurements to the effective profile.
///
/// Pass the profile the entry was normalized with — the per-kind one. A
/// texture's alpha bounds are 0.999..1.0 because a tiling texture is fully
/// opaque, and judging one against a sprite's 0.05..0.95 would reject every
/// texture the pipeline ever made.
pub fn evaluate(stats: &ImageStats, profile: &NormalizeProfile) -> CheckReport {
    let c = &profile.checks;
    let mut failed = Vec::new();

    if stats.alpha < c.alpha_min {
        failed.push(CheckName::AlphaLow);
    } else if stats.alpha > c.alpha_max {
        failed.push(CheckName::AlphaHigh);
    }
    if stats.entropy < c.entropy_min {
        failed.push(CheckName::Entropy);
    }
    if stats.palette_distance > c.palette_distance_max {
        failed.push(CheckName::PaletteDistance);
    }

    CheckReport {
        passed: failed.is_empty(),
        stats: *stats,
        failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_gen::profile::{effective_profile, AssetKind};

    fn stats(alpha: f32, entropy: f32, palette_distance: f32) -> ImageStats {
        ImageStats {
            alpha,
            entropy,
            palette_distance,
        }
    }

    fn sprite() -> NormalizeProfile {
        effective_profile(&NormalizeProfile::default(), AssetKind::Sprite)
    }

    #[test]
    fn an_in_style_sprite_passes_everything() {
        let r = evaluate(&stats(0.4, 3.0, 0.01), &sprite());
        assert!(r.passed);
        assert!(r.failed.is_empty());
    }

    #[test]
    fn a_blank_canvas_fails_alpha_low() {
        // Nothing opaque at all: the generation came back empty, or the key
        // ate the subject.
        let r = evaluate(&stats(0.0, 3.0, 0.0), &sprite());
        assert_eq!(r.failed, vec![CheckName::AlphaLow]);
        assert!(!r.passed);
    }

    #[test]
    fn a_fully_opaque_sprite_fails_alpha_high() {
        // The key never fired, so there is no background to remove and the
        // sprite is a full-frame composition. Opposite failure, opposite fix.
        let r = evaluate(&stats(1.0, 3.0, 0.0), &sprite());
        assert_eq!(r.failed, vec![CheckName::AlphaHigh]);
    }

    #[test]
    fn alpha_cannot_fail_in_both_directions_at_once() {
        for a in [0.0, 0.5, 1.0] {
            let r = evaluate(&stats(a, 3.0, 0.0), &sprite());
            assert!(
                !(r.failed.contains(&CheckName::AlphaLow)
                    && r.failed.contains(&CheckName::AlphaHigh)),
                "alpha {a}"
            );
        }
    }

    #[test]
    fn the_alpha_bounds_are_inclusive_at_both_ends() {
        let p = sprite();
        let lo = p.checks.alpha_min;
        let hi = p.checks.alpha_max;
        assert!(evaluate(&stats(lo, 3.0, 0.0), &p).passed, "at the floor");
        assert!(evaluate(&stats(hi, 3.0, 0.0), &p).passed, "at the ceiling");
        assert!(!evaluate(&stats(lo - 0.001, 3.0, 0.0), &p).passed);
        assert!(!evaluate(&stats(hi + 0.001, 3.0, 0.0), &p).passed);
    }

    #[test]
    fn flat_grey_mush_fails_entropy() {
        // The most common bad generation a model produces.
        let r = evaluate(&stats(0.4, 0.2, 0.0), &sprite());
        assert_eq!(r.failed, vec![CheckName::Entropy]);
    }

    #[test]
    fn the_entropy_floor_is_inclusive() {
        let p = sprite();
        let min = p.checks.entropy_min;
        assert!(evaluate(&stats(0.4, min, 0.0), &p).passed);
        assert!(!evaluate(&stats(0.4, min - 0.001, 0.0), &p).passed);
    }

    #[test]
    fn an_off_style_generation_fails_palette_distance() {
        // The failure a palette-only design hides: the output is perfectly
        // in-palette and the generation was nothing like it.
        let r = evaluate(&stats(0.4, 3.0, 0.9), &sprite());
        assert_eq!(r.failed, vec![CheckName::PaletteDistance]);
    }

    #[test]
    fn the_palette_distance_ceiling_is_inclusive() {
        let p = sprite();
        let max = p.checks.palette_distance_max;
        assert!(evaluate(&stats(0.4, 3.0, max), &p).passed);
        assert!(!evaluate(&stats(0.4, 3.0, max + 0.001), &p).passed);
    }

    #[test]
    fn a_texture_is_judged_against_its_own_alpha_bounds() {
        // A tiling texture is fully opaque. Judged as a sprite it fails every
        // time; judged as itself, an alpha of 0.5 is the failure.
        let t = effective_profile(&NormalizeProfile::default(), AssetKind::Texture);
        assert!(evaluate(&stats(1.0, 3.0, 0.0), &t).passed);
        assert!(!evaluate(&stats(0.5, 3.0, 0.0), &t).passed);
        assert!(evaluate(&stats(0.5, 3.0, 0.0), &sprite()).passed);
    }

    #[test]
    fn every_failure_is_reported_not_just_the_first() {
        let r = evaluate(&stats(0.0, 0.0, 1.0), &sprite());
        assert_eq!(
            r.failed,
            vec![
                CheckName::AlphaLow,
                CheckName::Entropy,
                CheckName::PaletteDistance
            ]
        );
    }

    #[test]
    fn evaluation_is_pure() {
        let s = stats(0.4, 0.2, 0.9);
        let p = sprite();
        let a = evaluate(&s, &p);
        let b = evaluate(&s, &p);
        assert_eq!(a.failed, b.failed);
        assert_eq!(a.passed, b.passed);
    }
}
