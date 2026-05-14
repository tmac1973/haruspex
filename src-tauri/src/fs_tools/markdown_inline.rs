//! Inline markdown parsing, table formatting, and PDF-safe ASCII folding.
//!
//! Pure utilities shared by the PDF / DOCX / ODT writers. Everything here is
//! stateless and deterministic — `build_pdf` / `build_docx` / `build_odt`
//! call into this module to classify lines into `DocumentBlock`s and to
//! parse inline syntax (bold/italic/code/links) into `InlineRun`s.

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

/// A run of inline text with uniform bold/italic flags.
#[derive(Clone, Debug)]
pub(super) struct InlineRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

/// A single whitespace-separated word carrying its style. Used during
/// line-wrapping so each word can be placed individually and re-styled.
#[derive(Clone, Debug)]
pub(super) struct StyledWord {
    pub word: String,
    pub bold: bool,
    pub italic: bool,
}

/// Parse inline markdown into styled runs. Handles:
///   - `**bold**` and `*italic*` (bold takes priority when it sees `**`)
///   - `` `code` `` — backticks stripped, text rendered plain (no monospace)
///   - `[text](url)` — rendered as just the link text
///
/// Anything else passes through literally. Unclosed emphasis markers mean
/// the rest of the line inherits the last toggled state.
pub(super) fn parse_inline_markdown(line: &str) -> Vec<InlineRun> {
    let chars: Vec<char> = line.chars().collect();
    let mut runs: Vec<InlineRun> = Vec::new();
    let mut cur = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();

        // **bold** — check before single `*` so we don't misparse it
        if c == '*' && next == Some('*') {
            if !cur.is_empty() {
                runs.push(InlineRun {
                    text: std::mem::take(&mut cur),
                    bold,
                    italic,
                });
            }
            bold = !bold;
            i += 2;
            continue;
        }

        // *italic*
        if c == '*' {
            if !cur.is_empty() {
                runs.push(InlineRun {
                    text: std::mem::take(&mut cur),
                    bold,
                    italic,
                });
            }
            italic = !italic;
            i += 1;
            continue;
        }

        // `code` — emit content as a plain run (printpdf Courier switching
        // would be nicer, but Helvetica keeps measurement consistent)
        if c == '`' {
            if !cur.is_empty() {
                runs.push(InlineRun {
                    text: std::mem::take(&mut cur),
                    bold,
                    italic,
                });
            }
            let mut j = i + 1;
            let mut code = String::new();
            while j < chars.len() && chars[j] != '`' {
                code.push(chars[j]);
                j += 1;
            }
            if !code.is_empty() {
                runs.push(InlineRun {
                    text: code,
                    bold,
                    italic,
                });
            }
            i = if j < chars.len() { j + 1 } else { j };
            continue;
        }

        // [text](url) — keep only the link text. If the pattern doesn't
        // fully match, fall through and the `[` gets treated literally.
        if c == '[' {
            let mut close_bracket = i + 1;
            while close_bracket < chars.len() && chars[close_bracket] != ']' {
                close_bracket += 1;
            }
            if close_bracket + 1 < chars.len() && chars[close_bracket + 1] == '(' {
                let mut close_paren = close_bracket + 2;
                while close_paren < chars.len() && chars[close_paren] != ')' {
                    close_paren += 1;
                }
                if close_paren < chars.len() {
                    for ch in &chars[(i + 1)..close_bracket] {
                        cur.push(*ch);
                    }
                    i = close_paren + 1;
                    continue;
                }
            }
        }

        cur.push(c);
        i += 1;
    }

    if !cur.is_empty() {
        runs.push(InlineRun {
            text: cur,
            bold,
            italic,
        });
    }
    runs
}

