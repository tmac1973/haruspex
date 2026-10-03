//! IMAP client wrapper.
//!
//! Thin layer over `async-imap` (runtime-tokio feature) + `tokio-rustls`.
//!
//! - **Every network step has a time limit** ([`TIMEOUTS`]), and its error
//!   names the step and the host: a stalled server fails the call instead of
//!   hanging the turn.
//! - **One logged-in session per account is kept** for a couple of minutes
//!   ([`checkout`] / [`checkin`]). A call takes the session out for its whole
//!   duration and puts it back only on success, so a call that failed — or
//!   was aborted mid-protocol, which raises no error at all — never leaves a
//!   broken session for the next one.
//! - **A list never downloads a message whole:** headers, the structure, and
//!   the first 4 KB of the text part.

use std::collections::HashMap;
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use async_imap::imap_proto::types::SectionPath;
use async_imap::types::Fetch;
use futures_util::stream::StreamExt;
use rustls::pki_types::ServerName;
use rustls::{ClientConfig, RootCertStore};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use super::auth::EmailAccount;
use super::parser::{
    listing_from_header, parse_rfc5322, parse_with_body, EmailListing, NormalizedMessage,
};
use super::provider::TlsMode;
use super::structure::{self, Part};

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
    /// Upper bound on results: [`DEFAULT_MAX_RESULTS`] when zero, at most
    /// [`MAX_RESULTS`].
    pub max_results: u32,
}

/// Results when the caller names no number. The tool's schema and its
/// TypeScript fan-out say the same.
pub const DEFAULT_MAX_RESULTS: u32 = 25;
const MAX_RESULTS: u32 = 50;

/// How much of a message's text part a list reads for its preview.
const PREVIEW_BYTES: u32 = 4096;
/// A message larger than this is read without its attachments.
const WHOLE_MESSAGE_MAX: u32 = 5 * 1024 * 1024;
/// How much text a read of such a message fetches.
const LARGE_TEXT_BYTES: u32 = 512 * 1024;

/// A logged-in session, over TLS from the start or after STARTTLS.
type ImapSession = async_imap::Session<TlsStream<TcpStream>>;

/// The limits on each network step.
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub connect: Duration,
    pub login: Duration,
    pub command: Duration,
    pub noop: Duration,
}

pub const TIMEOUTS: Timeouts = Timeouts {
    connect: Duration::from_secs(15),
    login: Duration::from_secs(20),
    command: Duration::from_secs(30),
    noop: Duration::from_secs(5),
};

/// A kept session is dropped after this long unused.
const SESSION_IDLE: Duration = Duration::from_secs(120);

fn span(d: Duration) -> String {
    if d.as_secs() >= 1 {
        format!("{} s", d.as_secs())
    } else {
        format!("{} ms", d.as_millis())
    }
}

/// Run one network step under its time limit; either failure names the step
/// and the host.
async fn within<T, E: std::fmt::Display>(
    limit: Duration,
    host: &str,
    step: &str,
    fut: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(limit, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{step} on {host} failed: {e}")),
        Err(_) => Err(format!(
            "{host} did not answer {step} within {}",
            span(limit)
        )),
    }
}

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

async fn tls(tcp: TcpStream, host: &str, t: &Timeouts) -> Result<TlsStream<TcpStream>, String> {
    let name = ServerName::try_from(host.to_string())
        .map_err(|e| format!("Invalid IMAP hostname {host:?}: {e}"))?;
    let connector = TlsConnector::from(tls_config());
    within(
        t.connect,
        host,
        "the TLS handshake",
        connector.connect(name, tcp),
    )
    .await
}

