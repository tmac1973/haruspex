//! Which window has each Code session open.
//!
//! A session is open in at most one window: the main window's Code tab, or a
//! detached `code-<id>` window. Each window's webview has its own session
//! store, so the rule can only be kept here, where every window can see it.
//! A window claims a session before it opens it; a claim held by another
//! window that still exists says "focus that one instead". A claim whose
//! window is gone (closed, crashed) counts as free, and closing a window
//! drops its claims.
//!
//! A release can leave a small JSON *handoff* for whichever window claims the
//! session next — the background-command watches, which live in a window's
//! JS context and would otherwise be lost when the session moves between
//! windows. The next successful claim takes it.

use crate::sync_util::LockExt;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
struct Inner {
    /// Session id → window label.
    owners: HashMap<String, String>,
    /// Session id → what its last owner handed over on release.
    handoffs: HashMap<String, String>,
}

/// Managed state: who owns which session.
#[derive(Default)]
pub struct CodeSessionClaims {
    inner: Mutex<Inner>,
}

/// The answer to a claim.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct CodeClaim {
    /// `None`: the caller owns the session now. Otherwise the label of the
    /// window that does, which the caller should focus instead.
    pub owner: Option<String>,
    /// What the previous owner left on release, given to the new owner once.
    pub handoff: Option<String>,
}

impl CodeSessionClaims {
    /// Claim `id` for `label`. `alive` says whether a window still exists.
    pub fn claim(&self, id: &str, label: &str, alive: impl Fn(&str) -> bool) -> CodeClaim {
        let mut inner = self.inner.lock_or_recover();
        if let Some(owner) = inner.owners.get(id) {
            if owner != label && alive(owner) {
                return CodeClaim {
                    owner: Some(owner.clone()),
                    handoff: None,
                };
            }
        }
        inner.owners.insert(id.to_string(), label.to_string());
        CodeClaim {
            owner: None,
            handoff: inner.handoffs.remove(id),
        }
    }

    /// Let go of `id`, if `label` holds it (or nobody does), leaving
    /// `handoff` for the next claim. A window can't release another's claim.
    pub fn release(&self, id: &str, label: &str, handoff: Option<String>) {
        let mut inner = self.inner.lock_or_recover();
        let owned = match inner.owners.get(id) {
            Some(owner) if owner != label => return,
            Some(_) => true,
            None => false,
        };
        if owned {
            inner.owners.remove(id);
        }
        match handoff {
            Some(h) => {
                inner.handoffs.insert(id.to_string(), h);
            }
            // Only the owner may clear what is waiting for the next one.
            None if owned => {
                inner.handoffs.remove(id);
            }
            None => {}
        }
    }

    /// Drop every claim a closed window held. Handoffs stay for the next owner.
    pub fn release_window(&self, label: &str) {
        self.inner
            .lock_or_recover()
            .owners
            .retain(|_, owner| owner != label);
    }

