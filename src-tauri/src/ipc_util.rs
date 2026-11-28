//! Helpers for commands that take their payload as a raw IPC body, with what
//! goes with it in request headers.

/// A header's value, percent-decoded: a path or a file name can hold any
/// character, and a header only ASCII. The webview encodes each with
/// `encodeURIComponent`.
pub fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("No {name} was given."))?;
    decode(raw, name)
}

fn decode(raw: &str, name: &str) -> Result<String, String> {
    urlencoding::decode(raw)
        .map(|s| s.into_owned())
        .map_err(|e| format!("{name} is not valid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_header_comes_back_decoded() {
        assert_eq!(
            decode("%2Fhome%2Fme%2Fd%C3%A9j%C3%A0%20vu.pptx", "x-path").unwrap(),
            "/home/me/déjà vu.pptx"
        );
    }

    #[test]
    fn bytes_that_are_not_utf8_are_refused_by_name() {
        let err = decode("%FF", "x-name").unwrap_err();
        assert!(err.starts_with("x-name is not valid UTF-8"), "{err}");
    }
}
