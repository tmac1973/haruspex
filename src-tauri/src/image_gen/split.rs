//! Cutting one generated sheet into the separate sprites drawn on it.
//!
//! A model asked for nine subjects in a 3×3 grid on a transparent canvas draws
//! them as nine islands of opaque pixels. Finding them is connected
//! components; the two things that make it more than that are measured, not
//! guessed:
//!
//! - **A sprite is not always one island.** A sword's pommel, a shopping
//!   trolley's handle, a scrap of debris beside a burnt car — drawn detached by
//!   a few pixels. Islands closer than a gap are joined, and the gap scales
//!   with the size of the pieces, not the canvas: a fixed fraction of the
//!   canvas split a trolley from its own handle on a 2048 sheet, where the
//!   sprites were no larger than at 1024 (phase 17, step 2).
//! - **Specks are not sprites.** A handful of stray pixels joins the piece it
//!   sits beside, or is dropped when it sits beside nothing.
//!
//! What this does NOT do is decide whether the sheet came out right. Two
//! sprites drawn touching come back as one piece, and a missing subject as one
//! piece fewer; the caller knows how many it asked for and where, and it is
//! the one that judges. Guessing a split here would hide the fault it needs to
//! see.

use std::collections::HashMap;

use image::{Rgba, RgbaImage};

/// One sprite found on a sheet, in sheet coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct Piece {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Area-weighted centre of the piece's own pixels.
    pub cx: f32,
    pub cy: f32,
    /// Opaque pixels.
    pub area: u32,
    /// Just this piece's pixels, cropped to its box. A neighbour whose box
    /// overlaps is not copied in.
    pub image: RgbaImage,
}

/// Tunables, with the values the spike's cutter was measured with.
#[derive(Clone, Copy, Debug)]
pub struct SplitOptions {
    /// An island smaller than this fraction of the canvas, with nothing within
    /// the gap to join, is a speck. 1024² × 0.0005 ≈ 500 px; the smallest
    /// real sprite measured on a 3×3 sheet was a coin of ~10,000 px.
    pub min_piece_fraction: f32,
    /// Islands closer than this many times the median piece's side are one
    /// piece. A detached pommel sits a few pixels off; neighbouring sprites on
    /// a 3×3 sheet sit roughly half a side apart.
    pub join_fraction: f32,
}

impl Default for SplitOptions {
    fn default() -> Self {
        Self {
            min_piece_fraction: 0.0005,
            join_fraction: 0.15,
        }
    }
}

struct Island {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    area: u32,
    sum_x: u64,
    sum_y: u64,
    /// Pixels with a transparent (or off-canvas) neighbour: the only ones that
    /// can be nearest to another island.
    edge: Vec<(u32, u32)>,
}

/// Label 4-connected opaque islands. Returns the label per pixel and the islands.
fn islands(img: &RgbaImage) -> (Vec<u32>, Vec<Island>) {
    let (w, h) = img.dimensions();
    let idx = |x: u32, y: u32| (y * w + x) as usize;
    let mut label = vec![u32::MAX; (w * h) as usize];
    let mut out: Vec<Island> = Vec::new();
    for y in 0..h {
        for x in 0..w {
            if img.get_pixel(x, y).0[3] == 0 || label[idx(x, y)] != u32::MAX {
                continue;
            }
            let id = out.len() as u32;
            let mut isl = Island {
                x0: x,
                y0: y,
                x1: x,
                y1: y,
                area: 0,
                sum_x: 0,
                sum_y: 0,
                edge: Vec::new(),
            };
            let mut stack = vec![(x, y)];
            label[idx(x, y)] = id;
            while let Some((cx, cy)) = stack.pop() {
                isl.area += 1;
                isl.sum_x += cx as u64;
                isl.sum_y += cy as u64;
                isl.x0 = isl.x0.min(cx);
                isl.y0 = isl.y0.min(cy);
                isl.x1 = isl.x1.max(cx);
                isl.y1 = isl.y1.max(cy);
                let neighbours = [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ];
                let mut on_edge = false;
                for (nx, ny) in neighbours {
                    if nx >= w || ny >= h || img.get_pixel(nx, ny).0[3] == 0 {
                        on_edge = true;
                        continue;
                    }
                    if label[idx(nx, ny)] != u32::MAX {
                        continue;
                    }
                    label[idx(nx, ny)] = id;
                    stack.push((nx, ny));
                }
                if on_edge {
                    isl.edge.push((cx, cy));
                }
            }
            out.push(isl);
        }
    }
    (label, out)
}

