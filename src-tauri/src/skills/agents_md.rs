//! A repo's own instructions for agents: `AGENTS.md` (or, in a folder without
//! one, `CLAUDE.md`), read into every Code mode turn in that repo.
//!
//! The root file applies to the whole repo. A folder below it can have its own,
//! which the AGENTS.md convention says wins for that subtree, so the one
//! nearest the shell's cwd is read too and goes last, where it reads as the
//! refinement it is.
//!
//! Every byte is paid on every turn, on models whose context may be small, so
//! the total is capped and the turn is told when it was cut.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// The most a turn carries from these files.
pub const MAX_BYTES: usize = 8 * 1024;

/// What a Code mode turn takes from the repo.
#[derive(Clone, Debug, Serialize, PartialEq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentsMd {
    /// The files read, relative to the repo root, root first.
    pub files: Vec<String>,
    /// Their contents, each under a "From <file>:" line, capped at `MAX_BYTES`.
    pub text: String,
    /// The text was cut to fit the cap.
    pub truncated: bool,
    /// Size of everything read before the cap, in bytes.
    pub total_bytes: u32,
}

/// Where `/init` writes, and what is there now.
#[derive(Clone, Debug, Serialize, PartialEq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentsMdDraft {
    pub path: String,
    /// The file as it is now; None when there isn't one.
    pub current: Option<String>,
}

/// The root `AGENTS.md` of the repo `cwd` is in.
fn target(cwd: &Path) -> Result<PathBuf, String> {
    super::find_project_root(cwd)
        .map(|root| root.join("AGENTS.md"))
        .ok_or_else(|| "the shell is not in a git repo; AGENTS.md goes at a repo's root".into())
}

pub fn draft(cwd: &Path) -> Result<AgentsMdDraft, String> {
    let path = target(cwd)?;
    let current = match fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    Ok(AgentsMdDraft {
        path: path.to_string_lossy().into_owned(),
        current,
    })
}

