//! The contact sheet: the whole set in one image.
//!
//! "A contact sheet of the set reads as one game" is the success criterion the
//! whole feature is aimed at, and it is not a thing you can check by opening
//! forty PNGs one at a time — incoherence is only visible side by side. So the
//! run produces the artifact its own goal is judged on.
//!
//! Assets are nearest-neighbour upscaled into fixed cells. A 32 px sprite
//! viewed at 32 px tells you nothing; at 4x it is legible at a glance, and
//! nearest-neighbour is the only resampling that does not undo the pixel grid
//! normalization just imposed.

use image::RgbaImage;

/// The checkerboard behind transparent pixels, so a keyed sprite is
/// distinguishable from a white one. Two greys, 8 px squares.
const CHECK_A: [u8; 4] = [0x50, 0x50, 0x50, 0xFF];
const CHECK_B: [u8; 4] = [0x3C, 0x3C, 0x3C, 0xFF];
const CHECK_SIZE: u32 = 8;

/// Columns for `n` cells: square-ish, wider than tall, and never zero.
pub fn columns_for(n: usize) -> u32 {
    if n == 0 {
        return 1;
    }
    (n as f64).sqrt().ceil() as u32
}

fn checker(x: u32, y: u32) -> [u8; 4] {
    if ((x / CHECK_SIZE) + (y / CHECK_SIZE)).is_multiple_of(2) {
        CHECK_A
    } else {
        CHECK_B
    }
}

/// Nearest-neighbour fit into a `cell`-sized box, centred, aspect preserved.
fn blit(dst: &mut RgbaImage, src: &RgbaImage, ox: u32, oy: u32, cell: u32) {
    if src.width() == 0 || src.height() == 0 {
        return;
    }
    // Integer scale where one fits, so the grid survives; otherwise shrink to
    // fit, which only happens for an asset larger than a cell.
    let scale = (cell / src.width().max(1))
        .min(cell / src.height().max(1))
        .max(1);
    let (w, h) = if src.width() * scale <= cell && src.height() * scale <= cell {
        (src.width() * scale, src.height() * scale)
    } else {
        let f = (cell as f64 / src.width().max(src.height()) as f64).min(1.0);
        (
            ((src.width() as f64 * f) as u32).max(1),
            ((src.height() as f64 * f) as u32).max(1),
        )
    };
    let px = ox + (cell - w.min(cell)) / 2;
    let py = oy + (cell - h.min(cell)) / 2;

    for y in 0..h.min(cell) {
        for x in 0..w.min(cell) {
            let sx = (x as u64 * src.width() as u64 / w as u64) as u32;
            let sy = (y as u64 * src.height() as u64 / h as u64) as u32;
            let s = src
                .get_pixel(sx.min(src.width() - 1), sy.min(src.height() - 1))
                .0;
            if s[3] == 0 {
                continue;
            }
            let d = dst.get_pixel_mut(px + x, py + y);
            if s[3] == 255 {
                d.0 = s;
            } else {
                // Composite over the checkerboard already painted there.
                let a = s[3] as u32;
                let inv = 255 - a;
                for (dc, sc) in d.0.iter_mut().zip(s.iter()).take(3) {
                    *dc = ((*sc as u32 * a + *dc as u32 * inv) / 255) as u8;
                }
            }
        }
    }
}

