//! Turning a mail body into text a model can read: HTML to text, and the
//! trailing quote cut off before summarising.

use scraper::{ElementRef, Html, Node};

/// Elements whose text is never part of what the reader sees.
const SKIP: &[&str] = &["head", "style", "script", "template", "title", "noscript"];

/// Elements that start and end a line.
const BLOCK: &[&str] = &[
    "p",
    "div",
    "li",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "ul",
    "ol",
    "blockquote",
    "pre",
    "section",
    "article",
    "header",
    "footer",
];

/// Blocks followed by a blank line, as a paragraph is.
const PARAGRAPH: &[&str] = &[
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "ul",
    "ol",
    "blockquote",
];

/// Lines of text being built: spaces collapsed within a line, at most one
/// blank line between blocks.
#[derive(Default)]
struct Lines {
    done: Vec<String>,
    cur: String,
}

impl Lines {
    fn text(&mut self, s: &str) {
        for ch in s.chars() {
            if ch.is_whitespace() || ch == '\u{a0}' {
                if !self.cur.is_empty() && !self.cur.ends_with(' ') {
                    self.cur.push(' ');
                }
            } else {
                self.cur.push(ch);
            }
        }
    }

    fn end_line(&mut self) {
        let line = self.cur.trim().to_string();
        self.cur.clear();
        if !line.is_empty() {
            self.done.push(line);
        }
    }

    fn blank(&mut self) {
        self.end_line();
        if self.done.last().is_some_and(|l| !l.is_empty()) {
            self.done.push(String::new());
        }
    }

    fn finish(mut self) -> String {
        self.end_line();
        while self.done.last().is_some_and(|l| l.is_empty()) {
            self.done.pop();
        }
        self.done.join("\n")
    }
}

fn walk(el: ElementRef<'_>, out: &mut Lines) {
    let name = el.value().name();
    if SKIP.contains(&name) {
        return;
    }
    if name == "br" {
        out.end_line();
        return;
    }
    let block = BLOCK.contains(&name);
    if block {
        out.end_line();
    }
    if name == "li" {
        out.text("- ");
    }
    for child in el.children() {
        if let Some(child_el) = ElementRef::wrap(child) {
            walk(child_el, out);
        } else if let Node::Text(t) = child.value() {
            out.text(t);
        }
    }
    if name == "a" {
        link_target(el, out);
    }
    if PARAGRAPH.contains(&name) {
        out.blank();
    } else if block {
        out.end_line();
    }
}

/// "text (href)" for a link whose text is not already its address.
fn link_target(el: ElementRef<'_>, out: &mut Lines) {
    let Some(href) = el.value().attr("href").map(str::trim) else {
        return;
    };
    if href.is_empty() || href.starts_with('#') || href.starts_with("mailto:") {
        return;
    }
    let text: String = el.text().collect::<String>();
    let text = text.trim();
    if !text.is_empty() && text != href && !href.ends_with(text) {
        out.text(&format!(" ({href})"));
    }
}

/// An HTML body as plain text: no styles or scripts, a line per block, a
/// blank line after each paragraph, list items as "- ", and links as
/// "text (href)".
pub fn html_to_text(html: &str) -> String {
    let doc = Html::parse_document(html);
    let mut out = Lines::default();
    walk(doc.root_element(), &mut out);
    out.finish()
}

/// The verb with which a reply introduces the message it quotes, in the
/// languages mail is most often written in: "On Tue, … Bob wrote:", "Am …
/// schrieb Bob:".
const ATTRIBUTION_VERBS: &[&str] = &[
    "wrote",
    "schrieb",
    "a écrit",
    "escribió",
    "ha scritto",
    "schreef",
    "skrev",
    "napisał",
    "escreveu",
];

/// Separators after which everything is the quoted original (Outlook does
/// not interleave).
const ORIGINAL_SEPARATORS: &[&str] = &[
    "-----Original Message-----",
    "-----Ursprüngliche Nachricht-----",
];

fn is_attribution(line: &str) -> bool {
    let l = line.trim();
    l.ends_with(':') && ATTRIBUTION_VERBS.iter().any(|v| l.contains(v))
}

