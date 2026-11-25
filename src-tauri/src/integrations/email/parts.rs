//! Files staged for an outgoing message: pictures shown inline and
//! attachments.
//!
//! The webview sends each file once, as raw bytes (`email_part_stage`, with
//! its name and type in headers), and gets an id. `email_send` names the ids
//! it uses; they are dropped once the message is sent, or when the review
//! dialog discards the draft (`email_part_drop`). A failed send keeps them,
//! so Send can be clicked again.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::Deserialize;

use super::body::{clean_name, FilePart};

/// The most a message's files may add up to, raw. Base64 makes that about
/// 24 MB on the wire, under Gmail's 25 MB.
pub const MAX_MESSAGE_BYTES: usize = 18 * 1024 * 1024;
/// The most all staged files may hold at once (several drafts, or ones
/// never sent nor discarded).
const MAX_STAGED_BYTES: usize = 3 * MAX_MESSAGE_BYTES;

/// A staged file an outgoing message uses.
#[derive(Clone, Debug, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PartRef {
    /// The id `email_part_stage` returned.
    pub id: String,
    /// Set for a picture the HTML shows as `cid:<cid>`; absent for an
    /// attachment.
    #[serde(default)]
    #[ts(optional)]
    pub cid: Option<String>,
}

/// A message's files: inline pictures with their Content-IDs, then attachments.
pub type Resolved = (Vec<(String, FilePart)>, Vec<FilePart>);

#[derive(Default)]
struct Store {
    next: u64,
    parts: HashMap<String, FilePart>,
}

impl Store {
    fn held(&self) -> usize {
        self.parts.values().map(|p| p.bytes.len()).sum()
    }

    fn stage(&mut self, name: &str, mime: &str, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(format!(
                "{name} is over {} MB, more than an email can carry",
                MAX_MESSAGE_BYTES / 1024 / 1024
            ));
        }
        if self.held() + bytes.len() > MAX_STAGED_BYTES {
            return Err(
                "Too many files are waiting to be sent. Send or discard a draft first.".into(),
            );
        }
        self.next += 1;
        let id = format!("part-{}", self.next);
        self.parts.insert(
            id.clone(),
            FilePart {
                name: clean_name(name),
                mime: mime.trim().to_string(),
                bytes,
            },
        );
        Ok(id)
    }

    /// The files `refs` names, split into inline and attached, or why not.
    fn resolve(&self, refs: &[PartRef]) -> Result<Resolved, String> {
        let mut inline = Vec::new();
        let mut attached = Vec::new();
        let mut total = 0usize;
        for r in refs {
            let part = self
                .parts
                .get(&r.id)
                .ok_or("A file for this message is no longer here. Add it again.")?;
            total += part.bytes.len();
            match &r.cid {
                Some(cid) => inline.push((cid.clone(), part.clone())),
                None => attached.push(part.clone()),
            }
        }
        if total > MAX_MESSAGE_BYTES {
            return Err(format!(
                "The files add up to more than {} MB, more than an email can carry",
                MAX_MESSAGE_BYTES / 1024 / 1024
            ));
        }
        Ok((inline, attached))
    }

    fn drop_ids(&mut self, ids: &[String]) {
        for id in ids {
            self.parts.remove(id);
        }
    }
}

fn store() -> MutexGuard<'static, Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The files a message names, split into inline pictures and attachments.
pub fn resolve(refs: &[PartRef]) -> Result<Resolved, String> {
    store().resolve(refs)
}

/// Forget the files a sent message used.
pub fn forget(refs: &[PartRef]) {
    let ids: Vec<String> = refs.iter().map(|r| r.id.clone()).collect();
    store().drop_ids(&ids);
}

/// Stage one file: the raw body, its name in `x-name` and its MIME type in
/// `x-mime` (both URI-encoded). Returns the id `email_send` names it by.
#[tauri::command]
pub fn email_part_stage(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("A file must be sent as raw bytes.".into());
    };
    let name = crate::notebook_files::transfer::header(&request, "x-name")?;
    let mime = crate::notebook_files::transfer::header(&request, "x-mime")?;
    if lettre::message::header::ContentType::parse(&mime).is_err() {
        return Err(format!("{mime:?} is not a MIME type"));
    }
    store().stage(&name, &mime, bytes.clone())
}

/// Forget staged files: a draft was discarded.
#[tauri::command]
pub fn email_part_drop(ids: Vec<String>) {
    store().drop_ids(&ids);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, cid: Option<&str>) -> PartRef {
        PartRef {
            id: id.into(),
            cid: cid.map(str::to_string),
        }
    }

    #[test]
    fn staged_files_come_back_inline_or_attached() {
        let mut s = Store::default();
        let pic = s.stage("map.png", "image/png", vec![1, 2]).unwrap();
        let doc = s.stage("../trip.pdf", "application/pdf", vec![3]).unwrap();
        let (inline, attached) = s.resolve(&[r(&pic, Some("p1")), r(&doc, None)]).unwrap();
        assert_eq!(inline[0].0, "p1");
        assert_eq!(inline[0].1.name, "map.png");
        assert_eq!(attached[0].name, "_trip.pdf");
        s.drop_ids(std::slice::from_ref(&pic));
        assert!(s.resolve(&[r(&pic, None)]).is_err());
        assert!(s.resolve(&[r(&doc, None)]).is_ok());
    }

    #[test]
    fn an_unknown_id_is_an_error() {
        assert!(Store::default().resolve(&[r("part-9", None)]).is_err());
    }

    #[test]
    fn a_message_over_the_limit_is_refused() {
        let mut s = Store::default();
        let half = MAX_MESSAGE_BYTES / 2 + 1;
        let a = s
            .stage("a.bin", "application/octet-stream", vec![0; half])
            .unwrap();
        let b = s
            .stage("b.bin", "application/octet-stream", vec![0; half])
            .unwrap();
        assert!(s.resolve(&[r(&a, None)]).is_ok());
        assert!(s.resolve(&[r(&a, None), r(&b, None)]).is_err());
        assert!(s
            .stage(
                "c.bin",
                "application/octet-stream",
                vec![0; MAX_MESSAGE_BYTES + 1]
            )
            .is_err());
    }

    #[test]
    fn the_store_holds_only_so_much_at_once() {
        let mut s = Store::default();
        for _ in 0..3 {
            s.stage(
                "a.bin",
                "application/octet-stream",
                vec![0; MAX_MESSAGE_BYTES],
            )
            .unwrap();
        }
        assert!(s
            .stage("b.bin", "application/octet-stream", vec![0; 1])
            .is_err());
    }
}
