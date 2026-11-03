//! Keyword-ranked code chunks for a plain-words query
//! (`code_search_candidates`), the candidate stage of the `search_code`
//! helper. Files are walked the way `code_grep` walks them, cut into 30-line
//! half-overlapping windows and scored by IDF-weighted term matches. A
//! reranker (or the agent) takes it from there.

use super::search::{resolve_code_root, walk_files};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const CHUNK_LINES: usize = 30;
const CHUNK_STEP: usize = 15;
const MAX_TERMS: usize = 12;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 200;
/// Score multiplier for test and generated files: kept, but below the source.
const TEST_FILE_FACTOR: f64 = 0.5;

const STOPWORDS: &[&str] = &[
    "the", "and", "for", "from", "with", "are", "its", "this", "that", "which", "where", "what",
    "when", "how", "does", "want", "into", "all", "their", "them", "they", "who", "user", "users",
    "app", "code", "file", "files", "there", "make", "sure", "still", "before", "after", "while",
];

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "Cargo.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "poetry.lock",
    "uv.lock",
];

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SearchChunk {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
    pub score: f32,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SearchCandidates {
    /// The words the query was scored by, after splitting and stemming.
    pub terms: Vec<String>,
    pub chunks: Vec<SearchChunk>,
    pub files_scanned: u32,
}

/// One window of a file's lines, 1-indexed and inclusive.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Chunk {
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
    pub text: String,
}

/// A text file `candidate_files` kept.
#[derive(Clone, Debug)]
pub(crate) struct CandidateFile {
    /// Relative to the root, `/`-separated.
    pub path: String,
    pub abs: PathBuf,
}

/// Split an identifier on snake_case and camelCase boundaries
/// (`parseHTMLBody` → `parse`, `HTML`, `Body`).
fn identifier_parts(ident: &str) -> Vec<String> {
    let mut parts = Vec::new();
    for piece in ident.split('_').filter(|p| !p.is_empty()) {
        let chars: Vec<char> = piece.chars().collect();
        let mut current = String::new();
        for (i, &c) in chars.iter().enumerate() {
            if i > 0 && c.is_uppercase() {
                let prev = chars[i - 1];
                let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
                if !prev.is_uppercase() || next_lower {
                    parts.push(std::mem::take(&mut current));
                }
            }
            current.push(c);
        }
        parts.push(current);
    }
    parts
}

/// Strip one common suffix from a long word, so `resizing` and `resize`
/// meet as a substring.
fn stem(word: &str) -> String {
    if word.chars().count() > 5 {
        for suffix in ["ing", "ed", "es", "s"] {
            if let Some(stripped) = word.strip_suffix(suffix) {
                return stripped.to_string();
            }
        }
    }
    word.to_string()
}

/// The words a query is scored by: each identifier whole and split on
/// camelCase / snake_case, lowercased, without short words and stopwords,
/// lightly stemmed, deduplicated in order and capped at `MAX_TERMS`.
pub(crate) fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let idents = query
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|s| !s.is_empty());
    for ident in idents {
        let parts = identifier_parts(ident);
        let words =
            std::iter::once(ident.to_string()).chain(parts.into_iter().filter(|p| p != ident));
        for word in words {
            let word = word.to_lowercase();
            if word.chars().count() < 3 || STOPWORDS.contains(&word.as_str()) {
                continue;
            }
            let word = stem(&word);
            if !terms.contains(&word) {
                terms.push(word);
            }
            if terms.len() == MAX_TERMS {
                return terms;
            }
        }
    }
    terms
}

/// True when the first `BINARY_SNIFF_BYTES` of the file hold a NUL byte, or
/// it can't be read.
fn looks_binary(abs: &Path) -> bool {
    let Ok(file) = std::fs::File::open(abs) else {
        return true;
    };
    let mut head = Vec::with_capacity(BINARY_SNIFF_BYTES);
    if file
        .take(BINARY_SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return true;
    }
    head.contains(&0)
}

