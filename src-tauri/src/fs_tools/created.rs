//! Files the agent made, so it may delete or move them again (`fs_delete`,
//! `fs_move`).
//!
//! A scope is one conversation, Code session or job run (`chat:<id>`,
//! `code:<id>`, `job:<id>`). Each file a scope's writes created is recorded
//! by its canonical path with a sha256 of what was written; the agent's own
//! later writes and edits update the hash. A file is the agent's to remove
//! only while it still holds what the agent last wrote: once the user changes
//! it, it is theirs. Deleting moves the file to the system trash.
//!
//! Kept in `<app data>/created_files.json`, so a chat reopened tomorrow can
//! still tidy what it made today.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use super::path::{resolve_in_workdir, workdir_path, workdir_path_for_write};

/// Entries kept before the ones whose files are gone are dropped.
const PRUNE_ABOVE: usize = 5000;

type Store = HashMap<String, HashMap<String, String>>;

/// The record, loaded from disk on first use.
pub struct CreatedFiles {
    file: Option<PathBuf>,
    store: Mutex<Option<Store>>,
}

/// Where a file stands for a scope.
#[derive(Debug, PartialEq, Eq)]
pub enum Status {
    /// Nothing is there.
    Missing,
    /// The scope made it, and it still holds what the scope last wrote.
    Owned,
    /// The scope made it, but it was changed since.
    Changed,
    /// The scope didn't make it.
    Foreign,
}

impl Status {
    fn word(&self) -> &'static str {
        match self {
            Status::Missing => "missing",
            Status::Owned => "owned",
            Status::Changed => "changed",
            Status::Foreign => "foreign",
        }
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(crate::hash_util::hex(&hasher.finalize()))
}

