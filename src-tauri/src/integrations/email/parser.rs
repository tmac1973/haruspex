//! Normalized email models + RFC 5322 → normalized conversion.
//!
//! The raw output of `mail-parser` is rich — headers, HTML/plain
//! alternatives, attachments, etc. We don't want any of that
//! structure leaking into the agent loop because tokens cost money
//! and the model doesn't need 90% of it. Instead we collapse each
//! message into two small views:
//!
//! - `EmailListing` — metadata only, safe to return 20+ at a time
//! - `NormalizedMessage` — full plaintext body + metadata, meant for
//!   the sub-agent summarizer or the escape-hatch `email_read_full`
//!
//! Both types round-trip cleanly through serde into the frontend.

use mail_parser::{Address, Message, MessageParser, MimeHeaders, PartType};
use serde::{Deserialize, Serialize};

use super::text::html_to_text;
pub use super::text::strip_quoted_replies;

/// Snippet length — the first ~N characters of the plaintext body,
/// included in `EmailListing` so the model can decide which messages
/// are worth a full read / summarize.
const SNIPPET_LEN: usize = 240;

/// Maximum number of characters we'll return in a full body. Anything
/// longer is tail-trimmed with a `[truncated]` marker to protect the
/// sub-agent's input budget against enormous messages (mailing lists,
/// forwarded chains, quoted receipts).
pub const MAX_BODY_CHARS: usize = 40_000;

/// Cheap per-message metadata (no body). Returned by `email_list_recent`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailListing {
    /// Account this message came from. The opaque UUID that
    /// `email_summarize_message` / `email_read_full` should receive
    /// back verbatim.
    pub account_id: String,

    /// Human-readable label for the account ("Work Gmail",
    /// "Personal"). Included in every listing so the model can
    /// match user intent like "summarize my work email" without
    /// needing a separate accounts lookup call. When the user has
    /// only one account enabled, the model can ignore this field.
    pub account_label: String,

    /// Our handle for the message: `"<uidvalidity>:<uid>"` in its INBOX.
    /// Not the RFC Message-ID, which is `rfc_message_id` on the full view.
    pub message_id: String,

    pub subject: String,
    pub from_name: String,
    pub from_email: String,

    /// RFC 3339 date in UTC, so listings from several accounts sort as
    /// strings. Empty if the message had no usable date.
    pub date: String,

    /// First ~240 chars of the plaintext body, useful for the model
    /// to decide which messages to expand.
    pub snippet: String,

    /// Whether the MIME structure had any attachment parts. The
    /// attachments themselves are never fetched for the model; the flag
    /// tells it there is more than the text.
    pub has_attachments: bool,

    /// Seconds since the epoch, for sorting and the `hours` filter.
    #[serde(skip)]
    pub timestamp: Option<i64>,
}

/// Full message view. Returned by `email_read_full` and consumed
/// internally by the summarizer sub-agent.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub account_id: String,
    pub account_label: String,
    pub message_id: String,
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    /// Where a reply goes, when the sender asked for somewhere else.
    pub reply_to: String,
    pub date: String,
    pub body: String,
    pub has_attachments: bool,
    /// The RFC 5322 Message-ID, without angle brackets: what a reply's
    /// In-Reply-To names.
    pub rfc_message_id: String,
    pub in_reply_to: String,
    pub references: Vec<String>,
}

/// The headers both views are built from.
struct Headers {
    subject: String,
    from_name: String,
    from_email: String,
    to: Vec<String>,
    cc: Vec<String>,
    reply_to: String,
    date: String,
    timestamp: Option<i64>,
    rfc_message_id: String,
    in_reply_to: String,
    references: Vec<String>,
}

fn headers_of(parsed: &Message<'_>) -> Headers {
    let (from_name, from_email) = parsed.from().map(extract_from).unwrap_or_default();
    let timestamp = parsed.date().map(|d| d.to_timestamp());
    let ids = |v: &mail_parser::HeaderValue<'_>| -> Vec<String> {
        v.as_text_list()
            .map(|l| l.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    };
    Headers {
        subject: clean(parsed.subject().unwrap_or("")),
        from_name: clean(&from_name),
        from_email: clean(&from_email),
        to: parsed.to().map(extract_address_list).unwrap_or_default(),
        cc: parsed.cc().map(extract_address_list).unwrap_or_default(),
        reply_to: parsed
            .reply_to()
            .map(extract_from)
            .map(|(_, e)| e)
            .unwrap_or_default(),
        date: timestamp.map(utc_rfc3339).unwrap_or_default(),
        timestamp,
        rfc_message_id: parsed.message_id().unwrap_or("").to_string(),
        in_reply_to: ids(parsed.in_reply_to())
            .into_iter()
            .next()
            .unwrap_or_default(),
        references: ids(parsed.references()),
    }
}

/// A timestamp as an RFC 3339 date in UTC.
pub fn utc_rfc3339(ts: i64) -> String {
    mail_parser::DateTime::from_timestamp(ts).to_rfc3339()
}

