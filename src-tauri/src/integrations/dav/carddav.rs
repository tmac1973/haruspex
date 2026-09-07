//! Asking an address book who is in it.
//!
//! # Everything, then filtered here
//!
//! Unlike `caldav.rs`, which pushes its time window onto the server because a
//! year of a busy calendar is megabytes, this fetches the whole address book
//! and filters locally. Two reasons. CardDAV's `text-match` filter is
//! inconsistently implemented — several servers ignore it and return
//! everything, which turns a search that quietly works on one server into one
//! that quietly returns nothing on another. And an address book is small: a
//! large personal one is a few hundred cards, which is one round trip either
//! way.
//!
//! # Two ways to ask, because servers disagree
//!
//! `addressbook-query` is the specified verb and what Nextcloud, Fastmail,
//! Radicale and Baikal answer. Some servers refuse a REPORT with an empty
//! filter, so a plain `PROPFIND` for the same property is tried after it. The
//! fallback is not speculative — it is the same request with a different verb,
//! and it costs one round trip only on a server that has already refused.

use super::client::DavClient;
use super::discovery::AddressBook;
use super::vcard::{parse_contacts, Contact, ContactSource};

/// A REPORT asking for every card with its data.
///
/// The empty `<filter/>` is required by the schema even when it selects
/// everything; omitting it is a 400 on servers that validate.
pub const ADDRESSBOOK_QUERY_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
  <c:filter/>
</c:addressbook-query>"#;

/// The same request as a PROPFIND, for servers that refuse the REPORT.
pub const ADDRESS_DATA_PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
</d:propfind>"#;

/// Every contact in one address book.
pub async fn fetch_contacts(
    client: &DavClient,
    book: &AddressBook,
    source: &ContactSource,
) -> Result<Vec<Contact>, String> {
    let responses = match client.report(&book.url, "1", ADDRESSBOOK_QUERY_BODY).await {
        Ok(responses) => responses,
        Err(report_error) => client
            .propfind(&book.url, "1", ADDRESS_DATA_PROPFIND_BODY)
            .await
            // The REPORT's error is the one worth showing: it is the request
            // that should have worked, and a server failing both has usually
            // failed both for the same reason.
            .map_err(|_| report_error)?,
    };

    let mut contacts = Vec::new();
    for response in &responses {
        if let Some(data) = response.props.get("address-data") {
            contacts.extend(parse_contacts(data, source, &response.href));
        }
    }
    contacts.sort_by_key(sort_key);
    Ok(contacts)
}

/// Order an address book the way an address book is ordered: by surname, then
/// by whatever the card is actually called.
fn sort_key(contact: &Contact) -> (String, String) {
    (
        contact
            .last_name
            .clone()
            .unwrap_or_else(|| contact.full_name.clone())
            .to_lowercase(),
        contact.full_name.to_lowercase(),
    )
}

/// Find the one contact an identifier names.
///
/// Tried in order of how specific each is: the UID a previous search returned,
/// then an exact email, then an exact name, then a substring of the name. The
/// ladder exists because a model passes back whatever it has — usually the name
/// the *user* said, not the id it was given.
pub fn find(contacts: &[Contact], identifier: &str) -> Option<Contact> {
    let needle = identifier.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    let by = |f: &dyn Fn(&Contact) -> bool| contacts.iter().find(|c| f(c)).cloned();

    by(&|c| c.uid.to_lowercase() == needle)
        .or_else(|| by(&|c| c.emails.iter().any(|e| e.value.to_lowercase() == needle)))
        .or_else(|| by(&|c| c.full_name.to_lowercase() == needle))
        .or_else(|| by(&|c| c.full_name.to_lowercase().contains(&needle)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::integrations::dav::vcard::TypedValue;

    fn contact(uid: &str, name: &str, email: &str, last: &str) -> Contact {
        Contact {
            uid: uid.into(),
            full_name: name.into(),
            last_name: (!last.is_empty()).then(|| last.to_string()),
            emails: vec![TypedValue {
                kind: None,
                value: email.into(),
            }],
            ..Contact::default()
        }
    }

    fn people() -> Vec<Contact> {
        vec![
            contact("uid-1", "Sarah Okonjo", "sarah@example.com", "Okonjo"),
            contact("uid-2", "Alan Turing", "alan@example.com", "Turing"),
            contact("uid-3", "Sarah Connor", "connor@example.com", "Connor"),
        ]
    }

    #[test]
    fn the_query_asks_for_the_card_data_itself() {
        assert!(ADDRESSBOOK_QUERY_BODY.contains("address-data"));
        assert!(ADDRESS_DATA_PROPFIND_BODY.contains("address-data"));
    }

    #[test]
    fn the_query_carries_the_empty_filter_the_schema_requires() {
        // Omitting it is a 400 on servers that validate the request.
        assert!(ADDRESSBOOK_QUERY_BODY.contains("<c:filter/>"));
    }

    #[test]
    fn a_uid_finds_exactly_that_contact() {
        assert_eq!(find(&people(), "uid-2").unwrap().full_name, "Alan Turing");
    }

    #[test]
    fn an_email_address_finds_its_owner() {
        assert_eq!(
            find(&people(), "SARAH@example.com").unwrap().uid,
            "uid-1",
            "matched case-insensitively"
        );
    }

    #[test]
    fn an_exact_name_beats_a_partial_one() {
        // Two Sarahs. "Sarah Connor" must not resolve to Sarah Okonjo just
        // because she comes first in the book.
        assert_eq!(find(&people(), "Sarah Connor").unwrap().uid, "uid-3");
    }

    #[test]
    fn a_partial_name_still_finds_someone() {
        // The model passes back whatever the user said.
        assert_eq!(find(&people(), "turing").unwrap().uid, "uid-2");
    }

    #[test]
    fn nothing_matches_nothing() {
        assert!(find(&people(), "nobody").is_none());
        assert!(find(&people(), "   ").is_none());
    }

    #[test]
    fn the_book_is_ordered_by_surname() {
        let mut sorted = people();
        sorted.sort_by_key(sort_key);
        let names: Vec<_> = sorted.iter().map(|c| c.full_name.as_str()).collect();
        assert_eq!(names, ["Sarah Connor", "Sarah Okonjo", "Alan Turing"]);
    }

    #[test]
    fn a_contact_with_no_surname_sorts_by_the_name_it_has() {
        let mut all = [
            contact("uid-4", "Acme Support", "support@acme.test", ""),
            contact("uid-2", "Alan Turing", "alan@example.com", "Turing"),
        ];
        all.sort_by_key(sort_key);
        assert_eq!(all[0].full_name, "Acme Support");
    }
}
