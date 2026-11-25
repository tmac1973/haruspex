//! Research by email: the reply to a request, built here from checked parts.
//!
//! It goes from the account to the account and nowhere else: the caller
//! passes no recipient and no header. The caller chooses the Message-ID, so
//! a send retried after a crash carries the id the job already stored.
//! Everything the caller passes is checked and refused if wrong rather than
//! cleaned. The HTML is not sanitised here: the job builds it from Markdown
//! and sanitises it.

use lettre::message::header::{HeaderName, HeaderValue};
use lettre::message::{Mailbox, Message};
use serde::Deserialize;

use super::body::{self, Content};
use super::requests::{is_valid_message_id, REPLY_HEADER};
use super::smtp_client::reply_subject;

/// Most References entries a reply keeps (the latest ones).
pub const MAX_REFERENCES: usize = 20;
/// Longest subject, in characters. A longer one is cut.
pub const MAX_SUBJECT_CHARS: usize = 200;
/// Largest text or HTML part, in bytes.
pub const MAX_PART_BYTES: usize = 512 * 1024;

/// One reply, as the Research by email job describes it.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ReplyInput {
    /// The reply's own Message-ID, without angle brackets, on the account's
    /// domain.
    pub reply_message_id: String,
    /// The request's Message-ID, without angle brackets.
    pub request_message_id: String,
    /// The request's References, oldest first.
    pub references: Vec<String>,
    /// The request's subject; "Re: " is added once.
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// The whole reply, from `from` (the account's address) to `from`.
pub fn build(from: &str, message_id: &str, input: &ReplyInput) -> Result<Message, String> {
    let me: Mailbox = from
        .trim()
        .parse()
        .map_err(|e| format!("The account address {from:?} is not valid: {e}"))?;

    if message_id != input.reply_message_id {
        return Err("The reply's Message-ID changed between storing and sending".into());
    }
    let reply_id = checked_id(&input.reply_message_id, "reply")?;
    let own_domain = me.email.domain();
    let reply_domain = reply_id.rsplit_once('@').map_or("", |(_, d)| d);
    if !reply_domain.eq_ignore_ascii_case(own_domain) {
        return Err(format!(
            "The reply's Message-ID must be on {own_domain}, not {reply_domain}"
        ));
    }
    let request_id = checked_id(&input.request_message_id, "request")?;

    if input.subject.contains(['\r', '\n']) {
        return Err("The subject holds a line break".into());
    }
    let subject: String = reply_subject(&input.subject)
        .chars()
        .take(MAX_SUBJECT_CHARS)
        .collect();

    for (name, part) in [("text", &input.text), ("HTML", &input.html)] {
        if part.len() > MAX_PART_BYTES {
            return Err(format!(
                "The reply's {name} is over {} KB",
                MAX_PART_BYTES / 1024
            ));
        }
    }

    let references = references(&input.references, request_id);

    let builder = Message::builder()
        .from(me.clone())
        .to(me)
        .subject(subject)
        .date_now()
        .message_id(Some(format!("<{reply_id}>")))
        .in_reply_to(format!("<{request_id}>"))
        .references(references)
        .raw_header(HeaderValue::new(
            HeaderName::new_from_ascii_str(REPLY_HEADER),
            "1".into(),
        ))
        .raw_header(HeaderValue::new(
            HeaderName::new_from_ascii_str("Auto-Submitted"),
            "auto-replied".into(),
        ));
    body::finish_plain_auto(
        builder,
        &Content {
            html: Some(input.html.clone()),
            ..Content::text(input.text.clone())
        },
    )
}

/// A Message-ID that passes the shared check and is plain ASCII, without
/// its angle brackets.
fn checked_id<'a>(id: &'a str, which: &str) -> Result<&'a str, String> {
    let bare = bare(id);
    if is_valid_message_id(bare) && bare.is_ascii() {
        Ok(bare)
    } else {
        Err(format!("The {which}'s Message-ID is not valid"))
    }
}

