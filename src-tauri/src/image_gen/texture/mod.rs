//! Textures drawn by code from a recipe, instead of by the image model.
//!
//! The image model draws pictures — a road scene, tents round a fire — where a
//! tilemap needs a surface, and its viewpoint drifts. A recipe is a base
//! material and layers from a fixed set (`recipe.rs`), each periodic over the
//! tile (`noise.rs`, `layers.rs`), so the result is flat, top-down, and tiles
//! by construction. Variants are the same recipe at other seeds: the details
//! move, the material does not, so any two can sit side by side.
//!
//! Prototyped in `plan/misc_futures/phase-17-prototype/`.

pub mod layers;
pub mod noise;
pub mod recipe;

use image::RgbaImage;

use super::palette::quantize_to;
pub use recipe::{validate, TextureRecipe};

/// Most variants one call may ask for.
pub const MAX_VARIANTS: u32 = 8;

/// Draw `variants` tiles of `size` pixels from one recipe. Variant 0 is the
/// base; each is snapped to `palette` (packed `0xRRGGBBAA`) when one is given,
/// so the textures share the sprites' colours.
pub fn render(
    r: &TextureRecipe,
    size: u32,
    seed: u64,
    variants: u32,
    palette: &[u32],
) -> Result<Vec<RgbaImage>, String> {
    validate(r)?;
    // The dither matrix is 4 pixels: a size it does not divide would not tile.
    if !(8..=256).contains(&size) || !size.is_multiple_of(4) {
        return Err(format!(
            "A {size}-pixel tile cannot be drawn: use a multiple of 4 from 8 to 256."
        ));
    }
    if !(1..=MAX_VARIANTS).contains(&variants) {
        return Err(format!(
            "Variants must be 1 to {MAX_VARIANTS}, not {variants}."
        ));
    }
    Ok((0..variants)
        .map(|k| {
            let mut img = layers::draw(r, size, noise::variant_seed(seed, k));
            if !palette.is_empty() {
                quantize_to(&mut img, palette);
            }
            img
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::recipe::{Axis, BaseLayer, Layer, WallFace};
    use super::*;
    use std::collections::HashMap;

    fn base() -> BaseLayer {
        BaseLayer {
            ramp: vec!["#2a2a2d".into(), "#34343a".into(), "#3e3e44".into()],
            cells: Some(4),
            octaves: Some(3),
            dither: Some(true),
        }
    }

    fn with(layers: Vec<Layer>) -> TextureRecipe {
        TextureRecipe {
            base: base(),
            layers,
            wall_face: None,
        }
    }

    fn every_layer() -> Vec<(&'static str, Layer)> {
        let c = || "#b89a2e".to_string();
        vec![
            (
                "speckle",
                Layer::Speckle {
                    color: c(),
                    amount: 0.05,
                },
            ),
            (
                "cracks",
                Layer::Cracks {
                    color: c(),
                    cells: 3,
                    coverage: 0.4,
                    width: None,
                },
            ),
            (
                "blotches",
                Layer::Blotches {
                    color: c(),
                    cells: 4,
                    threshold: 0.7,
                },
            ),
            (
                "bricks",
                Layer::Bricks {
                    w: 8.0,
                    h: 4.0,
                    gap: 1.0,
                    offset: true,
                    colors: vec!["#c2bcaa".into(), "#b8b2a0".into()],
                    mortar: "#6e6a60".into(),
                },
            ),
            (
                "stripes",
                Layer::Stripes {
                    axis: Axis::X,
                    pos: 15.0,
                    width: 2.0,
                    dash: Some([8.0, 8.0]),
                    color: c(),
                    wear: Some(0.2),
                },
            ),
            (
                "waves",
                Layer::Waves {
                    color: c(),
                    freq: 5,
                    threshold: 0.9,
                },
            ),
            (
                "grid",
                Layer::Grid {
                    step: 8.0,
                    width: None,
                    color: c(),
                },
            ),
            (
                "bevel",
                Layer::Bevel {
                    step: 8.0,
                    light: "#77746b".into(),
                    dark: "#4a4843".into(),
                },
            ),
        ]
    }

    fn diff(a: [u8; 4], b: [u8; 4]) -> f64 {
        (0..3).map(|i| (a[i] as f64 - b[i] as f64).abs()).sum()
    }

    /// Mean colour step across the wrap seam, the mean across interior
    /// neighbours, and the sharpest interior step, for columns (`vertical`
    /// false) or rows.
    fn seam_and_interior(img: &RgbaImage, vertical: bool) -> (f64, f64, f64) {
        let n = img.width();
        let px = |a: u32, b: u32| {
            if vertical {
                img.get_pixel(b, a).0
            } else {
                img.get_pixel(a, b).0
            }
        };
        let seam: f64 = (0..n).map(|b| diff(px(n - 1, b), px(0, b))).sum::<f64>() / n as f64;
        let (mut inner, mut worst) = (0.0, 0.0f64);
        for a in 0..n - 1 {
            let step = (0..n).map(|b| diff(px(a, b), px(a + 1, b))).sum::<f64>() / n as f64;
            inner += step;
            worst = worst.max(step);
        }
        (seam, inner / (n - 1) as f64, worst)
    }

    #[test]
    fn every_layer_tiles_at_every_size() {
        // The measure from comfyui/templates/README.md: an image tiles when
        // its wrap seam is no more discontinuous than its own interior.
        // Averaged over 20 seeds, because a single seam of 32 pixels is noisy.
        //
        // A patterned layer is held to a different bar. Bricks, grids and
        // bevels put a line on one side of the seam by design, so the seam is
        // as sharp as the edge between any two cells — sharper than the average step,
        // which is mostly brick face. For those, the seam must be no sharper
        // than the sharpest step inside the tile.
        for (name, l) in every_layer() {
            let patterned = matches!(
                l,
                Layer::Bricks { .. } | Layer::Grid { .. } | Layer::Bevel { .. }
            );
            for n in [16, 32, 64] {
                let (mut seams, mut inners, mut worst) = (0.0, 0.0, 0.0f64);
                for seed in 1..=20 {
                    let img = &render(&with(vec![l.clone()]), n, seed, 1, &[]).unwrap()[0];
                    for vertical in [false, true] {
                        let (s, i, m) = seam_and_interior(img, vertical);
                        seams += s;
                        inners += i;
                        worst = worst.max(m);
                        if patterned {
                            // 15% over: the seam is one more brick edge, and its
                            // shades are as random as any other edge's.
                            assert!(
                                s <= m * 1.15 + 1.0,
                                "{name} at {n}px: seam {s:.0} over the sharpest step {m:.0}"
                            );
                        }
                    }
                }
                if !patterned {
                    assert!(
                        seams <= inners * 1.25 + 1.0,
                        "{name} at {n}px: seam {seams:.0} against interior {inners:.0}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_wall_face_still_tiles_across() {
        // A wall with a front face repeats along a wall, not up it.
        let mut r = with(vec![]);
        r.wall_face = Some(WallFace {
            height: 6.0,
            shade: 0.6,
        });
        let (mut seam, mut inner) = (0.0, 0.0);
        for seed in 1..=20 {
            let img = &render(&r, 32, seed, 1, &[]).unwrap()[0];
            let (s, i, _) = seam_and_interior(img, false);
            seam += s;
            inner += i;
            // And the face is there: the bottom row is darker than the top.
            let lum = |y: u32| {
                (0..32)
                    .map(|x| img.get_pixel(x, y).0[1] as u32)
                    .sum::<u32>()
            };
            assert!(lum(31) < lum(0));
        }
        assert!(seam <= inner * 1.25 + 1.0);
    }

    #[test]
    fn a_recipe_and_seed_always_give_the_same_pixels() {
        let r = with(every_layer().into_iter().map(|(_, l)| l).collect());
        let a = render(&r, 32, 9, 2, &[]).unwrap();
        let b = render(&r, 32, 9, 2, &[]).unwrap();
        assert_eq!(a[0].as_raw(), b[0].as_raw());
        assert_eq!(a[1].as_raw(), b[1].as_raw());
    }

    fn histogram(img: &RgbaImage) -> HashMap<[u8; 4], f64> {
        let mut h = HashMap::new();
        let total = (img.width() * img.height()) as f64;
        for p in img.pixels() {
            *h.entry(p.0).or_insert(0.0) += 1.0 / total;
        }
        h
    }

    #[test]
    fn variants_differ_in_detail_but_not_in_material() {
        let r = with(vec![
            Layer::Speckle {
                color: "#4c4c52".into(),
                amount: 0.05,
            },
            Layer::Cracks {
                color: "#1d1d20".into(),
                cells: 3,
                coverage: 0.55,
                width: None,
            },
        ]);
        let v = render(&r, 32, 1, 4, &[]).unwrap();
        for i in 0..4 {
            for j in i + 1..4 {
                assert_ne!(v[i].as_raw(), v[j].as_raw(), "variants {i} and {j} match");
            }
        }
        // The same colours in about the same amounts. L1 distance between
        // colour histograms: 0 is identical, 2 shares no colour at all. The
        // noise is re-normalized per variant, so the split between shades
        // moves: measured up to 0.30 on this asphalt over seeds 1–4, about
        // 15% of pixels changing shade. The material is the same; the plan's
        // "within 5%" was a guess.
        let h0 = histogram(&v[0]);
        for img in &v[1..] {
            let h = histogram(img);
            let keys: std::collections::HashSet<_> = h0.keys().chain(h.keys()).collect();
            let l1: f64 = keys
                .iter()
                .map(|k| (h0.get(*k).unwrap_or(&0.0) - h.get(*k).unwrap_or(&0.0)).abs())
                .sum();
            assert!(l1 < 0.4, "histogram distance {l1:.2}");
        }
    }

    #[test]
    fn snaps_to_the_palette_given() {
        let palette = [0x101010ff, 0x808080ff, 0xf0f0f0ff];
        let r = with(every_layer().into_iter().map(|(_, l)| l).collect());
        let img = &render(&r, 32, 3, 1, &palette).unwrap()[0];
        let allowed: Vec<[u8; 4]> = palette
            .iter()
            .map(|p| super::super::profile::rgba(*p))
            .collect();
        assert!(img.pixels().all(|p| allowed.contains(&p.0)));
    }

    #[test]
    fn refuses_a_bad_recipe_naming_the_field() {
        let mut r = with(vec![Layer::Speckle {
            color: "orange".into(),
            amount: 0.1,
        }]);
        let e = render(&r, 32, 1, 1, &[]).unwrap_err();
        assert!(e.contains("layers[0].color"), "{e}");

        r.layers = vec![Layer::Grid {
            step: 99.0,
            width: None,
            color: "#000000".into(),
        }];
        assert!(render(&r, 32, 1, 1, &[])
            .unwrap_err()
            .contains("layers[0].step"));

        r.layers.clear();
        r.base.ramp = vec!["#000000".into()];
        assert!(render(&r, 32, 1, 1, &[]).unwrap_err().contains("base.ramp"));

        let unknown = r##"{"base":{"ramp":["#000000","#ffffff"]},"layers":[{"type":"lava","color":"#ff0000"}]}"##;
        assert!(serde_json::from_str::<TextureRecipe>(unknown).is_err());
        let extra = r##"{"base":{"ramp":["#000000","#ffffff"],"sparkle":true}}"##;
        assert!(serde_json::from_str::<TextureRecipe>(extra).is_err());
    }

    #[test]
    fn refuses_sizes_and_counts_it_cannot_draw() {
        let r = with(vec![]);
        assert!(render(&r, 30, 1, 1, &[]).is_err());
        assert!(render(&r, 4, 1, 1, &[]).is_err());
        assert!(render(&r, 32, 1, 0, &[]).is_err());
        assert!(render(&r, 32, 1, MAX_VARIANTS + 1, &[]).is_err());
    }

    fn prototype_recipes() -> Vec<(String, TextureRecipe)> {
        let text = include_str!("fixtures/prototype-recipes.json");
        let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(text).unwrap();
        map.into_iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    serde_json::from_value(v).unwrap_or_else(|e| panic!("{k}: {e}")),
                )
            })
            .collect()
    }

    #[test]
    fn the_prototype_recipes_parse_and_render() {
        let recipes = prototype_recipes();
        assert_eq!(recipes.len(), 12);
        for (name, r) in &recipes {
            render(r, 32, 1, 4, &[]).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    /// Not a check: writes each prototype recipe tiled 2×2, with its four
    /// variants, for a person to look at.
    /// `TEXTURE_PREVIEW_DIR=/tmp/t cargo test --lib texture -- --ignored`
    #[test]
    #[ignore]
    fn write_previews() {
        let Ok(dir) = std::env::var("TEXTURE_PREVIEW_DIR") else {
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        let recipes = prototype_recipes();
        let (n, scale) = (32u32, 6u32);
        let t = n * scale;
        let cols = 4u32;
        let rows = recipes.len() as u32;
        // Per recipe: the base tiled 2×2, then variants 1–3 each tiled 2×2.
        let mut sheet = RgbaImage::from_pixel(
            cols * (2 * t + 12),
            rows * (2 * t + 12),
            image::Rgba([40, 40, 40, 255]),
        );
        for (row, (_, r)) in recipes.iter().enumerate() {
            let v = render(r, n, 1, 4, &[]).unwrap();
            for (col, img) in v.iter().enumerate() {
                let big = image::imageops::resize(img, t, t, image::imageops::FilterType::Nearest);
                for (dx, dy) in [(0, 0), (t, 0), (0, t), (t, t)] {
                    image::imageops::overlay(
                        &mut sheet,
                        &big,
                        (col as u32 * (2 * t + 12) + dx) as i64,
                        (row as u32 * (2 * t + 12) + dy) as i64,
                    );
                }
            }
        }
        sheet.save(format!("{dir}/variants.png")).unwrap();
        // And each recipe's base laid out 4×4 with its variants mixed by a
        // hash of position, the way a tilemap would place them.
        let mut map = RgbaImage::new(recipes.len() as u32 * (4 * t + 12), 4 * t);
        for (i, (_, r)) in recipes.iter().enumerate() {
            let v = render(r, n, 1, 4, &[]).unwrap();
            for cy in 0..4u32 {
                for cx in 0..4u32 {
                    let k = (noise::variant_seed(cx as u64 * 31 + cy as u64, 0) % 4) as usize;
                    let big =
                        image::imageops::resize(&v[k], t, t, image::imageops::FilterType::Nearest);
                    image::imageops::overlay(
                        &mut map,
                        &big,
                        (i as u32 * (4 * t + 12) + cx * t) as i64,
                        (cy * t) as i64,
                    );
                }
            }
        }
        map.save(format!("{dir}/mixed.png")).unwrap();
    }
}