/// Run `text` through `parse_inline_markdown` and concatenate the resulting
/// run text, discarding the bold/italic flags. Used for contexts (currently
/// just table cells rendered in Courier) where we need to strip the
/// markdown syntax characters but don't have a way to render mixed bold/
/// italic runs in that context.
pub(super) fn strip_inline_markdown(text: &str) -> String {
    parse_inline_markdown(text)
        .into_iter()
        .map(|r| r.text)
        .collect::<Vec<_>>()
        .join("")
}

/// Detects a markdown horizontal rule (`---`, `***`, `___`, possibly with
/// interspersed spaces). Requires at least 3 rule characters, and every
/// non-whitespace character must be the same rule character. These get
/// treated as explicit page breaks in the PDF.
pub(super) fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(rule_char) = trimmed.chars().find(|c| !c.is_whitespace()) else {
        return false;
    };
    if rule_char != '-' && rule_char != '*' && rule_char != '_' {
        return false;
    }
    let count = trimmed.chars().filter(|c| *c == rule_char).count();
    count >= 3 && trimmed.chars().all(|c| c == rule_char || c.is_whitespace())
}

/// A candidate table row: starts and ends with `|` and has at least one
/// internal cell separator.
pub(super) fn is_table_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.matches('|').count() >= 2
}

/// A candidate table separator row: only `|`, `:`, `-`, and whitespace, and
/// contains at least one dash. Checked against the line that follows a
/// header in `preprocess_lines`.
pub(super) fn is_table_separator(line: &str) -> bool {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return false;
    }
    trimmed
        .chars()
        .all(|c| c == '|' || c == ':' || c == '-' || c.is_whitespace())
        && trimmed.contains('-')
}

/// Split a `| a | b | c |` row into `["a", "b", "c"]`, trimming each cell.
pub(super) fn parse_table_row(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    let stripped = trimmed.trim_start_matches('|').trim_end_matches('|');
    stripped.split('|').map(|s| s.trim().to_string()).collect()
}

/// A single pre-formatted monospace line with an optional bold flag. Used
/// inside `DocumentBlock::MonoBlock` to render tables with aligned columns.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct MonoLine {
    pub text: String,
    pub bold: bool,
}

/// One unit of rendered content. `Line` is a regular markdown-ish paragraph
/// rendered in Helvetica with inline parsing; `MonoBlock` is a pre-formatted
/// block rendered in Courier (monospace) so column alignment via space
/// padding works. Tables become MonoBlocks.
#[derive(Clone, Debug)]
pub(super) enum DocumentBlock {
    Line(String),
    MonoBlock(Vec<MonoLine>),
    /// Standalone embedded image. Carries the workdir-relative path the user
    /// wrote in `![alt](path)` plus parsed `ImageOptions` from the title
    /// field. Only lines that are *entirely* an image reference become Image
    /// blocks — image syntax inside a paragraph is left as plain text and
    /// rendered as the alt text. Image blocks always render on their own
    /// with a small vertical gap above and below.
    Image(String, ImageOptions),
}

/// Horizontal alignment for embedded images. Defaults to Left, matching the
/// pre-options default and standard markdown rendering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[allow(dead_code)] pub enum ImageAlignment {
    #[default]
    Left,
    Center,
    Right,
}

/// Parsed image-layout flags from the markdown title field. Built by
/// `parse_image_options_from_title`. Defaults mean "no override" — every
/// builder applies its existing auto-fit / left-align behavior.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[allow(dead_code)] pub struct ImageOptions {
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

