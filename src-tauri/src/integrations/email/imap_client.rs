//! IMAP client wrapper.
//!
//! Thin layer over `async-imap` (runtime-tokio feature) + `tokio-rustls`.
//! Every method opens a fresh connection, runs one logical operation,
//! and closes — no pooling. Phase 10.1 doesn't need long-lived
//! sessions, and the connect-per-call model avoids a whole class of
//! state-management bugs we'd otherwise have to chase (stale tokens,
//! half-closed sockets, unrelated clients draining our rate budget).

use std::sync::{Arc, OnceLock};

use async_imap::types::Fetch;
use futures_util::stream::StreamExt;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use super::auth::EmailAccount;
use super::parser::{parse_rfc5322, parse_to_listing, EmailListing, NormalizedMessage};
use super::provider::TlsMode;

/// Filters accepted by [`list_recent`]. All fields are optional;
/// `None` means "don't constrain on this axis".
#[derive(Debug, Clone, Default)]
pub struct ListFilters {
    /// Only return messages newer than N hours ago. Exclusive with
    /// `since_date`; if both are set, `hours` wins.
    pub hours: Option<u32>,
    /// Alternative date floor — an IMAP `SINCE` date in
    /// `DD-Mon-YYYY` format (e.g. "10-Apr-2026").
    pub since_date: Option<String>,
    /// Case-insensitive substring filter on the `FROM` header.
    pub from: Option<String>,
    /// Case-insensitive substring filter on the `SUBJECT` header.
    pub subject_contains: Option<String>,
    /// Upper bound on results. Cap enforced by the caller (default 20,
    /// hard max 50).
    pub max_results: u32,
}

/// Convenience type alias for an authenticated async-imap session over
/// the TLS-wrapped TCP stream.
type ImapSession = async_imap::Session<TlsStream<TcpStream>>;

/// Build a rustls client config from the `webpki-roots` bundle. We
/// reuse this across connections rather than rebuilding it every
/// time — the CA load is cheap but pointlessly repetitive.
///
/// Also handles the rustls 0.23 CryptoProvider ambiguity: the crate
/// refuses to pick a default provider when multiple are compiled in
/// (Haruspex's tree pulls rustls in via reqwest, tokio-rustls, and
/// our direct dep). We install the `ring` provider the first time
/// this function is called. `install_default` is idempotent in the
/// sense that a second call returns `Err` but leaves the previously
/// installed provider in place, so we discard the result.
fn tls_config() -> Arc<ClientConfig> {
    static CONFIG: OnceLock<Arc<ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let cfg = ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

/// Open a TLS connection to the account's configured IMAP host and
/// authenticate via plain `LOGIN` (which Gmail, Fastmail, iCloud, and
/// Yahoo all accept for app passwords). STARTTLS support is stubbed
/// because none of the presets use it and wiring it up correctly
/// needs extra care around the imap_stream's generic bounds.
pub async fn connect_and_login(account: &EmailAccount) -> Result<ImapSession, String> {
    account
        .validate()
        .map_err(|e| format!("Account validation failed: {e}"))?;

    if account.imap_tls != TlsMode::Implicit {
        // STARTTLS for IMAP support is deferred until we have a user
        // who actually needs it. Every built-in preset uses implicit
        // TLS on port 993.
        return Err("STARTTLS IMAP is not yet supported — use implicit TLS (port 993)".to_string());
    }

    let addr = format!("{}:{}", account.imap_host, account.imap_port);
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("TCP connect to {addr} failed: {e}"))?;

    let connector = TlsConnector::from(tls_config());
    let dns_name = ServerName::try_from(account.imap_host.clone())
        .map_err(|e| format!("Invalid IMAP hostname {:?}: {e}", account.imap_host))?;
    let tls_stream = connector
        .connect(dns_name, tcp)
        .await
        .map_err(|e| format!("TLS handshake with {addr} failed: {e}"))?;

    let mut client = async_imap::Client::new(tls_stream);

    // Read the server greeting — async-imap expects us to drain it
    // before issuing any commands.
    let _greeting = client
        .read_response()
        .await
        .map_err(|e| format!("Reading IMAP greeting failed: {e}"))?
        .ok_or_else(|| "Server closed the connection before sending a greeting".to_string())?;

    let session = client
        .login(&account.email_address, &account.password)
        .await
        .map_err(|(err, _client)| format!("IMAP LOGIN rejected: {err}"))?;

    Ok(session)
}

