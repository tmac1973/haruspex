//! The MIME body of an outgoing message, built one way for every sender.
//!
//! ```text
//! mixed                      only with attachments
//! └ related                  only with inline pictures
//!   ├ alternative            only with HTML
//!   │ ├ text/plain
//!   │ └ text/html
//!   └ inline pictures, each with a Content-ID
//! └ attachments
//! ```
//!
//! A layer with nothing to hold is left out, so a text-only message is one
//! text part, as it always was. Inline pictures without HTML have nothing to
//! show them, so they go as attachments.

use lettre::message::header::{ContentTransferEncoding, ContentType};
use lettre::message::{Attachment, Body, MessageBuilder, MultiPart, SinglePart};
use lettre::Message;

/// Largest HTML part, in bytes.
pub const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;

/// One file in a message: a picture shown inline or an attachment.
#[derive(Clone, Debug, PartialEq)]
pub struct FilePart {
    /// A file name already cleaned by [`clean_name`].
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// A body's content, before it is laid out.
pub struct Content {
    pub text: String,
    pub html: Option<String>,
    /// Pictures the HTML shows, each with its Content-ID (no angle brackets).
    pub inline: Vec<(String, FilePart)>,
    pub attachments: Vec<FilePart>,
}

impl Content {
    pub fn text(text: String) -> Self {
        Content {
            text,
            html: None,
            inline: Vec::new(),
            attachments: Vec::new(),
        }
    }
}

/// A file name safe for a header: no control characters or path
/// separators, at most 200 characters, never empty.
pub fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '/' | '\\') { '_' } else { c })
        .take(200)
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed.into()
    }
}

/// A Content-ID a part may carry: ASCII letters, digits and `.-_@`.
pub fn valid_cid(cid: &str) -> bool {
    !cid.is_empty()
        && cid.len() <= 100
        && cid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '@'))
}

fn content_type(mime: &str) -> Result<ContentType, String> {
    ContentType::parse(mime).map_err(|_| format!("{mime:?} is not a MIME type"))
}

/// The plain text part. Quoted-printable, as mail from here always was.
fn text_part(text: &str) -> Result<SinglePart, String> {
    let body = Body::new_with_encoding(text.to_string(), ContentTransferEncoding::QuotedPrintable)
        .map_err(|_| "The message body could not be encoded".to_string())?;
    Ok(SinglePart::builder()
        .header(ContentType::TEXT_PLAIN)
        .body(body))
}

fn attachment(f: &FilePart) -> Result<SinglePart, String> {
    Ok(Attachment::new(f.name.clone()).body(f.bytes.clone(), content_type(&f.mime)?))
}

fn inline(cid: &str, f: &FilePart) -> Result<SinglePart, String> {
    Ok(
        Attachment::new_inline_with_name(cid.to_string(), f.name.clone())
            .body(f.bytes.clone(), content_type(&f.mime)?),
    )
}

/// A layer that is one part or several.
enum Layer {
    Single(SinglePart),
    Multi(MultiPart),
}

impl Layer {
    fn into_mixed(self, mut parts: Vec<SinglePart>) -> MultiPart {
        let mut m = match self {
            Layer::Single(p) => MultiPart::mixed().singlepart(p),
            Layer::Multi(p) => MultiPart::mixed().multipart(p),
        };
        for p in parts.drain(..) {
            m = m.singlepart(p);
        }
        m
    }
}

/// Check `content` and lay it out.
fn layout(
    content: &Content,
    plain_text: impl Fn(&str) -> Result<SinglePart, String>,
) -> Result<Layer, String> {
    let mut seen = std::collections::HashSet::new();
    for (cid, _) in &content.inline {
        if !valid_cid(cid) || !seen.insert(cid.as_str()) {
            return Err(format!("{cid:?} is not a usable Content-ID"));
        }
    }
    let mut attachments: Vec<SinglePart> = content
        .attachments
        .iter()
        .map(attachment)
        .collect::<Result<_, _>>()?;

    let mut layer = match &content.html {
        None => Layer::Single(plain_text(&content.text)?),
        Some(html) => {
            if html.len() > MAX_HTML_BYTES {
                return Err(format!(
                    "The message's HTML is over {} MB",
                    MAX_HTML_BYTES / 1024 / 1024
                ));
            }
            Layer::Multi(
                MultiPart::alternative()
                    .singlepart(plain_text(&content.text)?)
                    .singlepart(SinglePart::html(html.clone())),
            )
        }
    };

    if !content.inline.is_empty() {
        if content.html.is_some() {
            let mut related = match layer {
                Layer::Single(p) => MultiPart::related().singlepart(p),
                Layer::Multi(p) => MultiPart::related().multipart(p),
            };
            for (cid, f) in &content.inline {
                related = related.singlepart(inline(cid, f)?);
            }
            layer = Layer::Multi(related);
        } else {
            for (_, f) in &content.inline {
                attachments.push(attachment(f)?);
            }
        }
    }

    Ok(if attachments.is_empty() {
        layer
    } else {
        Layer::Multi(layer.into_mixed(attachments))
    })
}

/// Finish `builder` with `content`'s body. The text part is quoted-printable.
pub fn finish(builder: MessageBuilder, content: &Content) -> Result<Message, String> {
    attach(builder, layout(content, text_part)?)
}