/// Wrap `text` into lines that fit within `max_chars` characters, splitting
/// on whitespace. Words longer than `max_chars` are hard-broken. Used by
/// the table formatter so each cell stays within its allotted column width.
pub(super) fn wrap_to_width(text: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut current_len = 0usize;
    for word in text.split_whitespace() {
        let wlen = word.chars().count();
        if wlen > max_chars {
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
                current_len = 0;
            }
            let mut remaining: Vec<char> = word.chars().collect();
            while remaining.len() > max_chars {
                let head: String = remaining.iter().take(max_chars).collect();
                lines.push(head);
                remaining = remaining.into_iter().skip(max_chars).collect();
            }
            if !remaining.is_empty() {
                let tail: String = remaining.into_iter().collect();
                current_len = tail.chars().count();
                current.push_str(&tail);
            }
            continue;
        }
        let candidate = if current_len == 0 {
            wlen
        } else {
            current_len + 1 + wlen
        };
        if candidate > max_chars {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
            current_len = wlen;
        } else {
            if current_len > 0 {
                current.push(' ');
                current_len += 1;
            }
            current.push_str(word);
            current_len += wlen;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// Right-pad a string to exactly `width` characters. If `s` is already
/// longer than `width`, it is truncated.
pub(super) fn pad_right(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        s.chars().take(width).collect()
    } else {
        let mut out = s.to_string();
        out.push_str(&" ".repeat(width - len));
        out
    }
}

/// Format a markdown table as a block of aligned monospace lines.
///
/// Column widths are computed from each column's longest cell and then
/// shrunk proportionally if the total exceeds `max_line_chars` (picked so
/// the output fits within the PDF's content width at Courier body size).
/// Each cell is wrapped to its column width, row height = max wrapped line
/// count across the row's cells, and the header is flagged `bold`. A line
/// of dashes separates the header from the data rows.
///
/// The returned MonoLines are consumed by `build_pdf` as a single
/// `DocumentBlock::MonoBlock`, which renders them in Courier/CourierBold so
/// the padded spaces align columns correctly.
pub(super) fn format_table_as_monoblock(header: &[String], rows: &[Vec<String>]) -> Vec<MonoLine> {
    let num_cols = header.len();
    if num_cols == 0 {
        return Vec::new();
    }

    // Strip inline markdown (`**bold**`, `*italic*`, `` `code` ``, links)
    // from every cell before doing any width math or rendering. The
    // monospace table path renders all cells in plain Courier, so we can't
    // express bold/italic in-cell anyway — and keeping the raw `**` would
    // leave the literal asterisks visible in the output (the exact bug
    // the user reported as "trying to use ** inside tables").
    let header: Vec<String> = header.iter().map(|h| strip_inline_markdown(h)).collect();

    // Normalize every data row to exactly num_cols cells (pad/truncate),
    // and strip inline markdown from each cell at the same time.
    let normalized_rows: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let mut out: Vec<String> = r.iter().map(|c| strip_inline_markdown(c)).collect();
            out.resize(num_cols, String::new());
            out
        })
        .collect();

    // Starting column widths = max content width per column.
    let mut col_widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
    for row in &normalized_rows {
        for (i, cell) in row.iter().enumerate() {
            col_widths[i] = col_widths[i].max(cell.chars().count());
        }
    }

    // Fit into the available width. Courier 11pt advance ≈ 6.6pt, content
    // width ≈ 498pt → ~75 chars. Two-space column separator.
    let max_line_chars: usize = 75;
    let separator = "  ";
    let sep_total = separator.len() * num_cols.saturating_sub(1);
    let total_needed: usize = col_widths.iter().sum::<usize>() + sep_total;

    if total_needed > max_line_chars {
        let available = max_line_chars.saturating_sub(sep_total);
        let sum: usize = col_widths.iter().sum();
        if sum > 0 && available > 0 {
            for w in col_widths.iter_mut() {
                let new_w = (*w as f64 * available as f64 / sum as f64).floor() as usize;
                *w = new_w.max(4);
            }
        }
    }

    // Emit a single table row as one or more MonoLines, wrapping each cell
    // to its column width and joining with the column separator.
    let emit_row = |cells: &[String], bold: bool| -> Vec<MonoLine> {
        let wrapped: Vec<Vec<String>> = cells
            .iter()
            .enumerate()
            .map(|(i, c)| wrap_to_width(c, col_widths[i]))
            .collect();
        let row_height = wrapped.iter().map(|w| w.len()).max().unwrap_or(1);
        let mut out = Vec::with_capacity(row_height);
        for row_line in 0..row_height {
            let mut parts: Vec<String> = Vec::with_capacity(num_cols);
            for (col_idx, wrapped_cell) in wrapped.iter().enumerate() {
                let cell_line = wrapped_cell.get(row_line).map(|s| s.as_str()).unwrap_or("");
                parts.push(pad_right(cell_line, col_widths[col_idx]));
            }
            out.push(MonoLine {
                text: parts.join(separator),
                bold,
            });
        }
        out
    };

    let mut lines: Vec<MonoLine> = Vec::new();
    // Header row(s)
    lines.extend(emit_row(&header, true));
    // Horizontal rule under the header, matching the exact column widths.
    let rule_parts: Vec<String> = col_widths.iter().map(|w| "-".repeat(*w)).collect();
    lines.push(MonoLine {
        text: rule_parts.join(separator),
        bold: false,
    });
    // Data rows
    for row in &normalized_rows {
        lines.extend(emit_row(row, false));
    }
    lines
}

