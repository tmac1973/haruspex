//! Streaming file hashes, and the lower-case hex every digest here is shown as.

use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncReadExt;

/// Hex sha256 of a file, read 1 MiB at a time — model files run to ~38 GB,
/// far too large to read whole. `on_progress(hashed)` is called after every
/// read so long verifications can show movement.
pub async fn sha256_file(path: &Path, mut on_progress: impl FnMut(u64)) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut hashed = 0u64;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        hashed += n as u64;
        on_progress(hashed);
    }
    Ok(hex(&hasher.finalize()))
}

/// Lower-case hex, two digits a byte. sha2 0.11's digest output no longer
/// implements `LowerHex`, so `{:x}` on it doesn't compile.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// `bytes` bytes from the system's random source, as lower-case hex: the
/// ids, tokens and keys the app hands out.
pub fn random_hex(bytes: usize) -> Result<String, String> {
    use ring::rand::{SecureRandom, SystemRandom};
    let mut buf = vec![0u8; bytes];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| "the system random number generator failed".to_string())?;
    Ok(hex(&buf))
}

#[cfg(test)]
mod tests {
    #[test]
    fn random_hex_is_two_digits_a_byte_and_differs_each_time() {
        let a = super::random_hex(16).unwrap();
        assert_eq!(a.len(), 32);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, super::random_hex(16).unwrap());
    }

    use super::*;
    use crate::test_util::temp_dir;

    #[tokio::test]
    async fn hashes_and_reports_progress() {
        let dir = temp_dir("hash_util");
        let path = dir.join("abc.bin");
        std::fs::write(&path, b"abc").unwrap();
        let mut seen = Vec::new();
        let hash = sha256_file(&path, |n| seen.push(n)).await.unwrap();
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(seen, vec![3]);
    }

    #[test]
    fn hex_is_lower_case_and_zero_padded() {
        assert_eq!(hex(&[0x00, 0x0f, 0xab, 0xff]), "000fabff");
        assert_eq!(hex(&[]), "");
    }

    #[tokio::test]
    async fn missing_file_is_an_error() {
        let dir = temp_dir("hash_util_missing");
        let path = dir.join("missing.bin");
        assert!(sha256_file(&path, |_| {}).await.is_err());
    }
}
