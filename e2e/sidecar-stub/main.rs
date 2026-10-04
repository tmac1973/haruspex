//! A stand-in for a sidecar binary (llama-server, sd-server, …) in the
//! real-app end-to-end tests: it listens on the `--port` it is given, answers
//! every request `200 {"status":"ok"}` (enough for the app's health checks),
//! and runs until it is killed.
//!
//! When `E2E_STUB_PIDS` names a directory, it writes `<its name>.pid` there, so
//! a test can check that it died with the app.
//!
//! Standard library only, so `rustc -O main.rs` builds it anywhere CI does.

use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .windows(2)
        .find(|w| w[0] == "--port" || w[0] == "--listen-port")
        .and_then(|w| w[1].parse::<u16>().ok())
        .unwrap_or(0);
    if let Ok(dir) = std::env::var("E2E_STUB_PIDS") {
        let name = std::path::Path::new(&args[0])
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sidecar".into());
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(
            std::path::Path::new(&dir).join(format!("{name}.pid")),
            std::process::id().to_string(),
        );
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("sidecar stub: cannot listen on {port}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("sidecar stub listening on {}", listener.local_addr().unwrap());
    for stream in listener.incoming().flatten() {
        let mut stream = stream;
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let body = r#"{"status":"ok"}"#;
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
}
