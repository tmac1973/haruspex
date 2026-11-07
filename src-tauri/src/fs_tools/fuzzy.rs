//! Resilient find-and-replace for `fs_edit_text` / `fs_edit_text_absolute`.
//!
//! Weak local models routinely fail an exact-substring edit because of
//! invisible drift between what they "see" and the bytes on disk: CRLF vs
//! LF line endings, trailing whitespace, smart quotes, Unicode dashes, NBSP.
//! Each failed edit costs a whole round-trip. This module adds two things on
//! top of the old exact-match-or-error behaviour:
//!
//!   1. **LF normalization** of file + `old_str` before matching, so a model
//!      emitting `\n` still matches a CRLF file. Original line endings (and a
//!      leading BOM) are restored on write.
//!   2. **A fuzzy fallback** when the exact match misses: retry against a
//!      per-line normalized view (trailing-ws strip, NFKC, smart quotes →
//!      ASCII, Unicode dashes → '-', exotic spaces → ' '). The replacement is
//!      applied to the *original* lines so untouched lines keep their exact
//!      bytes — only the matched window is swapped.
//!
//! Uniqueness is still enforced in both passes: `old_str` must match exactly
//! once or the model gets the same "appears N times / not found" coaching as
//! before.

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

/// What an edit changed, surfaced to the model as a compact confirmation
/// (not a full diff — see plan §7). `first_changed_line` is 1-indexed.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EditResult {
    pub first_changed_line: usize,
    /// First original line of the matched region (for the confirmation).
    pub line_before: String,
    /// First line of `new_str` (what replaced it).
    pub line_after: String,
    /// True when the exact match missed and the fuzzy fallback matched.
    pub used_fuzzy: bool,
}

/// The edited file content (line endings + BOM restored) plus the result.
#[derive(Debug)]
pub struct EditOutcome {
    pub new_content: String,
    pub result: EditResult,
}

/// CRLF / lone-CR → LF.
fn normalize_to_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Strip a leading UTF-8 BOM; return (had_bom, rest) so it can be re-prepended.
fn strip_bom(s: &str) -> (bool, &str) {
    match s.strip_prefix('\u{FEFF}') {
        Some(rest) => (true, rest),
        None => (false, s),
    }
}

/// Per-line fuzzy normalization (mirror of Pi's normalizeForFuzzyMatch, applied
/// one line at a time so indices stay 1:1 with the original line vector).
/// Order: NFKC, then trailing-whitespace strip, then 1:1 char folds.
fn normalize_for_fuzzy_line(line: &str) -> String {
    let nfkc: String = line.nfkc().collect();
    nfkc.trim_end()
        .chars()
        .map(|c| match c {
            // smart single quotes → '
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // smart double quotes → "
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // dashes / minus → -
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            // special spaces → space
            '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
            other => other,
        })
        .collect()
}

fn line_of_byte_offset(s: &str, offset: usize) -> usize {
    s[..offset].bytes().filter(|&b| b == b'\n').count() + 1
}

/// Find-and-replace `old_str` → `new_str` in `raw`, with the LF-normalize +
/// fuzzy-fallback strategy. `path` is only used to phrase errors. Returns the
/// content to write (endings/BOM restored) and an `EditResult`.
pub fn apply_edit(
    raw: &str,
    old_str: &str,
    new_str: &str,
    path: &str,
) -> Result<EditOutcome, String> {
    let (had_bom, body) = strip_bom(raw);
    let was_crlf = body.contains("\r\n");
    let content = normalize_to_lf(body);
    let old = normalize_to_lf(old_str);
    let new = normalize_to_lf(new_str);

    if old.is_empty() {
        return Err("old_str must not be empty.".to_string());
    }

    let (new_content, result) = {
        let occurrences = content.matches(&old).count();
        if occurrences > 1 {
            return Err(format!(
                "old_str appears {} times in {}. It must be unique — include more surrounding context.",
                occurrences, path
            ));
        } else if occurrences == 1 {
            // Exact pass — byte-precise, handles partial-line edits.
            let offset = content.find(&old).expect("match counted above");
            let first_changed_line = line_of_byte_offset(&content, offset);
            let new_content = content.replacen(&old, &new, 1);
            let line_before = content
                .split('\n')
                .nth(first_changed_line - 1)
                .unwrap_or("")
                .to_string();
            let result = EditResult {
                first_changed_line,
                line_before,
                line_after: new.split('\n').next().unwrap_or("").to_string(),
                used_fuzzy: false,
            };
            (new_content, result)
        } else {
            // Fuzzy pass — line-windowed, whitespace/quote/dash insensitive.
            fuzzy_apply(&content, &old, &new, path)?
        }
    };

    if new_content == content {
        return Err(format!(
            "The replacement leaves {} unchanged (old_str and new_str are equivalent). No edit performed.",
            path
        ));
    }

    // Restore the file's original line endings + BOM so the edit doesn't
    // silently rewrite every line ending.
    let mut out = if was_crlf {
        new_content.replace('\n', "\r\n")
    } else {
        new_content
    };
    if had_bom {
        out.insert(0, '\u{FEFF}');
    }

    Ok(EditOutcome {
        new_content: out,
        result,
    })
}