/// Write `text` as the repo's `AGENTS.md`. Text over the cap is refused, since
/// a turn would only read part of it.
pub fn save(cwd: &Path, text: &str) -> Result<PathBuf, String> {
    if text.trim().is_empty() {
        return Err("AGENTS.md is empty".into());
    }
    if text.len() > MAX_BYTES {
        return Err(format!(
            "AGENTS.md is {} KB; turns read only the first {} KB, so shorten it",
            text.len().div_ceil(1024),
            MAX_BYTES / 1024
        ));
    }
    let path = target(cwd)?;
    let tmp = path.with_file_name(".AGENTS.md.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(path)
}

/// The instructions file in `dir`: `AGENTS.md`, else `CLAUDE.md`.
fn instructions_in(dir: &Path) -> Option<PathBuf> {
    ["AGENTS.md", "CLAUDE.md"]
        .iter()
        .map(|f| dir.join(f))
        .find(|p| p.is_file())
}

/// The instructions for a turn in `cwd`, inside the repo at `root`. None when
/// the repo has none.
pub fn read(root: &Path, cwd: &Path) -> Option<AgentsMd> {
    let mut paths: Vec<PathBuf> = instructions_in(root).into_iter().collect();
    // The nearest nested file between the cwd and the root, if the cwd is in
    // this repo at all.
    if cwd.starts_with(root) {
        let nested = cwd
            .ancestors()
            .take_while(|dir| *dir != root)
            .find_map(instructions_in);
        paths.extend(nested);
    }

    let mut sections = Vec::new();
    let mut files = Vec::new();
    for path in &paths {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        sections.push(format!("From {rel}:\n{}", text.trim()));
        files.push(rel);
    }
    if files.is_empty() {
        return None;
    }

    let mut text = sections.join("\n\n");
    let total_bytes = text.len();
    let truncated = total_bytes > MAX_BYTES;
    if truncated {
        let mut cut = MAX_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Some(AgentsMd {
        files,
        text,
        truncated,
        total_bytes: total_bytes as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_agents_md_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn drafts_and_saves_the_root_file_from_a_subfolder() {
        let base = temp_dir("write");
        fs::create_dir_all(base.join(".git")).unwrap();
        fs::create_dir_all(base.join("src/deep")).unwrap();
        let cwd = base.join("src/deep");
        let d = draft(&cwd).unwrap();
        assert_eq!(d.path, base.join("AGENTS.md").to_string_lossy());
        assert_eq!(d.current, None);
        save(&cwd, "# Build\n").unwrap();
        assert_eq!(draft(&cwd).unwrap().current.as_deref(), Some("# Build\n"));
        assert!(!base.join(".AGENTS.md.tmp").exists());
    }

    #[test]
    fn refuses_to_write_outside_a_repo_or_past_the_cap() {
        let base = temp_dir("write_refused");
        assert!(draft(&base).unwrap_err().contains("not in a git repo"));
        fs::create_dir_all(base.join(".git")).unwrap();
        assert!(save(&base, " ").unwrap_err().contains("empty"));
        let long = "x".repeat(MAX_BYTES + 1);
        assert!(save(&base, &long).unwrap_err().contains("shorten it"));
        assert!(!base.join("AGENTS.md").exists());
    }

    #[test]
    fn reads_the_root_file() {
        let root = temp_dir("root");
        fs::write(root.join("AGENTS.md"), "Run make check.\n").unwrap();
        let got = read(&root, &root).unwrap();
        assert_eq!(got.files, vec!["AGENTS.md"]);
        assert_eq!(got.text, "From AGENTS.md:\nRun make check.");
        assert!(!got.truncated);
    }

    #[test]
    fn falls_back_to_claude_md_and_prefers_agents_md() {
        let root = temp_dir("fallback");
        fs::write(root.join("CLAUDE.md"), "claude").unwrap();
        assert_eq!(read(&root, &root).unwrap().files, vec!["CLAUDE.md"]);
        fs::write(root.join("AGENTS.md"), "agents").unwrap();
        assert_eq!(read(&root, &root).unwrap().files, vec!["AGENTS.md"]);
    }

    #[test]
    fn appends_the_nearest_nested_file() {
        let root = temp_dir("nested");
        fs::write(root.join("AGENTS.md"), "root rules").unwrap();
        fs::create_dir_all(root.join("app/src/deep")).unwrap();
        fs::write(root.join("app/AGENTS.md"), "app rules").unwrap();
        fs::write(root.join("app/src/AGENTS.md"), "src rules").unwrap();
        let got = read(&root, &root.join("app/src/deep")).unwrap();
        assert_eq!(got.files, vec!["AGENTS.md", "app/src/AGENTS.md"]);
        assert!(got.text.ends_with("From app/src/AGENTS.md:\nsrc rules"));
    }

    #[test]
    fn a_nested_file_alone_is_enough() {
        let root = temp_dir("nested_only");
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app/AGENTS.md"), "app rules").unwrap();
        assert_eq!(
            read(&root, &root.join("app")).unwrap().files,
            vec!["app/AGENTS.md"]
        );
        assert!(read(&root, &root).is_none());
    }

    #[test]
    fn nothing_when_there_is_no_file_or_the_cwd_is_elsewhere() {
        let root = temp_dir("none");
        assert!(read(&root, &root).is_none());
        let other = temp_dir("none_other");
        fs::write(other.join("AGENTS.md"), "not this repo").unwrap();
        assert!(read(&root, &other).is_none());
    }

    #[test]
    fn caps_the_text_and_says_so() {
        let root = temp_dir("cap");
        let big = "é".repeat(MAX_BYTES); // two bytes each: the cut must land on a boundary
        fs::write(root.join("AGENTS.md"), &big).unwrap();
        let got = read(&root, &root).unwrap();
        assert!(got.truncated);
        assert!(got.text.len() <= MAX_BYTES);
        assert!(got.total_bytes as usize > MAX_BYTES);
    }
}