/// The key a file is recorded under: its canonical path, so two spellings of
/// one file agree.
fn key_of(path: &Path) -> Result<String, String> {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

impl CreatedFiles {
    pub fn new(file: Option<PathBuf>) -> Self {
        Self {
            file,
            store: Mutex::new(None),
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Store) -> T) -> T {
        let mut guard = self.store.lock().unwrap_or_else(|p| p.into_inner());
        let store = guard.get_or_insert_with(|| {
            self.file
                .as_ref()
                .and_then(|f| std::fs::read_to_string(f).ok())
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        });
        f(store)
    }

    fn save(&self, store: &Store) {
        let Some(file) = &self.file else { return };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(store) {
            let tmp = file.with_extension("json.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, file);
            }
        }
    }

    /// Where `path` stands for `scope`.
    pub fn status(&self, scope: &str, path: &Path) -> Status {
        if !path.is_file() {
            return Status::Missing;
        }
        let Ok(key) = key_of(path) else {
            return Status::Missing;
        };
        let recorded = self.with(|s| s.get(scope).and_then(|m| m.get(&key)).cloned());
        match recorded {
            None => Status::Foreign,
            Some(hash) if hash_file(path).ok().as_deref() == Some(hash.as_str()) => Status::Owned,
            Some(_) => Status::Changed,
        }
    }

    /// Record `path` as `scope`'s, holding what is in it now.
    pub fn note(&self, scope: &str, path: &Path) -> Result<(), String> {
        let key = key_of(path)?;
        let hash = hash_file(path)?;
        self.with(|s| {
            s.entry(scope.to_string()).or_default().insert(key, hash);
            if s.values().map(HashMap::len).sum::<usize>() > PRUNE_ABOVE {
                for files in s.values_mut() {
                    files.retain(|k, _| Path::new(k).is_file());
                }
                s.retain(|_, files| !files.is_empty());
            }
            self.save(s);
        });
        Ok(())
    }

    fn forget(&self, scope: &str, key: &str) {
        self.with(|s| {
            if let Some(files) = s.get_mut(scope) {
                files.remove(key);
            }
            self.save(s);
        });
    }

    /// Move `path` to the trash, when it is `scope`'s; where it went.
    ///
    /// When the system trash refuses it (a network share with no trash
    /// folder, where making one needs a chmod the share won't do), the file
    /// goes to `fallback` instead, so a delete is still never for good.
    pub fn delete(
        &self,
        scope: &str,
        path: &Path,
        shown: &str,
        fallback: &Path,
        to_trash: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<Deleted, String> {
        refuse_unless_owned(self.status(scope, path), shown)?;
        let key = key_of(path)?;
        let went = match to_trash(path) {
            Ok(()) => Deleted::Trash,
            Err(why) => Deleted::Folder(set_aside(path, fallback).map_err(|e| {
                format!(
                    "{shown} could not be moved to the trash ({why}) or set aside ({e}), so it was left alone."
                )
            })?),
        };
        self.forget(scope, &key);
        Ok(went)
    }

    /// Move or rename `from` to `to`, when `from` is `scope`'s. `to` may only
    /// replace a file that is `scope`'s too.
    pub fn rename(
        &self,
        scope: &str,
        from: &Path,
        to: &Path,
        shown: (&str, &str),
    ) -> Result<(), String> {
        refuse_unless_owned(self.status(scope, from), shown.0)?;
        if to.is_dir() {
            return Err(format!(
                "{} is a folder. Give the new file's full path.",
                shown.1
            ));
        }
        match self.status(scope, to) {
            Status::Missing | Status::Owned => {}
            _ => {
                return Err(format!(
                    "{} already exists and isn't yours to replace. Pick another name.",
                    shown.1
                ))
            }
        }
        let old = key_of(from)?;
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not make the folder for {}: {e}", shown.1))?;
        }
        if std::fs::rename(from, to).is_err() {
            // Another file system: copy, then remove the original.
            std::fs::copy(from, to).map_err(|e| format!("could not move {}: {e}", shown.0))?;
            std::fs::remove_file(from).map_err(|e| {
                let _ = std::fs::remove_file(to);
                format!("could not move {}: {e}", shown.0)
            })?;
        }
        self.forget(scope, &old);
        self.note(scope, to)
    }
}

/// Where a deleted file went.
#[derive(Debug, PartialEq, Eq)]
pub enum Deleted {
    Trash,
    /// The system trash refused it; it was moved here.
    Folder(PathBuf),
}

/// Move `path` into `dir` under a name no other file there has.
fn set_aside(path: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let mut to = dir.join(format!("{stamp}-{name}"));
    let mut n = 2;
    while to.exists() {
        to = dir.join(format!("{stamp}-{n}-{name}"));
        n += 1;
    }
    if std::fs::rename(path, &to).is_err() {
        crate::video::copy_file(path, &to).map_err(|e| e.to_string())?;
        std::fs::remove_file(path).map_err(|e| {
            let _ = std::fs::remove_file(&to);
            e.to_string()
        })?;
    }
    Ok(to)
}

fn refuse_unless_owned(status: Status, shown: &str) -> Result<(), String> {
    match status {
        Status::Owned => Ok(()),
        Status::Missing => Err(format!("No such file: {shown}")),
        Status::Changed => Err(format!(
            "{shown} was changed after you wrote it, so it is the user's now. Ask them to remove or move it."
        )),
        Status::Foreign => Err(format!(
            "You didn't make {shown} in this conversation, so you can't remove or move it. Ask the user to."
        )),
    }
}

fn scope_of(scope: &str) -> Result<&str, String> {
    let scope = scope.trim();
    if scope.is_empty() {
        return Err("No conversation to keep track of files for.".into());
    }
    Ok(scope)
}

/// Where `rel_path` stands for `scope`: missing, owned, changed or foreign.
#[tauri::command]
pub fn fs_created_status(
    state: tauri::State<'_, CreatedFiles>,
    workdir: String,
    rel_path: String,
    scope: String,
) -> Result<String, String> {
    let path = resolve_in_workdir(&workdir_path(&workdir)?, &rel_path)?;
    Ok(state.status(scope_of(&scope)?, &path).word().to_string())
}

/// Record `rel_path` as `scope`'s, as it is now.
#[tauri::command]
pub fn fs_created_note(
    state: tauri::State<'_, CreatedFiles>,
    workdir: String,
    rel_path: String,
    scope: String,
) -> Result<(), String> {
    let path = resolve_in_workdir(&workdir_path(&workdir)?, &rel_path)?;
    state.note(scope_of(&scope)?, &path)
}

/// Folder a delete falls back to, inside the working folder.
const SET_ASIDE: &str = ".haruspex/trash";

/// Move `rel_path` to the trash, when `scope` made it and nobody changed it.
/// Returns null when the system trash took it, or the working-folder path it
/// was set aside at when the trash refused.
#[tauri::command]
pub fn fs_delete_created(
    state: tauri::State<'_, CreatedFiles>,
    workdir: String,
    rel_path: String,
    scope: String,
) -> Result<Option<String>, String> {
    let root = workdir_path_for_write(&workdir)?;
    let path = resolve_in_workdir(&root, &rel_path)?;
    let went = state.delete(
        scope_of(&scope)?,
        &path,
        &rel_path,
        &root.join(SET_ASIDE),
        |p| trash::delete(p).map_err(|e| e.to_string()),
    )?;
    Ok(match went {
        Deleted::Trash => None,
        Deleted::Folder(to) => Some(
            to.strip_prefix(&root)
                .unwrap_or(&to)
                .to_string_lossy()
                .replace('\\', "/"),
        ),
    })
}

/// Move or rename `from` to `to` inside the working folder, under the same rule.
#[tauri::command]
pub fn fs_move_created(
    state: tauri::State<'_, CreatedFiles>,
    workdir: String,
    from: String,
    to: String,
    scope: String,
) -> Result<(), String> {
    let root = workdir_path_for_write(&workdir)?;
    let from_path = resolve_in_workdir(&root, &from)?;
    let to_path = resolve_in_workdir(&root, &to)?;
    state.rename(scope_of(&scope)?, &from_path, &to_path, (&from, &to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::temp_dir;
    use std::fs;

    fn store(dir: &Path) -> CreatedFiles {
        CreatedFiles::new(Some(dir.join("store/created_files.json")))
    }

    #[test]
    fn a_file_is_the_scopes_while_it_holds_what_it_wrote() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let a = dir.join("a.md");
        assert_eq!(files.status("chat:1", &a), Status::Missing);
        fs::write(&a, "draft").unwrap();
        assert_eq!(files.status("chat:1", &a), Status::Foreign);
        files.note("chat:1", &a).unwrap();
        assert_eq!(files.status("chat:1", &a), Status::Owned);
        assert_eq!(files.status("chat:2", &a), Status::Foreign);
        fs::write(&a, "the user's edit").unwrap();
        assert_eq!(files.status("chat:1", &a), Status::Changed);
    }

    #[test]
    fn the_record_survives_a_restart() {
        let dir = temp_dir("created");
        let a = dir.join("a.md");
        fs::write(&a, "draft").unwrap();
        store(&dir).note("job:7", &a).unwrap();
        assert_eq!(store(&dir).status("job:7", &a), Status::Owned);
    }

    #[test]
    fn delete_refuses_what_isnt_the_scopes() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let a = dir.join("a.md");
        fs::write(&a, "theirs").unwrap();
        let aside = dir.join(".haruspex/trash");
        let trash = |_: &Path| -> Result<(), String> { panic!("refused before the trash") };
        let err = files
            .delete("chat:1", &a, "a.md", &aside, trash)
            .unwrap_err();
        assert!(
            err.starts_with("You didn't make a.md in this conversation"),
            "{err}"
        );
        files.note("chat:1", &a).unwrap();
        fs::write(&a, "changed").unwrap();
        let err = files
            .delete("chat:1", &a, "a.md", &aside, trash)
            .unwrap_err();
        assert!(
            err.starts_with("a.md was changed after you wrote it"),
            "{err}"
        );
        assert!(a.exists());
    }

    #[test]
    fn delete_uses_the_trash_and_forgets_the_file() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let a = dir.join("a.md");
        fs::write(&a, "draft").unwrap();
        files.note("chat:1", &a).unwrap();
        let went = files
            .delete("chat:1", &a, "a.md", &dir.join("aside"), |p| {
                fs::remove_file(p).map_err(|e| e.to_string())
            })
            .unwrap();
        assert_eq!(went, Deleted::Trash);
        assert!(!dir.join("aside").exists());
    }

    #[test]
    fn delete_sets_the_file_aside_when_the_trash_refuses() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let a = dir.join("a.md");
        fs::write(&a, "draft").unwrap();
        files.note("chat:1", &a).unwrap();
        let aside = dir.join(".haruspex/trash");
        let went = files
            .delete(
                "chat:1",
                &a,
                "a.md",
                &aside,
                |_| Err("no trash here".into()),
            )
            .unwrap();
        let Deleted::Folder(to) = went else {
            panic!("not set aside: {went:?}")
        };
        assert!(!a.exists());
        assert!(to.starts_with(&aside), "{}", to.display());
        assert!(to.to_string_lossy().ends_with("-a.md"));
        assert_eq!(fs::read_to_string(&to).unwrap(), "draft");
    }

    #[test]
    fn rename_moves_the_record_with_the_file() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let (a, b) = (dir.join("a.md"), dir.join("sub/b.md"));
        fs::write(&a, "draft").unwrap();
        files.note("chat:1", &a).unwrap();
        files
            .rename("chat:1", &a, &b, ("a.md", "sub/b.md"))
            .unwrap();
        assert!(!a.exists());
        assert_eq!(fs::read_to_string(&b).unwrap(), "draft");
        assert_eq!(files.status("chat:1", &b), Status::Owned);
    }

    #[test]
    fn rename_wont_replace_a_file_that_isnt_the_scopes() {
        let dir = temp_dir("created");
        let files = store(&dir);
        let (a, b) = (dir.join("a.md"), dir.join("b.md"));
        fs::write(&a, "draft").unwrap();
        fs::write(&b, "the user's").unwrap();
        files.note("chat:1", &a).unwrap();
        let err = files
            .rename("chat:1", &a, &b, ("a.md", "b.md"))
            .unwrap_err();
        assert!(err.contains("isn't yours to replace"), "{err}");
        assert_eq!(fs::read_to_string(&b).unwrap(), "the user's");
        assert!(a.exists());
    }
}