/// Pull a "Name" + "addr@host" pair out of a mail-parser `Address`.
/// Address can be a single mailbox or a group — we only care about
/// the first usable mailbox in either case.
fn extract_from(addr: &Address<'_>) -> (String, String) {
    if let Some(first) = addr.first() {
        let email = first.address().unwrap_or("").to_string();
        let name = first.name().unwrap_or("").to_string();
        return (name, email);
    }
    (String::new(), String::new())
}

/// Pull every addr@host out of an Address header (To, Cc, …).
/// Works for both single-mailbox and group-shaped addresses.
fn extract_address_list(addr: &Address<'_>) -> Vec<String> {
    addr.iter()
        .filter_map(|a| a.address().map(|s| s.to_string()))
        .collect()
}

/// Strip a leading BOM and trim leading/trailing whitespace — keeps
/// snippet output clean of invisible garbage that wastes tokens.
fn clean(text: &str) -> String {
    text.trim_start_matches('\u{FEFF}').trim().to_string()
}

/// Reduce a block of text to a short inline snippet: collapse runs
/// of whitespace, cap to SNIPPET_LEN chars with an ellipsis suffix
/// if we had to cut it.
fn make_snippet(body: &str) -> String {
    // Streamed collapse + cap: stop as soon as SNIPPET_LEN chars are kept (with
    // an ellipsis if there was more), so a huge body isn't fully scanned just to
    // build a 240-char preview. This interleaves the cap into the collapse, so
    // it can't share a separate collapse pass.
    let mut out = String::with_capacity(SNIPPET_LEN + 1);
    let mut last_was_space = true;
    for ch in body.chars() {
        if out.chars().count() >= SNIPPET_LEN {
            out.push('…');
            break;
        }
        if ch.is_whitespace() {
            if !last_was_space {
                out.push(' ');
                last_was_space = true;
            }
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    out.trim().to_string()
}

/// Core conversion: bytes from a FETCH BODY.PEEK[] call → a
/// `NormalizedMessage`. The caller supplies `account_id`,
/// `account_label`, and `message_id` because those aren't part of
/// the RFC 5322 envelope.
pub fn parse_rfc5322(
    bytes: &[u8],
    account_id: String,
    account_label: String,
    message_id: String,
) -> Result<NormalizedMessage, String> {
    let parsed = MessageParser::default()
        .parse(bytes)
        .ok_or_else(|| "mail-parser rejected the message bytes".to_string())?;

    // Prefer the plain-text body part; fall back to HTML → text.
    let mut body = parsed.body_text(0).map(|t| clean(&t)).unwrap_or_default();
    if body.is_empty() {
        if let Some(html) = parsed.body_html(0) {
            body = html_to_text(&html);
        }
    }

    // Attachment detection: any non-text part counts.
    let has_attachments = parsed.parts.iter().any(|p| {
        matches!(p.body, PartType::Binary(_) | PartType::InlineBinary(_))
            || p.content_disposition()
                .map(|cd| cd.attribute("filename").is_some())
                .unwrap_or(false)
    });

    Ok(message_from(
        headers_of(&parsed),
        body,
        has_attachments,
        account_id,
        account_label,
        message_id,
    ))
}

/// A full view from the header block alone and a body read separately: a
/// message too large to download whole.
pub fn parse_with_body(
    header: &[u8],
    body: String,
    has_attachments: bool,
    account_id: String,
    account_label: String,
    message_id: String,
) -> Result<NormalizedMessage, String> {
    let parsed = MessageParser::default()
        .parse_headers(header)
        .ok_or_else(|| "mail-parser rejected the message headers".to_string())?;
    Ok(message_from(
        headers_of(&parsed),
        body,
        has_attachments,
        account_id,
        account_label,
        message_id,
    ))
}

fn message_from(
    h: Headers,
    body: String,
    has_attachments: bool,
    account_id: String,
    account_label: String,
    message_id: String,
) -> NormalizedMessage {
    // Truncate absurdly long bodies so a single message can't blow
    // the sub-agent's input budget.
    let body = crate::text_util::truncate_chars(
        body,
        MAX_BODY_CHARS,
        "\n\n[truncated — message body exceeded the ingest cap]",
    );
    NormalizedMessage {
        account_id,
        account_label,
        message_id,
        subject: h.subject,
        from_name: h.from_name,
        from_email: h.from_email,
        to: h.to,
        cc: h.cc,
        reply_to: h.reply_to,
        date: h.date,
        body,
        has_attachments,
        rfc_message_id: h.rfc_message_id,
        in_reply_to: h.in_reply_to,
        references: h.references,
    }
}

/// The cheap listing view, from a message's header block and the start of
/// its text. `fallback_ts` (the server's INTERNALDATE) dates a message whose
/// Date header is missing or unreadable.
pub fn listing_from_header(
    header: &[u8],
    preview: &str,
    has_attachments: bool,
    fallback_ts: Option<i64>,
    account_id: String,
    account_label: String,
    message_id: String,
) -> Result<EmailListing, String> {
    let parsed = MessageParser::default()
        .parse_headers(header)
        .ok_or_else(|| "mail-parser rejected the message headers".to_string())?;
    let h = headers_of(&parsed);
    let timestamp = h.timestamp.or(fallback_ts);
    Ok(EmailListing {
        account_id,
        account_label,
        message_id,
        subject: h.subject,
        from_name: h.from_name,
        from_email: h.from_email,
        date: timestamp.map(utc_rfc3339).unwrap_or_default(),
        snippet: make_snippet(preview),
        has_attachments,
        timestamp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_PLAIN: &[u8] = b"From: Alice Example <alice@example.com>\r\n\
To: bob@example.com\r\n\
Subject: Hello\r\n\
Date: Tue, 7 Apr 2026 10:14:00 +0000\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
This is a simple plaintext email body.\r\n\
It has two lines.\r\n";

    const SAMPLE_HTML_ONLY: &[u8] = b"From: HTML Sender <html@example.com>\r\n\
Subject: HTML only\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<html><body><p>Hello <b>world</b>!</p></body></html>";

    const SAMPLE_QUOTED: &[u8] = b"From: alice@example.com\r\n\
Subject: Re: Meeting\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Sure, works for me.\r\n\
\r\n\
On Tue, Apr 7, 2026 at 10:14 AM Bob <bob@example.com> wrote:\r\n\
> are you free tomorrow?\r\n\
> let me know\r\n";

    #[test]
    fn parses_plain_message() {
        let msg = parse_rfc5322(SAMPLE_PLAIN, "acc-1".into(), "Work".into(), "42".into()).unwrap();
        assert_eq!(msg.subject, "Hello");
        assert_eq!(msg.from_name, "Alice Example");
        assert_eq!(msg.from_email, "alice@example.com");
        assert!(msg.body.contains("simple plaintext email body"));
        assert_eq!(msg.account_id, "acc-1");
        assert_eq!(msg.message_id, "42");
        assert!(!msg.has_attachments);
    }

    #[test]
    fn falls_back_to_html_when_no_plain() {
        let msg =
            parse_rfc5322(SAMPLE_HTML_ONLY, "acc".into(), "label".into(), "1".into()).unwrap();
        assert!(msg.body.contains("Hello"));
        assert!(msg.body.contains("world"));
        // No raw tags in the extracted body.
        assert!(!msg.body.contains("<b>"));
    }

    #[test]
    fn strips_quote_in_parsed_message() {
        let msg = parse_rfc5322(SAMPLE_QUOTED, "acc".into(), "label".into(), "9".into()).unwrap();
        let body = strip_quoted_replies(&msg.body);
        assert!(body.contains("Sure, works for me"));
        assert!(!body.contains("are you free"));
    }

    #[test]
    fn reads_the_headers_a_reply_needs() {
        let raw = b"From: Alice <alice@example.com>\r\n\
To: bob@example.com\r\n\
Cc: Carol <carol@example.com>, dave@example.com\r\n\
Reply-To: Team <team@example.com>\r\n\
Subject: Re: Plan\r\n\
Date: Tue, 7 Apr 2026 12:14:00 +0200\r\n\
Message-ID: <m3@example.com>\r\n\
In-Reply-To: <m2@example.com>\r\n\
References: <m1@example.com> <m2@example.com>\r\n\
\r\n\
Fine.\r\n";
        let msg = parse_rfc5322(raw, "a".into(), "l".into(), "7:1".into()).unwrap();
        assert_eq!(msg.cc, vec!["carol@example.com", "dave@example.com"]);
        assert_eq!(msg.reply_to, "team@example.com");
        assert_eq!(msg.rfc_message_id, "m3@example.com");
        assert_eq!(msg.in_reply_to, "m2@example.com");
        assert_eq!(msg.references, vec!["m1@example.com", "m2@example.com"]);
        // In UTC, so listings from several accounts sort as strings.
        assert_eq!(msg.date, "2026-04-07T10:14:00Z");
    }

    #[test]
    fn snippet_collapses_whitespace_and_truncates() {
        let s = make_snippet("Line one\n\nLine two        with spaces");
        assert_eq!(s, "Line one Line two with spaces");
        let long = "x".repeat(400);
        let snip = make_snippet(&long);
        assert!(snip.ends_with('…'));
        assert!(snip.chars().count() <= SNIPPET_LEN + 1);
    }

    #[test]
    fn a_listing_comes_from_the_header_and_a_preview() {
        let header = b"From: Alice Example <alice@example.com>\r\nSubject: Hello\r\n\r\n";
        let listing = listing_from_header(
            header,
            "First line\n\nsecond",
            true,
            Some(1_712_793_600),
            "acc".into(),
            "Work".into(),
            "7:42".into(),
        )
        .unwrap();
        assert_eq!(listing.subject, "Hello");
        assert_eq!(listing.from_email, "alice@example.com");
        assert_eq!(listing.snippet, "First line second");
        // No Date header: the server's INTERNALDATE stands in.
        assert_eq!(listing.timestamp, Some(1_712_793_600));
        assert_eq!(listing.date, "2024-04-11T00:00:00Z");
    }
}
