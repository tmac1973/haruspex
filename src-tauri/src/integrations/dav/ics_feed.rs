//! Calendar links: a read-only iCalendar feed at a URL.
//!
//! The easy way in for a calendar whose server wants OAuth — Google Calendar's
//! "secret address in iCal format" — and for anything that publishes a feed
//! (Outlook, iCloud, Proton, a sports fixture list). One GET for the whole
//! calendar, filtered and expanded locally by the same `ical.rs` that reads
//! CalDAV answers.
//!
//! The URL is a credential: whoever holds it reads the calendar. So it never
//! appears in an error, a log line or a tool result — only its host does.

use std::time::Duration;

use crate::proxy::{apply_proxy, ProxyConfig};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The largest feed we will read.
///
/// Years of a busy calendar run to a few megabytes. Anything far past that is
/// not a calendar, and reading it whole would hold it all in memory to answer
/// "what's on this week".
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;

/// The URL to fetch, from what the user pasted.
///
/// `webcal://` is what "subscribe" buttons hand out; it is plain HTTPS
/// underneath.
pub fn feed_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let url = match raw.get(..9) {
        Some(scheme) if scheme.eq_ignore_ascii_case("webcal://") => {
            format!("https://{}", &raw[9..])
        }
        _ => raw.to_string(),
    };
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| "The calendar link is not a web address.".to_string())?;
    match parsed.scheme() {
        "https" | "http" if parsed.host_str().is_some() => Ok(url),
        _ => Err("The calendar link should start with https:// or webcal://.".into()),
    }
}

/// Fetch the feed's text.
pub async fn fetch_feed(raw_url: &str, proxy: Option<&ProxyConfig>) -> Result<String, String> {
    let url = feed_url(raw_url)?;
    let host = host_of(&url);
    let http = apply_proxy(
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(5)),
        proxy,
    )?
    .build()
    .map_err(|e| format!("could not create an HTTP client: {e}"))?;

    let mut response = http
        .get(&url)
        .header("Accept", "text/calendar, */*;q=0.5")
        .send()
        .await
        // `without_url`: reqwest's message names the URL, which is the secret.
        .map_err(|e| format!("Could not reach {host}: {}", e.without_url()))?;

    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 | 404 => format!(
                "{host} refused the calendar link (HTTP {}). It may have been reset; copy it again.",
                status.as_u16()
            ),
            code => format!("{host} answered HTTP {code} for the calendar link."),
        });
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        format!(
            "Reading the calendar from {host} failed: {}",
            e.without_url()
        )
    })? {
        if body.len() + chunk.len() > MAX_FEED_BYTES {
            return Err(format!(
                "The calendar at {host} is larger than {} MB.",
                MAX_FEED_BYTES / (1024 * 1024)
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err(format!(
            "The link at {host} did not return a calendar. Use the iCal address, not the calendar's web page."
        ));
    }
    Ok(text)
}

/// The calendar's own name, from `X-WR-CALNAME`, when the feed gives one.
pub fn feed_name(ics: &str) -> Option<String> {
    let reader = ical::IcalParser::new(std::io::Cursor::new(ics.as_bytes()));
    reader.flatten().find_map(|calendar| {
        calendar
            .properties
            .into_iter()
            .find(|p| p.name.eq_ignore_ascii_case("X-WR-CALNAME"))
            .and_then(|p| p.value)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// The host, for messages. Never the path, which is where the secret is.
fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "the calendar server".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str =
        "https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123abcd/basic.ics";

    #[test]
    fn webcal_links_are_fetched_over_https() {
        assert_eq!(
            feed_url("webcal://p01-caldav.icloud.com/published/2/abc").unwrap(),
            "https://p01-caldav.icloud.com/published/2/abc"
        );
        assert_eq!(
            feed_url("  WEBCAL://example.com/cal.ics ").unwrap(),
            "https://example.com/cal.ics"
        );
        assert_eq!(feed_url(SECRET).unwrap(), SECRET);
    }

    #[test]
    fn only_web_addresses_are_accepted() {
        for bad in [
            "",
            "calendar.google.com/x.ics",
            "file:///etc/passwd",
            "ftp://x/y.ics",
        ] {
            assert!(feed_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn errors_name_the_host_and_never_the_secret_path() {
        let err = feed_url("file:///home/me/private-0123abcd.ics").unwrap_err();
        assert!(!err.contains("private-0123abcd"), "{err}");
        assert_eq!(host_of(SECRET), "calendar.google.com");
    }

    /// A refused connection on loopback: nothing listens on port 1, so this
    /// fails at once without a packet leaving the machine.
    #[tokio::test]
    async fn a_transport_failure_does_not_leak_the_link() {
        let err = fetch_feed("http://127.0.0.1:1/private-0123abcd/basic.ics", None)
            .await
            .unwrap_err();
        assert!(err.contains("127.0.0.1"), "{err}");
        assert!(!err.contains("private-0123abcd"), "{err}");
    }

    #[test]
    fn the_calendar_names_itself() {
        let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Family\r\nEND:VCALENDAR\r\n";
        assert_eq!(feed_name(ics).as_deref(), Some("Family"));
        assert_eq!(feed_name("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"), None);
    }

    /// Serve one HTTP response on loopback and hand back the URL.
    async fn serve_once(status: &'static str, body: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            let _ = socket.read(&mut request).await;
            let reply = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/calendar\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        });
        format!("http://127.0.0.1:{port}/private-0123abcd/basic.ics")
    }

    #[tokio::test]
    async fn a_feed_is_fetched_whole() {
        let url = serve_once(
            "200 OK",
            "BEGIN:VCALENDAR\r\nX-WR-CALNAME:Family\r\nEND:VCALENDAR\r\n",
        )
        .await;
        let ics = fetch_feed(&url, None).await.unwrap();
        assert_eq!(feed_name(&ics).as_deref(), Some("Family"));
    }

    #[tokio::test]
    async fn a_reset_link_says_so_without_naming_it() {
        let url = serve_once("404 Not Found", "").await;
        let err = fetch_feed(&url, None).await.unwrap_err();
        assert!(err.contains("copy it again"), "{err}");
        assert!(!err.contains("private-0123abcd"), "{err}");
    }

    #[tokio::test]
    async fn a_web_page_is_not_mistaken_for_a_calendar() {
        let url = serve_once("200 OK", "<html>Google Calendar</html>").await;
        let err = fetch_feed(&url, None).await.unwrap_err();
        assert!(err.contains("iCal address"), "{err}");
    }

    /// Google's public US holidays calendar: the same `/ical/.../basic.ics`
    /// shape as a secret link, without the secret. Ignored by default because
    /// it needs the network; run it when changing how feeds are read.
    #[tokio::test]
    #[ignore]
    async fn a_real_google_feed_reads_end_to_end() {
        use chrono::{TimeZone, Utc};
        let url = "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics";
        let ics = fetch_feed(url, None).await.expect("the feed");
        let source = super::super::ical::EventSource {
            account_id: "g".into(),
            account_label: "Holidays".into(),
            calendar_name: feed_name(&ics).unwrap_or_default(),
        };
        let from = Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap();
        let to = Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap();
        let events = super::super::ical::parse_events(&ics, &source, from, to, chrono_tz::UTC);
        assert!(
            events.iter().any(|e| e.summary.contains("Christmas")),
            "{:?}",
            events
                .iter()
                .map(|e| (&e.summary, &e.start))
                .collect::<Vec<_>>()
        );
    }
}
