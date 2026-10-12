//! Response-body helpers shared by every outbound fetch: a size-capped read
//! into memory and a streamed download to a file. Each caller words its own
//! errors, so these return a small error enum rather than a message.

use std::future::Future;
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// Why a capped read failed.
#[derive(Debug)]
pub enum CappedReadError {
    /// The declared Content-Length, or the bytes actually sent, passed the cap.
    TooLarge,
    Read(reqwest::Error),
}

/// Read a response body, failing as soon as it passes `max` bytes. An honest
/// Content-Length is refused before reading anything; otherwise the cap is
/// enforced chunk by chunk, so a runaway body is cut off at the cap instead of
/// being held in memory whole and only then rejected.
pub async fn read_capped(
    mut resp: reqwest::Response,
    max: u64,
) -> Result<Vec<u8>, CappedReadError> {
    if resp.content_length().is_some_and(|n| n > max) {
        return Err(CappedReadError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(CappedReadError::Read)? {
        if (body.len() + chunk.len()) as u64 > max {
            return Err(CappedReadError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Why a streamed download failed. The partial file is already gone.
#[derive(Debug)]
pub enum DownloadError {
    /// More than the cap arrived; carries the bytes streamed so far.
    TooLarge(u64),
    /// `keep_going` returned false.
    Stopped,
    Create(std::io::Error),
    Read(reqwest::Error),
    Write(std::io::Error),
}

/// Stream a response body into `dest`, returning the bytes written. After
/// each chunk `keep_going(written)` is awaited — progress reporting and
/// cancellation hang off it. Any failure removes the partial file, so a
/// half-written download is never mistaken for a whole one.
pub async fn stream_to_file<F, Fut>(
    mut resp: reqwest::Response,
    dest: &Path,
    max: Option<u64>,
    mut keep_going: F,
) -> Result<u64, DownloadError>
where
    F: FnMut(u64) -> Fut,
    Fut: Future<Output = bool>,
{
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(DownloadError::Create)?;
    let result = async {
        let mut written = 0u64;
        while let Some(chunk) = resp.chunk().await.map_err(DownloadError::Read)? {
            written += chunk.len() as u64;
            if max.is_some_and(|max| written > max) {
                return Err(DownloadError::TooLarge(written));
            }
            file.write_all(&chunk).await.map_err(DownloadError::Write)?;
            if !keep_going(written).await {
                return Err(DownloadError::Stopped);
            }
        }
        file.flush().await.map_err(DownloadError::Write)?;
        Ok(written)
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serve one raw HTTP/1.1 response per connection, verbatim, then close.
    async fn serve_raw(response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let response = response.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(&response).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}/")
    }

    fn with_length(body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    /// No Content-Length: the body runs until the connection closes.
    fn without_length(body: &[u8]) -> Vec<u8> {
        let mut r = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        r.extend_from_slice(body);
        r
    }

    /// Chunked transfer encoding, so no Content-Length is declared.
    fn chunked(chunks: &[&[u8]]) -> Vec<u8> {
        let mut r =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".to_vec();
        for c in chunks {
            r.extend_from_slice(format!("{:x}\r\n", c.len()).as_bytes());
            r.extend_from_slice(c);
            r.extend_from_slice(b"\r\n");
        }
        r.extend_from_slice(b"0\r\n\r\n");
        r
    }

    async fn get(url: &str) -> reqwest::Response {
        reqwest::Client::new().get(url).send().await.unwrap()
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "haruspex_test_http_util_{}_{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("out.bin")
    }

    #[tokio::test]
    async fn read_capped_refuses_an_honest_content_length_over_the_cap() {
        let url = serve_raw(with_length(&[7u8; 100])).await;
        let resp = get(&url).await;
        assert_eq!(resp.content_length(), Some(100));
        assert!(matches!(
            read_capped(resp, 99).await,
            Err(CappedReadError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn read_capped_reads_a_body_at_or_under_the_cap_whole() {
        let body: Vec<u8> = (0..=255u8).collect();
        let url = serve_raw(with_length(&body)).await;
        assert_eq!(read_capped(get(&url).await, 256).await.unwrap(), body);

        let url = serve_raw(without_length(&body)).await;
        assert_eq!(read_capped(get(&url).await, 1000).await.unwrap(), body);
    }

    #[tokio::test]
    async fn read_capped_cuts_off_a_body_without_content_length() {
        let url = serve_raw(without_length(&[1u8; 5000])).await;
        let resp = get(&url).await;
        assert_eq!(resp.content_length(), None);
        assert!(matches!(
            read_capped(resp, 4999).await,
            Err(CappedReadError::TooLarge)
        ));

        let url = serve_raw(chunked(&[&[1u8; 60], &[2u8; 60]])).await;
        assert!(matches!(
            read_capped(get(&url).await, 100).await,
            Err(CappedReadError::TooLarge)
        ));
    }

    #[tokio::test]
    async fn read_capped_accepts_an_empty_body() {
        let url = serve_raw(with_length(b"")).await;
        assert!(read_capped(get(&url).await, 0).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stream_to_file_writes_the_body_and_returns_its_length() {
        let body: Vec<u8> = (0..3000u32).map(|i| i as u8).collect();
        let url = serve_raw(with_length(&body)).await;
        let dest = temp_path("ok");
        let mut last_seen = 0;
        let n = stream_to_file(get(&url).await, &dest, Some(3000), |w| {
            assert!(w >= last_seen);
            last_seen = w;
            async { true }
        })
        .await
        .unwrap();
        assert_eq!(n, 3000);
        assert_eq!(last_seen, 3000);
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn stream_to_file_removes_the_partial_file_when_too_large() {
        let url = serve_raw(chunked(&[&[1u8; 60], &[2u8; 60]])).await;
        let dest = temp_path("too_large");
        let err = stream_to_file(get(&url).await, &dest, Some(100), |_| async { true })
            .await
            .unwrap_err();
        match err {
            DownloadError::TooLarge(n) => assert!(n > 100, "reported {n}"),
            other => panic!("expected TooLarge, got {other:?}"),
        }
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn stream_to_file_removes_the_partial_file_when_stopped() {
        let url = serve_raw(with_length(&[3u8; 2000])).await;
        let dest = temp_path("stopped");
        let err = stream_to_file(get(&url).await, &dest, None, |_| async { false })
            .await
            .unwrap_err();
        assert!(matches!(err, DownloadError::Stopped), "got {err:?}");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(dest.parent().unwrap());
    }

    #[tokio::test]
    async fn stream_to_file_reports_a_create_error() {
        let url = serve_raw(with_length(b"hi")).await;
        let file = temp_path("create");
        let dest = file.with_file_name("missing_dir").join("out.bin");
        let err = stream_to_file(get(&url).await, &dest, None, |_| async { true })
            .await
            .unwrap_err();
        assert!(matches!(err, DownloadError::Create(_)), "got {err:?}");
        let _ = std::fs::remove_dir_all(file.parent().unwrap());
    }
}