/// Read the server's greeting, which must come before any command.
async fn greeting<S>(
    client: &mut async_imap::Client<S>,
    host: &str,
    t: &Timeouts,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + std::fmt::Debug + Send,
{
    let got = within(t.connect, host, "the greeting", client.read_response()).await?;
    got.map(|_| ())
        .ok_or_else(|| format!("{host} closed the connection before greeting"))
}

/// Connect and log in. Implicit TLS, or STARTTLS: connect in the clear,
/// upgrade, and only then send the password. Never a plain login.
pub async fn connect_and_login(
    account: &EmailAccount,
    t: &Timeouts,
) -> Result<ImapSession, String> {
    account
        .validate()
        .map_err(|e| format!("Account validation failed: {e}"))?;
    let host = account.imap_host.as_str();
    let addr = format!("{host}:{}", account.imap_port);
    let tcp = within(t.connect, host, "the connection", TcpStream::connect(&addr)).await?;

    let stream = match account.imap_tls {
        TlsMode::Implicit => {
            let stream = tls(tcp, host, t).await?;
            let mut client = async_imap::Client::new(stream);
            greeting(&mut client, host, t).await?;
            client
        }
        TlsMode::Starttls => {
            let mut plain = async_imap::Client::new(tcp);
            greeting(&mut plain, host, t).await?;
            within(
                t.command,
                host,
                "STARTTLS",
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await?;
            let stream = tls(plain.into_inner(), host, t).await?;
            // No greeting after the upgrade (RFC 3501 §6.2.1).
            async_imap::Client::new(stream)
        }
    };

    let login = async {
        stream
            .login(&account.email_address, &account.password)
            .await
            .map_err(|(e, _)| e)
    };
    within(t.login, host, "LOGIN", login).await
}

/// Just open + authenticate + logout. Used by the `email_test_connection`
/// Tauri command to validate credentials without fetching anything. Never
/// cached: the account under test may not be saved yet.
pub async fn test_connection(account: &EmailAccount) -> Result<(), String> {
    let t = TIMEOUTS;
    let mut session = connect_and_login(account, &t).await?;
    // SELECT INBOX as an extra sanity check — catches the case where
    // LOGIN succeeds but the mailbox is unavailable (rare but happens
    // with unusual Gmail delegation setups).
    within(
        t.command,
        &account.imap_host,
        "SELECT INBOX",
        session.select("INBOX"),
    )
    .await?;
    let _ = session.logout().await;
    Ok(())
}

struct Kept {
    session: ImapSession,
    used: Instant,
    /// The login it was made with; a different one never reuses it.
    login: u64,
}

fn kept() -> &'static Mutex<HashMap<String, Kept>> {
    static KEPT: OnceLock<Mutex<HashMap<String, Kept>>> = OnceLock::new();
    KEPT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn login_of(account: &EmailAccount) -> u64 {
    let mut h = DefaultHasher::new();
    (
        &account.imap_host,
        account.imap_port,
        account.imap_tls == TlsMode::Implicit,
        &account.email_address,
        &account.password,
    )
        .hash(&mut h);
    h.finish()
}

/// A logged-in session for the account: the kept one if it is fresh and
/// still answers, else a new login.
async fn checkout(account: &EmailAccount, t: &Timeouts) -> Result<ImapSession, String> {
    let kept = kept()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&account.id);
    if let Some(mut k) = kept {
        if k.login == login_of(account) && k.used.elapsed() < SESSION_IDLE {
            if let Ok(Ok(())) = tokio::time::timeout(t.noop, k.session.noop()).await {
                return Ok(k.session);
            }
        }
    }
    connect_and_login(account, t).await
}

/// Keep a session that finished its call cleanly.
fn checkin(account: &EmailAccount, session: ImapSession) {
    kept().lock().unwrap_or_else(|p| p.into_inner()).insert(
        account.id.clone(),
        Kept {
            session,
            used: Instant::now(),
            login: login_of(account),
        },
    );
}

/// Drop the kept session, so the next call logs in again: the account was
/// edited.
pub fn forget(account_id: &str) {
    kept()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(account_id);
}

/// SELECT INBOX; its UIDVALIDITY.
async fn select_inbox(session: &mut ImapSession, host: &str, t: &Timeouts) -> Result<u32, String> {
    let mailbox = within(t.command, host, "SELECT INBOX", session.select("INBOX")).await?;
    Ok(mailbox.uid_validity.unwrap_or(0))
}

/// A UID FETCH, collected. One message the server could not send is
/// skipped, not fatal.
async fn fetch(
    session: &mut ImapSession,
    host: &str,
    t: &Timeouts,
    set: &str,
    query: &str,
) -> Result<Vec<Fetch>, String> {
    let collect = async {
        let mut stream = session.uid_fetch(set, query).await?;
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(f) => out.push(f),
                Err(e) => log::warn!("IMAP fetch error skipped: {e}"),
            }
        }
        Ok::<_, async_imap::error::Error>(out)
    };
    within(t.command, host, "FETCH", collect).await
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
        parts.push(format!("SINCE {}", normalize_since_date(d)));
    }

    if let Some(f) = filters.from.as_ref() {
        parts.push(format!("FROM \"{}\"", sanitize_search_value(f)));
    }

    if let Some(s) = filters.subject_contains.as_ref() {
        parts.push(format!("SUBJECT \"{}\"", sanitize_search_value(s)));
    }

    if parts.is_empty() {
        "ALL".to_string()
    } else {
        parts.join(" ")
    }
}