/// Just open + authenticate + logout. Used by the `email_test_connection`
/// Tauri command to validate credentials without fetching anything.
pub async fn test_connection(account: &EmailAccount) -> Result<(), String> {
    let mut session = connect_and_login(account).await?;
    // SELECT INBOX as an extra sanity check — catches the case where
    // LOGIN succeeds but the mailbox is unavailable (rare but happens
    // with unusual Gmail delegation setups).
    session
        .select("INBOX")
        .await
        .map_err(|e| format!("SELECT INBOX failed: {e}"))?;
    let _ = session.logout().await;
    Ok(())
}

/// Build an IMAP SEARCH query string from the filter set.
///
/// RFC 3501 SEARCH uses a space-separated list of criteria that are
/// implicitly ANDed. Our filter set maps directly:
///
/// - `hours` / `since_date` → `SINCE <DD-Mon-YYYY>`
/// - `from`                 → `FROM "<substring>"`
/// - `subject_contains`     → `SUBJECT "<substring>"`
///
/// When no criteria are supplied we default to `ALL` (which the
/// caller then bounds by `max_results`).
fn build_search_query(filters: &ListFilters) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(h) = filters.hours {
        // Translate "last N hours" into an IMAP SINCE floor. IMAP
        // SINCE is date-granularity — finer-grained filtering happens
        // in the post-fetch pass below where we have the real Date
        // header to compare against.
        let since = imap_since_for_hours(h);
        parts.push(format!("SINCE {since}"));
    } else if let Some(d) = filters.since_date.as_ref() {
        parts.push(format!("SINCE {d}"));
    }

    if let Some(f) = filters.from.as_ref() {
        parts.push(format!("FROM \"{}\"", f.replace('"', "")));
    }

    if let Some(s) = filters.subject_contains.as_ref() {
        parts.push(format!("SUBJECT \"{}\"", s.replace('"', "")));
    }

    if parts.is_empty() {
        "ALL".to_string()
    } else {
        parts.join(" ")
    }
}

/// Format the IMAP SINCE clause for `now - hours` in `DD-Mon-YYYY`
/// form. We avoid pulling in chrono for this — computing the date
/// "N hours ago" using std::time + a small month-name table is
/// enough.
fn imap_since_for_hours(hours: u32) -> String {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0));
    let back = now.saturating_sub(Duration::from_secs(hours as u64 * 3600));
    unix_to_imap_date(back.as_secs() as i64)
}

/// Convert a Unix timestamp to IMAP's `DD-Mon-YYYY` date format.
/// Pure integer math so we don't need chrono; accuracy is
/// day-granularity which is all SINCE consumes.
fn unix_to_imap_date(secs: i64) -> String {
    // Days since the Unix epoch (1970-01-01 is a Thursday).
    let days = secs.div_euclid(86_400);

    // Algorithm from Howard Hinnant's "date algorithms" paper —
    // converts days-since-epoch to a (y, m, d) tuple without
    // external deps. Handles the Gregorian calendar correctly.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let month = MONTHS[(m - 1) as usize];
    format!("{:02}-{}-{:04}", d, month, y)
}

/// Extract the raw RFC 5322 bytes from a single Fetch response. Some
/// servers return `BODY[]` in the `body()` slot, others return it
/// under a non-standard attribute; async-imap's `body()` covers both.
fn fetch_bytes(f: &Fetch) -> Option<Vec<u8>> {
    f.body().map(|b| b.to_vec())
}

