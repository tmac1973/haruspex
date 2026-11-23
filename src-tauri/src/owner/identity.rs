//! Which Haruspex this is: a random id made once per install, and the
//! computer's name. `/api/v1/health` answers both, so another Haruspex can
//! tell that a computer it found on the network and one the owner typed by
//! name are the same one, and skip itself (plan/instance-sync).
//!
//! The id is kept in its own file in the app data folder, not in Settings,
//! so a settings file copied to another computer never clones it. It isn't
//! a secret: it only names an install.

use std::path::Path;

use serde::Serialize;

use super::trust::system_hostname;

/// The name shown when the computer's hostname can't be read.
const FALLBACK_NAME: &str = "Haruspex";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstanceIdentity {
    pub id: String,
    /// The computer's hostname up to its first dot.
    pub name: String,
}

impl InstanceIdentity {
    /// Read the id kept at `path`, or make and keep a new one. A file that
    /// can't be read or written still yields an id, for this run only.
    pub fn load(path: Option<&Path>) -> Self {
        InstanceIdentity {
            id: path.map(load_or_create_id).unwrap_or_else(new_id),
            name: short_name(system_hostname().as_deref()),
        }
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn load_or_create_id(path: &Path) -> String {
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(id) = uuid::Uuid::parse_str(text.trim()) {
            return id.to_string();
        }
        log::warn!("[owner] instance id file is not an id; making a new one");
    }
    let id = new_id();
    let tmp = path.with_extension("tmp");
    // On a first launch the app data folder may not exist yet (Windows).
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::write(&tmp, format!("{id}\n")))
        .and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = written {
        log::warn!("[owner] could not keep the instance id: {e}");
    }
    id
}

fn short_name(hostname: Option<&str>) -> String {
    hostname
        .and_then(|h| h.split('.').next())
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or(FALLBACK_NAME)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_folder_gets_an_id_that_is_kept() {
        let dir = crate::test_util::temp_dir("identity_new");
        let path = dir.join("instance-id");
        let first = InstanceIdentity::load(Some(&path));
        assert!(uuid::Uuid::parse_str(&first.id).is_ok());
        assert!(path.is_file());
        assert_eq!(InstanceIdentity::load(Some(&path)).id, first.id);
    }

    #[test]
    fn a_garbled_file_is_replaced() {
        let dir = crate::test_util::temp_dir("identity_garbled");
        let path = dir.join("instance-id");
        std::fs::write(&path, "not an id").unwrap();
        let id = InstanceIdentity::load(Some(&path)).id;
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), id);
    }

    #[test]
    fn a_missing_folder_is_made_and_the_id_kept() {
        let dir = crate::test_util::temp_dir("identity_missing");
        let path = dir.join("missing").join("instance-id");
        let first = InstanceIdentity::load(Some(&path));
        assert!(path.is_file());
        assert_eq!(InstanceIdentity::load(Some(&path)).id, first.id);
    }

    #[test]
    fn an_unwritable_folder_still_gives_an_id() {
        let dir = crate::test_util::temp_dir("identity_unwritable");
        std::fs::write(dir.join("blocked"), "a file, not a folder").unwrap();
        let path = dir.join("blocked").join("instance-id");
        let id = InstanceIdentity::load(Some(&path)).id;
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert!(!path.exists());
    }

    #[test]
    fn the_name_is_the_hostname_up_to_its_first_dot() {
        assert_eq!(short_name(Some("desk-pc.lan")), "desk-pc");
        assert_eq!(short_name(Some("desk-pc")), "desk-pc");
        assert_eq!(short_name(Some("")), FALLBACK_NAME);
        assert_eq!(short_name(None), FALLBACK_NAME);
    }
}
