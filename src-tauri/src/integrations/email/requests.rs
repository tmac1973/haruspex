//! Research by email: the IMAP side of a request.
//!
//! A request is an email the account sent itself, with the job's trigger
//! phrase in its subject. The From header proves nothing, so a request is
//! trusted only when the account's Sent folder holds a matching copy: the
//! same Message-ID exactly, from and to the account, with the phrase. Mail
//! from outside only ever reaches the Inbox.
//!
//! Every decision is made here, on headers fetched from the server, never
//! on what the frontend passes in. IMAP `SEARCH` only narrows: it matches
//! substrings and servers differ, so each hit is checked again exactly.

use async_imap::types::{Flag, NameAttribute};
use futures_util::TryStreamExt;
use mail_parser::{AddressList, Message, MessageParser};
use serde::{Deserialize, Serialize};

use super::auth::{self, EmailAccount};
use super::auth_results::{self, AuthResults};
use super::imap_client::{
    checkin, checkout, fetch, handle, move_selected, sanitize_search_value, select_inbox,
    special_mailbox, uid_from_handle, uid_set, unix_to_imap_date, within, ImapSession, Timeouts,
    SENT_NAMES, TIMEOUTS,
};

/// Marks every reply Haruspex sends, so a scan never takes one for a request.
pub const REPLY_HEADER: &str = "X-Haruspex-Reply";

/// The folder a picked-up request moves to, and the one under it for
/// ignored requests.
const HARUSPEX_FOLDER: &str = "Haruspex";
const IGNORED_LEAF: &str = "Ignored";

/// A scan returns at most this many requests.
const MAX_CANDIDATES: usize = 50;
/// How many SEARCH hits a scan reads the headers of, newest first, before
/// it drops replies and mail that doesn't qualify.
const MAX_SCANNED: usize = 200;
/// How many hits of one Message-ID search are compared exactly.
const MAX_ID_HITS: usize = 20;

/// The shortest local part a request's Message-ID may have.
const MIN_ID_LOCAL: usize = 8;
const MAX_ID_LEN: usize = 250;

/// One of the job's two folders. The frontend names which; Rust names the
/// folder, so no caller can move mail anywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum RequestFolder {
    Haruspex,
    Ignored,
}

/// An Inbox message that looks like a request: from the account, with the
/// phrase. It is not trusted until [`sent_has`] says so.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RequestCandidate {
    /// Our handle in INBOX, `"<uidvalidity>:<uid>"`, for reading and moving.
    pub handle: String,
    /// The RFC Message-ID without angle brackets; empty when the message
    /// has none, or more than one.
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    /// When the server received it.
    #[ts(type = "number")]
    pub internal_date_ms: i64,
    /// The first In-Reply-To id, without angle brackets.
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub auth: AuthResults,
}

/// A Message-ID a request may have, and a reply may carry: `local@domain`
/// (angle brackets optional), at most 250 characters, at least 8 before the
/// `@`, nothing that could break a header or a SEARCH string.
pub fn is_valid_message_id(id: &str) -> bool {
    let bare = bare_id(id);
    if bare.is_empty() || bare.len() > MAX_ID_LEN {
        return false;
    }
    if bare
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | '\\'))
    {
        return false;
    }
    match bare.rsplit_once('@') {
        Some((local, domain)) => local.chars().count() >= MIN_ID_LOCAL && !domain.is_empty(),
        None => false,
    }
}

/// A Message-ID without the angle brackets a header writes around it.
fn bare_id(id: &str) -> &str {
    let id = id.trim();
    id.strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(id)
}

/// The headers the checks read.
#[derive(Debug, Default)]
struct HeaderView {
    /// Present only when the message has exactly one Message-ID header.
    message_id: Option<String>,
    from: Vec<String>,
    to: Vec<String>,
    subject: String,
    in_reply_to: Option<String>,
    references: Vec<String>,
    /// Raw `Authentication-Results` values, topmost first.
    auth: Vec<String>,
    has_reply_header: bool,
}