/// The text files under `root` (or `path` under it) that search reads:
/// gitignore-aware and WSL-aware like `code_grep`, without files over 1 MB,
/// binaries and lockfiles. Blocking; run it off the async runtime.
pub(crate) fn candidate_files(
    root: String,
    path: Option<&str>,
    wsl_distro: Option<&str>,
) -> Result<Vec<CandidateFile>, String> {
    let root = resolve_code_root(root, wsl_distro)?;
    let walk_root = match path {
        // An absolute Linux path in a WSL session names an in-distro
        // directory, not one under the (already translated) root.
        Some(p) if wsl_distro.is_some() && p.starts_with('/') => {
            crate::fs_tools::absolute::require_absolute(p, wsl_distro)?
        }
        Some(p) => Path::new(&root).join(p),
        None => PathBuf::from(&root),
    };
    if !walk_root.exists() {
        let shown = match (path, wsl_distro) {
            (Some(p), Some(_)) => p.to_string(),
            _ => walk_root.display().to_string(),
        };
        return Err(format!("Search path does not exist: {shown}"));
    }

    let mut files = Vec::new();
    for (rel, abs) in walk_files(&walk_root, Path::new(&root)) {
        let name = abs.file_name().map(|n| n.to_string_lossy());
        if name.is_some_and(|n| LOCKFILES.contains(&n.as_ref())) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&abs) else {
            continue;
        };
        if meta.len() > MAX_FILE_BYTES || looks_binary(&abs) {
            continue;
        }
        files.push(CandidateFile {
            path: rel.replace('\\', "/"),
            abs,
        });
    }
    Ok(files)
}

/// Cut a file into `CHUNK_LINES`-line windows starting every `CHUNK_STEP`
/// lines. A file of up to `CHUNK_LINES` lines is one chunk; an empty one is
/// none.
pub(crate) fn chunk_file(path: &str, text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let starts: Vec<usize> = if lines.len() <= CHUNK_LINES {
        vec![0]
    } else {
        (0..lines.len()).step_by(CHUNK_STEP).collect()
    };
    starts
        .into_iter()
        .map(|start| {
            let end = (start + CHUNK_LINES).min(lines.len());
            Chunk {
                path: path.to_string(),
                start_line: start as u32 + 1,
                end_line: end as u32,
                text: lines[start..end].join("\n"),
            }
        })
        .collect()
}

/// Test and generated files: matched, but scored at `TEST_FILE_FACTOR`.
fn is_test_or_generated(path: &str) -> bool {
    let slashed = format!("/{}", path.to_lowercase());
    let name = slashed.rsplit('/').next().unwrap_or("");
    [".test.", ".spec.", "_test."]
        .iter()
        .any(|m| name.contains(m))
        || name.ends_with(".min.js")
        || ["/tests/", "/__tests__/", "/gen/", "/generated/"]
            .iter()
            .any(|d| slashed.contains(d))
}

/// A chunk that matched at least one term, before IDF weighting.
struct Matched {
    chunk: Chunk,
    /// Indexes into the term list.
    terms: Vec<usize>,
    hits: usize,
}

fn match_chunk(chunk: Chunk, terms: &[String]) -> Option<Matched> {
    let text = chunk.text.to_lowercase();
    let path = chunk.path.to_lowercase();
    let mut matched = Vec::new();
    let mut hits = 0;
    for (i, term) in terms.iter().enumerate() {
        let in_text = text.matches(term.as_str()).count();
        let in_path = path.matches(term.as_str()).count();
        if in_text + in_path > 0 {
            matched.push(i);
            hits += in_text + 2 * in_path;
        }
    }
    (!matched.is_empty()).then_some(Matched {
        chunk,
        terms: matched,
        hits,
    })
}