    /// Every session some live window has open.
    pub fn open_ids(&self, alive: impl Fn(&str) -> bool) -> Vec<String> {
        let mut ids: Vec<String> = self
            .inner
            .lock_or_recover()
            .owners
            .iter()
            .filter(|(_, owner)| alive(owner))
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    #[cfg(test)]
    fn owner(&self, id: &str) -> Option<String> {
        self.inner.lock_or_recover().owners.get(id).cloned()
    }
}

/// Claim a session for the calling window. See [`CodeSessionClaims::claim`].
#[tauri::command]
pub fn code_session_claim(
    window: tauri::Window,
    state: tauri::State<'_, CodeSessionClaims>,
    id: String,
) -> CodeClaim {
    let app = window.app_handle();
    state.claim(&id, window.label(), |label| {
        app.get_webview_window(label).is_some()
    })
}

/// Release the calling window's claim on a session, optionally leaving a
/// handoff for the next owner.
#[tauri::command]
pub fn code_session_release(
    window: tauri::Window,
    state: tauri::State<'_, CodeSessionClaims>,
    id: String,
    handoff: Option<String>,
) {
    state.release(&id, window.label(), handoff);
}

/// The sessions open in any window, this one included: for "another session
/// is open in this folder", which has to see detached windows too.
#[tauri::command]
pub fn code_session_open_ids(
    window: tauri::Window,
    state: tauri::State<'_, CodeSessionClaims>,
) -> Vec<String> {
    let app = window.app_handle();
    state.open_ids(|label| app.get_webview_window(label).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_alive(_: &str) -> bool {
        true
    }

    #[test]
    fn a_free_session_goes_to_the_first_window_and_stays_there() {
        let c = CodeSessionClaims::default();
        assert_eq!(c.claim("s1", "main", all_alive).owner, None);
        // Claiming again from the owner is fine; from elsewhere names the owner.
        assert_eq!(c.claim("s1", "main", all_alive).owner, None);
        assert_eq!(
            c.claim("s1", "code-s1", all_alive).owner.as_deref(),
            Some("main")
        );
        assert_eq!(c.owner("s1").as_deref(), Some("main"));
    }

    #[test]
    fn a_claim_whose_window_is_gone_is_free() {
        let c = CodeSessionClaims::default();
        c.claim("s1", "code-s1", all_alive);
        let claim = c.claim("s1", "main", |label| label != "code-s1");
        assert_eq!(claim.owner, None);
        assert_eq!(c.owner("s1").as_deref(), Some("main"));
    }

    #[test]
    fn release_frees_only_the_callers_claim() {
        let c = CodeSessionClaims::default();
        c.claim("s1", "main", all_alive);
        c.release("s1", "code-s1", None);
        assert_eq!(c.owner("s1").as_deref(), Some("main"));
        c.release("s1", "main", None);
        assert_eq!(c.owner("s1"), None);
        assert_eq!(c.claim("s1", "code-s1", all_alive).owner, None);
    }

    #[test]
    fn open_ids_lists_claims_of_live_windows() {
        let c = CodeSessionClaims::default();
        c.claim("s2", "main", all_alive);
        c.claim("s1", "code-s1", all_alive);
        c.claim("s3", "gone", all_alive);
        assert_eq!(c.open_ids(|l| l != "gone"), vec!["s1", "s2"]);
    }

    #[test]
    fn closing_a_window_drops_all_its_claims() {
        let c = CodeSessionClaims::default();
        c.claim("s1", "code-s1", all_alive);
        c.claim("s2", "main", all_alive);
        c.release_window("code-s1");
        assert_eq!(c.owner("s1"), None);
        assert_eq!(c.owner("s2").as_deref(), Some("main"));
    }

    #[test]
    fn a_handoff_goes_to_the_next_owner_once() {
        let c = CodeSessionClaims::default();
        c.claim("s1", "main", all_alive);
        c.release("s1", "main", Some("{\"watches\":[]}".into()));
        // Someone else's release can't overwrite or clear it.
        c.claim("s2", "main", all_alive);
        c.release("s1", "other", None);
        let claim = c.claim("s1", "code-s1", all_alive);
        assert_eq!(claim.owner, None);
        assert_eq!(claim.handoff.as_deref(), Some("{\"watches\":[]}"));
        c.release("s1", "code-s1", None);
        assert_eq!(c.claim("s1", "main", all_alive).handoff, None);
    }

    #[test]
    fn a_refused_claim_leaves_the_handoff_alone() {
        let c = CodeSessionClaims::default();
        c.release("s1", "main", Some("h".into()));
        c.claim("s1", "main", all_alive);
        c.release("s1", "main", Some("h2".into()));
        c.claim("s1", "code-s1", all_alive);
        // main's claim is refused while code-s1 holds it, and takes nothing.
        let refused = c.claim("s1", "main", all_alive);
        assert_eq!(refused.owner.as_deref(), Some("code-s1"));
        assert_eq!(refused.handoff, None);
    }
}