/// Line-windowed fuzzy match. Both `content` and `old` are already LF-normalized.
/// Builds normalized per-line views (indices aligned 1:1 with the originals),
/// slides a window, and on a unique hit splices the *original* lines so
/// untouched lines keep their exact bytes.
fn fuzzy_apply(
    content: &str,
    old: &str,
    new: &str,
    path: &str,
) -> Result<(String, EditResult), String> {
    let content_lines: Vec<&str> = content.split('\n').collect();
    let old_lines: Vec<&str> = old.split('\n').collect();

    let content_norm: Vec<String> = content_lines
        .iter()
        .map(|l| normalize_for_fuzzy_line(l))
        .collect();
    let old_norm: Vec<String> = old_lines
        .iter()
        .map(|l| normalize_for_fuzzy_line(l))
        .collect();

    let win = old_norm.len();
    let not_found = || {
        format!(
            "old_str not found in {}. The text doesn't match the file even allowing for whitespace/quote differences. {}",
            path,
            closest_hint(&content_lines, &content_norm, &old_norm)
        )
    };
    if win == 0 || win > content_norm.len() {
        return Err(not_found());
    }

    let mut starts = Vec::new();
    for start in 0..=(content_norm.len() - win) {
        if content_norm[start..start + win] == old_norm[..] {
            starts.push(start);
        }
    }
    match starts.len() {
        0 => return Err(not_found()),
        1 => {}
        n => {
            return Err(format!(
                "old_str matches {} places in {} (allowing for whitespace/quote differences). It must be unique — include more surrounding context.",
                n, path
            ))
        }
    }

    let i = starts[0];
    let new_lines: Vec<&str> = new.split('\n').collect();
    let mut out_lines: Vec<&str> = Vec::with_capacity(content_lines.len());
    out_lines.extend_from_slice(&content_lines[..i]);
    out_lines.extend_from_slice(&new_lines);
    out_lines.extend_from_slice(&content_lines[i + win..]);

    let result = EditResult {
        first_changed_line: i + 1,
        line_before: content_lines[i].to_string(),
        line_after: new_lines.first().copied().unwrap_or("").to_string(),
        used_fuzzy: true,
    };
    Ok((out_lines.join("\n"), result))
}

/// Lines a not-found hint quotes are cut to this many characters.
const HINT_LINE_CHARS: usize = 120;

fn quoted(line: &str) -> String {
    let t = line.trim();
    match t.char_indices().nth(HINT_LINE_CHARS) {
        Some((i, _)) => format!("`{}…`", &t[..i]),
        None => format!("`{t}`"),
    }
}

