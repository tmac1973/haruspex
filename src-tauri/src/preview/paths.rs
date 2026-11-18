//! Which file a preview request names, inside the session folder.
//!
//! The page is model-written and the URL is anyone's who can reach the port,
//! so the checks here are the whole boundary: nothing above the folder, no
//! symlink out of it, and no dotfile (`.git`, `.env`) at any depth.

use crate::fs_tools::path::strip_verbatim;
use crate::fs_tools::resolve_in_workdir;
use std::path::{Path, PathBuf};

/// Why a path was turned away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Above the folder, absolute, a drive, or a symlink out.
    Outside,
    /// A file or folder whose name starts with a dot.
    Hidden,
    /// Inside, but nothing there.
    NotFound,
}

impl Refusal {
    /// The message `preview_serve` hands back, which the agent reads.
    pub fn message(self, path: &str) -> String {
        match self {
            Refusal::Outside => format!("Not inside the session folder: {path}"),
            Refusal::Hidden => format!("Hidden files can't be previewed: {path}"),
            Refusal::NotFound => format!("Not found: {path}"),
        }
    }
}

/// `rel`'s segments, `/`-separated, once each is checked. `rel` is already
/// percent-decoded. Empty and `.` segments are dropped.
pub fn segments(rel: &str) -> Result<Vec<&str>, Refusal> {
    if rel.contains(['\0', '\\']) {
        return Err(Refusal::Outside);
    }
    let mut out = Vec::new();
    for seg in rel.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err(Refusal::Outside),
            // A drive (`C:`) or an NTFS stream (`page.html:x`).
            s if s.contains(':') => return Err(Refusal::Outside),
            s if s.starts_with('.') => return Err(Refusal::Hidden),
            s => out.push(s),
        }
    }
    Ok(out)
}

/// The file `rel` names inside `root`: a folder means its `index.html`.
/// Returned without the `\\?\` prefix, so it compares with the root's form.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, Refusal> {
    let joined = segments(rel)?.join("/");
    let found = inside(root, &joined)?;
    let file = if found.is_dir() {
        let index = if joined.is_empty() {
            "index.html".to_string()
        } else {
            format!("{joined}/index.html")
        };
        inside(root, &index)?
    } else {
        found
    };
    if file.is_file() {
        Ok(file)
    } else {
        Err(Refusal::NotFound)
    }
}

/// `rel` under `root`, canonical, refused when it ends up outside (a symlink).
fn inside(root: &Path, rel: &str) -> Result<PathBuf, Refusal> {
    let path = resolve_in_workdir(root, rel).map_err(|_| Refusal::Outside)?;
    if !path.exists() {
        return Err(Refusal::NotFound);
    }
    Ok(strip_verbatim(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn site() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("mockup/css")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("index.html"), "root").unwrap();
        fs::write(root.join("mockup/index.html"), "page").unwrap();
        fs::write(root.join("mockup/css/style.css"), "body{}").unwrap();
        fs::write(root.join(".git/config"), "secret").unwrap();
        fs::write(root.join(".env"), "KEY=1").unwrap();
        dir
    }

    fn root(dir: &tempfile::TempDir) -> PathBuf {
        strip_verbatim(&dir.path().canonicalize().unwrap())
    }

    #[test]
    fn files_and_folders_inside_resolve() {
        let dir = site();
        let r = root(&dir);
        assert_eq!(
            resolve(&r, "mockup/css/style.css").unwrap(),
            r.join("mockup/css/style.css")
        );
        assert_eq!(resolve(&r, "mockup").unwrap(), r.join("mockup/index.html"));
        assert_eq!(resolve(&r, "mockup/").unwrap(), r.join("mockup/index.html"));
        assert_eq!(resolve(&r, "").unwrap(), r.join("index.html"));
        assert_eq!(
            resolve(&r, "./mockup//index.html").unwrap(),
            r.join("mockup/index.html")
        );
    }

    #[test]
    fn nothing_outside_the_folder() {
        let dir = site();
        let r = root(&dir);
        for bad in [
            "..",
            "../x",
            "a/../../x",
            "mockup/../../x",
            "C:/x",
            "c:",
            "\\..\\x",
            "a\0b",
        ] {
            assert_eq!(resolve(&r, bad), Err(Refusal::Outside), "{bad}");
        }
        assert_eq!(
            resolve(&r, "mockup/index.html:stream"),
            Err(Refusal::Outside)
        );
    }

    #[test]
    fn an_absolute_path_is_read_as_inside() {
        // The URL path is always relative to the token: `/etc/passwd` after
        // decoding is the folder's own `etc/passwd`, which isn't there.
        let dir = site();
        let r = root(&dir);
        assert_eq!(resolve(&r, "/etc/passwd"), Err(Refusal::NotFound));
    }

    #[test]
    fn dotfiles_are_hidden() {
        let dir = site();
        let r = root(&dir);
        assert_eq!(resolve(&r, ".git/config"), Err(Refusal::Hidden));
        assert_eq!(resolve(&r, ".env"), Err(Refusal::Hidden));
        assert_eq!(resolve(&r, "mockup/.secret"), Err(Refusal::Hidden));
    }

    #[test]
    fn missing_is_not_found() {
        let dir = site();
        let r = root(&dir);
        assert_eq!(resolve(&r, "nope.html"), Err(Refusal::NotFound));
        assert_eq!(resolve(&r, "mockup/css"), Err(Refusal::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_is_refused() {
        let dir = site();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("link.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linkdir")).unwrap();
        let r = root(&dir);
        assert_eq!(resolve(&r, "link.txt"), Err(Refusal::Outside));
        assert_eq!(resolve(&r, "linkdir/secret.txt"), Err(Refusal::Outside));
    }
}
