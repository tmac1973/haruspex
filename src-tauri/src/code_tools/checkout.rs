//! Which of the user's folders is a checkout of a GitHub repo, for Home's
//! GitHub card: Work on this opens a session (or plans a job) there. The
//! folders are the saved Code sessions' roots, newest first; the first whose
//! `origin` remote names the repo wins.

use crate::skills::origin::origin_url;
use std::path::Path;

/// `owner/name` from a GitHub remote URL, lowercased: `git@github.com:o/n.git`,
/// `https://github.com/o/n(.git)` or `ssh://git@github.com/o/n`. None for a
/// remote on another host.
fn github_repo(url: &str) -> Option<String> {
    let url = url.trim();
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))
        .or_else(|| url.strip_prefix("http://github.com/"))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("{owner}/{name}").to_lowercase())
}

/// The first of `roots` whose `origin` is the GitHub repo `repo` (`owner/name`,
/// any case).
fn find(repo: &str, roots: &[String]) -> Option<String> {
    let want = repo.trim().to_lowercase();
    roots
        .iter()
        .find(|root| {
            origin_url(Path::new(root))
                .and_then(|url| github_repo(&url))
                .is_some_and(|have| have == want)
        })
        .cloned()
}

#[tauri::command]
pub fn code_checkout_find(repo: String, roots: Vec<String>) -> Option<String> {
    find(&repo, &roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use std::fs;

    #[test]
    fn reads_github_remotes_in_every_form() {
        for url in [
            "git@github.com:Tmac/Haruspex.git",
            "https://github.com/tmac/haruspex",
            "https://github.com/tmac/haruspex.git",
            "ssh://git@github.com/tmac/haruspex",
            "https://github.com/tmac/haruspex/",
        ] {
            assert_eq!(github_repo(url).as_deref(), Some("tmac/haruspex"), "{url}");
        }
        assert_eq!(github_repo("https://gitlab.com/tmac/haruspex.git"), None);
        assert_eq!(github_repo("https://github.com/tmac"), None);
        assert_eq!(
            github_repo("https://github.com/tmac/haruspex/tree/main"),
            None
        );
    }

    fn checkout(base: &Path, dir: &str, url: &str) -> String {
        let root = base.join(dir);
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join(".git/config"),
            format!("[remote \"origin\"]\n\turl = {url}\n"),
        )
        .unwrap();
        root.display().to_string()
    }

    #[test]
    fn finds_the_first_checkout_of_the_repo() {
        let base = temp_dir("checkout");
        let other = checkout(&base, "other", "git@github.com:tmac/other.git");
        let first = checkout(&base, "first", "git@github.com:TMac/Haruspex.git");
        let second = checkout(&base, "second", "https://github.com/tmac/haruspex");
        let gone = base.join("gone").display().to_string();
        let roots = vec![gone, other, first.clone(), second];
        assert_eq!(find("tmac/haruspex", &roots), Some(first));
        assert_eq!(find("tmac/missing", &roots), None);
    }

    #[test]
    fn finds_a_worktree_by_its_shared_origin() {
        let base = temp_dir("checkout-wt");
        let main = base.join("main");
        fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        fs::write(
            main.join(".git/config"),
            "[remote \"origin\"]\n\turl = git@github.com:tmac/haruspex.git\n",
        )
        .unwrap();
        fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        let root = wt.display().to_string();
        assert_eq!(
            find("tmac/haruspex", std::slice::from_ref(&root)),
            Some(root)
        );
    }
}