/// Walk the incoming lines and split them into a sequence of
/// `DocumentBlock`s. Markdown table blocks get packaged into a single
/// `MonoBlock` built via `format_table_as_monoblock`; everything else
/// becomes a `Line`. Called once at the start of `build_pdf`.
pub(super) fn preprocess_lines(lines: &[&str]) -> Vec<DocumentBlock> {
    let mut out: Vec<DocumentBlock> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        // Standalone image-reference line takes priority — these are
        // promoted to Image blocks so the renderer can embed the bitmap
        // instead of falling through to alt-text rendering.
        if let Some((path, opts)) = parse_standalone_image_line(lines[i]) {
            out.push(DocumentBlock::Image(path, opts));
            i += 1;
            continue;
        }
        // Table detection: a header row followed by a separator row, then
        // zero or more data rows until the block ends.
        if i + 1 < lines.len() && is_table_row(lines[i]) && is_table_separator(lines[i + 1]) {
            let header = parse_table_row(lines[i]);
            let mut j = i + 2;
            let mut data_rows: Vec<Vec<String>> = Vec::new();
            while j < lines.len() && is_table_row(lines[j]) {
                data_rows.push(parse_table_row(lines[j]));
                j += 1;
            }
            let mono = format_table_as_monoblock(&header, &data_rows);
            out.push(DocumentBlock::MonoBlock(mono));
            i = j;
            continue;
        }
        out.push(DocumentBlock::Line(lines[i].to_string()));
        i += 1;
    }
    out
}

/// Disambiguate bullet-list markers that would otherwise confuse inline
/// markdown parsing. `* foo` at the start of a line looks identical to the
/// opening of `*italic*` without a closer, so we rewrite `* ` and `+ ` into
/// `- ` which the inline parser ignores entirely. Existing `- ` markers and
/// numbered lists (`1. foo`) pass through untouched.
///
/// Note: we intentionally don't use `•` (U+2022) as the bullet glyph — see
/// `ascii_fold_for_pdf` below for the encoding bug that makes non-ASCII
/// characters mojibake in the generated PDF.
pub(super) fn normalize_list_marker(line: &str) -> String {
    let trimmed = line.trim_start();
    let indent = &line[..line.len() - trimmed.len()];
    if let Some(rest) = trimmed.strip_prefix("* ") {
        return format!("{}- {}", indent, rest);
    }
    if let Some(rest) = trimmed.strip_prefix("+ ") {
        return format!("{}- {}", indent, rest);
    }
    line.to_string()
}