/// Tile `images` into one sheet of `cell`-sized squares.
///
/// `n` need not be a perfect square: the last row is short, and the empty
/// cells stay checkerboard rather than being cropped away, so the grid reads
/// as a grid.
pub fn contact_sheet(images: &[RgbaImage], cell: u32) -> RgbaImage {
    let cell = cell.max(1);
    let cols = columns_for(images.len());
    let rows = (images.len().max(1) as u32).div_ceil(cols);
    let mut out = RgbaImage::new(cols * cell, rows * cell);

    for y in 0..out.height() {
        for x in 0..out.width() {
            out.put_pixel(x, y, image::Rgba(checker(x, y)));
        }
    }
    for (i, img) in images.iter().enumerate() {
        let ox = (i as u32 % cols) * cell;
        let oy = (i as u32 / cols) * cell;
        blit(&mut out, img, ox, oy, cell);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    #[test]
    fn columns_are_square_ish() {
        assert_eq!(columns_for(0), 1);
        assert_eq!(columns_for(1), 1);
        assert_eq!(columns_for(4), 2);
        assert_eq!(columns_for(5), 3);
        assert_eq!(columns_for(9), 3);
        assert_eq!(columns_for(10), 4);
    }

    #[test]
    fn a_perfect_square_tiles_exactly() {
        let imgs: Vec<_> = (0..4).map(|_| solid(32, 32, [255, 0, 0, 255])).collect();
        let s = contact_sheet(&imgs, 128);
        assert_eq!((s.width(), s.height()), (256, 256));
    }

    #[test]
    fn a_short_last_row_still_gets_a_full_row_of_cells() {
        // Five assets: three columns, two rows, one empty cell. Cropping the
        // empty cell away would make the grid stop reading as a grid.
        let imgs: Vec<_> = (0..5).map(|_| solid(32, 32, [255, 0, 0, 255])).collect();
        let s = contact_sheet(&imgs, 64);
        assert_eq!((s.width(), s.height()), (192, 128));
    }

    #[test]
    fn an_empty_set_still_produces_an_image() {
        let s = contact_sheet(&[], 64);
        assert_eq!((s.width(), s.height()), (64, 64));
    }

    #[test]
    fn assets_are_upscaled_by_an_integer_factor() {
        // Nearest-neighbour at an integer factor is the only resampling that
        // does not undo the pixel grid normalization just imposed.
        let mut src = solid(2, 2, [255, 0, 0, 255]);
        src.put_pixel(1, 1, Rgba([0, 0, 255, 255]));
        let s = contact_sheet(&[src], 8);
        // 4x: the bottom-right 4x4 block is entirely blue.
        for y in 4..8 {
            for x in 4..8 {
                assert_eq!(s.get_pixel(x, y).0, [0, 0, 255, 255], "at {x},{y}");
            }
        }
        assert_eq!(s.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn the_sheet_invents_no_colours() {
        let src = solid(4, 4, [10, 200, 30, 255]);
        let s = contact_sheet(&[src], 16);
        for p in s.pixels() {
            let c = p.0;
            assert!(
                c == [10, 200, 30, 255] || c == CHECK_A || c == CHECK_B,
                "invented {c:?}"
            );
        }
    }

    #[test]
    fn transparency_shows_the_checkerboard_rather_than_white() {
        // A keyed sprite and a white one must not look the same on the sheet.
        let src = solid(4, 4, [0, 0, 0, 0]);
        let s = contact_sheet(&[src], 16);
        assert_eq!(s.get_pixel(0, 0).0, CHECK_A);
        assert_eq!(s.get_pixel(CHECK_SIZE, 0).0, CHECK_B);
    }

    #[test]
    fn an_asset_larger_than_its_cell_is_shrunk_to_fit() {
        let src = solid(64, 64, [1, 2, 3, 255]);
        let s = contact_sheet(&[src], 16);
        assert_eq!((s.width(), s.height()), (16, 16));
        assert_eq!(s.get_pixel(8, 8).0, [1, 2, 3, 255]);
    }

    #[test]
    fn a_non_square_asset_is_centred_rather_than_stretched() {
        let src = solid(8, 4, [1, 2, 3, 255]);
        let s = contact_sheet(&[src], 16);
        // 2x → 16x8, centred vertically: rows 4..12 are the asset, the rest
        // is checkerboard.
        assert_eq!(s.get_pixel(0, 0).0, CHECK_A);
        assert_eq!(s.get_pixel(0, 4).0, [1, 2, 3, 255]);
        assert_eq!(s.get_pixel(0, 11).0, [1, 2, 3, 255]);
        // Row 12 is in the second checker band, not the first.
        assert_eq!(s.get_pixel(0, 12).0, CHECK_B);
    }
}