/// Gap between two boxes in pixels: 0 when they touch or overlap.
fn box_gap(a: &Island, b: &Island) -> u32 {
    let dx = b.x0.saturating_sub(a.x1).max(a.x0.saturating_sub(b.x1));
    let dy = b.y0.saturating_sub(a.y1).max(a.y0.saturating_sub(b.y1));
    dx.max(dy)
}

/// Do any two pixels of these islands sit within `gap` of each other?
///
/// Boxes alone are not enough: an L-shaped sprite's box can wrap around a
/// neighbour that is nowhere near its pixels. So boxes only shortlist a pair,
/// and their edge pixels decide it, through a grid of `gap`-sized cells so
/// each edge pixel is compared with only its own neighbourhood.
fn near(a: &Island, b: &Island, gap: u32) -> bool {
    if box_gap(a, b) > gap {
        return false;
    }
    let cell = gap.max(1);
    let mut grid: HashMap<(u32, u32), Vec<(u32, u32)>> = HashMap::new();
    for &(x, y) in &b.edge {
        grid.entry((x / cell, y / cell)).or_default().push((x, y));
    }
    a.edge.iter().any(|&(x, y)| {
        let (gx, gy) = (x / cell, y / cell);
        (gx.saturating_sub(1)..=gx + 1).any(|cx| {
            (gy.saturating_sub(1)..=gy + 1).any(|cy| {
                grid.get(&(cx, cy)).is_some_and(|pts| {
                    pts.iter()
                        .any(|&(qx, qy)| qx.abs_diff(x).max(qy.abs_diff(y)) <= gap)
                })
            })
        })
    })
}

fn find(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

/// Cut a sheet into its pieces, in reading order: top row first, left to right.
///
/// The sheet's alpha is read as-is — anything above 0 is opaque — so harden it
/// first if it has a soft edge (`normalize::harden_alpha`).
pub fn split_sheet(img: &RgbaImage, opts: SplitOptions) -> Vec<Piece> {
    let (w, h) = img.dimensions();
    let (label, isl) = islands(img);
    if isl.is_empty() {
        return Vec::new();
    }
    let canvas = (w as f32) * (h as f32);
    let floor = (canvas * opts.min_piece_fraction).max(1.0);
    let big: Vec<usize> = (0..isl.len())
        .filter(|&i| isl[i].area as f32 >= floor)
        .collect();
    if big.is_empty() {
        return Vec::new();
    }

    // The join gap, from the pieces themselves.
    let mut areas: Vec<u32> = big.iter().map(|&i| isl[i].area).collect();
    areas.sort_unstable();
    let median_side = (areas[areas.len() / 2] as f32).sqrt();
    let gap = (median_side * opts.join_fraction).round() as u32;

    // Join every pair of islands within the gap, where at least one of the
    // two is a real piece. Specks join what they sit beside; two specks do
    // not join each other into a piece.
    let mut parent: Vec<usize> = (0..isl.len()).collect();
    for &a in &big {
        for j in 0..isl.len() {
            if j != a && near(&isl[a], &isl[j], gap) {
                let (ra, rb) = (find(&mut parent, a), find(&mut parent, j));
                if ra != rb {
                    parent[rb] = ra;
                }
            }
        }
    }

    // Groups that contain at least one real piece.
    let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
    for i in 0..isl.len() {
        let root = find(&mut parent, i);
        match groups.iter_mut().find(|(r, _)| *r == root) {
            Some((_, members)) => members.push(i),
            None => groups.push((root, vec![i])),
        }
    }
    groups.retain(|(_, m)| m.iter().any(|i| big.contains(i)));

    let mut pieces: Vec<Piece> = groups
        .into_iter()
        .map(|(_, members)| {
            let x0 = members.iter().map(|&i| isl[i].x0).min().unwrap_or(0);
            let y0 = members.iter().map(|&i| isl[i].y0).min().unwrap_or(0);
            let x1 = members.iter().map(|&i| isl[i].x1).max().unwrap_or(0);
            let y1 = members.iter().map(|&i| isl[i].y1).max().unwrap_or(0);
            let area: u32 = members.iter().map(|&i| isl[i].area).sum();
            let sx: u64 = members.iter().map(|&i| isl[i].sum_x).sum();
            let sy: u64 = members.iter().map(|&i| isl[i].sum_y).sum();
            let mut image = RgbaImage::from_pixel(x1 - x0 + 1, y1 - y0 + 1, Rgba([0, 0, 0, 0]));
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let l = label[(y * w + x) as usize];
                    if l != u32::MAX && members.contains(&(l as usize)) {
                        image.put_pixel(x - x0, y - y0, *img.get_pixel(x, y));
                    }
                }
            }
            Piece {
                x: x0,
                y: y0,
                width: x1 - x0 + 1,
                height: y1 - y0 + 1,
                cx: sx as f32 / area.max(1) as f32,
                cy: sy as f32 / area.max(1) as f32,
                area,
                image,
            }
        })
        .collect();

    reading_order(&mut pieces);
    pieces
}

