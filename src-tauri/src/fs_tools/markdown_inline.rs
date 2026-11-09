//! Markdown helpers for the .docx and .odt writers: headings, XML escaping,
//! and a picture on a line of its own with its `"center 50%"` options. The
//! PDF is built in the frontend (`src/lib/documents/`), which parses the
//! markdown itself.

pub(super) fn parse_heading(line: &str) -> (&str, Option<usize>) {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix("# ") {
        (rest, Some(1))
    } else if let Some(rest) = trimmed.strip_prefix("## ") {
        (rest, Some(2))
    } else if let Some(rest) = trimmed.strip_prefix("### ") {
        (rest, Some(3))
    } else {
        (line, None)
    }
}

pub(super) fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Horizontal alignment for embedded images. Defaults to Left, matching the
/// pre-options default and standard markdown rendering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[allow(dead_code)]
pub enum ImageAlignment {
    #[default]
    Left,
    Center,
    Right,
}

/// Parsed image-layout flags from the markdown title field. Built by
/// `parse_image_options_from_title`. Defaults mean "no override" — every
/// builder applies its existing auto-fit / left-align behavior.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[allow(dead_code)]
pub struct ImageOptions {
    pub alignment: ImageAlignment,
    /// Display width as a fraction (0.05..=1.0) of the document's content
    /// width. `None` means use natural size, scaled down to fit if needed.
    pub width_fraction: Option<f32>,
}

/// Parse `"center 50%"`-style image options from the markdown title field.
/// Tokens are whitespace-separated; `left|center|right` (and `centre`) set
/// alignment, any token ending in `%` sets the width fraction. Unknown
/// tokens are ignored so future flags can land without breaking docs.
pub(super) fn parse_image_options_from_title(title: &str) -> ImageOptions {
    let mut out = ImageOptions::default();
    for raw in title.split_whitespace() {
        let token = raw.to_ascii_lowercase();
        match token.as_str() {
            "left" => out.alignment = ImageAlignment::Left,
            "center" | "centre" => out.alignment = ImageAlignment::Center,
            "right" => out.alignment = ImageAlignment::Right,
            other if other.ends_with('%') => {
                if let Ok(pct) = other.trim_end_matches('%').parse::<f32>() {
                    // Clamp to a sane range: <5% is almost always a model
                    // typo, >100% would overflow the content margin.
                    let clamped = pct.clamp(5.0, 100.0);
                    out.width_fraction = Some(clamped / 100.0);
                }
            }
            _ => { /* ignore unknown tokens */ }
        }
    }
    out
}

/// Parse an `![alt](path "title")` reference if the trimmed line consists of
/// only that and nothing else. Returns the path and parsed options. The
/// title is optional and quoted in CommonMark; we accept both `"..."` and
/// `'...'`. Returns None for inline image refs embedded in other text — the
/// preprocessor only promotes whole-line image refs to standalone blocks.
pub(super) fn parse_standalone_image_line(line: &str) -> Option<(String, ImageOptions)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("![")?;
    let alt_end = rest.find(']')?;
    let after_alt = &rest[alt_end + 1..];
    let inside = after_alt.strip_prefix('(')?;
    let close = inside.rfind(')')?;
    // Reject anything trailing after the closing `)`.
    if !inside[close + 1..].trim().is_empty() {
        return None;
    }
    let body = &inside[..close];

    // Split path from optional title on the first whitespace run.
    let (path, title) = match body.find(char::is_whitespace) {
        Some(i) => (body[..i].trim(), body[i + 1..].trim()),
        None => (body.trim(), ""),
    };
    if path.is_empty() {
        return None;
    }

    // Strip surrounding quotes from the title if present.
    let title_unquoted = if title.len() >= 2
        && ((title.starts_with('"') && title.ends_with('"'))
            || (title.starts_with('\'') && title.ends_with('\'')))
    {
        &title[1..title.len() - 1]
    } else {
        title
    };

    Some((
        path.to_string(),
        parse_image_options_from_title(title_unquoted),
    ))
}