/// Score every matched chunk: `Σ ln(1 + N / df(t))` over its terms, plus
/// `0.3 · ln(1 + hits)`, halved for test and generated files. `N` and `df`
/// count matched chunks only, so the whole set is scored at once.
fn score_chunks(matched: Vec<Matched>, term_count: usize) -> Vec<SearchChunk> {
    let n = matched.len() as f64;
    let mut df = vec![0usize; term_count];
    for m in &matched {
        for &t in &m.terms {
            df[t] += 1;
        }
    }
    matched
        .into_iter()
        .map(|m| {
            let idf: f64 = m.terms.iter().map(|&t| (1.0 + n / df[t] as f64).ln()).sum();
            let mut score = idf + 0.3 * (1.0 + m.hits as f64).ln();
            if is_test_or_generated(&m.chunk.path) {
                score *= TEST_FILE_FACTOR;
            }
            SearchChunk {
                path: m.chunk.path,
                start_line: m.chunk.start_line,
                end_line: m.chunk.end_line,
                text: m.chunk.text,
                score: score as f32,
            }
        })
        .collect()
}

/// Best first, dropping a chunk whose start is under `CHUNK_LINES` lines from
/// one already kept in the same file, up to `limit`.
fn pick(mut scored: Vec<SearchChunk>, limit: usize) -> Vec<SearchChunk> {
    scored.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.start_line.cmp(&b.start_line))
    });
    let mut kept_starts: HashMap<String, Vec<u32>> = HashMap::new();
    let mut picked = Vec::new();
    for chunk in scored {
        if picked.len() == limit {
            break;
        }
        let starts = kept_starts.entry(chunk.path.clone()).or_default();
        if starts
            .iter()
            .any(|&s| s.abs_diff(chunk.start_line) < CHUNK_LINES as u32)
        {
            continue;
        }
        starts.push(chunk.start_line);
        picked.push(chunk);
    }
    picked
}

fn rank(
    root: String,
    query: &str,
    path: Option<&str>,
    limit: usize,
    wsl_distro: Option<&str>,
) -> Result<SearchCandidates, String> {
    let terms = query_terms(query);
    if terms.is_empty() {
        return Ok(SearchCandidates {
            terms,
            chunks: Vec::new(),
            files_scanned: 0,
        });
    }
    let files = candidate_files(root, path, wsl_distro)?;
    let mut matched = Vec::new();
    let mut files_scanned = 0u32;
    for file in &files {
        let Ok(bytes) = std::fs::read(&file.abs) else {
            continue;
        };
        files_scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        matched.extend(
            chunk_file(&file.path, &text)
                .into_iter()
                .filter_map(|c| match_chunk(c, &terms)),
        );
    }
    let chunks = pick(score_chunks(matched, terms.len()), limit);
    Ok(SearchCandidates {
        terms,
        chunks,
        files_scanned,
    })
}