/// [`finish`] with lettre's own choice of encoding for the text part, as the
/// Research by email reply has always been sent.
pub fn finish_plain_auto(builder: MessageBuilder, content: &Content) -> Result<Message, String> {
    attach(
        builder,
        layout(content, |t| Ok(SinglePart::plain(t.to_string())))?,
    )
}

fn attach(builder: MessageBuilder, layer: Layer) -> Result<Message, String> {
    match layer {
        Layer::Single(p) => builder.singlepart(p),
        Layer::Multi(p) => builder.multipart(p),
    }
    .map_err(|e| format!("The message could not be built: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_parser::MessageParser;

    fn builder() -> MessageBuilder {
        Message::builder()
            .from("me@example.com".parse().unwrap())
            .to("you@example.com".parse().unwrap())
            .subject("Trip")
    }

    fn png(name: &str) -> FilePart {
        FilePart {
            name: name.into(),
            mime: "image/png".into(),
            bytes: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        }
    }

    fn pdf() -> FilePart {
        FilePart {
            name: "trip.pdf".into(),
            mime: "application/pdf".into(),
            bytes: b"%PDF-1.4 tiny".to_vec(),
        }
    }

    fn raw(content: &Content) -> String {
        String::from_utf8(finish(builder(), content).unwrap().formatted()).unwrap()
    }

    fn top(raw: &str) -> String {
        let parsed = MessageParser::default().parse(raw.as_bytes()).unwrap();
        let ct = parsed.content_type().unwrap();
        format!("{}/{}", ct.ctype(), ct.subtype().unwrap_or(""))
    }

    fn html(text: &str, html: &str) -> Content {
        Content {
            html: Some(html.into()),
            ..Content::text(text.into())
        }
    }

    #[test]
    fn text_alone_is_one_text_part() {
        let r = raw(&Content::text("Hello".into()));
        assert_eq!(top(&r), "text/plain");
        assert!(r.contains("Content-Transfer-Encoding: quoted-printable"));
    }

    #[test]
    fn html_makes_an_alternative_text_first() {
        let r = raw(&html("Hello", "<p>Hello</p>"));
        assert_eq!(top(&r), "multipart/alternative");
        assert!(r.find("text/plain").unwrap() < r.find("text/html").unwrap());
    }

    #[test]
    fn inline_pictures_sit_beside_the_html_in_related() {
        let mut c = html("Map", r#"<p><img src="cid:p1"></p>"#);
        c.inline.push(("p1".into(), png("map.png")));
        let r = raw(&c);
        assert_eq!(top(&r), "multipart/related");
        assert!(r.contains("Content-ID: <p1>"));
        let parsed = MessageParser::default().parse(r.as_bytes()).unwrap();
        assert!(parsed.body_html(0).unwrap().contains("cid:p1"));
    }

    #[test]
    fn attachments_go_last_in_mixed() {
        let mut c = html("Trip", "<p>Trip</p>");
        c.inline.push(("p1".into(), png("map.png")));
        c.attachments.push(pdf());
        let r = raw(&c);
        assert_eq!(top(&r), "multipart/mixed");
        let parsed = MessageParser::default().parse(r.as_bytes()).unwrap();
        let names: Vec<_> = parsed
            .attachments()
            .filter_map(|a| a.attachment_name().map(str::to_string))
            .collect();
        assert!(names.contains(&"trip.pdf".to_string()), "{names:?}");
        assert!(r.find("multipart/related").unwrap() < r.find("trip.pdf").unwrap());
    }

    #[test]
    fn text_with_an_attachment_is_mixed() {
        let mut c = Content::text("See the file.".into());
        c.attachments.push(pdf());
        assert_eq!(top(&raw(&c)), "multipart/mixed");
    }

    #[test]
    fn pictures_without_html_are_attached() {
        let mut c = Content::text("Map".into());
        c.inline.push(("p1".into(), png("map.png")));
        let r = raw(&c);
        assert_eq!(top(&r), "multipart/mixed");
        assert!(!r.contains("Content-ID"));
        assert!(r.contains("map.png"));
    }

    #[test]
    fn bad_or_repeated_content_ids_are_refused() {
        let mut c = html("x", "<p>x</p>");
        c.inline.push(("a b".into(), png("a.png")));
        assert!(finish(builder(), &c).is_err());
        let mut c = html("x", "<p>x</p>");
        c.inline.push(("p1".into(), png("a.png")));
        c.inline.push(("p1".into(), png("b.png")));
        assert!(finish(builder(), &c).is_err());
    }

    #[test]
    fn a_bad_mime_type_and_a_huge_html_part_are_refused() {
        let mut c = Content::text("x".into());
        c.attachments.push(FilePart {
            mime: "not a type".into(),
            ..pdf()
        });
        assert!(finish(builder(), &c).is_err());
        let c = html("x", &"x".repeat(MAX_HTML_BYTES + 1));
        assert!(finish(builder(), &c).is_err());
    }

    #[test]
    fn names_are_made_safe_for_a_header() {
        assert_eq!(clean_name("../etc/passwd"), "_etc_passwd");
        assert_eq!(clean_name("a\r\nBcc: x.pdf"), "aBcc: x.pdf");
        assert_eq!(clean_name("  "), "attachment");
        assert_eq!(clean_name("Kart\u{e9}.png"), "Kart\u{e9}.png");
        assert_eq!(clean_name(&"x".repeat(300)).len(), 200);
    }
}
