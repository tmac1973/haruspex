//! A texture recipe: a base material and a list of layers over it.
//!
//! The vocabulary is fixed on purpose. A model writes these, and a recipe it
//! can only build from layers that wrap at the tile edge is a texture that
//! cannot fail to tile, whatever it asked for. Positions and sizes are in the
//! pixels of a 32-pixel tile and are scaled to the size rendered.

use serde::{Deserialize, Serialize};

/// The tile size positions and sizes are written for.
pub const DESIGN_SIZE: f32 = 32.0;

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct TextureRecipe {
    pub base: BaseLayer,
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// A darker band along the bottom, for walls drawn with a front face.
    /// Absent for a flat, top-down tile.
    #[serde(default)]
    #[ts(optional)]
    pub wall_face: Option<WallFace>,
}

/// The material itself: noise mapped onto a ramp of shades, dark to light.
#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct BaseLayer {
    /// 2 to 8 colours, `#rrggbb`, darkest first.
    pub ramp: Vec<String>,
    /// Noise cells across the tile: 2 is broad patches, 8 is fine grain.
    #[serde(default = "default_cells")]
    #[ts(optional)]
    pub cells: Option<u32>,
    #[serde(default = "default_octaves")]
    #[ts(optional)]
    pub octaves: Option<u32>,
    /// Ordered dithering between shades. Off gives flat bands.
    #[serde(default = "default_true")]
    #[ts(optional)]
    pub dither: Option<bool>,
}