fn bare(id: &str) -> &str {
    let id = id.trim();
    id.strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(id)
}

/// The References header: the request's valid references (the latest
/// [`MAX_REFERENCES`], without repeats), then the request itself.
fn references(given: &[String], request_id: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for r in given {
        let r = bare(r);
        if is_valid_message_id(r) && r.is_ascii() && r != request_id && !kept.contains(&r) {
            kept.push(r);
        }
    }
    let skip = kept.len().saturating_sub(MAX_REFERENCES);
    kept.into_iter()
        .skip(skip)
        .chain(std::iter::once(request_id))
        .map(|r| format!("<{r}>"))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::{AddressList, MessageParser, TextList};

    const ME: &str = "me@example.com";
    const REPLY_ID: &str = "18f0a.1c.0.haruspex@example.com";

    fn input() -> ReplyInput {
        ReplyInput {
            reply_message_id: REPLY_ID.into(),
            request_message_id: "CAF1234abcd@mail.gmail.com".into(),
            references: vec!["first-request@mail.gmail.com".into()],
            subject: "ask haruspex: e-bikes for hills".into(),
            text: "The answer.\n\nSources:\n1. https://example.org".into(),
            html: "<p>The answer.</p>".into(),
        }
    }

    fn raw(i: &ReplyInput) -> String {
        String::from_utf8(build(ME, &i.reply_message_id, i).unwrap().formatted()).unwrap()
    }

    fn ids(v: Option<TextList<'_>>) -> Vec<String> {
        v.map(|l| l.iter().map(|s| s.to_string()).collect())
            .unwrap_or_default()
    }

    fn addrs(a: Option<AddressList<'_>>) -> Vec<String> {
        a.map(|a| {
            a.mailboxes()
                .filter_map(|x| x.address().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
    }

    fn header(m: &mail_parser::Message<'_>, name: &str) -> Option<String> {
        m.headers()
            .all(name)
            .next()
            .map(|h| String::from_utf8_lossy(h.raw_value()).trim().to_string())
    }

    #[test]
    fn goes_only_to_the_account_with_the_chosen_id_and_markers() {
        let text = raw(&input());
        let parsed = MessageParser::default().parse(text.as_bytes()).unwrap();
        assert_eq!(addrs(parsed.from()), vec![ME]);
        assert_eq!(addrs(parsed.to()), vec![ME]);
        assert!(parsed.cc().is_none() && parsed.bcc().is_none());
        assert!(parsed.reply_to().is_none());
        assert_eq!(parsed.message_id(), Some(REPLY_ID));
        assert_eq!(
            header(&parsed, REPLY_HEADER).as_deref(),
            Some("1"),
            "{text}"
        );
        assert_eq!(
            header(&parsed, "Auto-Submitted").as_deref(),
            Some("auto-replied")
        );
    }

    #[test]
    fn threads_under_the_request_without_doubling_re() {
        let mut i = input();
        i.subject = "RE: ask haruspex: more".into();
        let parsed_raw = raw(&i);
        let parsed = MessageParser::default()
            .parse(parsed_raw.as_bytes())
            .unwrap();
        assert_eq!(parsed.subject(), Some("RE: ask haruspex: more"));
        assert_eq!(
            ids(parsed.in_reply_to()),
            vec!["CAF1234abcd@mail.gmail.com"]
        );
        assert_eq!(
            ids(parsed.references()),
            vec!["first-request@mail.gmail.com", "CAF1234abcd@mail.gmail.com"]
        );
        assert_eq!(
            MessageParser::default()
                .parse(raw(&input()).as_bytes())
                .unwrap()
                .subject(),
            Some("Re: ask haruspex: e-bikes for hills")
        );
    }

    #[test]
    fn the_body_is_text_then_html() {
        let text = raw(&input());
        let parsed = MessageParser::default().parse(text.as_bytes()).unwrap();
        let ct = parsed.content_type().unwrap();
        assert_eq!(ct.ctype(), "multipart");
        assert_eq!(ct.subtype(), Some("alternative"));
        let plain = text.find("text/plain").unwrap();
        let html = text.find("text/html").unwrap();
        assert!(plain < html);
        assert!(parsed.body_text(0).unwrap().contains("The answer."));
        assert!(parsed.body_html(0).unwrap().contains("<p>The answer.</p>"));
    }

    #[test]
    fn a_header_in_the_subject_is_refused() {
        let mut i = input();
        i.subject = "ask haruspex\r\nBcc: x@y.com".into();
        assert!(build(ME, REPLY_ID, &i).is_err());
        i.subject = "ask haruspex\nBcc: x@y.com".into();
        assert!(build(ME, REPLY_ID, &i).is_err());
    }

    #[test]
    fn a_long_subject_is_cut() {
        let mut i = input();
        i.subject = "x".repeat(500);
        let parsed_raw = raw(&i);
        let parsed = MessageParser::default()
            .parse(parsed_raw.as_bytes())
            .unwrap();
        assert_eq!(parsed.subject().unwrap().chars().count(), MAX_SUBJECT_CHARS);
    }

    #[test]
    fn bad_ids_are_refused() {
        for bad in [
            "CAF1234abcd@mail\r.gmail.com",
            "CAF1234 abcd@mail.gmail.com",
            "short@x",
            "no-at-sign-at-all",
            "",
        ] {
            let mut i = input();
            i.request_message_id = bad.into();
            assert!(build(ME, REPLY_ID, &i).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_reply_id_on_another_domain_or_changed_is_refused() {
        let mut i = input();
        i.reply_message_id = "18f0a.1c.0.haruspex@evil.example".into();
        assert!(build(ME, &i.reply_message_id.clone(), &i).is_err());
        assert!(build(ME, "other.id.haruspex@example.com", &input()).is_err());
        // Angle brackets and case in the domain are fine.
        let mut i = input();
        i.reply_message_id = "<18f0a.1c.0.haruspex@EXAMPLE.com>".into();
        assert!(build(ME, &i.reply_message_id.clone(), &i).is_ok());
    }

    #[test]
    fn bad_references_are_dropped_and_only_the_last_twenty_kept() {
        let mut given: Vec<String> = (0..30)
            .map(|n| format!("ref-{n:04}@mail.example"))
            .collect();
        given.push("bad id@x.y".into());
        given.push("tiny@x".into());
        given.push("ref-0029@mail.example".into());
        let header = references(&given, "CAF1234abcd@mail.gmail.com");
        let out: Vec<&str> = header.split(' ').collect();
        assert_eq!(out.len(), MAX_REFERENCES + 1);
        assert_eq!(out[0], "<ref-0010@mail.example>");
        assert_eq!(out[MAX_REFERENCES - 1], "<ref-0029@mail.example>");
        assert_eq!(out[MAX_REFERENCES], "<CAF1234abcd@mail.gmail.com>");
        assert!(!header.contains("bad id") && !header.contains("tiny@x"));
    }

    #[test]
    fn many_long_references_keep_lines_within_the_limit() {
        let mut i = input();
        i.references = (0..25)
            .map(|n| format!("{}-{n}@mail.example", "r".repeat(200)))
            .collect();
        let text = raw(&i);
        assert!(text.lines().all(|l| l.len() <= 998), "{text}");
        let parsed = MessageParser::default().parse(text.as_bytes()).unwrap();
        assert_eq!(ids(parsed.references()).len(), MAX_REFERENCES + 1);
    }

    #[test]
    fn oversized_parts_are_refused() {
        let mut i = input();
        i.html = "x".repeat(MAX_PART_BYTES + 1);
        assert!(build(ME, REPLY_ID, &i).is_err());
        let mut i = input();
        i.text = "x".repeat(MAX_PART_BYTES + 1);
        assert!(build(ME, REPLY_ID, &i).is_err());
    }
}