/// Where `old_str` comes closest to the file, for a not-found error: the
/// window whose lines match `old_str`'s first lines longest, and the first
/// line that differs. A bare "re-read the file" sent a model back to read a
/// file it had just read, when its `old_str` came from a version that was
/// never written (#1032). Lines compare trimmed, so indentation drift still
/// finds the place.
fn closest_hint(content_lines: &[&str], content_norm: &[String], old_norm: &[String]) -> String {
    let trim = |s: &String| s.trim().to_string();
    let file: Vec<String> = content_norm.iter().map(trim).collect();
    let old: Vec<String> = old_norm.iter().map(trim).collect();
    // A final newline leaves an empty last entry that isn't a line.
    let total = content_lines.len() - usize::from(content_lines.last() == Some(&""));
    let reread = |line: usize| {
        let from = line.saturating_sub(5).max(1);
        let to = (line + old.len() + 5).min(total);
        format!("Read lines {from}-{to} again and copy old_str from what is there now.")
    };

    // The longest run of old_str's opening lines found together in the file.
    let mut best: Option<(usize, usize)> = None;
    for start in 0..file.len() {
        let n = old
            .iter()
            .zip(&file[start..])
            .take_while(|(a, b)| a == b)
            .count();
        if n > 0 && !old[0].is_empty() && best.is_none_or(|(_, m)| n > m) {
            best = Some((start, n));
        }
    }
    if let Some((start, n)) = best {
        if n == old.len() {
            return format!(
                "It matches lines {}-{} of the file except for indentation: copy them with the file's leading spaces or tabs.",
                start + 1,
                start + n
            );
        }
        let at = start + n;
        let file_has = content_lines
            .get(at)
            .map_or("the end of the file".to_string(), |l| quoted(l));
        return format!(
            "Its first {n} line{} match line {} of the file, then line {} differs: the file has {file_has}, old_str has {}. {}",
            if n == 1 { "" } else { "s" },
            start + 1,
            at + 1,
            quoted(&old_norm[n]),
            reread(start + 1)
        );
    }

    // No opening line matches: is any of its other lines there?
    for (k, line) in old.iter().enumerate() {
        if line.chars().count() < 8 {
            continue;
        }
        if let Some(i) = file.iter().position(|l| l == line) {
            return format!(
                "Its line {} ({}) is at line {} of the file, but the lines around it differ. {}",
                k + 1,
                quoted(line),
                i + 1,
                reread(i + 1)
            );
        }
    }
    format!(
        "None of its lines are in the file ({total} lines now): it may come from a version that was never written, or that has changed since. Read the file again and copy old_str from what is there now."
    )
}