fn view_of(header: &[u8]) -> Option<HeaderView> {
    let parsed = MessageParser::default().parse_headers(header)?;
    Some(view_from(&parsed))
}

fn view_from(parsed: &Message<'_>) -> HeaderView {
    let headers = parsed.headers();
    let ids = headers.all("Message-ID").count();
    let raw = |name: &'static str| -> Vec<String> {
        headers
            .all(name)
            .map(|h| unfold(&String::from_utf8_lossy(h.raw_value())))
            .collect()
    };
    let text_list = |v: Option<mail_parser::TextList<'_>>| -> Vec<String> {
        v.map(|l| l.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    };
    HeaderView {
        message_id: if ids == 1 {
            parsed.message_id().map(|s| s.to_string())
        } else {
            None
        },
        from: parsed.from().map(addresses).unwrap_or_default(),
        to: parsed.to().map(addresses).unwrap_or_default(),
        subject: parsed.subject().unwrap_or("").trim().to_string(),
        in_reply_to: text_list(parsed.in_reply_to()).into_iter().next(),
        references: text_list(parsed.references()),
        auth: raw("Authentication-Results"),
        has_reply_header: headers.contains(REPLY_HEADER),
    }
}

fn addresses(list: AddressList<'_>) -> Vec<String> {
    list.mailboxes()
        .filter_map(|a| a.address().map(|s| s.trim().to_ascii_lowercase()))
        .collect()
}

