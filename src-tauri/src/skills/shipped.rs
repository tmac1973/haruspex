//! Skills Haruspex ships, copied into the user's skills folder as ordinary
//! files they can edit, replace or delete.
//!
//! The files are compiled in from `resources/skills/` (see `build.rs`). A
//! record outside the skills folder, `<app data>/shipped-skills.json`, keeps
//! the hash of each skill as last copied in, which is how a later start tells
//! the user's changes from ours:
//!
//! - never shipped and no folder of that name: copy it in;
//! - never shipped but the user has a folder of that name: theirs wins;
//! - shipped and the folder is gone: the user deleted it, so it stays gone;
//! - shipped and unchanged since: replace it if this release's differs;
//! - shipped and edited: leave it.
//!
//! The user can put one back as shipped (Settings → Skills → Restore), which
//! also brings back a deleted one.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/shipped_skills.rs"));
}

/// The skills compiled into this build: (path under `resources/skills/`, bytes).
pub const SHIPPED: &[(&str, &[u8])] = embedded::SHIPPED;

/// Where a shipped skill stands on this machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShippedState {
    /// As shipped.
    Installed,
    /// Changed by the user since it was copied in.
    Edited,
    /// Deleted by the user.
    Deleted,
    /// The user's own folder of that name, which was there first.
    Theirs,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShippedSkill {
    pub name: String,
    pub state: ShippedState,
}

/// Each skill's files, by skill name: (path inside the skill, bytes).
type Skills<'a> = BTreeMap<&'a str, Vec<(&'a str, &'a [u8])>>;

fn by_skill<'a>(files: &[(&'a str, &'a [u8])]) -> Skills<'a> {
    let mut skills: Skills = BTreeMap::new();
    for (path, bytes) in files {
        if let Some((name, rel)) = path.split_once('/') {
            skills.entry(name).or_default().push((rel, bytes));
        }
    }
    skills
}

/// One hash for a set of files, independent of the order they're listed in.
fn hash(files: impl IntoIterator<Item = (String, Vec<u8>)>) -> String {
    let mut files: Vec<(String, Vec<u8>)> = files.into_iter().collect();
    files.sort();
    let mut h = Sha256::new();
    for (rel, bytes) in files {
        h.update(rel.as_bytes());
        h.update([0]);
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(&bytes);
    }
    format!("{:x}", h.finalize())
}

fn shipped_hash(files: &[(&str, &[u8])]) -> String {
    hash(files.iter().map(|(rel, b)| (rel.to_string(), b.to_vec())))
}

/// The hash of everything under `dir`, as `shipped_hash` would compute it;
/// None when it can't be read. A file the user added counts as an edit.
fn disk_hash(dir: &Path) -> Option<String> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Option<()> {
        for entry in fs::read_dir(dir).ok()? {
            let path = entry.ok()?.path();
            if path.is_dir() {
                walk(base, &path, out)?;
            } else {
                let rel = path
                    .strip_prefix(base)
                    .ok()?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, fs::read(&path).ok()?));
            }
        }
        Some(())
    }
    let mut files = Vec::new();
    walk(dir, dir, &mut files)?;
    Some(hash(files))
}

/// Name → hash of the skill as last copied in.
type Record = BTreeMap<String, String>;