fn default_cells() -> Option<u32> {
    Some(4)
}
fn default_octaves() -> Option<u32> {
    Some(3)
}
fn default_true() -> Option<bool> {
    Some(true)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Axis {
    /// A line running left to right.
    X,
    /// A line running top to bottom.
    Y,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub enum Layer {
    /// Single pixels scattered at random: grit, gravel, flecks.
    Speckle { color: String, amount: f32 },
    /// Thin lines along the borders of irregular cells: cracked asphalt,
    /// dried mud, flagstones. `coverage` 0 cracks everywhere, 1 nowhere.
    Cracks {
        color: String,
        cells: u32,
        coverage: f32,
        #[serde(default = "default_crack_width")]
        #[ts(optional)]
        width: Option<f32>,
    },
    /// Irregular patches: stains, moss, puddles, bare earth. Higher
    /// `threshold` means fewer, smaller patches.
    Blotches {
        color: String,
        cells: u32,
        threshold: f32,
    },
    /// Bricks or blocks in rows, each a random one of `colors`, with mortar.
    Bricks {
        w: f32,
        h: f32,
        gap: f32,
        offset: bool,
        colors: Vec<String>,
        mortar: String,
    },
    /// A painted line, solid or dashed: lane markings, parking bays.
    Stripes {
        axis: Axis,
        pos: f32,
        width: f32,
        #[serde(default)]
        #[ts(optional)]
        dash: Option<[f32; 2]>,
        color: String,
        #[serde(default)]
        #[ts(optional)]
        wear: Option<f32>,
    },
    /// Wavy highlight lines: water. `freq` is waves down a 32-pixel tile.
    Waves {
        color: String,
        freq: u32,
        threshold: f32,
    },
    /// Straight seams on a square grid: floor tiles, panels, grates.
    Grid {
        step: f32,
        #[serde(default = "default_one")]
        #[ts(optional)]
        width: Option<f32>,
        color: String,
    },
    /// A light top-left and dark bottom-right edge on each grid cell, so
    /// tiles or plates look raised.
    Bevel {
        step: f32,
        light: String,
        dark: String,
    },
}

fn default_crack_width() -> Option<f32> {
    Some(0.8)
}
fn default_one() -> Option<f32> {
    Some(1.0)
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct WallFace {
    /// Rows of the face, in 32-pixel-tile pixels.
    pub height: f32,
    /// How dark the face is, 0 (black) to 1 (unchanged).
    pub shade: f32,
}

/// `#rrggbb` (or `rrggbb`) to RGB.
pub fn parse_color(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(h, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

fn color(field: &str, s: &str) -> Result<[u8; 3], String> {
    parse_color(s).ok_or_else(|| format!("{field}: \"{s}\" is not a #rrggbb colour."))
}

fn range(field: &str, v: f32, lo: f32, hi: f32) -> Result<(), String> {
    if v.is_finite() && v >= lo && v <= hi {
        Ok(())
    } else {
        Err(format!("{field}: {v} is outside {lo}–{hi}."))
    }
}

fn range_u(field: &str, v: u32, lo: u32, hi: u32) -> Result<(), String> {
    range(field, v as f32, lo as f32, hi as f32)
}

/// Refuse anything the renderer would have to guess at, naming the field. The
/// message goes back to the model that wrote the recipe, so it says what is
/// wrong rather than that something is.
pub fn validate(r: &TextureRecipe) -> Result<(), String> {
    let b = &r.base;
    range_u("base.ramp", b.ramp.len() as u32, 2, 8)
        .map_err(|_| "base.ramp: give 2 to 8 colours, darkest first.".to_string())?;
    for (i, c) in b.ramp.iter().enumerate() {
        color(&format!("base.ramp[{i}]"), c)?;
    }
    range_u("base.cells", b.cells.unwrap_or(4), 1, 16)?;
    range_u("base.octaves", b.octaves.unwrap_or(3), 1, 4)?;
    if r.layers.len() > 8 {
        return Err("layers: at most 8.".into());
    }
    for (i, l) in r.layers.iter().enumerate() {
        let p = |f: &str| format!("layers[{i}].{f}");
        match l {
            Layer::Speckle { color: c, amount } => {
                color(&p("color"), c)?;
                range(&p("amount"), *amount, 0.0, 0.5)?;
            }
            Layer::Cracks {
                color: c,
                cells,
                coverage,
                width,
            } => {
                color(&p("color"), c)?;
                range_u(&p("cells"), *cells, 1, 12)?;
                range(&p("coverage"), *coverage, 0.0, 1.0)?;
                range(&p("width"), width.unwrap_or(0.8), 0.2, 4.0)?;
            }
            Layer::Blotches {
                color: c,
                cells,
                threshold,
            } => {
                color(&p("color"), c)?;
                range_u(&p("cells"), *cells, 1, 16)?;
                range(&p("threshold"), *threshold, 0.0, 1.0)?;
            }
            Layer::Bricks {
                w,
                h,
                gap,
                colors,
                mortar,
                ..
            } => {
                range(&p("w"), *w, 2.0, DESIGN_SIZE)?;
                range(&p("h"), *h, 2.0, DESIGN_SIZE)?;
                range(&p("gap"), *gap, 0.0, 4.0)?;
                if colors.is_empty() || colors.len() > 6 {
                    return Err(format!("{}: give 1 to 6 colours.", p("colors")));
                }
                for (k, c) in colors.iter().enumerate() {
                    color(&format!("{}[{k}]", p("colors")), c)?;
                }
                color(&p("mortar"), mortar)?;
            }
            Layer::Stripes {
                pos,
                width,
                dash,
                color: c,
                wear,
                ..
            } => {
                range(&p("pos"), *pos, 0.0, DESIGN_SIZE - 1.0)?;
                range(&p("width"), *width, 1.0, DESIGN_SIZE / 2.0)?;
                if let Some([on, off]) = dash {
                    range(&p("dash[0]"), *on, 1.0, DESIGN_SIZE)?;
                    range(&p("dash[1]"), *off, 1.0, DESIGN_SIZE)?;
                }
                color(&p("color"), c)?;
                range(&p("wear"), wear.unwrap_or(0.0), 0.0, 0.9)?;
            }
            Layer::Waves {
                color: c,
                freq,
                threshold,
            } => {
                color(&p("color"), c)?;
                range_u(&p("freq"), *freq, 1, 16)?;
                range(&p("threshold"), *threshold, -1.0, 1.0)?;
            }
            Layer::Grid {
                step,
                width,
                color: c,
            } => {
                range(&p("step"), *step, 2.0, DESIGN_SIZE)?;
                range(&p("width"), width.unwrap_or(1.0), 1.0, 4.0)?;
                color(&p("color"), c)?;
            }
            Layer::Bevel { step, light, dark } => {
                range(&p("step"), *step, 4.0, DESIGN_SIZE)?;
                color(&p("light"), light)?;
                color(&p("dark"), dark)?;
            }
        }
    }
    if let Some(f) = &r.wall_face {
        range("wall_face.height", f.height, 1.0, DESIGN_SIZE / 2.0)?;
        range("wall_face.shade", f.shade, 0.0, 1.0)?;
    }
    Ok(())
}