/// A folded header value on one line.
fn unfold(v: &str) -> String {
    v.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn has_phrase(subject: &str, phrase: &str) -> bool {
    let phrase = phrase.trim().to_lowercase();
    !phrase.is_empty() && subject.to_lowercase().contains(&phrase)
}

/// From exactly one mailbox, and that is the account.
fn from_account(v: &HeaderView, address: &str) -> bool {
    v.from.len() == 1 && v.from[0] == address.trim().to_ascii_lowercase()
}

/// Whether an Inbox message is a request candidate. Haruspex's own replies
/// carry [`REPLY_HEADER`] and are never one.
fn is_candidate(v: &HeaderView, address: &str, phrase: &str) -> bool {
    !v.has_reply_header && from_account(v, address) && has_phrase(&v.subject, phrase)
}

/// Whether one of `hits` (from the Sent folder) is the request's own copy:
/// the same Message-ID exactly, from and to the account, with the phrase. A
/// forger who reuses the Message-ID of other mail the user sent fails here,
/// since that mail went to someone else without the phrase.
fn sent_copy_matches(hits: &[HeaderView], request_id: &str, address: &str, phrase: &str) -> bool {
    if !is_valid_message_id(request_id) {
        return false;
    }
    let id = bare_id(request_id);
    let me = address.trim().to_ascii_lowercase();
    hits.iter().any(|h| {
        h.message_id.as_deref() == Some(id)
            && from_account(h, address)
            && h.to.contains(&me)
            && has_phrase(&h.subject, phrase)
    })
}

/// Whether one of `hits` is the reply with this Message-ID, from the account.
fn reply_matches(hits: &[HeaderView], reply_id: &str, address: &str) -> bool {
    let id = bare_id(reply_id);
    hits.iter()
        .any(|h| h.message_id.as_deref() == Some(id) && from_account(h, address))
}

/// One mailbox from LIST.
#[derive(Debug, Clone)]
struct Mailbox {
    name: String,
    delimiter: Option<String>,
    sent: bool,
    /// `\All` or `\Junk`: mail from outside lands there too, so it can never
    /// stand in for Sent.
    gathers_incoming: bool,
}

/// The Sent folder a request's copy is looked for in: the one flagged
/// `\Sent`, else one with a well-known name. Never INBOX or a folder that
/// gathers incoming mail.
fn sent_folder(boxes: &[Mailbox]) -> Option<String> {
    let usable: Vec<(String, bool)> = boxes
        .iter()
        .filter(|b| !b.gathers_incoming && !b.name.eq_ignore_ascii_case("INBOX"))
        .map(|b| (b.name.clone(), b.sent))
        .collect();
    special_mailbox(&usable, SENT_NAMES)
}

/// The job's two folders, in the server's own hierarchy: `Haruspex` and
/// `Haruspex<delim>Ignored`, under `INBOX<delim>` on a server that keeps
/// every folder there.
fn folder_names(boxes: &[Mailbox]) -> (String, String) {
    let delim = boxes
        .iter()
        .find_map(|b| b.delimiter.clone())
        .unwrap_or_else(|| "/".to_string());
    let inbox_prefix = format!("INBOX{delim}");
    let others: Vec<&Mailbox> = boxes
        .iter()
        .filter(|b| !b.name.eq_ignore_ascii_case("INBOX"))
        .collect();
    let prefix = if !others.is_empty()
        && others
            .iter()
            .all(|b| b.name.to_ascii_uppercase().starts_with(&inbox_prefix))
    {
        inbox_prefix
    } else {
        String::new()
    };
    let top = format!("{prefix}{HARUSPEX_FOLDER}");
    let ignored = format!("{top}{delim}{IGNORED_LEAF}");
    (top, ignored)
}

/// The UID SEARCH a scan runs. SEARCH matches substrings and only by day;
/// [`scan_in`] checks each hit exactly. A phrase that isn't plain ASCII, or
/// that sanitising would change, is left out of the SEARCH and checked only
/// in Rust.
fn scan_query(address: &str, phrase: &str, since_ms: i64) -> String {
    // A day early: SEARCH SINCE compares dates in the server's zone.
    let since = unix_to_imap_date(since_ms.div_euclid(1000) - 86_400);
    format!("SINCE {since} {}", request_terms(address, phrase))
}

/// The SEARCH terms every request matches: from the account, not deleted,
/// and the phrase in the subject when SEARCH can carry it safely.
fn request_terms(address: &str, phrase: &str) -> String {
    let mut q = format!("FROM \"{}\" UNDELETED", sanitize_search_value(address));
    let clean = sanitize_search_value(phrase.trim());
    if phrase.trim().is_ascii() && clean == phrase.trim() && !clean.is_empty() {
        q.push_str(&format!(" SUBJECT \"{clean}\""));
    }
    q
}

/// What the inbox watcher found since its last look.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Arrivals {
    /// The UID to look from next time.
    pub next: u32,
    /// Whether one of the new messages is a request candidate.
    pub request: bool,
}

/// The UIDs of `found` at or above `next`. `UID n:*` always matches the
/// highest UID, even one below `n`, so a quiet mailbox returns its last
/// message on every look.
fn at_or_above(found: impl IntoIterator<Item = u32>, next: u32) -> Vec<u32> {
    let mut out: Vec<u32> = found.into_iter().filter(|&u| u >= next).collect();
    out.sort_unstable();
    out
}

/// For the inbox watcher: whether any message in the selected Inbox at or
/// above UID `next` is a request candidate, checked as exactly as a scan
/// checks it. Only a hint; the job's run decides. Nothing is marked read.
pub(super) async fn arrivals(
    session: &mut ImapSession,
    account: &EmailAccount,
    phrase: &str,
    next: u32,
    t: &Timeouts,
) -> Result<Arrivals, String> {
    let host = account.imap_host.as_str();
    let address = account.email_address.as_str();
    let all = within(
        t.command,
        host,
        "SEARCH",
        session.uid_search(format!("UID {next}:*")),
    )
    .await?;
    let new = at_or_above(all, next);
    let Some(&last) = new.last() else {
        return Ok(Arrivals {
            next,
            request: false,
        });
    };
    let query = format!("UID {} {}", uid_set(&new), request_terms(address, phrase));
    let hits = search_views(
        session,
        host,
        t,
        &query,
        MAX_SCANNED,
        "(UID FLAGS BODY.PEEK[HEADER])",
    )
    .await?;
    let request = hits
        .iter()
        .any(|(_, _, deleted, view)| !deleted && is_candidate(view, address, phrase));
    Ok(Arrivals {
        next: last.saturating_add(1),
        request,
    })
}