/// Strip characters that could break out of a quoted IMAP SEARCH atom.
/// Filter values are LLM-controlled tool args (reachable via prompt
/// injection from a malicious email), and `async-imap` does no escaping:
/// a CR/LF would terminate the SEARCH line and inject a new command on
/// the authenticated session; a backslash or quote could splice the
/// quoted string.
fn sanitize_search_value(v: &str) -> String {
    v.chars()
        .filter(|c| !matches!(c, '"' | '\\' | '\r' | '\n' | '\0'))
        .collect()
}

/// Month-name table shared by the SINCE-date formatters below.
const IMAP_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Normalize a model-supplied `since_date` into IMAP's `DD-Mon-YYYY`
/// SINCE format. Models routinely emit ISO `YYYY-MM-DD` dates; those
/// are converted. Anything else (including the already-correct native
/// format) passes through sanitized, exactly as before.
fn normalize_since_date(v: &str) -> String {
    let sanitized = sanitize_search_value(v);
    let trimmed = sanitized.trim();
    let bytes = trimmed.as_bytes();
    if trimmed.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' {
        if let (Ok(y), Ok(m), Ok(d)) = (
            trimmed[0..4].parse::<u16>(),
            trimmed[5..7].parse::<u8>(),
            trimmed[8..10].parse::<u8>(),
        ) {
            if (1..=12).contains(&m) && (1..=31).contains(&d) {
                return format!("{:02}-{}-{:04}", d, IMAP_MONTHS[(m - 1) as usize], y);
            }
        }
    }
    sanitized
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
    // A day earlier than the hours ask: SINCE compares dates in the server's
    // time zone, not UTC. The exact cut is made after the fetch.
    let back = now.saturating_sub(Duration::from_secs((hours as u64 + 24) * 3600));
    unix_to_imap_date(back.as_secs() as i64)
}

/// Convert a Unix timestamp to IMAP's `DD-Mon-YYYY` date format.
/// Pure integer math so we don't need chrono; accuracy is
/// day-granularity which is all SINCE consumes.
fn unix_to_imap_date(secs: i64) -> String {
    // Day-granularity is all IMAP's SINCE consumes. Shared calendar math
    // lives in crate::time_util (no chrono dependency).
    let (y, m, d) = crate::time_util::days_to_ymd(secs.div_euclid(86_400));
    let month = IMAP_MONTHS[(m - 1) as usize];
    format!("{:02}-{}-{:04}", d, month, y)
}

/// The query that lists a message without downloading it: the headers a
/// listing shows, the structure (to find the text part), and the server's
/// date for a message with no Date header.
const LIST_QUERY: &str = "(UID INTERNALDATE RFC822.SIZE BODYSTRUCTURE \
     BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID)])";

/// The fetch of the first `len` bytes of one part.
fn part_query(section: &str, len: u32) -> String {
    format!("(UID BODY.PEEK[{section}]<0.{len}>)")
}

/// A message handle: `"<uidvalidity>:<uid>"`.
pub fn handle(uid_validity: u32, uid: u32) -> String {
    format!("{uid_validity}:{uid}")
}

/// The UID in a handle, refusing one from before the mailbox was renumbered.
/// A bare UID, from before handles carried UIDVALIDITY, is still accepted.
pub fn uid_from_handle(handle: &str, uid_validity: u32) -> Result<u32, String> {
    let bad = || format!("Invalid message_id {handle:?} — pass the messageId from a listing");
    match handle.split_once(':') {
        Some((v, u)) => {
            let v: u32 = v.trim().parse().map_err(|_| bad())?;
            if v != uid_validity {
                return Err("That message list is stale — list again".to_string());
            }
            u.trim().parse().map_err(|_| bad())
        }
        None => handle.trim().parse().map_err(|_| bad()),
    }
}

