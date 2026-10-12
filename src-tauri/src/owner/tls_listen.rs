//! Accepting HTTPS for the owner API and guest chat: TCP connections, each handshaken on
//! its own task so a slow or silent client can't hold up the next, and
//! handed to axum as a [`Listener`]. A connection that speaks plain HTTP (an
//! old `http://` link or bookmark) is sent to the same address over HTTPS.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_rustls::server::TlsStream;
use tokio_rustls::TlsAcceptor;

/// Longest a client may take to start or finish its handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Most of a plain HTTP request read to find where it was going.
const MAX_PLAIN_HEAD: usize = 8 * 1024;

/// TLS records start with 0x16 (handshake); HTTP starts with a method.
const TLS_HANDSHAKE: u8 = 0x16;

type Accepted = (TlsStream<TcpStream>, SocketAddr);

/// Accept until `stopping`, sending each finished handshake on `out`. `tag`
/// names the server in the log (`"owner"`, `"remote"`).
pub async fn accept_loop(
    tag: &'static str,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    out: mpsc::Sender<Accepted>,
    mut stopping: watch::Receiver<bool>,
) {
    loop {
        let (stream, peer) = tokio::select! {
            r = listener.accept() => match r {
                Ok(c) => c,
                Err(e) => {
                    // Out of file descriptors and the like: don't spin.
                    log::warn!("[{tag}] accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            // In its own block: the `Ref` it returns can't cross threads.
            _ = async { let _ = stopping.wait_for(|s| *s).await; } => return,
        };
        let acceptor = acceptor.clone();
        let out = out.clone();
        tokio::spawn(async move {
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, admit(tag, stream, &acceptor)).await {
                Ok(Some(tls)) => {
                    let _ = out.send((tls, peer)).await;
                }
                Ok(None) => {}
                Err(_) => log::debug!("[{tag}] {peer} took too long to connect"),
            }
        });
    }
}

/// The connection as TLS, or `None` once a plain HTTP one has been
/// redirected (or a broken one dropped).
async fn admit(
    tag: &str,
    stream: TcpStream,
    acceptor: &TlsAcceptor,
) -> Option<TlsStream<TcpStream>> {
    let mut first = [0u8; 1];
    let n = stream.peek(&mut first).await.ok()?;
    if n == 0 {
        return None;
    }
    if first[0] != TLS_HANDSHAKE {
        redirect_plain(stream).await;
        return None;
    }
    match acceptor.accept(stream).await {
        Ok(tls) => Some(tls),
        Err(e) => {
            // Mostly a browser that hasn't accepted the certificate yet.
            log::debug!("[{tag}] TLS handshake failed: {e}");
            None
        }
    }
}

/// Answer a plain HTTP request with a redirect to the same place over HTTPS.
async fn redirect_plain(mut stream: TcpStream) {
    let mut head = Vec::new();
    let mut buf = [0u8; 1024];
    while head.len() < MAX_PLAIN_HEAD && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let response = match https_location(&head) {
        Some(location) => format!(
            "HTTP/1.1 308 Permanent Redirect\r\nLocation: {location}\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        ),
        None => "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\
                 Content-Length: 30\r\nConnection: close\r\n\r\nThis address only speaks HTTPS"
            .to_string(),
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// `https://<Host><path>` for a plain HTTP request head, if it has a usable
/// `Host` and path.
pub fn https_location(head: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let path = lines.next()?.split(' ').nth(1)?;
    let host = lines.find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("host").then(|| v.trim())
    })?;
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-.:[]".contains(c));
    let path_ok = path.starts_with('/')
        && !path.starts_with("//")
        && path.chars().all(|c| c.is_ascii_graphic());
    (host_ok && path_ok).then(|| format!("https://{host}{path}"))
}

/// Finished handshakes, as axum takes connections.
pub struct TlsListener {
    incoming: mpsc::Receiver<Accepted>,
    local: SocketAddr,
}

impl TlsListener {
    pub fn new(incoming: mpsc::Receiver<Accepted>, local: SocketAddr) -> Self {
        TlsListener { incoming, local }
    }
}

impl Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.incoming.recv().await {
            Some(c) => c,
            // The acceptor has stopped: so has the server, which is shutting
            // down; wait for that rather than spin.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.local)
    }
}

/// Who connected, for handlers (`ConnectInfo<PeerAddr>`): axum only knows
/// how to name the peer of its own TCP listener.
#[derive(Clone, Copy, Debug)]
pub struct PeerAddr(pub SocketAddr);

impl PeerAddr {
    pub fn ip(&self) -> IpAddr {
        self.0.ip()
    }
}

impl Connected<IncomingStream<'_, TlsListener>> for PeerAddr {
    fn connect_info(stream: IncomingStream<'_, TlsListener>) -> Self {
        PeerAddr(*stream.remote_addr())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_request_is_sent_to_https() {
        let head = b"GET /app/?x=1 HTTP/1.1\r\nHost: box.lan:8788\r\nAccept: */*\r\n\r\n";
        assert_eq!(
            https_location(head).as_deref(),
            Some("https://box.lan:8788/app/?x=1")
        );
        let v6 = b"GET / HTTP/1.1\r\nhost: [fe80::1]:8788\r\n\r\n";
        assert_eq!(
            https_location(v6).as_deref(),
            Some("https://[fe80::1]:8788/")
        );
    }

    #[test]
    fn nothing_odd_goes_into_the_location() {
        for head in [
            &b"GET / HTTP/1.1\r\n\r\n"[..],
            b"GET //evil.example/ HTTP/1.1\r\nHost: box\r\n\r\n",
            b"GET / HTTP/1.1\r\nHost: box/evil\r\n\r\n",
            b"GET http://x/ HTTP/1.1\r\nHost: box\r\n\r\n",
        ] {
            assert_eq!(
                https_location(head),
                None,
                "{:?}",
                String::from_utf8_lossy(head)
            );
        }
    }
}