/// The SEARCH for one Message-ID. Only a valid id reaches it, and a valid id
/// has nothing [`sanitize_search_value`] would strip.
fn id_query(id: &str) -> String {
    format!(
        "HEADER Message-ID \"{}\"",
        sanitize_search_value(bare_id(id))
    )
}

fn domain_of(address: &str) -> &str {
    address.rsplit_once('@').map(|(_, d)| d).unwrap_or("")
}

async fn mailboxes(
    session: &mut ImapSession,
    host: &str,
    t: &Timeouts,
) -> Result<Vec<Mailbox>, String> {
    let list = async {
        let names: Vec<async_imap::types::Name> = session
            .list(Some(""), Some("*"))
            .await?
            .try_collect()
            .await?;
        Ok::<_, async_imap::error::Error>(
            names
                .iter()
                .map(|n| Mailbox {
                    name: n.name().to_string(),
                    delimiter: n.delimiter().map(|d| d.to_string()),
                    sent: n
                        .attributes()
                        .iter()
                        .any(|a| matches!(a, NameAttribute::Sent)),
                    gathers_incoming: n
                        .attributes()
                        .iter()
                        .any(|a| matches!(a, NameAttribute::All | NameAttribute::Junk)),
                })
                .collect::<Vec<_>>(),
        )
    };
    within(t.command, host, "LIST", list).await
}

/// Headers of the newest `cap` messages matching `query` in the mailbox
/// already selected or examined.
async fn search_views(
    session: &mut ImapSession,
    host: &str,
    t: &Timeouts,
    query: &str,
    cap: usize,
    fields: &str,
) -> Result<Vec<(u32, Option<i64>, bool, HeaderView)>, String> {
    let found = within(t.command, host, "SEARCH", session.uid_search(query)).await?;
    let mut uids: Vec<u32> = found.into_iter().collect();
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(cap);
    if uids.is_empty() {
        return Ok(Vec::new());
    }
    let fetched = fetch(session, host, t, &uid_set(&uids), fields).await?;
    Ok(fetched
        .iter()
        .filter_map(|f| {
            let uid = f.uid?;
            let view = view_of(f.header()?)?;
            let deleted = f.flags().any(|flag| matches!(flag, Flag::Deleted));
            let internal = f.internal_date().map(|d| d.timestamp_millis());
            Some((uid, internal, deleted, view))
        })
        .collect())
}

/// The headers an exact Message-ID comparison reads.
const ID_FIELDS: &str = "(UID FLAGS BODY.PEEK[HEADER.FIELDS (MESSAGE-ID FROM TO SUBJECT)])";

/// Run `work` on a kept or new session for the account, keeping the session
/// only when the work succeeded.
macro_rules! with_session {
    ($account:expr, |$session:ident, $acct:ident, $t:ident| $body:expr) => {{
        let $t = TIMEOUTS;
        let resolved = auth::resolve($account).await?;
        let $acct = &resolved;
        let mut owned = checkout($acct, &$t).await?;
        let out = {
            let $session = &mut owned;
            $body.await
        };
        if out.is_ok() {
            checkin($acct, owned);
        }
        out
    }};
}

/// Inbox messages since `since_ms` (Unix milliseconds) from the account to
/// itself with the phrase in their subject: at most [`MAX_CANDIDATES`], the
/// newest, oldest first. Replies Haruspex sent, and messages flagged
/// deleted, are left out. Nothing is marked read.
pub async fn scan(
    account: &EmailAccount,
    phrase: &str,
    since_ms: i64,
) -> Result<Vec<RequestCandidate>, String> {
    if phrase.trim().is_empty() {
        return Err("The trigger phrase is empty.".to_string());
    }
    with_session!(account, |session, acct, t| scan_in(
        session, acct, phrase, since_ms, &t
    ))
}