/// The text part's bytes in a fetch, and whether they stop short of its end.
fn section_bytes<'a>(f: &'a Fetch, part: &Part, limit: u32) -> Option<(&'a [u8], bool)> {
    let bytes = f.section(&SectionPath::Part(part.path.clone(), None))?;
    Some((bytes, bytes.len() as u32 >= limit))
}

/// What the first fetch learnt about one message.
struct Listed {
    uid: u32,
    header: Vec<u8>,
    internal: Option<i64>,
    text: Option<Part>,
    attachments: bool,
}

/// Fetch listings for the `max_results` most recent messages matching the
/// filters, newest first.
///
/// 1. SELECT INBOX, UID SEARCH, keep the newest `max_results` UIDs.
/// 2. Fetch headers and structure ([`LIST_QUERY`]).
/// 3. Fetch the first [`PREVIEW_BYTES`] of each message's text part, one
///    FETCH per section number, and decode it for the snippet.
/// 4. Drop what is older than `hours`; SINCE only filters by day.
pub async fn list_recent(
    account: &EmailAccount,
    filters: &ListFilters,
) -> Result<Vec<EmailListing>, String> {
    let t = TIMEOUTS;
    let mut session = checkout(account, &t).await?;
    let out = list_in(&mut session, account, filters, &t).await;
    if out.is_ok() {
        checkin(account, session);
    }
    out
}

async fn list_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    filters: &ListFilters,
    t: &Timeouts,
) -> Result<Vec<EmailListing>, String> {
    let host = account.imap_host.as_str();
    let validity = select_inbox(session, host, t).await?;

    let query = build_search_query(filters);
    let found = within(t.command, host, "SEARCH", session.uid_search(&query)).await?;
    let mut uids: Vec<u32> = found.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(result_cap(filters.max_results));
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let set = uid_set(&uids);

    let mut listed: Vec<Listed> = fetch(session, host, t, &set, LIST_QUERY)
        .await?
        .iter()
        .filter_map(|f| {
            let parts = f.bodystructure().map(structure::parts).unwrap_or_default();
            Some(Listed {
                uid: f.uid?,
                header: f.header()?.to_vec(),
                internal: f.internal_date().map(|d| d.timestamp()),
                text: structure::text_part(&parts).cloned(),
                attachments: structure::has_attachments(&parts),
            })
        })
        .collect();

    // One FETCH per section number: most messages share one or two.
    let mut previews: HashMap<u32, String> = HashMap::new();
    let mut by_section: HashMap<String, Vec<u32>> = HashMap::new();
    for l in &listed {
        if let Some(p) = &l.text {
            by_section.entry(p.section()).or_default().push(l.uid);
        }
    }
    for (section, uids) in by_section {
        let fetched = fetch(
            session,
            host,
            t,
            &uid_set(&uids),
            &part_query(&section, PREVIEW_BYTES),
        )
        .await?;
        for f in &fetched {
            let Some(uid) = f.uid else { continue };
            let Some(part) = listed
                .iter()
                .find(|l| l.uid == uid)
                .and_then(|l| l.text.as_ref())
            else {
                continue;
            };
            if let Some((bytes, cut)) = section_bytes(f, part, PREVIEW_BYTES) {
                previews.insert(uid, structure::decode(bytes, part, cut));
            }
        }
    }

    let floor = filters.hours.map(|h| now_secs() - i64::from(h) * 3600);
    let mut listings: Vec<EmailListing> = listed
        .drain(..)
        .filter_map(|l| {
            let preview = previews.remove(&l.uid).unwrap_or_default();
            listing_from_header(
                &l.header,
                &preview,
                l.attachments,
                l.internal,
                account.id.clone(),
                account.label.clone(),
                handle(validity, l.uid),
            )
            .map_err(|e| log::warn!("Could not read the headers of UID {}: {e}", l.uid))
            .ok()
        })
        .filter(|l| within_hours(l.timestamp, floor))
        .collect();
    listings.sort_by_key(|l| std::cmp::Reverse(l.timestamp));
    Ok(listings)
}

