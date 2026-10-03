//! A message's MIME structure, from IMAP's BODYSTRUCTURE, so a list can fetch
//! a few KB of the right text part instead of every message whole.

use async_imap::imap_proto::types::{BodyContentCommon, BodyStructure, ContentEncoding};
use mail_parser::MessageParser;

use super::text::html_to_text;

/// How a part's bytes are encoded on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Identity,
    Base64,
    QuotedPrintable,
}

impl Encoding {
    fn header(self) -> &'static str {
        match self {
            Encoding::Identity => "8bit",
            Encoding::Base64 => "base64",
            Encoding::QuotedPrintable => "quoted-printable",
        }
    }
}

/// One leaf of the structure, flattened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Part {
    /// IMAP section number: `[1]` for a single-part message, `[1, 2]` for
    /// the second child of the first part.
    pub path: Vec<u32>,
    /// Lower-case "type/subtype".
    pub mime: String,
    pub charset: Option<String>,
    pub encoding: Encoding,
    /// Marked as an attachment, or carries a file name.
    pub attachment: bool,
}

impl Part {
    /// The section as IMAP writes it: "1.2".
    pub fn section(&self) -> String {
        self.path
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(".")
    }

    fn is_text(&self, subtype: &str) -> bool {
        !self.attachment && self.mime == format!("text/{subtype}")
    }
}

fn param<'a>(
    params: &'a Option<Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>>,
    key: &str,
) -> Option<&'a str> {
    params
        .as_ref()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_ref())
}

fn leaf(common: &BodyContentCommon<'_>, encoding: &ContentEncoding<'_>, path: Vec<u32>) -> Part {
    let mime = format!("{}/{}", common.ty.ty, common.ty.subtype).to_ascii_lowercase();
    let disposition = common.disposition.as_ref();
    let attachment = disposition.is_some_and(|d| {
        d.ty.eq_ignore_ascii_case("attachment") || param(&d.params, "filename").is_some()
    }) || param(&common.ty.params, "name").is_some();
    Part {
        path,
        mime,
        charset: param(&common.ty.params, "charset").map(str::to_string),
        encoding: match encoding {
            ContentEncoding::Base64 => Encoding::Base64,
            ContentEncoding::QuotedPrintable => Encoding::QuotedPrintable,
            _ => Encoding::Identity,
        },
        attachment,
    }
}

fn flatten(bs: &BodyStructure<'_>, path: Vec<u32>, out: &mut Vec<Part>) {
    match bs {
        BodyStructure::Multipart { bodies, .. } => {
            for (i, b) in bodies.iter().enumerate() {
                let mut child = path.clone();
                child.push(i as u32 + 1);
                flatten(b, child, out);
            }
        }
        BodyStructure::Text { common, other, .. } | BodyStructure::Basic { common, other, .. } => {
            out.push(leaf(common, &other.transfer_encoding, path));
        }
        // A forwarded message: one attachment, not text to preview.
        BodyStructure::Message { common, other, .. } => {
            let mut p = leaf(common, &other.transfer_encoding, path);
            p.attachment = true;
            out.push(p);
        }
    }
}

/// Every leaf, with its section number. A single-part message is part 1.
pub fn parts(bs: &BodyStructure<'_>) -> Vec<Part> {
    let mut out = Vec::new();
    match bs {
        BodyStructure::Multipart { .. } => flatten(bs, Vec::new(), &mut out),
        _ => flatten(bs, vec![1], &mut out),
    }
    out
}

/// The part to read for a preview or a body: the first plain text part,
/// else the first HTML one; never an attachment.
pub fn text_part(parts: &[Part]) -> Option<&Part> {
    parts
        .iter()
        .find(|p| p.is_text("plain"))
        .or_else(|| parts.iter().find(|p| p.is_text("html")))
}

/// Whether anything besides the text came with it.
pub fn has_attachments(parts: &[Part]) -> bool {
    parts
        .iter()
        .any(|p| p.attachment || !(p.mime.starts_with("text/") || p.mime.starts_with("multipart/")))
}