/// Translate common Unicode characters to ASCII equivalents before they
/// reach the PDF content stream.
///
/// Background: printpdf renders with the PDF built-in Helvetica font, which
/// uses WinAnsiEncoding. For built-in fonts it calls
/// `lopdf::Document::encode_text(&SimpleEncoding("WinAnsiEncoding"), text)`.
/// But lopdf 0.39's `string_to_bytes` has a bug: `SimpleEncoding` with any
/// name other than the two recognized UniGB variants falls through to
/// `text.as_bytes().to_vec()` (lopdf/src/encodings/mod.rs:132), dumping raw
/// UTF-8 bytes into the content stream. The PDF viewer then decodes those
/// bytes as WinAnsi, producing classic mojibake:
///   - `•` (UTF-8 `E2 80 A2`) -> `â€¢`
///   - `→` (UTF-8 `E2 86 92`) -> `â†'`
///   - `↓` (UTF-8 `E2 86 93`) -> `â†"`
///   - `"` (UTF-8 `E2 80 9C`) -> `â€œ`
///
/// Folding to ASCII sidesteps the bug because ASCII bytes (< 0x80) are
/// identical in UTF-8 and WinAnsi, so the viewer's reinterpretation is a
/// no-op. The trade-off is losing some non-ASCII typography (smart quotes,
/// em dashes, accents), but that's strictly better than garbled text.
pub(super) fn ascii_fold_for_pdf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        // Fast path: ASCII is always safe.
        if (c as u32) < 0x80 {
            out.push(c);
            continue;
        }
        let replacement: &str = match c {
            // Bullets, dashes, hyphens
            '\u{2022}' | '\u{00B7}' | '\u{2043}' | '\u{2219}' => "-",
            '\u{2013}' | '\u{2212}' => "-",
            '\u{2014}' | '\u{2015}' => "--",
            // Quotes
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' => "'",
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' => "\"",
            '\u{00AB}' => "<<",
            '\u{00BB}' => ">>",
            // Ellipsis and spaces
            '\u{2026}' => "...",
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2009}' | '\u{200A}' => " ",
            '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}' => "",
            // Arrows (common in model output for diagrams and tables)
            '\u{2190}' => "<-",
            '\u{2191}' => "^",
            '\u{2192}' => "->",
            '\u{2193}' => "v",
            '\u{2194}' => "<->",
            '\u{21D0}' => "<=",
            '\u{21D2}' => "=>",
            '\u{21D4}' => "<=>",
            // Math / comparison
            '\u{00D7}' => "x",
            '\u{00F7}' => "/",
            '\u{00B1}' => "+/-",
            '\u{00B0}' => " deg",
            '\u{2248}' => "~=",
            '\u{2260}' => "!=",
            '\u{2264}' => "<=",
            '\u{2265}' => ">=",
            '\u{221E}' => "inf",
            '\u{00B2}' => "^2",
            '\u{00B3}' => "^3",
            '\u{00BC}' => "1/4",
            '\u{00BD}' => "1/2",
            '\u{00BE}' => "3/4",
            // Currency and symbols
            '\u{00A9}' => "(c)",
            '\u{00AE}' => "(R)",
            '\u{2122}' => "(TM)",
            '\u{00A7}' => "Section ",
            '\u{00B6}' => "P ",
            '\u{20AC}' => "EUR",
            '\u{00A3}' => "GBP",
            '\u{00A5}' => "JPY",
            // Check marks and stars
            '\u{2713}' | '\u{2714}' => "[x]",
            '\u{2717}' | '\u{2718}' => "[ ]",
            '\u{2605}' | '\u{2606}' => "*",
            // Box drawing (model sometimes emits these for tables / diagrams)
            '\u{2500}' | '\u{2501}' | '\u{2504}' | '\u{2505}' | '\u{2508}' | '\u{2509}'
            | '\u{254C}' | '\u{254D}' | '\u{2550}' => "-",
            '\u{2502}' | '\u{2503}' | '\u{2506}' | '\u{2507}' | '\u{250A}' | '\u{250B}'
            | '\u{254E}' | '\u{254F}' | '\u{2551}' => "|",
            '\u{250C}' | '\u{2510}' | '\u{2514}' | '\u{2518}' | '\u{251C}' | '\u{2524}'
            | '\u{252C}' | '\u{2534}' | '\u{253C}' => "+",
            // Accented Latin letters — strip the accent to the base letter
            '\u{00C0}'..='\u{00C5}' => "A",
            '\u{00C6}' => "AE",
            '\u{00C7}' => "C",
            '\u{00C8}'..='\u{00CB}' => "E",
            '\u{00CC}'..='\u{00CF}' => "I",
            '\u{00D0}' => "D",
            '\u{00D1}' => "N",
            '\u{00D2}'..='\u{00D6}' | '\u{00D8}' => "O",
            '\u{00D9}'..='\u{00DC}' => "U",
            '\u{00DD}' => "Y",
            '\u{00DE}' => "Th",
            '\u{00DF}' => "ss",
            '\u{00E0}'..='\u{00E5}' => "a",
            '\u{00E6}' => "ae",
            '\u{00E7}' => "c",
            '\u{00E8}'..='\u{00EB}' => "e",
            '\u{00EC}'..='\u{00EF}' => "i",
            '\u{00F0}' => "d",
            '\u{00F1}' => "n",
            '\u{00F2}'..='\u{00F6}' | '\u{00F8}' => "o",
            '\u{00F9}'..='\u{00FC}' => "u",
            '\u{00FD}' | '\u{00FF}' => "y",
            '\u{00FE}' => "th",
            // Anything else we don't explicitly handle: drop silently.
            // Emitting `?` would be noisier than just losing the character.
            _ => "",
        };
        out.push_str(replacement);
    }
    out
}

