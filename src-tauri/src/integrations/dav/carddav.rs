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
//!
//! Google answers neither with any cards: its `addressbook-query` comes back
//! as an empty multistatus and the `PROPFIND` is a 400. What it does answer is
//! the two-step form — list the cards, then `addressbook-multiget` them — so
//! an address book that came back empty is asked that way before it is
//! believed. A genuinely empty one costs one more round trip.

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

/// The cards in an address book, by href, without their data.
const ETAG_PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>"#;

/// How many cards one multiget asks for. Keeps each request and answer to a
/// size every server accepts; a few hundred contacts is a handful of requests.
const MULTIGET_BATCH: usize = 100;

/// An `addressbook-multiget` for the given hrefs.
fn multiget_body(hrefs: &[String]) -> String {
    let mut body = String::from(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
"#,
    );
    for href in hrefs {
        body.push_str("  <d:href>");
        body.push_str(&xml_escape(href));
        body.push_str("</d:href>\n");
    }
    body.push_str("</c:addressbook-multiget>");
    body
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The card hrefs in a listing: everything but the address book itself.
fn card_hrefs(book_url: &str, responses: &[super::client::DavResponse]) -> Vec<String> {
    let own_path = url::Url::parse(book_url)
        .map(|u| u.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    responses
        .iter()
        .map(|r| r.href.clone())
        .filter(|h| h.trim_end_matches('/') != own_path && !h.ends_with('/'))
        .collect()
}

/// Ask for the cards one batch at a time, for a server that will not hand
/// them over in one query.
async fn fetch_by_multiget(
    client: &DavClient,
    book: &AddressBook,
) -> Result<Vec<super::client::DavResponse>, String> {
    let listing = client.propfind(&book.url, "1", ETAG_PROPFIND_BODY).await?;
    let hrefs = card_hrefs(&book.url, &listing);
    let mut responses = Vec::new();
    for batch in hrefs.chunks(MULTIGET_BATCH) {
        responses.extend(client.report(&book.url, "1", &multiget_body(batch)).await?);
    }
    Ok(responses)
}

/// Every contact in one address book.
pub async fn fetch_contacts(
    client: &DavClient,
    book: &AddressBook,
    source: &ContactSource,
) -> Result<Vec<Contact>, String> {
    let mut responses = match client.report(&book.url, "1", ADDRESSBOOK_QUERY_BODY).await {
        Ok(responses) => responses,
        Err(report_error) => client
            .propfind(&book.url, "1", ADDRESS_DATA_PROPFIND_BODY)
            .await
            // The REPORT's error is the one worth showing: it is the request
            // that should have worked, and a server failing both has usually
            // failed both for the same reason.
            .map_err(|_| report_error)?,
    };
    if !responses
        .iter()
        .any(|r| r.props.contains_key("address-data"))
    {
        responses = fetch_by_multiget(client, book).await?;
    }

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

    #[test]
    fn a_listing_names_the_cards_and_not_the_book() {
        let response = |href: &str| crate::integrations::dav::client::DavResponse {
            href: href.into(),
            ..Default::default()
        };
        let listing = [
            response("/carddav/v1/principals/me%40gmail.com/lists/default/"),
            response("/carddav/v1/principals/me%40gmail.com/lists/default/c1"),
            response("/carddav/v1/principals/me%40gmail.com/lists/default/c2"),
        ];
        assert_eq!(
            card_hrefs(
                "https://www.googleapis.com/carddav/v1/principals/me%40gmail.com/lists/default/",
                &listing
            ),
            [
                "/carddav/v1/principals/me%40gmail.com/lists/default/c1",
                "/carddav/v1/principals/me%40gmail.com/lists/default/c2"
            ]
        );
    }

    #[test]
    fn a_multiget_asks_for_each_card_by_href() {
        let body = multiget_body(&["/book/a".into(), "/book/b&c".into()]);
        assert!(body.contains("addressbook-multiget"));
        assert!(body.contains("<d:href>/book/a</d:href>"));
        assert!(body.contains("<d:href>/book/b&amp;c</d:href>"));
        assert!(body.contains("address-data"));
    }
}
