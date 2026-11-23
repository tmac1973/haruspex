//! Single frames out of a clip, and contact sheets of several for a model that
//! can see.

use image::{imageops, Rgb, RgbImage};
use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

/// The most frames one sheet holds: one image in the model's budget of six.
pub const MAX_FRAMES: usize = 16;
/// Each frame's width on a sheet.
const TILE_WIDTH: u32 = 480;
const GAP: u32 = 2;

/// One frame at `at` seconds as PNG, at most `max_width` wide. Rotation in the
/// file is applied (ffmpeg autorotates).
pub async fn extract_frame(
    ffmpeg: &str,
    file: &Path,
    at: f64,
    max_width: u32,
) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args([
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-ss",
        &format!("{:.3}", at.max(0.0)),
        "-i",
    ])
    .arg(file)
    .args([
        "-frames:v",
        "1",
        "-vf",
        &format!("scale='min({max_width},iw)':-2"),
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-",
    ])
    .stdin(std::process::Stdio::null())
    .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .map_err(|_| "taking a frame took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "no frame at {at:.1} s: {}",
            err.lines().next().unwrap_or("past the end of the clip?")
        ));
    }
    Ok(out.stdout)
}

/// Which frame `extract_still` takes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StillAt {
    Secs(f64),
    First,
    /// The true last frame, not the one a seek to the duration lands on.
    Last,
}

/// The ffmpeg arguments before the output path, for one still at full size.
/// `tail` reads only the last second for `Last`; without it the whole clip is
/// decoded, which a clip under a second (or one with no duration) needs.
fn still_args(file: &Path, at: StillAt, tail: bool) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = ["-nostdin", "-hide_banner", "-v", "error"]
        .iter()
        .map(Into::into)
        .collect();
    match at {
        StillAt::Secs(t) => args.extend(["-ss".into(), format!("{:.3}", t.max(0.0)).into()]),
        StillAt::First => args.extend(["-ss".into(), "0".into()]),
        StillAt::Last if tail => args.extend(["-sseof".into(), "-1".into()]),
        StillAt::Last => {}
    }
    args.push("-i".into());
    args.push(file.into());
    match at {
        // Every decoded frame overwrites the file, so the last one stays.
        StillAt::Last => args.extend(["-update".into(), "1".into()]),
        _ => args.extend(["-frames:v".into(), "1".into()]),
    }
    args.extend(["-c:v".into(), "png".into(), "-y".into()]);
    args
}

async fn run_still(ffmpeg: &str, args: Vec<std::ffi::OsString>, out: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.args(args)
        .arg(out)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    super::prepare_child(&mut cmd);
    let done = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "taking the still took too long".to_string())?
        .map_err(|e| format!("could not run ffmpeg: {e}"))?;
    let written = std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false);
    if !written {
        let err = String::from_utf8_lossy(&done.stderr);
        return Err(err
            .lines()
            .next()
            .unwrap_or("no frame there; past the end of the clip?")
            .trim()
            .to_string());
    }
    Ok(())
}

/// One frame of `file` as a full-size PNG at `out`. Returns its size.
pub async fn extract_still(
    ffmpeg: &str,
    file: &Path,
    at: StillAt,
    out: &Path,
) -> Result<(u32, u32), String> {
    let first = run_still(ffmpeg, still_args(file, at, true), out).await;
    if first.is_err() && at == StillAt::Last {
        run_still(ffmpeg, still_args(file, at, false), out).await?;
    } else {
        first?;
    }
    image::image_dimensions(out).map_err(|e| format!("the still didn't decode: {e}"))
}

/// A JPEG at most `max_width` wide, for showing a still in the chat.
pub fn preview_jpeg(png: &Path, max_width: u32) -> Result<Vec<u8>, String> {
    let img = image::open(png)
        .map_err(|e| format!("the still didn't decode: {e}"))?
        .to_rgb8();
    let img = if img.width() > max_width {
        let h = (img.height() as f64 * max_width as f64 / img.width() as f64).round() as u32;
        imageops::resize(&img, max_width, h.max(1), imageops::FilterType::Triangle)
    } else {
        img
    };
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&img)
        .map_err(|e| format!("can't encode the preview: {e}"))?;
    Ok(out.into_inner())
}

/// A 3×5 pixel font for the digits, one row per byte, high bits left.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b001, 0b001, 0b001],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