fn result_cap(max: u32) -> usize {
    (if max == 0 {
        DEFAULT_MAX_RESULTS
    } else {
        max.min(MAX_RESULTS)
    }) as usize
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Is a message dated at or after `floor`? An undated one is kept: there is
/// no telling, and SINCE already let it through.
fn within_hours(timestamp: Option<i64>, floor: Option<i64>) -> bool {
    match (timestamp, floor) {
        (Some(ts), Some(floor)) => ts >= floor,
        _ => true,
    }
}

/// Fetch one message by handle. Used by `email_read_full` and the
/// summarizer. A message over [`WHOLE_MESSAGE_MAX`] is read without its
/// attachments: its headers and up to [`LARGE_TEXT_BYTES`] of its text.
pub async fn fetch_full(
    account: &EmailAccount,
    message_id: &str,
) -> Result<NormalizedMessage, String> {
    let t = TIMEOUTS;
    let mut session = checkout(account, &t).await?;
    let out = read_in(&mut session, account, message_id, &t).await;
    if out.is_ok() {
        checkin(account, session);
    }
    out
}

async fn read_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    message_id: &str,
    t: &Timeouts,
) -> Result<NormalizedMessage, String> {
    let host = account.imap_host.as_str();
    let validity = select_inbox(session, host, t).await?;
    let uid = uid_from_handle(message_id, validity)?;
    let set = uid.to_string();
    let missing = || format!("No message {message_id} in INBOX — list again");
    let ids = || {
        (
            account.id.clone(),
            account.label.clone(),
            handle(validity, uid),
        )
    };

    let shape = fetch(session, host, t, &set, "(UID RFC822.SIZE BODYSTRUCTURE)").await?;
    let shape = shape.first().ok_or_else(missing)?;
    if shape.size.unwrap_or(0) <= WHOLE_MESSAGE_MAX {
        let whole = fetch(session, host, t, &set, "(UID BODY.PEEK[])").await?;
        let bytes = whole.first().and_then(|f| f.body()).ok_or_else(missing)?;
        let (id, label, handle) = ids();
        return parse_rfc5322(bytes, id, label, handle);
    }

    let parts = shape
        .bodystructure()
        .map(structure::parts)
        .unwrap_or_default();
    let header = fetch(session, host, t, &set, "(UID BODY.PEEK[HEADER])").await?;
    let header = header
        .first()
        .and_then(|f| f.header())
        .ok_or_else(missing)?
        .to_vec();
    let mut body = match structure::text_part(&parts) {
        Some(part) => {
            let got = fetch(
                session,
                host,
                t,
                &set,
                &part_query(&part.section(), LARGE_TEXT_BYTES),
            )
            .await?;
            got.first()
                .and_then(|f| section_bytes(f, part, LARGE_TEXT_BYTES))
                .map(|(bytes, cut)| structure::decode(bytes, part, cut))
                .unwrap_or_default()
        }
        None => String::new(),
    };
    body.push_str(&format!(
        "\n\n[The message is {} MB; its attachments were not downloaded.]",
        shape.size.unwrap_or(0) / (1024 * 1024)
    ));
    let (id, label, handle) = ids();
    parse_with_body(
        &header,
        body,
        structure::has_attachments(&parts),
        id,
        label,
        handle,
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
    fn search_query_strips_crlf_injection() {
        // A CR/LF in a filter value would terminate the SEARCH command
        // and inject a raw IMAP command on the authenticated session.
        let q = build_search_query(&ListFilters {
            from: Some("a\r\nA1 DELETE INBOX\r\n".into()),
            subject_contains: Some("x\\\"y\r\n".into()),
            since_date: Some("01-Jan-2026\r\nA2 LOGOUT".into()),
            ..Default::default()
        });
        assert!(!q.contains('\r'));
        assert!(!q.contains('\n'));
        assert!(!q.contains('\\'));
        assert!(q.contains("FROM \"aA1 DELETE INBOX\""));
        assert!(q.contains("SINCE 01-Jan-2026A2 LOGOUT"));
    }

    #[test]
    fn since_date_iso_format_is_converted_to_imap() {
        assert_eq!(normalize_since_date("2026-04-10"), "10-Apr-2026");
        assert_eq!(normalize_since_date("1999-12-01"), "01-Dec-1999");
        // Surrounding whitespace still converts.
        assert_eq!(normalize_since_date(" 2026-04-10 "), "10-Apr-2026");
        let q = build_search_query(&ListFilters {
            since_date: Some("2026-04-10".into()),
            ..Default::default()
        });
        assert_eq!(q, "SINCE 10-Apr-2026");
    }

    #[test]
    fn since_date_native_format_passes_through() {
        assert_eq!(normalize_since_date("10-Apr-2026"), "10-Apr-2026");
        let q = build_search_query(&ListFilters {
            since_date: Some("01-Jan-2026".into()),
            ..Default::default()
        });
        assert_eq!(q, "SINCE 01-Jan-2026");
    }

    #[test]
    fn since_date_garbage_passes_through_sanitized() {
        assert_eq!(normalize_since_date("next week"), "next week");
        // Out-of-range ISO-shaped values are not converted.
        assert_eq!(normalize_since_date("2026-13-10"), "2026-13-10");
        assert_eq!(normalize_since_date("2026-04-32"), "2026-04-32");
        // Injection characters are still scrubbed.
        assert_eq!(
            normalize_since_date("01-Jan-2026\r\nA2 LOGOUT"),
            "01-Jan-2026A2 LOGOUT"
        );
        // Sanitizing an ISO date with trailing CRLF still converts.
        assert_eq!(normalize_since_date("2026-04-10\r\n"), "10-Apr-2026");
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

    #[test]
    fn a_list_asks_for_headers_and_structure_never_the_body() {
        assert!(LIST_QUERY.contains("BODYSTRUCTURE"));
        assert!(LIST_QUERY.contains("BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID)]"));
        assert!(!LIST_QUERY.contains("BODY.PEEK[]"));
        assert_eq!(part_query("1.2", 4096), "(UID BODY.PEEK[1.2]<0.4096>)");
    }

    #[test]
    fn a_handle_carries_uidvalidity_and_a_stale_one_is_refused() {
        assert_eq!(handle(77, 1200), "77:1200");
        assert_eq!(uid_from_handle("77:1200", 77), Ok(1200));
        assert_eq!(
            uid_from_handle("76:1200", 77),
            Err("That message list is stale — list again".to_string())
        );
        // From before handles carried UIDVALIDITY.
        assert_eq!(uid_from_handle("1200", 77), Ok(1200));
        assert!(uid_from_handle("abc", 77).is_err());
    }

    #[test]
    fn hours_cuts_by_the_hour_not_the_day() {
        let now = now_secs();
        let floor = Some(now - 2 * 3600);
        assert!(!within_hours(Some(now - 3 * 3600), floor));
        assert!(within_hours(Some(now - 3600), floor));
        assert!(within_hours(None, floor));
        assert!(within_hours(Some(0), None));
    }

    #[test]
    fn result_cap_defaults_and_clamps() {
        assert_eq!(result_cap(0), 25);
        assert_eq!(result_cap(10), 10);
        assert_eq!(result_cap(500), 50);
    }

    fn local_account(port: u16) -> EmailAccount {
        EmailAccount {
            id: "t".into(),
            label: "T".into(),
            enabled: true,
            send_enabled: false,
            provider: super::super::provider::EmailProvider::Custom,
            email_address: "a@example.com".into(),
            password: "pw".into(),
            imap_host: "127.0.0.1".into(),
            imap_port: port,
            imap_tls: TlsMode::Implicit,
            smtp_host: String::new(),
            smtp_port: 0,
            smtp_tls: TlsMode::Implicit,
        }
    }

    #[tokio::test]
    async fn a_server_that_never_speaks_times_out_naming_the_host() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accept, hold the socket open, never answer.
        let server = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(sock);
        });
        let t = Timeouts {
            connect: Duration::from_millis(200),
            ..TIMEOUTS
        };
        let started = Instant::now();
        let err = connect_and_login(&local_account(port), &t)
            .await
            .expect_err("a silent server must fail");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
        assert!(err.contains("127.0.0.1"), "{err}");
        assert!(err.contains("did not answer"), "{err}");
        server.abort();
    }
}
