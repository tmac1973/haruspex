//! A USB watcher's shared files. A webcam can't be opened twice, so while a
//! watcher runs on one, its ffmpeg also keeps `latest.jpg` (the full picture,
//! rewritten each second) and the last 80 seconds of sound as 2-second WAV
//! segments in `<app data>/camera_watch/<camera_id>/`; a snapshot or a
//! listen on that camera reads those instead of opening the device.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime};

/// The picture, rewritten each second.
pub(crate) const LATEST: &str = "latest.jpg";
/// The sound segments' names, for ffmpeg's segment muxer.
pub(crate) const SEGMENT_PATTERN: &str = "seg%03d.wav";
pub(crate) const SEGMENT_SECS: u32 = 2;
/// Segments kept before names are reused: 80 s, more than the longest event
/// and its quiet tail.
pub(crate) const SEGMENT_WRAP: u32 = 40;
/// The format every segment is in, as `capture::audio_output` makes it.
const SAMPLE_RATE: u32 = 16_000;
/// A `latest.jpg` older than this means the watcher isn't getting pictures.
const STALE: Duration = Duration::from_secs(5);
/// How long a snapshot waits for a fresh picture, as when a watcher has just
/// started.
const PICTURE_WAIT: Duration = Duration::from_secs(5);

/// The cameras whose watcher is writing shared files now, by id.
static SHARED: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(Default::default);

fn shared() -> std::sync::MutexGuard<'static, HashMap<String, PathBuf>> {
    SHARED.lock().unwrap_or_else(|p| p.into_inner())
}

/// The shared-files folder of the camera's running watcher, if one is.
pub(crate) fn dir_for(camera_id: &str) -> Option<PathBuf> {
    shared().get(camera_id).cloned()
}

/// Marks a camera's files as being written while it lives.
pub(crate) struct SharedGuard {
    camera_id: String,
}

impl Drop for SharedGuard {
    fn drop(&mut self) {
        shared().remove(&self.camera_id);
    }
}

/// Say that `dir` holds the camera's shared files until the guard drops.
pub(crate) fn register(camera_id: &str, dir: &Path) -> SharedGuard {
    shared().insert(camera_id.to_string(), dir.to_path_buf());
    SharedGuard {
        camera_id: camera_id.to_string(),
    }
}

/// `latest.jpg` if it is a whole JPEG written in the last few seconds; it is
/// rewritten in place, so a read can catch it half-written.
pub(crate) fn read_latest(dir: &Path) -> Option<Vec<u8>> {
    let path = dir.join(LATEST);
    let modified = std::fs::metadata(&path).ok()?.modified().ok()?;
    let age = SystemTime::now()
        .duration_since(modified)
        .unwrap_or_default();
    if age > STALE {
        return None;
    }
    let jpeg = std::fs::read(&path).ok()?;
    let whole = jpeg.starts_with(b"\xff\xd8") && jpeg.ends_with(b"\xff\xd9");
    whole.then_some(jpeg)
}

