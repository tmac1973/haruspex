//! Which repo a folder holds, by its `origin` remote, so trust given to one
//! repo doesn't pass to another cloned into the same path later.
//!
//! Read straight from git's config file rather than by running `git`: this is
//! asked on every Shell turn, and the answer is one line of a small file.

use std::fs;
use std::path::{Path, PathBuf};

/// The `origin` URL of the repo at `root`, or None when it has none (or the
/// config can't be read).
pub fn origin_url(root: &Path) -> Option<String> {
    let config = fs::read_to_string(common_dir(root)?.join("config")).ok()?;
    origin_in(&config)
}

/// The folder holding the repo's shared config. `.git` is that folder in a
/// plain checkout; in a worktree or submodule it is a file pointing at the
/// worktree's own git dir, whose `commondir` points back at the shared one.
fn common_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let pointer = fs::read_to_string(&dot_git).ok()?;
    let git_dir = root.join(pointer.trim().strip_prefix("gitdir:")?.trim());
    match fs::read_to_string(git_dir.join("commondir")) {
        Ok(common) => Some(git_dir.join(common.trim())),
        Err(_) => Some(git_dir),
    }
}

/// `url` under `[remote "origin"]`. Section and key names are
/// case-insensitive in git; the subsection name is not.
fn origin_in(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[') {
            let header = header.trim_end_matches(']').trim();
            in_origin = match header.split_once(char::is_whitespace) {
                Some((section, sub)) => {
                    section.eq_ignore_ascii_case("remote") && sub.trim() == "\"origin\""
                }
                None => false,
            };
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("url") {
                let url = value.trim().trim_matches('"');
                return (!url.is_empty()).then(|| url.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("haruspex_skills_origin_test_{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_the_origin_url_and_nothing_else() {
        let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = up\n\
                      [Remote \"origin\"]\n\tfetch = +refs/heads/*\n\tURL = git@github.com:a/b.git\n";
        assert_eq!(origin_in(config).as_deref(), Some("git@github.com:a/b.git"));
        assert_eq!(origin_in("[remote \"upstream\"]\n\turl = up\n"), None);
        assert_eq!(origin_in(""), None);
    }

    #[test]
    fn finds_the_config_in_a_checkout_and_in_a_worktree() {
        let base = temp_dir("dirs");
        let main = base.join("main");
        fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        fs::write(
            main.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://example.com/r.git\n",
        )
        .unwrap();
        assert_eq!(
            origin_url(&main).as_deref(),
            Some("https://example.com/r.git")
        );

        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        assert_eq!(
            origin_url(&wt).as_deref(),
            Some("https://example.com/r.git")
        );

        assert_eq!(origin_url(&base.join("nowhere")), None);
    }
}
