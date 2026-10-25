//! HTTP `Range` for cached audio. A media element asks for byte ranges to
//! seek and to read a file's duration, and both the `haruspex-audio:` scheme
//! and Settings → Remote control's `/api/v1/audio/<hash>` answer them from
//! here.
//!
//! One range per request: `bytes=a-b`, `bytes=a-` and `bytes=-n`. A request
//! for several ranges gets the whole file, which the spec allows.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// What to send back.
#[derive(Debug, PartialEq, Eq)]
pub enum Slice {
    /// 200, the whole file.
    Whole(Vec<u8>),
    /// 206, `bytes start-end/total` (`end` inclusive).
    Part {
        bytes: Vec<u8>,
        start: u64,
        end: u64,
        total: u64,
    },
    /// 416, `bytes */total`.
    Unsatisfiable { total: u64 },
}

/// The inclusive byte span a `Range` header asks for, `Ok(None)` for no
/// usable range (absent, not `bytes=`, several ranges, malformed), or
/// `Err(())` when it names nothing inside a file of `total` bytes.
pub fn parse(header: Option<&str>, total: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((a, b)) = spec.split_once('-') else {
        return Ok(None);
    };
    let (a, b) = (a.trim(), b.trim());
    let span = match (a.is_empty(), b.is_empty()) {
        // bytes=-n: the last n bytes.
        (true, false) => {
            let Ok(n) = b.parse::<u64>() else {
                return Ok(None);
            };
            if n == 0 || total == 0 {
                return Err(());
            }
            (total.saturating_sub(n), total - 1)
        }
        // bytes=a-: from a to the end.
        (false, true) => {
            let Ok(start) = a.parse::<u64>() else {
                return Ok(None);
            };
            (start, total.saturating_sub(1))
        }
        (false, false) => {
            let (Ok(start), Ok(end)) = (a.parse::<u64>(), b.parse::<u64>()) else {
                return Ok(None);
            };
            if end < start {
                return Ok(None);
            }
            (start, end.min(total.saturating_sub(1)))
        }
        (true, true) => return Ok(None),
    };
    if span.0 >= total {
        return Err(());
    }
    Ok(Some(span))
}

/// Read what `range` asks for from the file at `path`.
pub fn read(path: &Path, range: Option<&str>) -> std::io::Result<Slice> {
    let mut file = std::fs::File::open(path)?;
    let total = file.metadata()?.len();
    match parse(range, total) {
        Err(()) => Ok(Slice::Unsatisfiable { total }),
        Ok(None) => {
            let mut bytes = Vec::with_capacity(total as usize);
            file.read_to_end(&mut bytes)?;
            Ok(Slice::Whole(bytes))
        }
        Ok(Some((start, end))) => {
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![0; (end - start + 1) as usize];
            file.read_exact(&mut bytes)?;
            Ok(Slice::Part {
                bytes,
                start,
                end,
                total,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;

    #[test]
    fn parses_the_three_single_range_forms() {
        assert_eq!(parse(Some("bytes=0-"), 1000), Ok(Some((0, 999))));
        assert_eq!(parse(Some("bytes=100-199"), 1000), Ok(Some((100, 199))));
        assert_eq!(parse(Some("bytes=-50"), 1000), Ok(Some((950, 999))));
        // An end past the file is clamped, not refused.
        assert_eq!(parse(Some("bytes=900-5000"), 1000), Ok(Some((900, 999))));
        // A suffix longer than the file is the whole file.
        assert_eq!(parse(Some("bytes=-5000"), 1000), Ok(Some((0, 999))));
    }

    #[test]
    fn a_range_outside_the_file_is_unsatisfiable() {
        assert_eq!(parse(Some("bytes=1000-"), 1000), Err(()));
        assert_eq!(parse(Some("bytes=2000-2100"), 1000), Err(()));
        assert_eq!(parse(Some("bytes=-0"), 1000), Err(()));
    }

    #[test]
    fn anything_else_is_the_whole_file() {
        for h in [
            None,
            Some(""),
            Some("items=0-1"),
            Some("bytes=0-1,5-6"),
            Some("bytes=x-y"),
            Some("bytes=-"),
            Some("bytes=9-3"),
        ] {
            assert_eq!(parse(h, 1000), Ok(None), "{h:?}");
        }
    }

    #[test]
    fn reads_the_slice_asked_for() {
        let dir = temp_dir("audio-range");
        let path = dir.join("f");
        std::fs::write(&path, b"0123456789").unwrap();
        assert_eq!(
            read(&path, None).unwrap(),
            Slice::Whole(b"0123456789".to_vec())
        );
        assert_eq!(
            read(&path, Some("bytes=2-4")).unwrap(),
            Slice::Part {
                bytes: b"234".to_vec(),
                start: 2,
                end: 4,
                total: 10
            }
        );
        assert_eq!(
            read(&path, Some("bytes=-3")).unwrap(),
            Slice::Part {
                bytes: b"789".to_vec(),
                start: 7,
                end: 9,
                total: 10
            }
        );
        assert_eq!(
            read(&path, Some("bytes=20-")).unwrap(),
            Slice::Unsatisfiable { total: 10 }
        );
    }
}