/// The latest picture, waiting a little for one.
pub(crate) async fn latest_jpeg(dir: &Path) -> Result<Vec<u8>, String> {
    let deadline = tokio::time::Instant::now() + PICTURE_WAIT;
    loop {
        let found = {
            let dir = dir.to_path_buf();
            tokio::task::spawn_blocking(move || read_latest(&dir))
                .await
                .ok()
                .flatten()
        };
        if let Some(jpeg) = found {
            return Ok(jpeg);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("The watcher on this webcam isn't getting pictures; \
                        check that it is plugged in."
                .into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// `jpeg` no wider than `max_width`, as JPEG.
pub(crate) fn fit_jpeg(jpeg: &[u8], max_width: u32) -> Result<Vec<u8>, String> {
    let img =
        image::load_from_memory(jpeg).map_err(|e| format!("The picture did not decode: {e}"))?;
    if img.width() <= max_width {
        return Ok(jpeg.to_vec());
    }
    let height = (u64::from(img.height()) * u64::from(max_width) / u64::from(img.width())) as u32;
    let small = img
        .resize(
            max_width,
            height.max(1),
            image::imageops::FilterType::Triangle,
        )
        .to_rgb8();
    let mut out = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
        .encode_image(&small)
        .map_err(|e| format!("The picture did not encode: {e}"))?;
    Ok(out.into_inner())
}

/// One picture from a watched webcam, at most `max_width` wide.
pub(crate) async fn snapshot(dir: &Path, max_width: u32) -> Result<Vec<u8>, String> {
    let jpeg = latest_jpeg(dir).await?;
    tokio::task::spawn_blocking(move || fit_jpeg(&jpeg, max_width))
        .await
        .map_err(|e| format!("resizing the picture failed: {e}"))?
}

/// The segments written to at or after `since`, oldest first. Names are
/// reused, so they are ordered by when they were written.
pub(crate) fn segments_since(dir: &Path, since: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with("seg") && name.ends_with(".wav")
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .filter(|(modified, _)| *modified >= since)
        .collect();
    found.sort();
    found.into_iter().map(|(_, p)| p).collect()
}

/// The 16-bit samples of `paths`' WAV files, one after another. A file that
/// isn't a WAV (yet) is skipped.
pub(crate) fn concat_pcm(paths: &[PathBuf]) -> Vec<u8> {
    let mut pcm = Vec::new();
    for path in paths {
        let Ok(wav) = std::fs::read(path) else {
            continue;
        };
        if let Some(at) = crate::audio::wav_data_start(&wav) {
            let samples = &wav[at..];
            // A half-written last sample is dropped.
            pcm.extend_from_slice(&samples[..samples.len() & !1]);
        }
    }
    pcm
}

/// 16 kHz mono 16-bit PCM as a WAV file.
pub(crate) fn wav_from_pcm(pcm: &[u8]) -> Vec<u8> {
    crate::audio::wav_from_pcm16(pcm, SAMPLE_RATE)
}

/// The last `seconds` of sound in the segments written since `since`.
pub(crate) fn clip_since(dir: &Path, since: SystemTime, seconds: u32) -> Option<Vec<u8>> {
    let pcm = concat_pcm(&segments_since(dir, since));
    if pcm.is_empty() {
        return None;
    }
    let want = (seconds * SAMPLE_RATE * 2) as usize;
    Some(wav_from_pcm(&pcm[pcm.len().saturating_sub(want)..]))
}

/// `seconds` of a watched webcam's sound, from now: the watcher writes it
/// with a second or so of delay, so this waits that much longer.
pub(crate) async fn record_audio(dir: &Path, seconds: u32) -> Result<Vec<u8>, String> {
    let since = SystemTime::now();
    tokio::time::sleep(Duration::from_secs(u64::from(seconds) + 1)).await;
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || clip_since(&dir, since, seconds))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "The watcher on this webcam isn't getting any sound.".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    pub(crate) fn tiny_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 40]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
            .encode_image(&img)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn segments_are_joined_into_one_wav() {
        let dir = temp_dir("camera_segments");
        let before = SystemTime::now() - Duration::from_secs(1);
        std::fs::write(dir.join("seg001.wav"), wav_from_pcm(&[1, 0, 2, 0])).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        // A half-written segment: a header with no sizes yet, and a stray byte.
        let mut partial = wav_from_pcm(&[3, 0, 4]);
        partial[40..44].copy_from_slice(&[0, 0, 0, 0]);
        std::fs::write(dir.join("seg000.wav"), partial).unwrap();
        std::fs::write(dir.join("other.wav"), wav_from_pcm(&[9, 9])).unwrap();
        let segs = segments_since(&dir, before);
        let names: Vec<_> = segs
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["seg001.wav", "seg000.wav"]);
        assert_eq!(concat_pcm(&segs), [1, 0, 2, 0, 3, 0]);
        assert!(segments_since(&dir, SystemTime::now() + Duration::from_secs(60)).is_empty());
        // The last second only.
        let one_sec = vec![7u8; 32_000];
        std::fs::write(dir.join("seg002.wav"), wav_from_pcm(&one_sec)).unwrap();
        let clip = clip_since(&dir, before, 1).unwrap();
        let mut fixed = clip.clone();
        super::super::capture::fix_wav_sizes(&mut fixed).unwrap();
        assert_eq!(fixed, clip, "the header is already right");
        assert_eq!(&clip[44..], &one_sec[..]);
    }

    #[test]
    fn a_wide_picture_is_made_smaller() {
        let jpeg = tiny_jpeg(1600, 900);
        let small = fit_jpeg(&jpeg, 640).unwrap();
        let img = image::load_from_memory(&small).unwrap();
        assert_eq!((img.width(), img.height()), (640, 360));
        assert_eq!(fit_jpeg(&small, 1280).unwrap(), small);
    }

    #[test]
    fn a_stale_or_partial_picture_is_not_read() {
        let dir = temp_dir("camera_latest");
        assert!(read_latest(&dir).is_none());
        let jpeg = tiny_jpeg(8, 8);
        std::fs::write(dir.join(LATEST), &jpeg[..jpeg.len() - 10]).unwrap();
        assert!(read_latest(&dir).is_none());
        std::fs::write(dir.join(LATEST), &jpeg).unwrap();
        assert_eq!(read_latest(&dir), Some(jpeg.clone()));
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(dir.join(LATEST))
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert!(read_latest(&dir).is_none());
    }

    #[test]
    fn the_registration_lasts_as_long_as_the_guard() {
        let dir = temp_dir("camera_register");
        assert_eq!(dir_for("reg-cam"), None);
        let guard = register("reg-cam", &dir);
        assert_eq!(dir_for("reg-cam").as_deref(), Some(dir.as_path()));
        drop(guard);
        assert_eq!(dir_for("reg-cam"), None);
    }
}