async fn scan_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    phrase: &str,
    since_ms: i64,
    t: &Timeouts,
) -> Result<Vec<RequestCandidate>, String> {
    let host = account.imap_host.as_str();
    let address = account.email_address.as_str();
    let validity = select_inbox(session, host, t).await?;
    let query = scan_query(address, phrase, since_ms);
    let hits = search_views(
        session,
        host,
        t,
        &query,
        MAX_SCANNED,
        "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER])",
    )
    .await?;
    let mut out: Vec<(u32, RequestCandidate)> = hits
        .into_iter()
        .filter(|(_, internal, deleted, view)| {
            !deleted
                && internal.is_some_and(|ms| ms >= since_ms)
                && is_candidate(view, address, phrase)
        })
        .map(|(uid, internal, _, view)| {
            let from = view.from.first().cloned().unwrap_or_default();
            let auth = auth_results::parse(&view.auth, domain_of(&from));
            (
                uid,
                RequestCandidate {
                    handle: handle(validity, uid),
                    message_id: view.message_id.clone().unwrap_or_default(),
                    subject: view.subject.clone(),
                    from_address: from,
                    internal_date_ms: internal.unwrap_or_default(),
                    in_reply_to: view.in_reply_to.clone(),
                    references: view.references.clone(),
                    auth,
                },
            )
        })
        .collect();
    out.sort_unstable_by_key(|c| std::cmp::Reverse(c.0));
    out.truncate(MAX_CANDIDATES);
    out.reverse();
    Ok(out.into_iter().map(|(_, c)| c).collect())
}

/// Whether the account's Sent folder holds this request's own copy (see
/// [`sent_copy_matches`]). An account with no usable Sent folder is an
/// error, not a "no".
pub async fn sent_has(
    account: &EmailAccount,
    message_id: &str,
    phrase: &str,
) -> Result<bool, String> {
    if !is_valid_message_id(message_id) {
        return Ok(false);
    }
    with_session!(account, |session, acct, t| sent_has_in(
        session, acct, message_id, phrase, &t
    ))
}

async fn sent_has_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    message_id: &str,
    phrase: &str,
    t: &Timeouts,
) -> Result<bool, String> {
    let host = account.imap_host.as_str();
    let boxes = mailboxes(session, host, t).await?;
    let sent = sent_folder(&boxes).ok_or_else(|| "No Sent folder on this account.".to_string())?;
    within(t.command, host, "EXAMINE", session.examine(&sent)).await?;
    let hits = search_views(
        session,
        host,
        t,
        &id_query(message_id),
        MAX_ID_HITS,
        ID_FIELDS,
    )
    .await?;
    let views: Vec<HeaderView> = hits.into_iter().map(|(_, _, _, v)| v).collect();
    Ok(sent_copy_matches(
        &views,
        message_id,
        &account.email_address,
        phrase,
    ))
}

/// Whether a reply Haruspex sent, with this Message-ID, has arrived: in
/// INBOX, Sent or either of the job's folders. A folder that doesn't exist
/// yet counts as no match.
pub async fn reply_seen(account: &EmailAccount, reply_message_id: &str) -> Result<bool, String> {
    if !is_valid_message_id(reply_message_id) {
        return Ok(false);
    }
    with_session!(account, |session, acct, t| reply_seen_in(
        session,
        acct,
        reply_message_id,
        &t
    ))
}

