//! Camera alerts' room references: a day and a night picture of each room as
//! the user says it normally looks, kept as `camera_refs/<camera>/day.jpg`
//! and `night.jpg` in the app's data folder, and what a room check needs to
//! compare a new picture with them.
//!
//! - [`is_night`]: Thingino's infrared night mode is greyscale, so a picture
//!   with almost no colour is a night one and is compared with the night
//!   reference.
//! - [`similarity`]: the correlation of two 64×36 greyscale copies, as a
//!   turn check uses, so a change of exposure doesn't count as a change.
//! - [`last_aimed_at`]: when a person or a chat last turned the camera, so a
//!   room check never moves a camera someone is aiming.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use image::imageops::FilterType;
use serde::Serialize;

use super::capture::{FINGERPRINT_H, FINGERPRINT_W};

/// Mean `|R−G| + |G−B|` under which a picture counts as greyscale (night).
const NIGHT_CHROMA: f64 = 4.0;

/// Which light a reference is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum Light {
    Day,
    Night,
}

impl Light {
    fn file(self) -> &'static str {
        match self {
            Light::Day => "day.jpg",
            Light::Night => "night.jpg",
        }
    }
}

fn decode(jpeg: &[u8]) -> Result<image::DynamicImage, String> {
    image::load_from_memory(jpeg).map_err(|e| format!("The picture could not be read: {e}"))
}

/// Whether a picture is greyscale: a camera in infrared night mode.
pub fn is_night(jpeg: &[u8]) -> Result<bool, String> {
    let small = decode(jpeg)?
        .resize_exact(
            FINGERPRINT_W as u32,
            FINGERPRINT_H as u32,
            FilterType::Triangle,
        )
        .to_rgb8();
    let n = small.pixels().len().max(1) as f64;
    let chroma: f64 = small
        .pixels()
        .map(|p| {
            let [r, g, b] = p.0.map(i32::from);
            f64::from((r - g).abs() + (g - b).abs())
        })
        .sum();
    Ok(chroma / n < NIGHT_CHROMA)
}

/// A 64×36 greyscale copy of a picture, like `capture::fingerprint` makes
/// from a live stream.
pub fn fingerprint_jpeg(jpeg: &[u8]) -> Result<Vec<u8>, String> {
    Ok(decode(jpeg)?
        .resize_exact(
            FINGERPRINT_W as u32,
            FINGERPRINT_H as u32,
            FilterType::Triangle,
        )
        .to_luma8()
        .into_raw())
}

/// How alike two pictures are, from -1 to 1 (1 the same view).
pub fn similarity(a: &[u8], b: &[u8]) -> Result<f64, String> {
    Ok(super::capture::correlation(
        &fingerprint_jpeg(a)?,
        &fingerprint_jpeg(b)?,
    ))
}

/// The folder a camera's references live in.
pub fn refs_dir(data_dir: &Path, camera_id: &str) -> PathBuf {
    data_dir
        .join("camera_refs")
        .join(super::watcher::folder_name(camera_id))
}

/// One saved reference.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// When it was saved, epoch ms.
    #[ts(type = "number")]
    pub set_at: i64,
    /// The picture, as a `data:image/jpeg;base64,` URL.
    pub data_url: String,
}

/// A camera's references.
#[derive(Clone, Debug, Default, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct References {
    pub day: Option<Reference>,
    pub night: Option<Reference>,
}

fn modified_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(d.as_millis()).ok()
}

/// Save `jpeg` as the reference for its light; which light that was.
pub fn save(dir: &Path, jpeg: &[u8]) -> Result<Light, String> {
    let light = if is_night(jpeg)? {
        Light::Night
    } else {
        Light::Day
    };
    std::fs::create_dir_all(dir)
        .and_then(|_| std::fs::write(dir.join(light.file()), jpeg))
        .map_err(|e| format!("Saving the reference failed: {e}"))?;
    Ok(light)
}