/// Draw `n` in white on a black box at the tile's top-left corner.
fn draw_number(img: &mut RgbImage, x0: u32, y0: u32, n: usize) {
    let scale = 4;
    let text = n.to_string();
    let w = text.len() as u32 * 4 * scale + scale;
    let h = 7 * scale;
    for y in y0..(y0 + h).min(img.height()) {
        for x in x0..(x0 + w).min(img.width()) {
            img.put_pixel(x, y, Rgb([0, 0, 0]));
        }
    }
    for (i, ch) in text.bytes().enumerate() {
        let glyph = DIGITS[(ch - b'0') as usize];
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = x0 + scale + i as u32 * 4 * scale + col * scale + dx;
                        let y = y0 + scale + row as u32 * scale + dy;
                        if x < img.width() && y < img.height() {
                            img.put_pixel(x, y, Rgb([255, 255, 255]));
                        }
                    }
                }
            }
        }
    }
}

/// Columns and rows for `n` tiles: as square as it goes, wider than tall.
pub fn grid(n: usize) -> (u32, u32) {
    let cols = (n as f64).sqrt().ceil().max(1.0) as u32;
    let rows = (n as u32).div_ceil(cols);
    (cols, rows)
}

/// Tile PNG frames into one JPEG, numbered from 1 in reading order.
pub fn contact_sheet(frames: &[Vec<u8>]) -> Result<Vec<u8>, String> {
    if frames.is_empty() {
        return Err("no frames to put on a sheet".into());
    }
    let decoded: Vec<RgbImage> = frames
        .iter()
        .map(|f| {
            image::load_from_memory(f)
                .map(|i| {
                    let i = i.to_rgb8();
                    let h = (i.height() as f64 * TILE_WIDTH as f64 / i.width().max(1) as f64)
                        .round() as u32;
                    imageops::resize(&i, TILE_WIDTH, h.max(1), imageops::FilterType::Triangle)
                })
                .map_err(|e| format!("a frame didn't decode: {e}"))
        })
        .collect::<Result<_, _>>()?;
    let tile_h = decoded.iter().map(RgbImage::height).max().unwrap_or(1);
    let (cols, rows) = grid(decoded.len());
    let mut sheet = RgbImage::from_pixel(
        cols * TILE_WIDTH + (cols - 1) * GAP,
        rows * tile_h + (rows - 1) * GAP,
        Rgb([24, 24, 24]),
    );
    for (i, tile) in decoded.iter().enumerate() {
        let (c, r) = (i as u32 % cols, i as u32 / cols);
        let (x, y) = (c * (TILE_WIDTH + GAP), r * (tile_h + GAP));
        imageops::overlay(&mut sheet, tile, x as i64, y as i64);
        draw_number(&mut sheet, x, y, i + 1);
    }
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .encode_image(&sheet)
        .map_err(|e| format!("can't encode the sheet: {e}"))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
        let img = RgbImage::from_pixel(w, h, Rgb(color));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn strs(args: Vec<std::ffi::OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_last_still_reads_the_tail_and_keeps_overwriting() {
        let a = strs(still_args(Path::new("c.webm"), StillAt::Last, true));
        assert!(a.windows(2).any(|w| w == ["-sseof", "-1"]), "{a:?}");
        assert!(a.windows(2).any(|w| w == ["-update", "1"]), "{a:?}");
        assert!(!a.contains(&"-frames:v".to_string()));
        let whole = strs(still_args(Path::new("c.webm"), StillAt::Last, false));
        assert!(!whole.contains(&"-sseof".to_string()));
        let at = strs(still_args(Path::new("c.webm"), StillAt::Secs(2.5), true));
        assert!(at.windows(2).any(|w| w == ["-ss", "2.500"]), "{at:?}");
        assert!(at.windows(2).any(|w| w == ["-frames:v", "1"]), "{at:?}");
        assert!(!at.iter().any(|x| x == "scale"));
    }

    #[test]
    fn grids_are_squarish() {
        assert_eq!(grid(1), (1, 1));
        assert_eq!(grid(5), (3, 2));
        assert_eq!(grid(16), (4, 4));
    }

    #[test]
    fn a_sheet_tiles_and_numbers_its_frames() {
        let frames: Vec<Vec<u8>> = (0..5).map(|i| png(640, 360, [i * 40, 100, 200])).collect();
        let jpeg = contact_sheet(&frames).unwrap();
        let sheet = image::load_from_memory(&jpeg).unwrap().to_rgb8();
        assert_eq!(sheet.width(), 3 * 480 + 2 * GAP);
        assert_eq!(sheet.height(), 2 * 270 + GAP);
        // The "1" box is black with white strokes, in the first tile's corner.
        let corner = sheet.get_pixel(1, 1);
        assert!(corner.0.iter().all(|&c| c < 40), "{corner:?}");
        let stroke = sheet.get_pixel(9, 5);
        assert!(stroke.0.iter().all(|&c| c > 200), "{stroke:?}");
    }

    #[test]
    fn digits_are_drawn_where_their_bits_are() {
        let mut img = RgbImage::from_pixel(40, 40, Rgb([9, 9, 9]));
        draw_number(&mut img, 0, 0, 7);
        // 7's top row is full; its middle-left is empty.
        assert_eq!(img.get_pixel(4, 4), &Rgb([255, 255, 255]));
        assert_eq!(img.get_pixel(4, 4 + 2 * 4), &Rgb([0, 0, 0]));
    }
}

#[cfg(test)]
mod real {
    use std::path::Path;
    /// `HARUSPEX_VIDEO_CLIP=… HARUSPEX_SHEET_OUT=/tmp/x.jpg cargo test -- --ignored sheet_of_a_real_clip`
    #[tokio::test]
    #[ignore = "needs ffmpeg and a clip"]
    async fn sheet_of_a_real_clip() {
        let clip = std::path::PathBuf::from(std::env::var("HARUSPEX_VIDEO_CLIP").unwrap());
        let mut pngs = Vec::new();
        for i in 0..9 {
            pngs.push(
                super::extract_frame("ffmpeg", &clip, 60.0 + i as f64 * 200.0, 960)
                    .await
                    .unwrap(),
            );
        }
        let jpeg = super::contact_sheet(&pngs).unwrap();
        std::fs::write(std::env::var("HARUSPEX_SHEET_OUT").unwrap(), &jpeg).unwrap();
        assert!(jpeg.len() < 2_000_000, "{}", jpeg.len());
    }

    /// A 2 s, 10 fps clip whose frame number is in its colour: frame n is
    /// n×12 red, so the last frame (19) is told from the one before it.
    fn ramp_clip(dir: &Path, name: &str, secs: f64) -> std::path::PathBuf {
        let clip = dir.join(name);
        let ok = std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!(
                "color=c=black:s=64x48:r=10:d={secs},format=rgb24,geq=r='N*12':g=0:b=0"
            ))
            .args(["-c:v", "ffv1"])
            .arg(&clip)
            .status()
            .unwrap()
            .success();
        assert!(ok);
        clip
    }

    fn red_at_centre(png: &Path) -> u8 {
        let img = image::open(png).unwrap().to_rgb8();
        img.get_pixel(32, 24).0[0]
    }

    /// `cargo test -- --ignored stills_from_a_clip`
    #[tokio::test]
    #[ignore = "needs ffmpeg"]
    async fn stills_from_a_clip() {
        let dir = crate::test_util::temp_dir("video_stills");
        let clip = ramp_clip(&dir, "ramp.mkv", 2.0);
        let out = dir.join("last.png");
        let size = super::extract_still("ffmpeg", &clip, super::StillAt::Last, &out)
            .await
            .unwrap();
        assert_eq!(size, (64, 48));
        // Frame 19 of 20.
        let red = red_at_centre(&out);
        assert!((red as i32 - 228).abs() <= 3, "last frame red {red}");
        let first = dir.join("first.png");
        super::extract_still("ffmpeg", &clip, super::StillAt::First, &first)
            .await
            .unwrap();
        assert!(red_at_centre(&first) <= 3);
        let mid = dir.join("mid.png");
        super::extract_still("ffmpeg", &clip, super::StillAt::Secs(1.0), &mid)
            .await
            .unwrap();
        assert!((red_at_centre(&mid) as i32 - 120).abs() <= 3);
        // Under a second: the tail read still finds the last frame.
        let short = ramp_clip(&dir, "short.mkv", 0.5);
        let out = dir.join("short.png");
        super::extract_still("ffmpeg", &short, super::StillAt::Last, &out)
            .await
            .unwrap();
        assert!((red_at_centre(&out) as i32 - 48).abs() <= 3);
        // Past the end is an error, not an empty file.
        let past = dir.join("past.png");
        assert!(
            super::extract_still("ffmpeg", &clip, super::StillAt::Secs(9.0), &past)
                .await
                .is_err()
        );
    }
}
