//! Gitignore-aware content search (`code_grep`) and file globbing
//! (`code_glob`) for the coding tools. Both return locations, never whole
//! file bodies, to keep model context small.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Default / max caps for code_grep + code_glob. Returning locations not
/// bodies, capped server-side, is the whole point (plan §7).
const GREP_DEFAULT_MAX: usize = 50;
const GREP_LINE_CHARS: usize = 200;
const GLOB_DEFAULT_MAX: usize = 100;

// ---------------------------------------------------------------------------
// code_grep
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GrepMatch {
    pub path: String,
    pub line: u32,
    pub text: String,
    /// False for the surrounding lines emitted in context mode; true for the
    /// matched line itself (and always true when no context was requested).
    pub is_match: bool,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GrepFileCount {
    pub path: String,
    pub count: u32,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GrepResult {
    /// Matched (and, in context mode, surrounding) lines. Empty in count /
    /// files-only mode.
    pub matches: Vec<GrepMatch>,
    pub truncated: bool,
    /// Per-file match counts — populated only in count mode.
    pub counts: Vec<GrepFileCount>,
    /// Grand total of matches across all files — count mode only.
    pub total: u32,
    /// Files with at least one match — populated only in files-only mode.
    pub files: Vec<String>,
}

/// Trim line endings and clamp to GREP_LINE_CHARS so grep output stays compact.
fn clamp_line(s: &str) -> String {
    s.trim_end_matches(['\n', '\r'])
        .chars()
        .take(GREP_LINE_CHARS)
        .collect()
}

/// grep Sink that collects matched lines *and* their surrounding context for
/// `code_grep`'s context mode. The `UTF8` convenience sink only surfaces
/// matched lines (it drops context), so context mode needs a custom sink.
struct ContextSink<'a> {
    path: &'a str,
    out: &'a mut Vec<GrepMatch>,
    /// Shared running count of *matched* lines (context lines don't count) so
    /// the cap and truncation behave the same as the no-context path.
    matched: &'a mut usize,
    cap: usize,
}

impl grep::searcher::Sink for ContextSink<'_> {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &grep::searcher::Searcher,
        m: &grep::searcher::SinkMatch<'_>,
    ) -> Result<bool, std::io::Error> {
        self.out.push(GrepMatch {
            path: self.path.to_string(),
            line: m.line_number().unwrap_or(0) as u32,
            text: clamp_line(&String::from_utf8_lossy(m.bytes())),
            is_match: true,
        });
        *self.matched += 1;
        // Stop this file once the global match cap is reached.
        Ok(*self.matched < self.cap)
    }

    fn context(
        &mut self,
        _searcher: &grep::searcher::Searcher,
        c: &grep::searcher::SinkContext<'_>,
    ) -> Result<bool, std::io::Error> {
        self.out.push(GrepMatch {
            path: self.path.to_string(),
            line: c.line_number().unwrap_or(0) as u32,
            text: clamp_line(&String::from_utf8_lossy(c.bytes())),
            is_match: false,
        });
        Ok(true)
    }
}

/// A WSL Shell session's root is the shell's Linux cwd; map it onto the
/// Windows path the tools can walk (see `require_absolute`). Other roots — the
/// Code tab's working directory, a PowerShell or Linux/macOS shell cwd — are
/// already host paths and pass through untouched.
fn resolve_code_root(root: String, wsl_distro: Option<&str>) -> Result<String, String> {
    match wsl_distro {
        Some(_) => crate::fs_tools::absolute::require_absolute(&root, wsl_distro)
            .map(|p| p.to_string_lossy().into_owned()),
        None => Ok(root),
    }
}

/// Walk `walk_root` honoring .gitignore even outside a git checkout (like
/// `rg --no-require-git`), yielding each regular file as `(relative_path,
/// absolute_path)`. The relative path is derived against `strip_root` (which
/// may differ from `walk_root` — `code_grep` walks a subdir but reports paths
/// relative to the project root). Unreadable entries are skipped. Shared by
/// `code_grep` and `code_glob` so they agree on traversal + path derivation.
/// Under a WSL distro's share the relative path uses `/`, and a file outside
/// `strip_root` is named by its Linux path, never the share's.
fn walk_files(walk_root: &Path, strip_root: &Path) -> impl Iterator<Item = (String, PathBuf)> {
    use ignore::WalkBuilder;
    let strip_root = strip_root.to_path_buf();
    let wsl = super::wsl::parse_wsl_unc(&strip_root.to_string_lossy()).is_some();
    WalkBuilder::new(walk_root)
        .require_git(false)
        .build()
        .filter_map(move |dent| {
            let dent = dent.ok()?;
            if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return None;
            }
            let fpath = dent.path();
            let rel = match fpath.strip_prefix(&strip_root) {
                Ok(rel) if wsl => rel.to_string_lossy().replace('\\', "/"),
                Ok(rel) => rel.to_string_lossy().into_owned(),
                Err(_) if wsl => super::wsl::parse_wsl_unc(&fpath.to_string_lossy())
                    .map(|(_, linux)| linux)
                    .unwrap_or_else(|| fpath.to_string_lossy().into_owned()),
                Err(_) => fpath.to_string_lossy().into_owned(),
            };
            Some((rel, fpath.to_path_buf()))
        })
}