/// Rank chunks of the files under `root` (optionally narrowed to `path`) by
/// how well they match a plain-words `query`. Returns up to `limit` (default
/// 100, max 200) non-overlapping chunks, best first, with paths relative to
/// the root.
#[tauri::command]
pub async fn code_search_candidates(
    root: String,
    query: String,
    path: Option<String>,
    limit: Option<usize>,
    wsl_distro: Option<String>,
) -> Result<SearchCandidates, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    tokio::task::spawn_blocking(move || {
        rank(root, &query, path.as_deref(), limit, wsl_distro.as_deref())
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{temp_dir, TestDir};
    use std::fs;

    fn root_of(dir: &TestDir) -> String {
        dir.to_string_lossy().into_owned()
    }

    fn search(dir: &TestDir, query: &str) -> SearchCandidates {
        rank(root_of(dir), query, None, DEFAULT_LIMIT, None).unwrap()
    }

    fn paths(result: &SearchCandidates) -> Vec<&str> {
        result.chunks.iter().map(|c| c.path.as_str()).collect()
    }

    /// `n` numbered filler lines that match no test query.
    fn filler(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn query_terms_split_identifiers_and_drop_noise() {
        assert_eq!(
            query_terms("autosizeTextarea"),
            ["autosizetextarea", "autosize", "textarea"]
        );
        assert_eq!(
            query_terms("run_turn_loop"),
            ["run_turn_loop", "run", "turn", "loop"]
        );
        assert_eq!(
            query_terms("parseHTMLBody"),
            ["parsehtmlbody", "parse", "html", "body"]
        );
        // Stopwords, short words and duplicates go; long words lose a suffix.
        assert_eq!(
            query_terms("where does the message box grow as I type? Box!"),
            ["message", "box", "grow", "type"]
        );
        assert_eq!(query_terms("resizing caches"), ["resiz", "cach"]);
        let many = (0..20)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(query_terms(&many).len(), MAX_TERMS);
    }

    #[test]
    fn chunks_are_half_overlapping_windows() {
        let chunks = chunk_file("a.rs", &filler(70));
        let starts: Vec<u32> = chunks.iter().map(|c| c.start_line).collect();
        assert_eq!(starts, [1, 16, 31, 46, 61]);
        assert_eq!(chunks[0].end_line, 30);
        assert_eq!(chunks[4].end_line, 70);
        assert!(chunks[1].text.starts_with("line 16\n"));
        assert!(chunks[1].text.ends_with("line 45"));

        let short = chunk_file("b.rs", &filler(20));
        assert_eq!(short.len(), 1);
        assert_eq!((short[0].start_line, short[0].end_line), (1, 20));
        assert!(chunk_file("c.rs", "").is_empty());
    }

    #[test]
    fn rare_terms_outrank_one_common_term_repeated() {
        let dir = temp_dir("rank_idf");
        fs::write(dir.join("rare.ts"), "const widget = gadget;\n").unwrap();
        fs::write(
            dir.join("common.ts"),
            "widget widget widget widget widget\n",
        )
        .unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("other{i}.ts")), "a widget here\n").unwrap();
        }
        let result = search(&dir, "widget gadget");
        assert_eq!(result.chunks[0].path, "rare.ts");
        assert_eq!(result.files_scanned, 7);
    }

    #[test]
    fn a_path_hit_counts() {
        let dir = temp_dir("rank_path");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/autosize.ts"), "export function grow() {}\n").unwrap();
        fs::write(dir.join("src/other.ts"), "export function shrink() {}\n").unwrap();
        assert_eq!(paths(&search(&dir, "autosize")), ["src/autosize.ts"]);
    }

    #[test]
    fn a_test_file_ranks_below_its_source() {
        let dir = temp_dir("rank_tests");
        fs::create_dir_all(dir.join("src/tests")).unwrap();
        let body = "function autosize(textarea) {}\n";
        fs::write(dir.join("src/grow.ts"), body).unwrap();
        fs::write(dir.join("src/grow.test.ts"), body).unwrap();
        fs::write(dir.join("src/tests/grow.ts"), body).unwrap();
        let result = search(&dir, "autosize textarea");
        assert_eq!(result.chunks[0].path, "src/grow.ts");
        assert!(result.chunks[1].score < result.chunks[0].score);
        assert_eq!(result.chunks.len(), 3);
    }

    #[test]
    fn ignored_binary_oversize_and_lock_files_are_skipped() {
        let dir = temp_dir("rank_skip");
        fs::write(dir.join(".gitignore"), "ignored.rs\n").unwrap();
        fs::write(dir.join("kept.rs"), "needle\n").unwrap();
        fs::write(dir.join("ignored.rs"), "needle\n").unwrap();
        fs::write(dir.join("binary.dat"), b"needle\0\x01\x02").unwrap();
        let big = "needle\n".repeat((MAX_FILE_BYTES as usize / 7) + 1);
        fs::write(dir.join("big.txt"), big).unwrap();
        fs::write(dir.join("Cargo.lock"), "needle\n").unwrap();
        fs::write(dir.join("package-lock.json"), "\"needle\"\n").unwrap();

        // `.gitignore` itself is hidden, so the walk skips it too.
        let files: Vec<String> = candidate_files(root_of(&dir), None, None)
            .unwrap()
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(files, ["kept.rs"]);
        assert_eq!(paths(&search(&dir, "needle")), ["kept.rs"]);
    }

    #[test]
    fn overlapping_windows_collapse_to_the_best() {
        let dir = temp_dir("rank_overlap");
        // The needle sits on line 20: windows 1–30 and 16–45 both hold it.
        // Line 100 holds another, far enough away to be kept too.
        let mut text = filler(120);
        text = text
            .replace("line 20\n", "needle\n")
            .replace("line 100\n", "needle\n");
        fs::write(dir.join("long.rs"), text).unwrap();
        let result = search(&dir, "needle");
        let starts: Vec<u32> = result.chunks.iter().map(|c| c.start_line).collect();
        assert_eq!(starts.len(), 2, "{starts:?}");
        for pair in [starts[0], starts[1]].windows(2) {
            assert!(pair[0].abs_diff(pair[1]) >= CHUNK_LINES as u32);
        }
    }

    #[test]
    fn path_limits_the_walk_and_limit_caps_the_count() {
        let dir = temp_dir("rank_scope");
        fs::create_dir_all(dir.join("a")).unwrap();
        fs::create_dir_all(dir.join("b")).unwrap();
        for i in 0..5 {
            fs::write(dir.join(format!("a/n{i}.rs")), "needle\n").unwrap();
            fs::write(dir.join(format!("b/n{i}.rs")), "needle\n").unwrap();
        }
        let scoped = rank(root_of(&dir), "needle", Some("a"), DEFAULT_LIMIT, None).unwrap();
        assert_eq!(scoped.chunks.len(), 5);
        assert_eq!(scoped.files_scanned, 5);
        assert!(scoped.chunks.iter().all(|c| c.path.starts_with("a/")));

        let capped = rank(root_of(&dir), "needle", None, 3, None).unwrap();
        assert_eq!(capped.chunks.len(), 3);

        assert!(rank(root_of(&dir), "needle", Some("missing"), 3, None).is_err());
    }

    #[test]
    fn a_query_of_only_stopwords_scans_nothing() {
        let dir = temp_dir("rank_empty");
        fs::write(dir.join("a.rs"), "the and for\n").unwrap();
        let result = search(&dir, "where is the code for it");
        assert!(result.terms.is_empty());
        assert!(result.chunks.is_empty());
    }

    /// The #951 spike's ten questions over this checkout: prints where the
    /// expected file first appears. Run with
    /// `cargo test spike_questions -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn spike_questions_find_the_right_file() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let root = repo.to_string_lossy().into_owned();
        let cases: &[(&str, &str)] = &[
            (
                "where does the proxy get skipped for local loopback addresses?",
                "src-tauri/src/proxy/bypass.rs",
            ),
            (
                "how are recalled memories ranked, and does their age count?",
                "src/lib/agent/memory/recall.ts",
            ),
            (
                "where is a large MCP tool result cut down before the model sees it?",
                "src/lib/agent/tools/mcp.ts",
            ),
            (
                "what limits how many matching lines the code grep tool returns?",
                "src-tauri/src/code_tools/search.rs",
            ),
            (
                "where does the 3D view pick which animation to play from a menu?",
                "src/lib/components/GlbViewer.svelte",
            ),
            (
                "change the wording on the Subtasks card in the Code settings",
                "src/lib/components/settings/CodeSection.svelte",
            ),
            (
                "how does npm find node when it runs an install script?",
                "src-tauri/src/runtimes.rs",
            ),
            (
                "where's the home card that shows GitHub notifications and pull requests?",
                "src/lib/components/home/cards/GitHubCard.svelte",
            ),
            (
                "which cards are greyed out in Add card, and why?",
                "src/lib/components/home/AddCardMenu.svelte",
            ),
            (
                "where does the message box grow taller as I type?",
                "src/lib/utils/autosize.ts",
            ),
        ];
        for (query, expected) in cases {
            let result = rank(root.clone(), query, None, DEFAULT_LIMIT, None).unwrap();
            let at = result
                .chunks
                .iter()
                .position(|c| c.path.ends_with(expected))
                .map(|i| i + 1);
            println!("{at:?}\t{expected}\t{query}");
            assert!(
                at.is_some(),
                "{expected} not in the top {DEFAULT_LIMIT} for {query:?}"
            );
        }
    }
}
