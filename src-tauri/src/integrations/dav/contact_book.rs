//! Contacts' email addresses, for addressing mail: the Review email dialog's
//! To and Cc suggestions, and `email_compose` given a name.
//!
//! Fetching an address book is a round trip per account, too slow to repeat
//! as someone types, so the list is kept in memory for a few minutes. It is
//! kept only when every account answered, so a failure is retried at once.
//! The `contacts_*` tools still fetch afresh: someone asking about a contact
//! they just added must find it.

use crate::sync_util::LockExt;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::account::DavAccount;
use super::commands::{collect_contacts, ContactQueryResult};
use super::vcard::Contact;
use crate::proxy::ProxyConfig;

/// How long a fetched list is used before it is fetched again.
const KEEP_FOR: Duration = Duration::from_secs(5 * 60);

/// One address someone can be written to at.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ContactAddress {
    /// The contact's name; empty when the card has none.
    pub name: String,
    pub email: String,
    /// The account it came from, to tell two people of one name apart.
    pub account_label: String,
}

/// Every contact's addresses, and what went wrong fetching them.
#[derive(Clone, Debug, Default, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ContactAddresses {
    pub addresses: Vec<ContactAddress>,
    pub problems: Vec<String>,
}

/// Each contact's addresses, one entry per address, the first of each
/// address kept, sorted by name.
pub fn addresses_of(contacts: &[Contact]) -> Vec<ContactAddress> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in contacts {
        for e in &c.emails {
            let email = e.value.trim();
            if !email.contains('@') || !seen.insert(email.to_lowercase()) {
                continue;
            }
            out.push(ContactAddress {
                name: c.full_name.trim().to_string(),
                email: email.to_string(),
                account_label: c.account_label.clone(),
            });
        }
    }
    out.sort_by(|a, b| {
        (
            a.name.is_empty(),
            a.name.to_lowercase(),
            a.email.to_lowercase(),
        )
            .cmp(&(
                b.name.is_empty(),
                b.name.to_lowercase(),
                b.email.to_lowercase(),
            ))
    });
    out
}

struct Kept {
    key: u64,
    at: Instant,
    addresses: Vec<ContactAddress>,
}

fn kept() -> &'static Mutex<Option<Kept>> {
    static KEPT: OnceLock<Mutex<Option<Kept>>> = OnceLock::new();
    KEPT.get_or_init(|| Mutex::new(None))
}

/// The accounts as one number: a changed account (another password, server
/// or switch) is another list. Hashed so no secret is kept. The proxy only
/// changes how they are reached, not what they hold.
fn key_of(accounts: &[DavAccount]) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_string(accounts)
        .unwrap_or_default()
        .hash(&mut h);
    h.finish()
}

fn fresh(key: u64) -> Option<Vec<ContactAddress>> {
    let guard = kept().lock_or_recover();
    guard
        .as_ref()
        .filter(|k| k.key == key && k.at.elapsed() < KEEP_FOR)
        .map(|k| k.addresses.clone())
}

/// What a fetch leaves: its addresses, kept when nothing went wrong.
fn keep(key: u64, result: ContactQueryResult) -> ContactAddresses {
    let addresses = addresses_of(&result.contacts);
    if result.problems.is_empty() {
        *kept().lock_or_recover() = Some(Kept {
            key,
            at: Instant::now(),
            addresses: addresses.clone(),
        });
    }
    ContactAddresses {
        addresses,
        problems: result.problems,
    }
}

/// Every enabled contacts account's addresses, from memory when fetched in
/// the last few minutes.
#[tauri::command]
pub async fn dav_contact_addresses(
    accounts: Vec<DavAccount>,
    proxy: Option<ProxyConfig>,
) -> Result<ContactAddresses, String> {
    let key = key_of(&accounts);
    if let Some(addresses) = fresh(key) {
        return Ok(ContactAddresses {
            addresses,
            problems: vec![],
        });
    }
    Ok(keep(key, collect_contacts(&accounts, proxy.as_ref()).await))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::dav::vcard::TypedValue;

    fn person(name: &str, emails: &[&str]) -> Contact {
        Contact {
            full_name: name.into(),
            account_label: "Google".into(),
            emails: emails
                .iter()
                .map(|e| TypedValue {
                    kind: None,
                    value: e.to_string(),
                })
                .collect(),
            ..Contact::default()
        }
    }

    #[test]
    fn one_entry_per_address_sorted_by_name_nameless_last() {
        let list = addresses_of(&[
            person("Sam Lee", &["sam@work.example", " sam@home.example "]),
            person("", &["nobody@example.com"]),
            person("alan", &["alan@example.com", "not an address"]),
            person("Sam L.", &["SAM@work.example"]),
        ]);
        let got: Vec<_> = list
            .iter()
            .map(|a| (a.name.as_str(), a.email.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("alan", "alan@example.com"),
                ("Sam Lee", "sam@home.example"),
                ("Sam Lee", "sam@work.example"),
                ("", "nobody@example.com"),
            ]
        );
    }

    #[test]
    fn a_list_is_kept_only_when_every_account_answered() {
        let ok = ContactQueryResult {
            contacts: vec![person("Ann", &["ann@example.com"])],
            total_matched: 1,
            problems: vec![],
        };
        keep(11, ok);
        assert_eq!(fresh(11).unwrap()[0].email, "ann@example.com");
        assert!(fresh(12).is_none());

        let failed = ContactQueryResult {
            contacts: vec![],
            total_matched: 0,
            problems: vec!["Work: timed out".into()],
        };
        let out = keep(13, failed);
        assert_eq!(out.problems, vec!["Work: timed out".to_string()]);
        assert!(fresh(13).is_none());
    }
}
