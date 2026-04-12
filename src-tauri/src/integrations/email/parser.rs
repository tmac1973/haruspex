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

use mail_parser::{Address, MessageParser, MimeHeaders, PartType};
use serde::{Deserialize, Serialize};

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

    /// IMAP UID for this message within its INBOX. We store it as a
    /// decimal string because UIDs are u32 but some providers treat
    /// them loosely and serde-through-JSON round-trip is cleaner as
    /// a string anyway.
    pub message_id: String,

    pub subject: String,
    pub from_name: String,
    pub from_email: String,

    /// RFC 3339 / ISO 8601 date string. Empty if the message had no
    /// Date header or it failed to parse.
    pub date: String,

    /// First ~240 chars of the plaintext body, useful for the model
    /// to decide which messages to expand.
    pub snippet: String,

    /// Whether the MIME structure had any attachment parts. We don't
    /// expose the attachments themselves in Phase 10.1; the flag is
    /// here so the model knows there's "more" it could ask about.
    pub has_attachments: bool,
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
    pub date: String,
    pub body: String,
    pub has_attachments: bool,
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

/// Very small HTML → plaintext fallback used only when a message has
/// no `text/plain` alternative. mail-parser gives us the decoded HTML
/// as a string; we strip tags with the `scraper` crate since it's
/// already a dependency.
fn html_to_plain(html: &str) -> String {
    use scraper::Html;
    let doc = Html::parse_document(html);
    // scraper's root element text() iterator yields plain text in
    // document order, skipping tags but preserving their textual
    // content. This is "good enough" for an email body.
    let root = doc.root_element();
    let text: String = root.text().collect::<Vec<_>>().join(" ");
    // Collapse runs of whitespace introduced by tag boundaries.
    let mut out = String::with_capacity(text.len());
    let mut last_was_space = true;
    for ch in text.chars() {
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

/// Best-effort quoted-reply stripper. Drops everything at or after a
/// line that matches common quote markers ("On … wrote:", a run of `>`
/// lines, etc.). Used before we hand the body to the summarizer
/// sub-agent — quoted chains add tokens without adding information.
pub fn strip_quoted_replies(body: &str) -> String {
    let mut out_lines: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim_start();
        // "On Tue, Apr 7, 2026 at 10:14 AM Foo <foo@bar> wrote:"
        if trimmed.starts_with("On ") && trimmed.contains("wrote:") {
            break;
        }
        // Classic `>` quoted lines — one or two in a row is usually
        // a short quote, but a run of them typically marks the start
        // of a full quoted reply. Cut once we see the first one.
        if trimmed.starts_with('>') {
            break;
        }
        // Outlook-style separator
        if trimmed.starts_with("-----Original Message-----") {
            break;
        }
        // Gmail-style "Forwarded message" divider
        if trimmed.starts_with("---------- Forwarded message") {
            break;
        }
        out_lines.push(line);
    }
    out_lines.join("\n").trim().to_string()
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

    let subject = parsed.subject().unwrap_or("").to_string();

    let (from_name, from_email) = match parsed.from() {
        Some(h) => extract_from(h),
        None => (String::new(), String::new()),
    };

    let to = parsed.to().map(extract_address_list).unwrap_or_default();

    // mail-parser exposes Date as an Option<DateTime>. It's already
    // structured, so format it as a sortable ISO-8601-ish string.
    let date = parsed.date().map(|d| d.to_rfc3339()).unwrap_or_default();

    // Prefer the plain-text body part; fall back to HTML → plain.
    let mut body = String::new();
    if let Some(text) = parsed.body_text(0) {
        body = clean(&text);
    }
    if body.is_empty() {
        if let Some(html) = parsed.body_html(0) {
            body = html_to_plain(&html);
        }
    }

    // Truncate absurdly long bodies so a single message can't blow
    // the sub-agent's input budget.
    if body.chars().count() > MAX_BODY_CHARS {
        let mut tail_idx = 0usize;
        for (n, (i, _)) in body.char_indices().enumerate() {
            if n == MAX_BODY_CHARS {
                tail_idx = i;
                break;
            }
        }
        if tail_idx > 0 {
            body.truncate(tail_idx);
            body.push_str("\n\n[truncated — message body exceeded the ingest cap]");
        }
    }

    // Attachment detection: any non-text part counts.
    let has_attachments = parsed.parts.iter().any(|p| {
        matches!(p.body, PartType::Binary(_) | PartType::InlineBinary(_))
            || p.content_disposition()
                .map(|cd| cd.attribute("filename").is_some())
                .unwrap_or(false)
    });

    Ok(NormalizedMessage {
        account_id,
        account_label,
        message_id,
        subject: clean(&subject),
        from_name: clean(&from_name),
        from_email: clean(&from_email),
        to,
        date,
        body,
        has_attachments,
    })
}

/// Convenience: parse once and produce the cheap listing view.
pub fn parse_to_listing(
    bytes: &[u8],
    account_id: String,
    account_label: String,
    message_id: String,
) -> Result<EmailListing, String> {
    let msg = parse_rfc5322(bytes, account_id, account_label, message_id)?;
    Ok(EmailListing {
        account_id: msg.account_id,
        account_label: msg.account_label,
        message_id: msg.message_id,
        subject: msg.subject,
        from_name: msg.from_name,
        from_email: msg.from_email,
        date: msg.date,
        snippet: make_snippet(&msg.body),
        has_attachments: msg.has_attachments,
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
    fn strips_quoted_reply_tail() {
        let stripped =
            strip_quoted_replies("Sure, works for me.\n\nOn Tue, Apr 7 wrote:\n> are you free?");
        assert_eq!(stripped, "Sure, works for me.");
    }

    #[test]
    fn strips_quote_in_parsed_message() {
        let msg = parse_rfc5322(SAMPLE_QUOTED, "acc".into(), "label".into(), "9".into()).unwrap();
        let body = strip_quoted_replies(&msg.body);
        assert!(body.contains("Sure, works for me"));
        assert!(!body.contains("are you free"));
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
    fn parse_to_listing_populates_snippet() {
        let listing =
            parse_to_listing(SAMPLE_PLAIN, "acc".into(), "Work".into(), "42".into()).unwrap();
        assert_eq!(listing.account_label, "Work");
        assert!(listing.snippet.contains("simple plaintext"));
        assert_eq!(listing.from_email, "alice@example.com");
    }
}