/// Search file *contents* under `root` (optionally narrowed to `path`),
/// gitignore-aware, returning `file:line` locations — never whole bodies.
/// Capped at `max_matches` (default 50), each line clamped to ~200 chars.
///
/// Modes (mirroring the grep flags the model otherwise shells out for):
///   - `exclude`: skip files matching this glob (filename glob, or path glob
///     when it contains a slash — same rule as `glob`).
///   - `count`: return per-file match counts + grand total (`grep -c`).
///   - `files_only`: return just the files that contain a match (`grep -l`).
///   - `context`: include N lines around each match (`grep -C N`).
/// `count` takes precedence over `files_only`; both ignore `context`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn code_grep(
    root: String,
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    ignore_case: Option<bool>,
    max_matches: Option<usize>,
    exclude: Option<String>,
    count: Option<bool>,
    files_only: Option<bool>,
    context: Option<u32>,
    wsl_distro: Option<String>,
) -> Result<GrepResult, String> {
    use globset::Glob;
    use grep::regex::RegexMatcherBuilder;
    use grep::searcher::sinks::UTF8;
    use grep::searcher::SearcherBuilder;

    let cap = max_matches.unwrap_or(GREP_DEFAULT_MAX).max(1);
    let root = resolve_code_root(root, wsl_distro.as_deref())?;
    let search_root = match &path {
        // An absolute Linux path in a WSL session names an in-distro directory,
        // not one under the (already translated) root.
        Some(p) if wsl_distro.is_some() && p.starts_with('/') => {
            crate::fs_tools::absolute::require_absolute(p, wsl_distro.as_deref())?
        }
        Some(p) => Path::new(&root).join(p),
        None => PathBuf::from(&root),
    };
    if !search_root.exists() {
        // The path as asked for: in WSL, not the share it was mapped to.
        let shown = match (&path, &wsl_distro) {
            (Some(p), Some(_)) => p.clone(),
            _ => search_root.display().to_string(),
        };
        return Err(format!("Search path does not exist: {shown}"));
    }

    tokio::task::spawn_blocking(move || -> Result<GrepResult, String> {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(ignore_case.unwrap_or(false))
            .build(&pattern)
            .map_err(|e| format!("Invalid search pattern: {e}"))?;

        // Optional glob filters. A pattern without a slash (e.g. "*.rs") is
        // matched against the file name so it works regardless of directory
        // depth; a pattern containing a slash (e.g. "internal/**/*.go") is
        // matched against the path relative to `root`, mirroring `code_glob`.
        let compile = |g: &str, what: &str| {
            Glob::new(g)
                .map(|glob| glob.compile_matcher())
                .map_err(|e| format!("Invalid {what} glob: {e}"))
        };
        let glob_is_path = glob.as_deref().map(|g| g.contains('/')).unwrap_or(false);
        let name_glob = glob.as_deref().map(|g| compile(g, "")).transpose()?;
        let exclude_is_path = exclude.as_deref().map(|g| g.contains('/')).unwrap_or(false);
        let exclude_glob = exclude
            .as_deref()
            .map(|g| compile(g, "exclude"))
            .transpose()?;

        let count_mode = count.unwrap_or(false);
        let files_mode = !count_mode && files_only.unwrap_or(false);
        // count / files-only don't emit per-line bodies, so context is moot there.
        let ctx_lines = if count_mode || files_mode {
            0
        } else {
            context.unwrap_or(0) as usize
        };

        let root_path = PathBuf::from(&root);
        let mut matches: Vec<GrepMatch> = Vec::new();
        let mut matched_total: usize = 0;
        let mut counts: Vec<GrepFileCount> = Vec::new();
        let mut total: u32 = 0;
        let mut files: Vec<String> = Vec::new();
        let mut truncated = false;

        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            .before_context(ctx_lines)
            .after_context(ctx_lines)
            .build();

        // Match a compiled glob against the relative path (path globs) or the
        // bare file name (simple globs), the same split `glob` uses.
        let glob_hits = |m: &globset::GlobMatcher, is_path: bool, rel: &str, fpath: &Path| {
            if is_path {
                m.is_match(rel)
            } else {
                fpath.file_name().map(|n| m.is_match(n)).unwrap_or(false)
            }
        };

        for (rel, fpath) in walk_files(&search_root, &root_path) {
            if let Some(g) = &name_glob {
                if !glob_hits(g, glob_is_path, &rel, &fpath) {
                    continue;
                }
            }
            if let Some(g) = &exclude_glob {
                if glob_hits(g, exclude_is_path, &rel, &fpath) {
                    continue;
                }
            }

            if count_mode {
                let mut n: u32 = 0;
                let _ = searcher.search_path(
                    &matcher,
                    fpath,
                    UTF8(|_lnum, _line| {
                        Ok({
                            n += 1;
                            true
                        })
                    }),
                );
                if n > 0 {
                    counts.push(GrepFileCount {
                        path: rel.clone(),
                        count: n,
                    });
                    total += n;
                    if counts.len() >= cap {
                        truncated = true;
                        break;
                    }
                }
            } else if files_mode {
                let mut found = false;
                // Stop at the first hit — we only need the file name.
                let _ = searcher.search_path(
                    &matcher,
                    fpath,
                    UTF8(|_lnum, _line| {
                        Ok({
                            found = true;
                            false
                        })
                    }),
                );
                if found {
                    files.push(rel.clone());
                    if files.len() >= cap {
                        truncated = true;
                        break;
                    }
                }
            } else if ctx_lines > 0 {
                let _ = searcher.search_path(
                    &matcher,
                    fpath,
                    ContextSink {
                        path: &rel,
                        out: &mut matches,
                        matched: &mut matched_total,
                        cap,
                    },
                );
                if matched_total >= cap {
                    truncated = true;
                    break;
                }
            } else {
                let _ = searcher.search_path(
                    &matcher,
                    fpath,
                    UTF8(|lnum, line| {
                        matches.push(GrepMatch {
                            path: rel.clone(),
                            line: lnum as u32,
                            text: clamp_line(line),
                            is_match: true,
                        });
                        matched_total += 1;
                        // Stop this file once we hit the cap.
                        Ok(matched_total < cap)
                    }),
                );
                if matched_total >= cap {
                    truncated = true;
                    break;
                }
            }
        }

        Ok(GrepResult {
            matches,
            truncated,
            counts,
            total,
            files,
        })
    })
    .await
    .map_err(|e| format!("grep task failed: {e}"))?
}