/// Flatten runs into individual words so the wrapper can pack each word
/// onto a line independently of where the markdown boundaries fell.
pub(super) fn runs_to_words(runs: &[InlineRun]) -> Vec<StyledWord> {
    let mut out = Vec::new();
    for run in runs {
        for word in run.text.split_whitespace() {
            out.push(StyledWord {
                word: word.to_string(),
                bold: run.bold,
                italic: run.italic,
            });
        }
    }
    out
}

/// Greedy word wrap on a stream of styled words. Char counts are approximate
/// but match the original pure-string wrap_text to stay predictable.
pub(super) fn wrap_styled_words(words: &[StyledWord], max_chars: usize) -> Vec<Vec<StyledWord>> {
    if max_chars == 0 {
        return vec![words.to_vec()];
    }
    let mut lines: Vec<Vec<StyledWord>> = Vec::new();
    let mut current: Vec<StyledWord> = Vec::new();
    let mut current_len: usize = 0;

    for w in words {
        let wlen = w.word.chars().count();

        // Hard-wrap words that exceed the line width on their own.
        if wlen > max_chars {
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
                current_len = 0;
            }
            let mut remaining: Vec<char> = w.word.chars().collect();
            while remaining.len() > max_chars {
                let head: String = remaining.iter().take(max_chars).collect();
                lines.push(vec![StyledWord {
                    word: head,
                    bold: w.bold,
                    italic: w.italic,
                }]);
                remaining = remaining.into_iter().skip(max_chars).collect();
            }
            if !remaining.is_empty() {
                let tail: String = remaining.into_iter().collect();
                let tlen = tail.chars().count();
                current.push(StyledWord {
                    word: tail,
                    bold: w.bold,
                    italic: w.italic,
                });
                current_len = tlen;
            }
            continue;
        }

        let candidate = if current_len == 0 {
            wlen
        } else {
            current_len + 1 + wlen
        };
        if candidate > max_chars {
            lines.push(std::mem::take(&mut current));
            current.push(w.clone());
            current_len = wlen;
        } else {
            current.push(w.clone());
            current_len = candidate;
        }
    }

    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(Vec::new());
    }
    lines
}
