//! Streaming file hashes.

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
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hashes_and_reports_progress() {
        let dir = std::env::temp_dir().join("haruspex_test_hash_util");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("abc.bin");
        std::fs::write(&path, b"abc").unwrap();
        let mut seen = Vec::new();
        let hash = sha256_file(&path, |n| seen.push(n)).await.unwrap();
        assert_eq!(
            hash,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(seen, vec![3]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn missing_file_is_an_error() {
        let path = std::env::temp_dir().join("haruspex_test_hash_util_missing.bin");
        assert!(sha256_file(&path, |_| {}).await.is_err());
    }
}