/// Rows first, then left to right within a row.
///
/// A row is pieces whose centres sit within half a median piece-height of the
/// row's first one: a model does not draw a grid on exact lines, and sorting
/// by `cy` alone would interleave two rows whose sprites are offset by a few
/// pixels.
fn reading_order(pieces: &mut [Piece]) {
    if pieces.is_empty() {
        return;
    }
    let mut heights: Vec<u32> = pieces.iter().map(|p| p.height).collect();
    heights.sort_unstable();
    let tolerance = heights[heights.len() / 2] as f32 / 2.0;
    pieces.sort_by(|a, b| a.cy.total_cmp(&b.cy));
    let mut row = 0usize;
    let mut row_start = pieces[0].cy;
    let mut rows: Vec<usize> = Vec::with_capacity(pieces.len());
    for p in pieces.iter() {
        if p.cy - row_start > tolerance {
            row += 1;
            row_start = p.cy;
        }
        rows.push(row);
    }
    let mut keyed: Vec<(usize, f32, usize)> = rows
        .iter()
        .zip(pieces.iter())
        .enumerate()
        .map(|(i, (&r, p))| (r, p.cx, i))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let order: Vec<Piece> = keyed.iter().map(|&(_, _, i)| pieces[i].clone()).collect();
    pieces.clone_from_slice(&order);
}

#[cfg(test)]
mod tests {
    use super::*;

    const INK: Rgba<u8> = Rgba([40, 30, 20, 255]);

    fn canvas(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 0]))
    }

    fn square(img: &mut RgbaImage, x: u32, y: u32, side: u32) {
        for yy in y..y + side {
            for xx in x..x + side {
                img.put_pixel(xx, yy, INK);
            }
        }
    }

    /// A 3×3 grid of squares on a 300×300 canvas, with an optional square
    /// left out.
    fn grid(skip: Option<usize>) -> RgbaImage {
        let mut img = canvas(300, 300);
        for i in 0..9 {
            if Some(i) == skip {
                continue;
            }
            square(
                &mut img,
                20 + (i as u32 % 3) * 100,
                20 + (i as u32 / 3) * 100,
                60,
            );
        }
        img
    }

    #[test]
    fn nine_separate_squares_are_nine_pieces_in_reading_order() {
        let pieces = split_sheet(&grid(None), SplitOptions::default());
        assert_eq!(pieces.len(), 9);
        let centres: Vec<(u32, u32)> = pieces
            .iter()
            .map(|p| (p.cx.round() as u32, p.cy.round() as u32))
            .collect();
        let expected: Vec<(u32, u32)> = (0..9)
            .map(|i| (50 + (i % 3) * 100, 50 + (i / 3) * 100))
            .collect();
        assert_eq!(centres, expected);
    }

    #[test]
    fn rows_offset_by_a_few_pixels_still_read_left_to_right() {
        // A model's grid is not ruled. The middle square of the top row sits
        // lower than its neighbours; sorting by height alone would read it
        // after the right-hand one.
        let mut img = canvas(300, 120);
        square(&mut img, 20, 20, 60);
        square(&mut img, 120, 35, 60);
        square(&mut img, 220, 10, 60);
        let xs: Vec<u32> = split_sheet(&img, SplitOptions::default())
            .iter()
            .map(|p| p.x)
            .collect();
        assert_eq!(xs, vec![20, 120, 220]);
    }

    #[test]
    fn a_missing_subject_is_one_piece_fewer_not_a_guess() {
        assert_eq!(
            split_sheet(&grid(Some(4)), SplitOptions::default()).len(),
            8
        );
    }

    #[test]
    fn a_detached_part_within_the_gap_stays_with_its_sprite() {
        // A sword's pommel drawn three pixels below the grip.
        let mut img = grid(None);
        square(&mut img, 45, 83, 8);
        let pieces = split_sheet(&img, SplitOptions::default());
        assert_eq!(pieces.len(), 9);
        assert_eq!(pieces[0].height, 71);
    }

    #[test]
    fn the_join_gap_follows_the_pieces_not_the_canvas() {
        // The same grid on a canvas four times the size. A gap proportional to
        // the canvas would now be four times wider and swallow neighbours; one
        // proportional to the pieces is unchanged.
        let mut img = canvas(1200, 1200);
        for i in 0..9u32 {
            square(&mut img, 20 + (i % 3) * 100, 20 + (i / 3) * 100, 60);
        }
        assert_eq!(split_sheet(&img, SplitOptions::default()).len(), 9);
    }

    #[test]
    fn two_sprites_drawn_touching_come_back_as_one() {
        // Reported to the caller as one piece fewer; it is the one that knows
        // two subjects were asked for there.
        let mut img = grid(None);
        square(&mut img, 80, 40, 40); // bridges squares 0 and 1
        let pieces = split_sheet(&img, SplitOptions::default());
        assert_eq!(pieces.len(), 8);
        assert!(pieces[0].width > 150);
    }

    #[test]
    fn a_lone_speck_is_dropped_and_a_speck_beside_a_sprite_is_kept() {
        let mut img = grid(None);
        square(&mut img, 290, 150, 2); // far from everything
        square(&mut img, 82, 82, 2); // touching distance from square 0
        let pieces = split_sheet(&img, SplitOptions::default());
        assert_eq!(pieces.len(), 9);
        assert_eq!(pieces[0].width, 64);
    }

    #[test]
    fn a_piece_carries_only_its_own_pixels() {
        // An L-shaped neighbour whose box overlaps this one's must not be
        // copied into its crop.
        let mut img = canvas(200, 200);
        square(&mut img, 10, 10, 50);
        for y in 0..120 {
            img.put_pixel(150, y, INK);
        }
        for x in 30..151 {
            img.put_pixel(x, 120, INK);
        }
        let pieces = split_sheet(
            &img,
            SplitOptions {
                min_piece_fraction: 0.001,
                join_fraction: 0.05,
            },
        );
        assert_eq!(pieces.len(), 2);
        let square_piece = pieces.iter().find(|p| p.area == 2500).unwrap();
        let opaque = square_piece.image.pixels().filter(|p| p.0[3] != 0).count();
        assert_eq!(opaque, 2500);
    }

    #[test]
    fn an_empty_canvas_has_no_pieces() {
        assert!(split_sheet(&canvas(64, 64), SplitOptions::default()).is_empty());
    }
}