async fn reply_seen_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    reply_message_id: &str,
    t: &Timeouts,
) -> Result<bool, String> {
    let host = account.imap_host.as_str();
    let boxes = mailboxes(session, host, t).await?;
    let (top, ignored) = folder_names(&boxes);
    let mut look_in = vec!["INBOX".to_string()];
    look_in.extend(sent_folder(&boxes));
    for name in [top, ignored] {
        if boxes.iter().any(|b| b.name == name) {
            look_in.push(name);
        }
    }
    for mailbox in look_in {
        within(t.command, host, "EXAMINE", session.examine(&mailbox)).await?;
        let hits = search_views(
            session,
            host,
            t,
            &id_query(reply_message_id),
            MAX_ID_HITS,
            ID_FIELDS,
        )
        .await?;
        let views: Vec<HeaderView> = hits.into_iter().map(|(_, _, _, v)| v).collect();
        if reply_matches(&views, reply_message_id, &account.email_address) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Move one INBOX message (by handle) to one of the job's folders, creating
/// it (and `Haruspex` above `Ignored`) when it's missing.
pub async fn move_to(
    account: &EmailAccount,
    message_handle: &str,
    folder: RequestFolder,
) -> Result<(), String> {
    with_session!(account, |session, acct, t| move_in(
        session,
        acct,
        message_handle,
        folder,
        &t
    ))
}

async fn move_in(
    session: &mut ImapSession,
    account: &EmailAccount,
    message_handle: &str,
    folder: RequestFolder,
    t: &Timeouts,
) -> Result<(), String> {
    let host = account.imap_host.as_str();
    let boxes = mailboxes(session, host, t).await?;
    let (top, ignored) = folder_names(&boxes);
    let mut needed = vec![top.clone()];
    if folder == RequestFolder::Ignored {
        needed.push(ignored.clone());
    }
    for name in needed {
        if !boxes.iter().any(|b| b.name == name) {
            within(t.command, host, "CREATE", session.create(&name)).await?;
        }
    }
    let dest = match folder {
        RequestFolder::Haruspex => top,
        RequestFolder::Ignored => ignored,
    };
    let validity = select_inbox(session, host, t).await?;
    let set = uid_from_handle(message_handle, validity)?.to_string();
    move_selected(session, host, t, &set, &dest).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "me@example.com";

    fn view(raw: &str) -> HeaderView {
        view_of(raw.replace('\n', "\r\n").as_bytes()).expect("headers parse")
    }

    fn request(id: &str, to: &str, subject: &str) -> HeaderView {
        view(&format!(
            "Message-ID: <{id}>\nFrom: Me <me@example.com>\nTo: {to}\nSubject: {subject}\n\n"
        ))
    }

    #[test]
    fn a_message_id_needs_one_safe_local_at_domain() {
        assert!(is_valid_message_id("CAF1234567890abc@mail.gmail.com"));
        assert!(is_valid_message_id("<CAF1234567890abc@mail.gmail.com>"));
        for bad in [
            "",
            ".com",
            "@mail.gmail.com",
            "short@x.com",
            "abcdefgh@",
            "abcdefgh",
            "abcd efgh@x.com",
            "abcdefgh@x.com\r\nBcc: e@x.com",
            "abc\"defgh@x.com",
            "abc<defgh@x.com",
        ] {
            assert!(!is_valid_message_id(bad), "{bad:?}");
        }
        let long = format!("{}@x.com", "a".repeat(250));
        assert!(!is_valid_message_id(&long));
    }

    #[test]
    fn a_candidate_is_from_the_account_with_the_phrase_any_case() {
        let v = request("CAF1234567890abc@x.com", ME, "Ask Haruspex: e-bikes");
        assert!(is_candidate(&v, "Me@Example.com", "ask haruspex"));
        assert!(!is_candidate(&v, ME, "ask the oracle"));
        assert!(!is_candidate(&v, ME, "  "));
    }

    #[test]
    fn a_display_name_or_second_from_does_not_make_a_candidate() {
        let spoof = view(
            "Message-ID: <CAF1234567890abc@x.com>\nFrom: \"me@example.com\" <evil@x.com>\nTo: me@example.com\nSubject: ask haruspex\n\n",
        );
        assert!(!is_candidate(&spoof, ME, "ask haruspex"));
        let two = view(
            "Message-ID: <CAF1234567890abc@x.com>\nFrom: me@example.com, evil@x.com\nTo: me@example.com\nSubject: ask haruspex\n\n",
        );
        assert!(!is_candidate(&two, ME, "ask haruspex"));
    }

    #[test]
    fn our_own_reply_is_never_a_candidate() {
        let v = view(
            "Message-ID: <CAF1234567890abc@x.com>\nFrom: me@example.com\nTo: me@example.com\nSubject: Re: ask haruspex\nX-Haruspex-Reply: 1\n\n",
        );
        assert!(!is_candidate(&v, ME, "ask haruspex"));
    }

    #[test]
    fn the_sent_copy_must_match_exactly() {
        let id = "CAF1234567890abc@mail.gmail.com";
        let good = request(id, ME, "ask haruspex: e-bikes");
        assert!(sent_copy_matches(&[good], id, ME, "ask haruspex"));
        assert!(sent_copy_matches(
            &[request(id, ME, "ask haruspex")],
            &format!("<{id}>"),
            ME,
            "ask haruspex"
        ));

        // SEARCH matched a substring: another id that contains the request's.
        let longer = request("xxCAF1234567890abc@mail.gmail.com", ME, "ask haruspex");
        assert!(!sent_copy_matches(&[longer], id, ME, "ask haruspex"));
        // A real sent mail's id, reused by a forger: it went elsewhere.
        let elsewhere = request(id, "friend@other.com", "ask haruspex");
        assert!(!sent_copy_matches(&[elsewhere], id, ME, "ask haruspex"));
        // Same id and recipient, no phrase.
        let no_phrase = request(id, ME, "lunch?");
        assert!(!sent_copy_matches(&[no_phrase], id, ME, "ask haruspex"));
        // A short or empty request id is refused before anything else.
        let short = request("a@b.com", ME, "ask haruspex");
        assert!(!sent_copy_matches(&[short], "a@b.com", ME, "ask haruspex"));
        assert!(!sent_copy_matches(&[], "", ME, "ask haruspex"));
    }

    #[test]
    fn a_message_with_two_message_ids_has_none() {
        let v = view(
            "Message-ID: <CAF1234567890abc@x.com>\nMessage-ID: <other1234567@x.com>\nFrom: me@example.com\nTo: me@example.com\nSubject: ask haruspex\n\n",
        );
        assert_eq!(v.message_id, None);
        assert!(!sent_copy_matches(
            &[v],
            "CAF1234567890abc@x.com",
            ME,
            "ask haruspex"
        ));
    }

    #[test]
    fn a_reply_is_seen_only_by_exact_id_from_the_account() {
        let id = "0f3c2a1b-9d8e@example.com";
        assert!(reply_matches(&[request(id, ME, "Re: x")], id, ME));
        assert!(!reply_matches(
            &[request("x0f3c2a1b-9d8e@example.com", ME, "Re: x")],
            id,
            ME
        ));
        let foreign = view(&format!(
            "Message-ID: <{id}>\nFrom: evil@x.com\nTo: me@example.com\nSubject: Re: x\n\n"
        ));
        assert!(!reply_matches(&[foreign], id, ME));
    }

    #[test]
    fn auth_results_and_threading_headers_are_read() {
        let v = view(
            "Authentication-Results: mx.google.com;\n       dkim=pass header.i=@example.com;\n       spf=pass\nAuthentication-Results: forged; dkim=fail\nMessage-ID: <CAF1234567890abc@x.com>\nIn-Reply-To: <parent123456@x.com>\nReferences: <root12345678@x.com> <parent123456@x.com>\nFrom: me@example.com\nTo: me@example.com\nSubject: Re: ask haruspex\n\n",
        );
        assert_eq!(v.auth.len(), 2);
        assert!(v.auth[0].starts_with("mx.google.com; dkim=pass"));
        assert_eq!(v.in_reply_to.as_deref(), Some("parent123456@x.com"));
        assert_eq!(v.references.len(), 2);
        let auth = auth_results::parse(&v.auth, "example.com");
        assert_eq!(auth.dkim, auth_results::AuthResult::Pass);
    }

    fn mailbox(name: &str, sent: bool, incoming: bool) -> Mailbox {
        Mailbox {
            name: name.to_string(),
            delimiter: Some("/".to_string()),
            sent,
            gathers_incoming: incoming,
        }
    }

    #[test]
    fn the_sent_folder_is_never_inbox_or_one_that_gathers_incoming_mail() {
        let gmail = [
            mailbox("INBOX", false, false),
            mailbox("[Gmail]/All Mail", false, true),
            mailbox("[Gmail]/Sent Mail", true, false),
        ];
        assert_eq!(sent_folder(&gmail).as_deref(), Some("[Gmail]/Sent Mail"));
        // A server that flags All Mail \Sent as well still doesn't get it.
        let odd = [mailbox("INBOX", true, false), mailbox("All", true, true)];
        assert_eq!(sent_folder(&odd), None);
        let named = [
            mailbox("INBOX", false, false),
            mailbox("Sent Items", false, false),
        ];
        assert_eq!(sent_folder(&named).as_deref(), Some("Sent Items"));
    }

    #[test]
    fn the_job_folders_follow_the_server_hierarchy() {
        let gmail = [
            mailbox("INBOX", false, false),
            mailbox("[Gmail]/Sent Mail", true, false),
        ];
        assert_eq!(
            folder_names(&gmail),
            ("Haruspex".to_string(), "Haruspex/Ignored".to_string())
        );
        let dovecot = [
            Mailbox {
                delimiter: Some(".".to_string()),
                ..mailbox("INBOX", false, false)
            },
            Mailbox {
                delimiter: Some(".".to_string()),
                ..mailbox("INBOX.Sent", true, false)
            },
            Mailbox {
                delimiter: Some(".".to_string()),
                ..mailbox("INBOX.Trash", false, false)
            },
        ];
        assert_eq!(
            folder_names(&dovecot),
            (
                "INBOX.Haruspex".to_string(),
                "INBOX.Haruspex.Ignored".to_string()
            )
        );
    }

    #[test]
    fn the_scan_search_quotes_safely_and_skips_a_phrase_it_cannot_send() {
        // 2024-04-11 00:00 UTC, so a day earlier is 10 April.
        let q = scan_query(ME, "ask haruspex", 1_712_793_600_000);
        assert_eq!(
            q,
            "SINCE 10-Apr-2024 FROM \"me@example.com\" UNDELETED SUBJECT \"ask haruspex\""
        );
        let q = scan_query(ME, "ask \"x\"\r\nA1 LOGOUT", 1_712_793_600_000);
        assert!(!q.contains("SUBJECT"), "{q}");
        assert!(!q.contains('\r'));
        let q = scan_query(ME, "frag Haruspex – bitte", 1_712_793_600_000);
        assert!(!q.contains("SUBJECT"), "{q}");
        assert_eq!(
            id_query("<CAF1234567890abc@x.com>"),
            "HEADER Message-ID \"CAF1234567890abc@x.com\""
        );
    }

    #[test]
    fn the_watcher_terms_match_the_scan_without_a_date() {
        assert_eq!(
            request_terms(ME, "ask haruspex"),
            "FROM \"me@example.com\" UNDELETED SUBJECT \"ask haruspex\""
        );
        assert_eq!(
            request_terms(ME, "frag Haruspex – bitte"),
            "FROM \"me@example.com\" UNDELETED"
        );
    }

    #[test]
    fn a_quiet_mailbox_has_no_arrivals_although_uid_n_star_matches_its_last_message() {
        // `UID 42:*` on a mailbox whose highest UID is 41 returns 41.
        assert!(at_or_above([41], 42).is_empty());
        assert_eq!(at_or_above([44, 42, 43], 42), vec![42, 43, 44]);
    }
}