// ---------------------------------------------------------------------------
// code_glob
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GlobResult {
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// Find files by path glob under `root` (gitignore-aware). Returns paths only,
/// sorted deterministically, capped at `max_results` (default 100).
#[tauri::command]
pub async fn code_glob(
    root: String,
    pattern: String,
    max_results: Option<usize>,
    wsl_distro: Option<String>,
) -> Result<GlobResult, String> {
    use globset::Glob;

    let cap = max_results.unwrap_or(GLOB_DEFAULT_MAX).max(1);
    let root = resolve_code_root(root, wsl_distro.as_deref())?;

    tokio::task::spawn_blocking(move || -> Result<GlobResult, String> {
        let matcher = Glob::new(&pattern)
            .map_err(|e| format!("Invalid glob: {e}"))?
            .compile_matcher();
        let root_path = PathBuf::from(&root);

        let mut paths: Vec<String> = Vec::new();
        for (rel, _fpath) in walk_files(&root_path, &root_path) {
            if matcher.is_match(&rel) {
                paths.push(rel);
            }
        }

        paths.sort();
        let truncated = paths.len() > cap;
        paths.truncate(cap);
        Ok(GlobResult { paths, truncated })
    })
    .await
    .map_err(|e| format!("glob task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_code_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {\n    needle();\n}\n").unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn needle() {}\n").unwrap();
        fs::write(dir.join("README.md"), "no match here\n").unwrap();
        fs::write(dir.join(".gitignore"), "ignored.rs\n").unwrap();
        fs::write(dir.join("ignored.rs"), "fn needle() {}\n").unwrap();
        dir
    }

    #[cfg(windows)]
    #[test]
    fn wsl_code_root_maps_onto_the_distro_share() {
        assert_eq!(
            resolve_code_root("/home/tim/proj".to_string(), Some("Ubuntu")).unwrap(),
            r"\\wsl.localhost\Ubuntu\home\tim\proj"
        );
        // Not a WSL session: the root is already a host path.
        assert_eq!(
            resolve_code_root(r"C:\proj".to_string(), None).unwrap(),
            r"C:\proj"
        );
    }

    #[tokio::test]
    async fn grep_finds_matches_and_honors_gitignore() {
        let dir = temp_repo("grep");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // main.rs + lib.rs match; ignored.rs is gitignored; README has no match.
        let paths: Vec<&str> = res.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.ends_with("main.rs")));
        assert!(paths.iter().any(|p| p.ends_with("lib.rs")));
        assert!(!paths.iter().any(|p| p.contains("ignored.rs")));
    }

    #[tokio::test]
    async fn grep_glob_filters_by_filename() {
        let dir = temp_repo("grep_glob");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            Some("*.md".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // README.md has no "needle"; *.rs files are excluded by the glob.
        assert!(res.matches.is_empty());
    }

    #[tokio::test]
    async fn grep_path_glob_matches_relative_path() {
        let dir = temp_repo("grep_path_glob");
        // A glob containing a slash is matched against the path relative to
        // root, so "src/**/*.rs" reaches the nested .rs files.
        let hit = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            Some("src/**/*.rs".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let paths: Vec<&str> = hit.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(
            paths.iter().any(|p| p.ends_with("main.rs")),
            "got: {paths:?}"
        );
        assert!(
            paths.iter().any(|p| p.ends_with("lib.rs")),
            "got: {paths:?}"
        );

        // A path glob that doesn't match the directory yields nothing, even
        // though the bare filename glob "*.rs" would have matched.
        let miss = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            Some("other/**/*.rs".to_string()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(miss.matches.is_empty(), "got: {:?}", miss.matches);
    }

    #[tokio::test]
    async fn grep_caps_and_marks_truncated() {
        let dir = temp_repo("grep_cap");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            None,
            None,
            Some(1),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.matches.len(), 1);
        assert!(res.truncated);
    }

    #[tokio::test]
    async fn grep_exclude_skips_matching_files() {
        let dir = temp_repo("grep_exclude");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            None,
            None,
            None,
            Some("main.rs".to_string()),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let paths: Vec<&str> = res.matches.iter().map(|m| m.path.as_str()).collect();
        assert!(
            paths.iter().any(|p| p.ends_with("lib.rs")),
            "got: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.ends_with("main.rs")),
            "excluded file still present: {paths:?}"
        );
    }

    #[tokio::test]
    async fn grep_count_mode_returns_per_file_totals() {
        let dir = temp_repo("grep_count");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            None,
            None,
            None,
            None,
            Some(true),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        // needle: once in main.rs, once in lib.rs (ignored.rs is gitignored).
        assert!(res.matches.is_empty());
        assert_eq!(res.total, 2);
        assert_eq!(res.counts.len(), 2);
        assert!(res.counts.iter().all(|c| c.count == 1));
    }

    #[tokio::test]
    async fn grep_files_only_lists_files_without_bodies() {
        let dir = temp_repo("grep_files_only");
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(true),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(res.matches.is_empty());
        let mut files = res.files.clone();
        files.sort();
        assert_eq!(files.len(), 2, "got: {files:?}");
        assert!(files.iter().any(|p| p.ends_with("main.rs")));
        assert!(files.iter().any(|p| p.ends_with("lib.rs")));
    }

    #[tokio::test]
    async fn grep_context_includes_surrounding_lines() {
        let dir = temp_repo("grep_context");
        // Limit to main.rs (`fn main() {\n    needle();\n}`) for a deterministic
        // block: the match is line 2, with lines 1 and 3 as context.
        let res = code_grep(
            dir.to_string_lossy().into_owned(),
            "needle".to_string(),
            None,
            Some("main.rs".to_string()),
            None,
            None,
            None,
            None,
            None,
            Some(1),
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.matches.iter().filter(|m| m.is_match).count(), 1);
        let matched = res.matches.iter().find(|m| m.is_match).unwrap();
        assert_eq!(matched.line, 2);
        assert!(res
            .matches
            .iter()
            .any(|m| !m.is_match && m.line == 1 && m.text.contains("fn main")));
        assert!(res.matches.iter().any(|m| !m.is_match && m.line == 3));
    }

    #[tokio::test]
    async fn glob_finds_files_sorted_and_gitignore_aware() {
        let dir = temp_repo("glob");
        let res = code_glob(
            dir.to_string_lossy().into_owned(),
            "**/*.rs".to_string(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(res.paths.iter().any(|p| p.ends_with("main.rs")));
        assert!(res.paths.iter().any(|p| p.ends_with("lib.rs")));
        // gitignored ignored.rs excluded.
        assert!(!res.paths.iter().any(|p| p.contains("ignored.rs")));
        // Deterministic order.
        let mut sorted = res.paths.clone();
        sorted.sort();
        assert_eq!(res.paths, sorted);
    }

    #[tokio::test]
    async fn glob_caps_results() {
        let dir = temp_repo("glob_cap");
        let res = code_glob(
            dir.to_string_lossy().into_owned(),
            "**/*".to_string(),
            Some(1),
            None,
        )
        .await
        .unwrap();
        assert_eq!(res.paths.len(), 1);
        assert!(res.truncated);
    }
}