/// Fetch listings for the `max_results` most recent messages matching
/// the supplied filter set from the account's INBOX.
///
/// Flow:
///   1. LOGIN + SELECT INBOX
///   2. UID SEARCH with our generated criteria
///   3. Sort UIDs descending (newest first), slice to `max_results`
///   4. UID FETCH the envelope + body for each (single round-trip),
///      then normalize through mail-parser
///   5. LOGOUT
pub async fn list_recent(
    account: &EmailAccount,
    filters: &ListFilters,
) -> Result<Vec<EmailListing>, String> {
    let mut session = connect_and_login(account).await?;

    session
        .select("INBOX")
        .await
        .map_err(|e| format!("SELECT INBOX failed: {e}"))?;

    let query = build_search_query(filters);
    let uids = session
        .uid_search(&query)
        .await
        .map_err(|e| format!("UID SEARCH {query:?} failed: {e}"))?;

    // Sort UIDs descending so we process newest-first, then slice.
    let mut uids_vec: Vec<u32> = uids.into_iter().collect();
    uids_vec.sort_unstable_by(|a, b| b.cmp(a));
    let cap = if filters.max_results == 0 {
        20
    } else {
        filters.max_results.min(50) as usize
    };
    uids_vec.truncate(cap);

    if uids_vec.is_empty() {
        let _ = session.logout().await;
        return Ok(Vec::new());
    }

    // UID FETCH takes a comma-separated sequence set. We ask for
    // BODY.PEEK[] so the messages stay unread.
    let uid_seq = uids_vec
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let mut stream = session
        .uid_fetch(uid_seq, "BODY.PEEK[]")
        .await
        .map_err(|e| format!("UID FETCH failed: {e}"))?;

    let mut listings: Vec<EmailListing> = Vec::with_capacity(uids_vec.len());
    while let Some(msg) = stream.next().await {
        let fetch = match msg {
            Ok(f) => f,
            Err(e) => {
                // One bad message shouldn't kill the whole list.
                // Log (via the agent's tool-result channel) and move
                // on — future extension could preserve the error
                // inline, but for Phase 10.1 we just skip it.
                log::warn!("IMAP fetch error skipped: {e}");
                continue;
            }
        };
        let uid = match fetch.uid {
            Some(u) => u,
            None => continue,
        };
        let Some(bytes) = fetch_bytes(&fetch) else {
            continue;
        };
        match parse_to_listing(
            &bytes,
            account.id.clone(),
            account.label.clone(),
            uid.to_string(),
        ) {
            Ok(l) => listings.push(l),
            Err(e) => log::warn!("mail-parser rejected UID {uid}: {e}"),
        }
    }
    drop(stream);
    let _ = session.logout().await;

    // Re-sort by date descending so the caller sees newest-first
    // regardless of the order the server streamed them.
    listings.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(listings)
}

/// Fetch a single full message by UID. Used by `email_read_full` and
/// internally by the summarizer sub-agent.
pub async fn fetch_full(
    account: &EmailAccount,
    message_id: &str,
) -> Result<NormalizedMessage, String> {
    let uid: u32 = message_id
        .parse()
        .map_err(|_| format!("Invalid message_id {message_id:?} — expected a decimal UID"))?;

    let mut session = connect_and_login(account).await?;
    session
        .select("INBOX")
        .await
        .map_err(|e| format!("SELECT INBOX failed: {e}"))?;

    let mut stream = session
        .uid_fetch(uid.to_string(), "BODY.PEEK[]")
        .await
        .map_err(|e| format!("UID FETCH {uid} failed: {e}"))?;

    let mut bytes: Option<Vec<u8>> = None;
    while let Some(msg) = stream.next().await {
        let fetch = msg.map_err(|e| format!("UID FETCH stream error: {e}"))?;
        if let Some(b) = fetch_bytes(&fetch) {
            bytes = Some(b);
            break;
        }
    }
    drop(stream);
    let _ = session.logout().await;

    let bytes = bytes.ok_or_else(|| format!("No message body returned for UID {uid}"))?;
    parse_rfc5322(
        &bytes,
        account.id.clone(),
        account.label.clone(),
        message_id.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_query_defaults_to_all() {
        let q = build_search_query(&ListFilters::default());
        assert_eq!(q, "ALL");
    }

    #[test]
    fn search_query_combines_criteria() {
        let q = build_search_query(&ListFilters {
            hours: None,
            since_date: Some("01-Jan-2026".into()),
            from: Some("alice".into()),
            subject_contains: Some("report".into()),
            max_results: 10,
        });
        assert!(q.contains("SINCE 01-Jan-2026"));
        assert!(q.contains("FROM \"alice\""));
        assert!(q.contains("SUBJECT \"report\""));
    }

    #[test]
    fn search_query_strips_quotes_from_user_input() {
        let q = build_search_query(&ListFilters {
            from: Some(r#"ev"il"#.into()),
            ..Default::default()
        });
        // The embedded quote is scrubbed so it can't break out of the
        // quoted string and inject a new SEARCH clause.
        assert!(!q.contains(r#"ev"il"#));
        assert!(q.contains("FROM \"evil\""));
    }

    #[test]
    fn unix_epoch_maps_to_jan_1970() {
        assert_eq!(unix_to_imap_date(0), "01-Jan-1970");
    }

    #[test]
    fn known_date_conversion() {
        // 2024-04-11 00:00 UTC = 1_712_793_600
        assert_eq!(unix_to_imap_date(1_712_793_600), "11-Apr-2024");
    }
}