/// Real sheets from the 2026-09-30 spike, downscaled to 512 to keep them small.
/// A regression check behind the synthetic tests above, not instead of them.
#[cfg(test)]
mod fixtures {
    use super::*;
    use crate::image_gen::normalize::harden_alpha;

    fn load(bytes: &[u8]) -> RgbaImage {
        let mut img = image::load_from_memory(bytes).unwrap().to_rgba8();
        harden_alpha(&mut img, 128);
        img
    }

    #[test]
    fn a_ming_sheet_that_came_out_right_cuts_into_its_nine_sprites() {
        let img = load(include_bytes!(
            "../../tests/fixtures/image_gen/ming_sheet_items.png"
        ));
        assert_eq!(split_sheet(&img, SplitOptions::default()).len(), 9);
    }

    #[test]
    fn a_ming_sheet_whose_sprites_touch_reports_them_as_one_piece() {
        // Asked for nine top-down subjects; drew ten, and stacked the left
        // column so tightly that a survivor's boots, a tripod, a barrel and a
        // ghoul touch at alpha >= 128 (measured: 8% of the gap row is
        // opaque). No join gap separates them — they are connected at gap 0 —
        // so the cut reports seven pieces, one of them four sprites tall, and
        // the caller sees a merge rather than a guess.
        let img = load(include_bytes!(
            "../../tests/fixtures/image_gen/ming_sheet_topdown_touching.png"
        ));
        let pieces = split_sheet(&img, SplitOptions::default());
        assert_eq!(pieces.len(), 7);
        let tallest = pieces.iter().map(|p| p.height).max().unwrap();
        assert!(
            tallest > img.height() * 3 / 4,
            "the merged column is {tallest}px tall"
        );
    }

    /// Cut a real sheet and report the pieces. See `sheets.live.test.ts`.
    ///
    ///   HARUSPEX_SPLIT_IN=/tmp/sheet.png \
    ///     cargo test --lib split_a_real_sheet -- --ignored --nocapture
    #[test]
    #[ignore]
    fn split_a_real_sheet() {
        let Ok(path) = std::env::var("HARUSPEX_SPLIT_IN") else {
            eprintln!("set HARUSPEX_SPLIT_IN to a PNG");
            return;
        };
        let img = load(&std::fs::read(&path).expect("could not read the input"));
        let pieces = split_sheet(&img, SplitOptions::default());
        println!("{path}: {} piece(s)", pieces.len());
        for (i, p) in pieces.iter().enumerate() {
            println!(
                "  {i}: at ({}, {}) {}x{}  centre ({:.0}, {:.0})  area {}",
                p.x, p.y, p.width, p.height, p.cx, p.cy, p.area
            );
            p.image
                .save(format!("{path}.piece{i}.png"))
                .expect("could not write a piece");
        }
    }
}