fn load_record(path: &Path) -> Record {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_record(path: &Path, record: &Record) -> Result<(), String> {
    let text = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/// Replace whatever is at `dir` with `files`. Written beside it first and
/// renamed into place, so a failure leaves the old folder whole.
fn write_skill(dir: &Path, files: &[(&str, &[u8])]) -> Result<(), String> {
    let parent = dir.parent().ok_or("no parent folder")?;
    let name = dir.file_name().ok_or("no folder name")?.to_string_lossy();
    let tmp = parent.join(format!(".{name}.shipping"));
    let _ = fs::remove_dir_all(&tmp);
    for (rel, bytes) in files {
        let path = tmp.join(rel);
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    remove(dir)?;
    fs::rename(&tmp, dir).map_err(|e| {
        let _ = fs::remove_dir_all(&tmp);
        e.to_string()
    })
}

/// Remove `dir`; for a linked-in folder, only the link.
fn remove(dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(dir) {
        Err(_) => Ok(()),
        Ok(m) if m.file_type().is_symlink() => fs::remove_file(dir).map_err(|e| e.to_string()),
        Ok(_) => fs::remove_dir_all(dir).map_err(|e| e.to_string()),
    }
}

fn state(user_dir: &Path, record: &Record, name: &str) -> ShippedState {
    let dir = user_dir.join(name);
    let exists = fs::symlink_metadata(&dir).is_ok();
    match record.get(name) {
        None if exists => ShippedState::Theirs,
        None | Some(_) if !exists => ShippedState::Deleted,
        Some(recorded) if disk_hash(&dir).as_deref() == Some(recorded) => ShippedState::Installed,
        _ => ShippedState::Edited,
    }
}

/// Bring the user's folder in line with this build, by the rules above.
/// Returns what went wrong, one line per skill; the rest are still seeded.
pub fn seed(user_dir: &Path, record_path: &Path, shipped: &[(&str, &[u8])]) -> Vec<String> {
    let mut record = load_record(record_path);
    let mut errors = Vec::new();
    let mut changed = false;
    for (name, files) in by_skill(shipped) {
        let dir = user_dir.join(name);
        let new_hash = shipped_hash(&files);
        let copy = match (record.get(name), state(user_dir, &record, name)) {
            // Never shipped here, and nothing in the way.
            (None, ShippedState::Deleted) => true,
            (Some(old), ShippedState::Installed) => *old != new_hash,
            _ => false,
        };
        if !copy {
            continue;
        }
        match write_skill(&dir, &files) {
            Ok(()) => {
                record.insert(name.to_string(), new_hash);
                changed = true;
            }
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    if changed {
        if let Err(e) = save_record(record_path, &record) {
            errors.push(format!("the record of shipped skills: {e}"));
        }
    }
    errors
}

/// Every shipped skill and where it stands.
pub fn status(user_dir: &Path, record_path: &Path, shipped: &[(&str, &[u8])]) -> Vec<ShippedSkill> {
    let record = load_record(record_path);
    by_skill(shipped)
        .keys()
        .map(|name| ShippedSkill {
            name: name.to_string(),
            state: state(user_dir, &record, name),
        })
        .collect()
}

/// Put the skill `name` back as shipped, replacing what is there; with None,
/// put back every one the user deleted.
pub fn restore(
    user_dir: &Path,
    record_path: &Path,
    shipped: &[(&str, &[u8])],
    name: Option<&str>,
) -> Result<(), String> {
    let mut record = load_record(record_path);
    let skills = by_skill(shipped);
    let names: Vec<&str> = match name {
        Some(n) if skills.contains_key(n) => vec![n],
        Some(n) => return Err(format!("\"{n}\" isn't a skill Haruspex ships")),
        None => skills
            .keys()
            .copied()
            .filter(|n| state(user_dir, &record, n) == ShippedState::Deleted)
            .collect(),
    };
    for n in names {
        let files = &skills[n];
        write_skill(&user_dir.join(n), files)?;
        record.insert(n.to_string(), shipped_hash(files));
    }
    save_record(record_path, &record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("haruspex_shipped_test_{name}"));
        let _ = fs::remove_dir_all(&base);
        let user = base.join("skills");
        fs::create_dir_all(&user).unwrap();
        (user, base.join("shipped-skills.json"))
    }

    const V1: &[(&str, &[u8])] = &[
        ("a/SKILL.md", b"---\nname: a\ndescription: A.\n---\nv1\n"),
        ("a/refs/x.md", b"extra"),
        ("b/SKILL.md", b"---\nname: b\ndescription: B.\n---\nv1\n"),
    ];
    const V2: &[(&str, &[u8])] = &[
        ("a/SKILL.md", b"---\nname: a\ndescription: A.\n---\nv2\n"),
        ("a/refs/x.md", b"extra"),
        ("b/SKILL.md", b"---\nname: b\ndescription: B.\n---\nv2\n"),
    ];

    fn read(user: &Path, rel: &str) -> String {
        fs::read_to_string(user.join(rel)).unwrap()
    }

    fn states(user: &Path, record: &Path, shipped: &[(&str, &[u8])]) -> Vec<ShippedState> {
        status(user, record, shipped)
            .into_iter()
            .map(|s| s.state)
            .collect()
    }

    #[test]
    fn copies_every_skill_once() {
        let (user, record) = temp_dir("first");
        assert!(seed(&user, &record, V1).is_empty());
        assert!(read(&user, "a/SKILL.md").contains("v1"));
        assert_eq!(read(&user, "a/refs/x.md"), "extra");
        assert_eq!(states(&user, &record, V1), [ShippedState::Installed; 2]);
        let before = fs::read_to_string(&record).unwrap();
        assert!(seed(&user, &record, V1).is_empty());
        assert_eq!(fs::read_to_string(&record).unwrap(), before);
    }

    #[test]
    fn leaves_the_users_own_folder_alone() {
        let (user, record) = temp_dir("theirs");
        fs::create_dir_all(user.join("a")).unwrap();
        fs::write(user.join("a/SKILL.md"), "mine").unwrap();
        seed(&user, &record, V1);
        assert_eq!(read(&user, "a/SKILL.md"), "mine");
        assert_eq!(states(&user, &record, V1)[0], ShippedState::Theirs);
        seed(&user, &record, V2);
        assert_eq!(read(&user, "a/SKILL.md"), "mine");
    }

    #[test]
    fn a_deleted_skill_stays_deleted_until_restored() {
        let (user, record) = temp_dir("deleted");
        seed(&user, &record, V1);
        fs::remove_dir_all(user.join("a")).unwrap();
        seed(&user, &record, V2);
        assert!(!user.join("a").exists());
        assert_eq!(states(&user, &record, V2)[0], ShippedState::Deleted);
        restore(&user, &record, V2, None).unwrap();
        assert!(read(&user, "a/SKILL.md").contains("v2"));
        assert_eq!(states(&user, &record, V2), [ShippedState::Installed; 2]);
    }

    #[test]
    fn a_release_updates_only_unedited_skills() {
        let (user, record) = temp_dir("update");
        seed(&user, &record, V1);
        fs::write(user.join("b/SKILL.md"), "tuned").unwrap();
        assert_eq!(states(&user, &record, V1)[1], ShippedState::Edited);
        assert!(seed(&user, &record, V2).is_empty());
        assert!(read(&user, "a/SKILL.md").contains("v2"));
        assert_eq!(read(&user, "b/SKILL.md"), "tuned");
        // An added file is an edit too.
        fs::write(user.join("a/notes.md"), "mine").unwrap();
        assert_eq!(states(&user, &record, V2)[0], ShippedState::Edited);
    }

    #[test]
    fn restore_puts_one_back_as_shipped() {
        let (user, record) = temp_dir("restore");
        seed(&user, &record, V1);
        fs::write(user.join("a/SKILL.md"), "tuned").unwrap();
        fs::remove_file(user.join("a/refs/x.md")).unwrap();
        restore(&user, &record, V1, Some("a")).unwrap();
        assert!(read(&user, "a/SKILL.md").contains("v1"));
        assert_eq!(read(&user, "a/refs/x.md"), "extra");
        assert_eq!(states(&user, &record, V1)[0], ShippedState::Installed);
        assert!(restore(&user, &record, V1, Some("zzz")).is_err());
        assert!(!user.join(".a.shipping").exists());
    }

    #[test]
    fn this_build_ships_valid_skills() {
        let skills = by_skill(SHIPPED);
        assert!(skills.contains_key("init") && skills.contains_key("plan-2d-game"));
        for (name, files) in skills {
            let (_, text) = files
                .iter()
                .find(|(rel, _)| *rel == "SKILL.md")
                .unwrap_or_else(|| panic!("{name} has no SKILL.md"));
            let parsed = super::super::parse::parse_skill(std::str::from_utf8(text).unwrap(), name);
            assert_eq!(parsed.error, None, "{name}");
            assert!(parsed.warnings.is_empty(), "{name}: {:?}", parsed.warnings);
        }
    }
}