/// Remove the quoted message at the end of a reply: the attribution line
/// ("On … wrote:") and the `>` lines after it, to the end. Quotes with
/// replies after them stay — those are the conversation.
pub fn strip_quoted_replies(body: &str) -> String {
    let lines: Vec<&str> = body.lines().collect();

    if let Some(i) = lines
        .iter()
        .position(|l| ORIGINAL_SEPARATORS.iter().any(|s| l.trim().starts_with(s)))
    {
        return lines[..i].join("\n").trim().to_string();
    }

    // Walk up from the end over the trailing `>` block.
    let mut cut = lines.len();
    let mut quoted = false;
    for (i, line) in lines.iter().enumerate().rev() {
        let t = line.trim_start();
        if t.starts_with('>') {
            quoted = true;
            cut = i;
        } else if t.is_empty() {
            continue;
        } else {
            break;
        }
    }
    if !quoted {
        return body.trim().to_string();
    }

    // The attribution above it, which Gmail wraps onto two lines when the
    // address is long.
    let mut j = cut;
    while j > 0 && lines[j - 1].trim().is_empty() {
        j -= 1;
    }
    if j > 0 && is_attribution(lines[j - 1]) {
        cut = j - 1;
        if cut > 0 {
            let above = lines[cut - 1].trim();
            let this = lines[cut].trim();
            let opener = |l: &str| {
                ["On ", "Am ", "Le ", "El ", "Il ", "Op ", "Em "]
                    .iter()
                    .any(|o| l.starts_with(o))
            };
            if !opener(this) && opener(above) {
                cut -= 1;
            }
        }
    }
    lines[..cut].join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_drops_styles_and_keeps_structure() {
        let html = "<html><head><style>p{color:red}</style><title>t</title></head><body>\
            <p>Hello <b>there</b>,</p><p>Two things:</p>\
            <ul><li>first</li><li>second</li></ul>\
            <script>track()</script>\
            <div>See <a href=\"https://example.com/x\">the doc</a>.<br>Thanks</div></body></html>";
        let text = html_to_text(html);
        assert_eq!(
            text,
            "Hello there,\n\nTwo things:\n\n- first\n- second\n\nSee the doc (https://example.com/x).\nThanks"
        );
        assert!(!text.contains("color"));
        assert!(!text.contains("track"));
    }

    #[test]
    fn a_link_that_is_its_own_text_is_not_repeated() {
        let text = html_to_text("<p><a href=\"https://example.com\">https://example.com</a></p>");
        assert_eq!(text, "https://example.com");
    }

    #[test]
    fn a_trailing_gmail_quote_is_stripped() {
        let body = "Sure, works for me.\n\nOn Tue, Apr 7, 2026 at 10:14 AM Bob Example <\nbob@example.com> wrote:\n\n> are you free tomorrow?\n> let me know\n";
        assert_eq!(strip_quoted_replies(body), "Sure, works for me.");
    }

    #[test]
    fn an_interleaved_reply_keeps_all_its_text() {
        let body =
            "> Can you do Tuesday?\nYes, after 2.\n\n> And bring the report?\nIt's attached.\n";
        assert_eq!(strip_quoted_replies(body), body.trim());
    }

    #[test]
    fn a_quote_in_another_language_is_stripped() {
        let body = "Passt.\n\nAm Di., 7. Apr. 2026 um 10:14 Uhr schrieb Bob:\n> Dienstag?";
        assert_eq!(strip_quoted_replies(body), "Passt.");
    }

    #[test]
    fn an_outlook_original_is_stripped() {
        let body = "Done.\n\n-----Original Message-----\nFrom: Bob\nSubject: x\n\nPlease do it.";
        assert_eq!(strip_quoted_replies(body), "Done.");
    }

    #[test]
    fn a_forward_is_kept() {
        let body = "FYI\n\n---------- Forwarded message ---------\nFrom: Bob\n\nThe content.";
        assert_eq!(strip_quoted_replies(body), body.trim());
    }
}