/// A part's bytes as text: transfer encoding and charset undone, HTML
/// turned to text. `truncated` says the bytes stop short of the part's end;
/// the last line is then dropped, so a cut base64 quad or `=XX` escape is
/// never decoded.
pub fn decode(bytes: &[u8], part: &Part, truncated: bool) -> String {
    let bytes = if truncated {
        match bytes.iter().rposition(|&b| b == b'\n') {
            Some(i) => &bytes[..=i],
            None => bytes,
        }
    } else {
        bytes
    };
    // mail-parser already knows every charset and encoding, so the part is
    // handed to it as a message of its own.
    let mut msg = format!(
        "Content-Type: {}; charset=\"{}\"\r\nContent-Transfer-Encoding: {}\r\n\r\n",
        part.mime,
        part.charset.as_deref().unwrap_or("utf-8"),
        part.encoding.header()
    )
    .into_bytes();
    msg.extend_from_slice(bytes);
    let Some(parsed) = MessageParser::default().parse(&msg[..]) else {
        return String::from_utf8_lossy(bytes).into_owned();
    };
    if part.mime == "text/html" {
        parsed
            .body_html(0)
            .map(|h| html_to_text(&h))
            .unwrap_or_default()
    } else {
        parsed
            .body_text(0)
            .map(|t| t.into_owned())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_imap::imap_proto::types::{AttributeValue, Response};

    /// The leaves of a BODYSTRUCTURE as a server sends it.
    fn parse(bs: &str) -> Vec<Part> {
        let line = format!("* 1 FETCH (BODYSTRUCTURE {bs})\r\n");
        let (_, resp) = async_imap::imap_proto::parser::parse_response(line.as_bytes()).unwrap();
        let Response::Fetch(_, attrs) = resp else {
            panic!("not a fetch")
        };
        let bs = attrs
            .iter()
            .find_map(|a| match a {
                AttributeValue::BodyStructure(bs) => Some(bs),
                _ => None,
            })
            .unwrap();
        parts(bs)
    }

    const ALTERNATIVE: &str = r#"(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 120 4 NIL NIL NIL)("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "BASE64" 900 12 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL)"#;

    #[test]
    fn an_alternative_reads_its_plain_part() {
        let parts = parse(ALTERNATIVE);
        let p = text_part(&parts).unwrap();
        assert_eq!(p.section(), "1");
        assert_eq!(p.mime, "text/plain");
        assert_eq!(p.encoding, Encoding::QuotedPrintable);
        assert!(!has_attachments(&parts));
    }

    #[test]
    fn html_only_reads_the_html() {
        let parts =
            parse(r#"("TEXT" "HTML" ("CHARSET" "iso-8859-1") NIL NIL "7BIT" 300 6 NIL NIL NIL)"#);
        let p = text_part(&parts).unwrap();
        assert_eq!((p.section().as_str(), p.mime.as_str()), ("1", "text/html"));
        assert_eq!(p.charset.as_deref(), Some("iso-8859-1"));
    }

    #[test]
    fn an_attached_text_file_is_not_the_body() {
        let bs = format!(
            r#"(("TEXT" "PLAIN" ("NAME" "notes.txt") NIL NIL "7BIT" 50 2 NIL ("ATTACHMENT" ("FILENAME" "notes.txt")) NIL){ALTERNATIVE} "MIXED" ("BOUNDARY" "b0") NIL NIL)"#
        );
        let parts = parse(&bs);
        let p = text_part(&parts).unwrap();
        assert_eq!(p.section(), "2.1");
        assert!(has_attachments(&parts));
    }

    fn part(mime: &str, encoding: Encoding, charset: &str) -> Part {
        Part {
            path: vec![1],
            mime: mime.into(),
            charset: Some(charset.into()),
            encoding,
            attachment: false,
        }
    }

    #[test]
    fn decodes_a_cut_quoted_printable_part() {
        let bytes = b"Caf=C3=A9 at noon, then a long line that wraps=\r\n here.\r\nSecond li=C3=";
        let text = decode(
            bytes,
            &part("text/plain", Encoding::QuotedPrintable, "utf-8"),
            true,
        );
        assert_eq!(
            text.trim(),
            "Café at noon, then a long line that wraps here."
        );
    }

    #[test]
    fn decodes_a_cut_base64_part_in_its_charset() {
        // "Grüße aus Köln\r\n" in latin-1, base64, then a cut quad.
        let text = decode(
            b"R3L832UgYXVzIEv2bG4NCg==\r\nSGF",
            &part("text/plain", Encoding::Base64, "iso-8859-1"),
            true,
        );
        assert_eq!(text.trim(), "Grüße aus Köln");
    }

    #[test]
    fn decodes_html_to_text() {
        let text = decode(
            b"<p>Hi</p><style>x{}</style><p>there</p>",
            &part("text/html", Encoding::Identity, "utf-8"),
            false,
        );
        assert_eq!(text, "Hi\n\nthere");
    }
}