/// `content` as a whole-file rewrite of `path` should be written: in the
/// file's line endings and with its BOM, as an edit keeps them, so that
/// rewriting a CRLF file doesn't change every line in git. A new file, or
/// content that already carries CRLF, is left as given. Only the start of
/// the file is read to tell.
pub fn like_existing(path: &std::path::Path, content: String) -> String {
    use std::io::Read;
    let mut head = Vec::new();
    let Ok(file) = std::fs::File::open(path) else {
        return content;
    };
    if file.take(64 * 1024).read_to_end(&mut head).is_err() {
        return content;
    }
    let had_bom = head.starts_with("\u{FEFF}".as_bytes());
    let crlf = head
        .iter()
        .position(|&b| b == b'\n')
        .is_some_and(|i| i > 0 && head[i - 1] == b'\r');
    let mut out = if crlf && !content.contains('\r') {
        content.replace('\n', "\r\n")
    } else {
        content
    };
    if had_bom && !out.starts_with('\u{FEFF}') {
        out.insert(0, '\u{FEFF}');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rewrite_keeps_the_files_crlf_and_bom() {
        let dir = crate::test_util::temp_dir("like_existing");
        let crlf = dir.join("crlf.txt");
        std::fs::write(&crlf, "\u{FEFF}a\r\nb\r\n").unwrap();
        assert_eq!(like_existing(&crlf, "x\ny\n".into()), "\u{FEFF}x\r\ny\r\n");
        // Already CRLF: not doubled.
        assert_eq!(like_existing(&crlf, "x\r\n".into()), "\u{FEFF}x\r\n");
        let lf = dir.join("lf.txt");
        std::fs::write(&lf, "a\nb\n").unwrap();
        assert_eq!(like_existing(&lf, "x\ny\n".into()), "x\ny\n");
        // A new file is written as given.
        assert_eq!(like_existing(&dir.join("new.txt"), "x\n".into()), "x\n");
    }

    #[test]
    fn exact_match_preferred() {
        let out = apply_edit("alpha\nbeta\ngamma\n", "beta", "BETA", "f").unwrap();
        assert_eq!(out.new_content, "alpha\nBETA\ngamma\n");
        assert!(!out.result.used_fuzzy);
        assert_eq!(out.result.first_changed_line, 2);
        assert_eq!(out.result.line_before, "beta");
        assert_eq!(out.result.line_after, "BETA");
    }

    #[test]
    fn crlf_file_matches_lf_old_str() {
        // File is CRLF; model emits LF. Must match, and CRLF must be restored.
        let out = apply_edit("a\r\nbeta\r\nc\r\n", "beta", "BETA", "f").unwrap();
        assert_eq!(out.new_content, "a\r\nBETA\r\nc\r\n");
        assert!(!out.result.used_fuzzy);
    }

    #[test]
    fn fuzzy_matches_trailing_whitespace_drift() {
        // File line has trailing spaces; old_str doesn't. Exact misses, fuzzy hits.
        let out = apply_edit("foo   \nbar\n", "foo\nbar", "X\nY", "f").unwrap();
        assert_eq!(out.new_content, "X\nY\n");
        assert!(out.result.used_fuzzy);
        assert_eq!(out.result.first_changed_line, 1);
    }

    #[test]
    fn fuzzy_matches_smart_quotes() {
        // File has a smart quote; model emits an ASCII one.
        let out = apply_edit(
            "say \u{201C}hi\u{201D} now\n",
            "say \"hi\" now",
            "done",
            "f",
        )
        .unwrap();
        assert_eq!(out.new_content, "done\n");
        assert!(out.result.used_fuzzy);
    }

    #[test]
    fn fuzzy_rejects_non_unique_normalized_match() {
        // Two lines differ only by trailing whitespace → both normalize equal.
        let err = apply_edit("dup\ndup   \n", "dup", "X", "f").unwrap_err();
        assert!(err.contains("must be unique"), "got: {err}");
    }

    #[test]
    fn exact_appears_twice_errors() {
        let err = apply_edit("x\nx\n", "x", "y", "f").unwrap_err();
        assert!(err.contains("appears 2 times"), "got: {err}");
    }

    #[test]
    fn not_found_errors() {
        let err = apply_edit("alpha\n", "zeta", "x", "f").unwrap_err();
        assert!(err.contains("not found"), "got: {err}");
    }

    #[test]
    fn not_found_names_the_closest_place_and_the_line_that_differs() {
        let file = "a\nconst x = 1;\nconst y = 2;\nconst z = 3;\nb\n";
        let err = apply_edit(file, "const x = 1;\n  const y = 9;", "q", "f").unwrap_err();
        assert!(
            err.contains(
                "Its first 1 line match line 2 of the file, then line 3 differs: the file has `const y = 2;`, old_str has `const y = 9;`. Read lines 1-5 again"
            ),
            "got: {err}"
        );
    }

    #[test]
    fn not_found_finds_a_later_line_of_old_str() {
        let file = "one\ntwo\nfnQuat('Spine', t)\nthree\n";
        let err = apply_edit(file, "changed first\nfnQuat('Spine', t)", "q", "f").unwrap_err();
        assert!(
            err.contains("Its line 2 (`fnQuat('Spine', t)`) is at line 3 of the file"),
            "got: {err}"
        );
    }

    #[test]
    fn not_found_says_when_no_line_is_in_the_file() {
        let err = apply_edit("alpha\nbeta\n", "a version never written", "q", "f").unwrap_err();
        assert!(
            err.contains("None of its lines are in the file (2 lines now)"),
            "got: {err}"
        );
    }

    #[test]
    fn not_found_says_when_only_the_indentation_differs() {
        let err = apply_edit("if a {\n    b();\n}\n", "if a {\nb();", "q", "f").unwrap_err();
        assert!(
            err.contains("matches lines 1-2 of the file except for indentation"),
            "got: {err}"
        );
    }

    #[test]
    fn noop_replacement_errors() {
        let err = apply_edit("alpha\n", "alpha", "alpha", "f").unwrap_err();
        assert!(err.contains("unchanged"), "got: {err}");
    }

    #[test]
    fn bom_preserved() {
        let out = apply_edit("\u{FEFF}alpha\nbeta\n", "beta", "BETA", "f").unwrap();
        assert!(out.new_content.starts_with('\u{FEFF}'));
        assert_eq!(out.new_content, "\u{FEFF}alpha\nBETA\n");
    }

    #[test]
    fn empty_old_str_errors() {
        let err = apply_edit("alpha\n", "", "x", "f").unwrap_err();
        assert!(err.contains("must not be empty"), "got: {err}");
    }

    #[test]
    fn partial_line_exact_edit() {
        // Exact pass handles a within-line replacement the fuzzy pass can't.
        let out = apply_edit("let x = 1;\n", "= 1", "= 2", "f").unwrap();
        assert_eq!(out.new_content, "let x = 2;\n");
        assert!(!out.result.used_fuzzy);
    }
}
