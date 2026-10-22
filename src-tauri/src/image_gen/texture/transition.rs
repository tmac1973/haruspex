//! Transition sets: the 16 tiles a tilemap needs where two materials meet,
//! drawn from the materials' own recipes.
//!
//! A tile is set by its four corners, each one material or the other
//! (a corner-matching terrain, as Godot's "Match Corners" and Tiled's corner
//! sets read it). The border between them follows a blend of the corners,
//! wobbled by a noise field that every tile shares and that wraps at the tile
//! edge, so two tiles that share an edge's corners agree along it. Where all
//! four corners are one material the tile is that material's own tile, pixel
//! for pixel, so a set mixes with the plain tiles on a map.
//!
//! Two kinds:
//! - **top**: material A meets material B, seen from above.
//! - **side**: solid ground against transparent air, seen from the side, with
//!   an optional cap (grass on dirt) along the faces that point up.

use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};

use super::layers;
use super::noise::{fbm, variant_seed, Rng};
use super::recipe::{parse_color, validate, TextureRecipe, DESIGN_SIZE};
use crate::image_gen::palette::quantize_to;

/// Tiles in a set, and across its sheet.
pub const TILES: u32 = 16;
pub const COLUMNS: u32 = 4;

/// How far the border may wander, as a fraction of the tile. At this or less
/// a tile with four equal corners has no border in it, and an upward face
/// sits high enough in its tile for the deepest cap to fit below it.
const MAX_WOBBLE: f32 = 0.25;
const DEFAULT_WOBBLE: f32 = 0.1;
const DEFAULT_CAP: f32 = 4.0;
const MAX_CAP: f32 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TransitionView {
    /// Two ground materials meeting, seen from above.
    Top,
    /// Platform ground against air, seen from the side.
    Side,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TransitionEdge {
    /// How far the border wanders, as a fraction of the tile: 0 to 0.25.
    #[serde(default)]
    #[ts(optional)]
    pub wobble: Option<f32>,
    /// A `#rrggbb` line along the border, on A's side (top) or the solid's
    /// (side). None draws no line.
    #[serde(default)]
    #[ts(optional)]
    pub rim: Option<String>,
    /// Side sets only: how deep the cap is, in 32-pixel-tile pixels, 1 to 8.
    #[serde(default)]
    #[ts(optional)]
    pub cap_height: Option<f32>,
}

/// Refuse edge settings the renderer would have to guess at, naming the field.
pub fn validate_edge(view: TransitionView, e: &TransitionEdge) -> Result<(), String> {
    if let Some(w) = e.wobble {
        if !(w.is_finite() && (0.0..=MAX_WOBBLE).contains(&w)) {
            return Err(format!("edge.wobble: {w} is outside 0–{MAX_WOBBLE}."));
        }
    }
    if let Some(r) = &e.rim {
        if parse_color(r).is_none() {
            return Err(format!("edge.rim: \"{r}\" is not a #rrggbb colour."));
        }
    }
    if let Some(h) = e.cap_height {
        if view == TransitionView::Top {
            return Err("edge.cap_height: only a side set has a cap.".into());
        }
        if !(h.is_finite() && (1.0..=MAX_CAP).contains(&h)) {
            return Err(format!("edge.cap_height: {h} is outside 1–{MAX_CAP}."));
        }
    }
    Ok(())
}

/// Corner bits of tile `i`: NW, NE, SW, SE. A set bit is A, or solid.
fn corners(i: u32) -> [bool; 4] {
    [i & 1 != 0, i & 2 != 0, i & 4 != 0, i & 8 != 0]
}

/// The noise every tile of a set shares, periodic over the tile.
fn border_field(seed_a: u64, n: u32) -> Vec<f32> {
    fbm(&mut Rng::new(variant_seed(seed_a, 101)), n, 8, 3)
}

/// Which pixels of tile `i` are A (or solid), from the shared wobble field.
fn mask(i: u32, n: u32, field: &[f32], wobble: f32) -> Vec<bool> {
    (0..n * n)
        .map(|p| solid_at(i, n, field, wobble, (p % n) as i64, (p / n) as i64))
        .collect()
}

/// Whether pixel `(x, y)` of tile `i` is A (or solid).
///
/// The blend is sampled so the first and last columns (and rows) sit exactly
/// on the tile's edges, where it depends only on that edge's two corners. A
/// pixel one past an edge therefore takes the edge's blend and the shared
/// noise field at its own position: exactly what the neighbouring tile,
/// which shares those corners, draws there.
fn raw_at(i: u32, n: u32, field: &[f32], wobble: f32, x: i64, y: i64) -> bool {
    let [nw, ne, sw, se] = corners(i).map(|c| if c { 1.0f32 } else { 0.0 });
    let at = |p: i64| (p as f32 / (n - 1) as f32).clamp(0.0, 1.0);
    let (u, v) = (at(x), at(y));
    let m = nw * (1.0 - u) * (1.0 - v) + ne * u * (1.0 - v) + sw * (1.0 - u) * v + se * u * v;
    let f = field[(y.rem_euclid(n as i64) * n as i64 + x.rem_euclid(n as i64)) as usize];
    m + wobble * 2.0 * (f - 0.5) > 0.5
}

/// [`raw_at`], less the single-pixel specks noise leaves by the border: a
/// pixel whose four neighbours all disagree with it takes their side.
fn solid_at(i: u32, n: u32, field: &[f32], wobble: f32, x: i64, y: i64) -> bool {
    let here = raw_at(i, n, field, wobble, x, y);
    let lone = [(0, -1), (-1, 0), (0, 1), (1, 0)]
        .iter()
        .all(|(dx, dy)| raw_at(i, n, field, wobble, x + dx, y + dy) != here);
    here != lone
}

/// Draw a set: a `4n × 4n` sheet of 16 tiles, tile `i` at cell
/// `(i % 4, i / 4)`. `other` is material B (top, required) or the cap (side,
/// optional). Each material is drawn as `render` draws its first variant
/// from its own seed, and the sheet is snapped to `palette` when one is given.
#[allow(clippy::too_many_arguments)]
pub fn render_transition(
    view: TransitionView,
    a: &TextureRecipe,
    other: Option<&TextureRecipe>,
    edge: &TransitionEdge,
    n: u32,
    seed_a: u64,
    seed_other: u64,
    palette: &[u32],
) -> Result<RgbaImage, String> {
    validate(a).map_err(|e| format!("a: {e}"))?;
    if let Some(o) = other {
        validate(o).map_err(|e| format!("other: {e}"))?;
    }
    validate_edge(view, edge)?;
    if view == TransitionView::Top && other.is_none() {
        return Err("A top set needs both materials.".into());
    }
    if !(8..=256).contains(&n) || !n.is_multiple_of(4) {
        return Err(format!(
            "A {n}-pixel tile cannot be drawn: use a multiple of 4 from 8 to 256."
        ));
    }

    let tile_a = layers::draw(a, n, variant_seed(seed_a, 0));
    let tile_o = other.map(|o| layers::draw(o, n, variant_seed(seed_other, 0)));
    // Finer than the materials' broad patches: a border of small irregular
    // bays, not a few big lumps that every copy of the edge repeats.
    let field = border_field(seed_a, n);
    let wobble = edge.wobble.unwrap_or(DEFAULT_WOBBLE);
    let rim = edge.rim.as_deref().and_then(parse_color);
    let cap = (edge.cap_height.unwrap_or(DEFAULT_CAP) * n as f32 / DESIGN_SIZE)
        .round()
        .max(1.0) as u32;

    let mut sheet = RgbaImage::new(COLUMNS * n, COLUMNS * n);
    for i in 0..TILES {
        let m = mask(i, n, &field, wobble);
        let inside = |x: i64, y: i64| -> Option<bool> {
            (x >= 0 && y >= 0 && x < n as i64 && y < n as i64)
                .then(|| m[(y as u32 * n + x as u32) as usize])
        };
        // A neighbour one pixel away, past the edge or not, for the rim.
        let near =
            |x: i64, y: i64| inside(x, y).unwrap_or_else(|| solid_at(i, n, &field, wobble, x, y));
        let (ox, oy) = ((i % COLUMNS) * n, (i / COLUMNS) * n);
        for y in 0..n {
            for x in 0..n {
                let here = m[(y * n + x) as usize];
                let (xi, yi) = (x as i64, y as i64);
                let px = match view {
                    TransitionView::Top => {
                        let from = if here {
                            &tile_a
                        } else {
                            tile_o.as_ref().unwrap()
                        };
                        let mut p = from.get_pixel(x, y).0;
                        let border = [(0, -1), (-1, 0), (0, 1), (1, 0)]
                            .iter()
                            .any(|(dx, dy)| !near(xi + dx, yi + dy));
                        if here && border {
                            if let Some(c) = rim {
                                p = [c[0], c[1], c[2], 255];
                            }
                        }
                        p
                    }
                    TransitionView::Side => {
                        if !here {
                            [0, 0, 0, 0]
                        } else {
                            // Air within `cap` rows above, inside the tile: an
                            // upward face, which takes the cap. Only within the
                            // tile: carried further than a pixel, this tile's
                            // blend is no longer the tile above's.
                            let capped = tile_o.is_some()
                                && (1..=cap as i64).any(|d| inside(xi, yi - d) == Some(false));
                            let side = [(-1, 0), (1, 0), (0, 1)]
                                .iter()
                                .any(|(dx, dy)| !near(xi + dx, yi + dy));
                            let mut p = if capped {
                                tile_o.as_ref().unwrap().get_pixel(x, y).0
                            } else {
                                tile_a.get_pixel(x, y).0
                            };
                            if side {
                                if let Some(c) = rim {
                                    p = [c[0], c[1], c[2], 255];
                                }
                            }
                            p
                        }
                    }
                };
                sheet.put_pixel(ox + x, oy + y, Rgba(px));
            }
        }
    }
    if !palette.is_empty() {
        quantize_to(&mut sheet, palette);
    }
    Ok(sheet)
}

/// The preview maps, as corner grids: rows top first, 1 for A or solid. Tile
/// `(x, y)` takes corners `g[y][x]` (NW), `g[y][x+1]` (NE), `g[y+1][x]` (SW)
/// and `g[y+1][x+1]` (SE). Each was chosen to use all 16 tiles.
const TOP_LAYOUT: [&str; 7] = [
    "0000000", "0000110", "0110000", "0101100", "0110110", "0001110", "0000000",
];
const SIDE_LAYOUT: [&str; 5] = [
    "000000000",
    "101011100",
    "011011001",
    "100101100",
    "111111111",
];

fn layout(view: TransitionView) -> Vec<Vec<bool>> {
    let rows: &[&str] = match view {
        TransitionView::Top => &TOP_LAYOUT,
        TransitionView::Side => &SIDE_LAYOUT,
    };
    rows.iter()
        .map(|r| r.bytes().map(|b| b == b'1').collect())
        .collect()
}

/// The tile indices of a layout, row by row.
fn layout_tiles(g: &[Vec<bool>]) -> Vec<Vec<u32>> {
    (0..g.len() - 1)
        .map(|y| {
            (0..g[0].len() - 1)
                .map(|x| {
                    g[y][x] as u32
                        | (g[y][x + 1] as u32) << 1
                        | (g[y + 1][x] as u32) << 2
                        | (g[y + 1][x + 1] as u32) << 3
                })
                .collect()
        })
        .collect()
}

/// How wide a preview aims to be, in pixels.
const PREVIEW_EDGE: u32 = 480;

/// A set laid out as a small map, for a person or the judge: tiles picked
/// from a fixed corner grid, scaled up by a whole number. Air shows as a
/// checkerboard.
pub fn transition_preview(view: TransitionView, sheet: &RgbaImage, n: u32) -> RgbaImage {
    let tiles = layout_tiles(&layout(view));
    let (cols, rows) = (tiles[0].len() as u32, tiles.len() as u32);
    let scale = (PREVIEW_EDGE / (cols * n)).max(1);
    let t = n * scale;
    let mut out = RgbaImage::new(cols * t, rows * t);
    for (ty, row) in tiles.iter().enumerate() {
        for (tx, &i) in row.iter().enumerate() {
            let (sx, sy) = ((i % COLUMNS) * n, (i / COLUMNS) * n);
            for y in 0..t {
                for x in 0..t {
                    let (ox, oy) = (tx as u32 * t + x, ty as u32 * t + y);
                    let p = sheet.get_pixel(sx + x / scale, sy + y / scale).0;
                    let px = if p[3] == 0 {
                        crate::image_gen::sheet::checker(ox, oy)
                    } else {
                        p
                    };
                    out.put_pixel(ox, oy, Rgba(px));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::render;
    use super::*;

    fn recipe(json: &str) -> TextureRecipe {
        serde_json::from_str(json).unwrap()
    }

    fn grass() -> TextureRecipe {
        recipe(
            r##"{"base":{"ramp":["#3d5a26","#46652c","#507032"],"cells":5},"layers":[{"type":"speckle","color":"#6a9a3c","amount":0.06}]}"##,
        )
    }

    fn dirt() -> TextureRecipe {
        recipe(
            r##"{"base":{"ramp":["#3e3428","#4a3e2f","#564836"],"cells":4},"layers":[{"type":"speckle","color":"#2f271e","amount":0.06}]}"##,
        )
    }

    fn edge() -> TransitionEdge {
        TransitionEdge {
            wobble: Some(0.2),
            rim: Some("#202020".into()),
            cap_height: None,
        }
    }

    fn tile(sheet: &RgbaImage, i: u32, n: u32) -> RgbaImage {
        image::imageops::crop_imm(sheet, (i % 4) * n, (i / 4) * n, n, n).to_image()
    }

    #[test]
    fn uniform_tiles_equal_the_materials() {
        for n in [16, 32, 64] {
            let (a, b) = (grass(), dirt());
            let s = render_transition(TransitionView::Top, &a, Some(&b), &edge(), n, 7, 9, &[])
                .unwrap();
            assert_eq!(
                tile(&s, 15, n).as_raw(),
                render(&a, n, 7, 1, &[]).unwrap()[0].as_raw()
            );
            assert_eq!(
                tile(&s, 0, n).as_raw(),
                render(&b, n, 9, 1, &[]).unwrap()[0].as_raw()
            );
        }
    }

    fn diff(a: [u8; 4], b: [u8; 4]) -> f64 {
        (0..4).map(|i| (a[i] as f64 - b[i] as f64).abs()).sum()
    }

    #[test]
    fn neighbours_agree_at_every_edge() {
        // Across a shared edge, the step is no sharper than the sharpest step
        // inside the sheet's tiles: no seam between matching tiles.
        for view in [TransitionView::Top, TransitionView::Side] {
            for seed in 1..=10u64 {
                let n = 32;
                let cap = grass();
                let other = if view == TransitionView::Top {
                    dirt()
                } else {
                    cap
                };
                let s = render_transition(
                    view,
                    &grass(),
                    Some(&other),
                    &edge(),
                    n,
                    seed,
                    seed + 50,
                    &[],
                )
                .unwrap();
                let tiles: Vec<RgbaImage> = (0..16).map(|i| tile(&s, i, n)).collect();
                let mut worst = 0.0f64;
                for t in &tiles {
                    for y in 0..n {
                        for x in 0..n - 1 {
                            worst = worst.max(diff(t.get_pixel(x, y).0, t.get_pixel(x + 1, y).0));
                        }
                    }
                }
                for i in 0..16u32 {
                    for j in 0..16u32 {
                        let [_, ne, _, se] = corners(i);
                        let [nw, _, sw, _] = corners(j);
                        if (ne, se) != (nw, sw) {
                            continue;
                        }
                        let step: f64 = (0..n)
                            .map(|y| {
                                diff(
                                    tiles[i as usize].get_pixel(n - 1, y).0,
                                    tiles[j as usize].get_pixel(0, y).0,
                                )
                            })
                            .fold(0.0, f64::max);
                        assert!(
                            step <= worst * 1.15 + 1.0,
                            "{view:?} seed {seed}: {i}→{j} step {step}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn flat_and_inner_faces_leave_room_for_the_cap() {
        // A flat top (12) and the inner corners (13, 14) keep their upward
        // faces high enough for the deepest cap. A tile with one solid
        // corner curves its face down toward the tile below, where the cap
        // is clipped: that is the corner turning into a side face.
        let n = 32;
        let field_edge = TransitionEdge {
            wobble: Some(MAX_WOBBLE),
            rim: None,
            cap_height: None,
        };
        let limit = (0.75 * n as f32).ceil() as u32 + 1;
        for seed in 1..=20u64 {
            let field = border_field(seed, n);
            for i in [12, 13, 14] {
                let m = mask(i, n, &field, field_edge.wobble.unwrap());
                for y in 1..n {
                    for x in 0..n {
                        if m[(y * n + x) as usize] && !m[((y - 1) * n + x) as usize] {
                            assert!(y <= limit, "tile {i} seed {seed}: upward face at row {y}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn cap_only_on_upward_faces() {
        let n = 32;
        let cap = recipe(r##"{"base":{"ramp":["#ff00ff","#ff00ff"],"dither":false},"layers":[]}"##);
        let e = TransitionEdge {
            wobble: Some(0.1),
            rim: None,
            cap_height: Some(4.0),
        };
        let s =
            render_transition(TransitionView::Side, &dirt(), Some(&cap), &e, n, 1, 2, &[]).unwrap();
        let magenta = |t: &RgbaImage| t.pixels().filter(|p| p.0 == [255, 0, 255, 255]).count();
        // Ground below, air above: a top face.
        assert!(magenta(&tile(&s, 12, n)) > 0);
        // Ground above, air below: a ceiling, no grass on it.
        assert_eq!(magenta(&tile(&s, 3, n)), 0);
    }

    #[test]
    fn air_is_transparent() {
        let n = 16;
        let s =
            render_transition(TransitionView::Side, &dirt(), None, &edge(), n, 1, 2, &[]).unwrap();
        assert!(tile(&s, 0, n).pixels().all(|p| p[3] == 0));
        assert!(tile(&s, 15, n).pixels().all(|p| p[3] == 255));
    }

    #[test]
    fn edge_validation_names_fields() {
        let e = |w, r: Option<&str>, c| TransitionEdge {
            wobble: w,
            rim: r.map(String::from),
            cap_height: c,
        };
        let top = TransitionView::Top;
        assert!(validate_edge(top, &e(Some(0.3), None, None))
            .unwrap_err()
            .starts_with("edge.wobble"));
        assert!(validate_edge(top, &e(None, Some("red"), None))
            .unwrap_err()
            .starts_with("edge.rim"));
        assert!(validate_edge(top, &e(None, None, Some(4.0)))
            .unwrap_err()
            .starts_with("edge.cap_height"));
        let side = TransitionView::Side;
        assert!(validate_edge(side, &e(None, None, Some(9.0)))
            .unwrap_err()
            .starts_with("edge.cap_height"));
        validate_edge(side, &e(Some(0.25), Some("#102030"), Some(8.0))).unwrap();
    }

    #[test]
    fn a_top_set_needs_both_materials() {
        assert!(
            render_transition(TransitionView::Top, &grass(), None, &edge(), 32, 1, 2, &[]).is_err()
        );
    }

    #[test]
    fn preview_grids_cover_every_tile() {
        for view in [TransitionView::Top, TransitionView::Side] {
            let used: std::collections::HashSet<u32> =
                layout_tiles(&layout(view)).into_iter().flatten().collect();
            assert_eq!(used.len(), 16, "{view:?}");
        }
    }

    #[test]
    fn preview_scales_by_a_whole_number() {
        let n = 32;
        let s = render_transition(
            TransitionView::Top,
            &grass(),
            Some(&dirt()),
            &edge(),
            n,
            1,
            2,
            &[],
        )
        .unwrap();
        let p = transition_preview(TransitionView::Top, &s, n);
        assert_eq!(p.width() % (6 * n), 0);
        assert_eq!((p.width(), p.height()), (6 * n * 2, 6 * n * 2));
    }

    /// Not a check: writes grass meeting dirt, and dirt with a grass cap, as
    /// previews. `TEXTURE_PREVIEW_DIR=/tmp/t cargo test --lib transition -- --ignored`
    #[test]
    #[ignore]
    fn write_transition_previews() {
        let Ok(dir) = std::env::var("TEXTURE_PREVIEW_DIR") else {
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        let n = 32;
        let side_edge = TransitionEdge {
            wobble: Some(0.15),
            rim: Some("#2a2018".into()),
            cap_height: Some(4.0),
        };
        let top = render_transition(
            TransitionView::Top,
            &grass(),
            Some(&dirt()),
            &edge(),
            n,
            3,
            4,
            &[],
        )
        .unwrap();
        let side = render_transition(
            TransitionView::Side,
            &dirt(),
            Some(&grass()),
            &side_edge,
            n,
            3,
            4,
            &[],
        )
        .unwrap();
        top.save(format!("{dir}/top-sheet.png")).unwrap();
        side.save(format!("{dir}/side-sheet.png")).unwrap();
        transition_preview(TransitionView::Top, &top, n)
            .save(format!("{dir}/top-map.png"))
            .unwrap();
        transition_preview(TransitionView::Side, &side, n)
            .save(format!("{dir}/side-map.png"))
            .unwrap();
    }

    /// Not a check: lays out a set from a live run as a map, and says whether
    /// its plain tile matches the material's own file.
    /// `LIVE_SHEET=s.png LIVE_VIEW=top LIVE_MATERIAL=grass.png cargo test --lib live_map -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_map_from_sheet() {
        let Ok(path) = std::env::var("LIVE_SHEET") else {
            return;
        };
        let view = match std::env::var("LIVE_VIEW").as_deref() {
            Ok("side") => TransitionView::Side,
            _ => TransitionView::Top,
        };
        let sheet = image::open(&path).unwrap().to_rgba8();
        let n = sheet.width() / 4;
        let map = transition_preview(view, &sheet, n);
        let out = format!("{}-map.png", path.trim_end_matches(".png"));
        map.save(&out).unwrap();
        eprintln!("map: {out}");
        if let Ok(material) = std::env::var("LIVE_MATERIAL") {
            let m = image::open(&material).unwrap().to_rgba8();
            let same = tile(&sheet, 15, n).as_raw() == m.as_raw();
            eprintln!(
                "tile 15 against {material}: {}",
                if same { "match" } else { "differs" }
            );
        }
    }
}