/// The reference for `light`, with when it was saved; `None` when there is none.
pub fn load(dir: &Path, light: Light) -> Option<(Vec<u8>, i64)> {
    let path = dir.join(light.file());
    let jpeg = std::fs::read(&path).ok()?;
    Some((jpeg, modified_ms(&path).unwrap_or(0)))
}

/// Remove one reference; a missing one is fine.
pub fn clear(dir: &Path, light: Light) -> Result<(), String> {
    match std::fs::remove_file(dir.join(light.file())) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("Removing the reference failed: {e}"))
        }
        _ => Ok(()),
    }
}

static LAST_AIM: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Default::default);

/// A person or a chat turned this camera now (epoch ms).
pub fn record_aim(camera_id: &str, now: i64) {
    LAST_AIM
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(camera_id.to_string(), now);
}

/// When a person or a chat last turned this camera, epoch ms.
pub fn last_aimed_at(camera_id: &str) -> Option<i64> {
    LAST_AIM
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(camera_id)
        .copied()
}

/// How long after someone turns a camera a room check leaves it alone.
pub const AIM_QUIET_MS: i64 = 5 * 60_000;

/// Whether a room check must leave this camera alone at `now`.
pub fn busy(camera_id: &str, now: i64) -> bool {
    last_aimed_at(camera_id).is_some_and(|t| now - t < AIM_QUIET_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn jpeg(f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let img = ImageBuffer::from_fn(160, 90, |x, y| Rgb(f(x, y)));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageFormat::Jpeg)
            .unwrap();
        out.into_inner()
    }

    fn room() -> Vec<u8> {
        jpeg(|x, y| {
            if x < 80 {
                [180, 120, 60]
            } else if y < 45 {
                [40, 90, 160]
            } else {
                [200, 200, 190]
            }
        })
    }

    #[test]
    fn greyscale_is_night_and_colour_is_day() {
        assert!(!is_night(&room()).unwrap());
        let grey = jpeg(|x, _| {
            let v = (x % 256) as u8;
            [v, v, v]
        });
        assert!(is_night(&grey).unwrap());
    }

    #[test]
    fn the_same_room_brighter_is_similar_and_a_moved_block_is_not() {
        let a = room();
        let brighter = jpeg(|x, y| {
            if x < 80 {
                [220, 160, 100]
            } else if y < 45 {
                [80, 130, 200]
            } else {
                [240, 240, 230]
            }
        });
        let moved = jpeg(|x, y| {
            if x >= 80 {
                [180, 120, 60]
            } else if y >= 45 {
                [40, 90, 160]
            } else {
                [200, 200, 190]
            }
        });
        assert!(similarity(&a, &a).unwrap() > 0.999);
        assert!(similarity(&a, &brighter).unwrap() > 0.99);
        assert!(similarity(&a, &moved).unwrap() < 0.9);
    }

    #[test]
    fn references_are_saved_by_light_and_cleared() {
        let dir = tempfile::tempdir().unwrap();
        let refs = refs_dir(dir.path(), "cam/1");
        assert_eq!(save(&refs, &room()).unwrap(), Light::Day);
        assert!(refs.join("day.jpg").exists());
        let (bytes, at) = load(&refs, Light::Day).unwrap();
        assert_eq!(bytes, room());
        assert!(at > 0);
        assert!(load(&refs, Light::Night).is_none());
        clear(&refs, Light::Day).unwrap();
        clear(&refs, Light::Day).unwrap();
        assert!(load(&refs, Light::Day).is_none());
    }

    #[test]
    fn a_camera_turned_in_the_last_five_minutes_is_busy() {
        record_aim("cam-busy", 1_000_000);
        assert!(busy("cam-busy", 1_000_000 + AIM_QUIET_MS - 1));
        assert!(!busy("cam-busy", 1_000_000 + AIM_QUIET_MS));
        assert!(!busy("cam-never", 1_000_000));
    }
}
