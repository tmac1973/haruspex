//! Google contacts, read through the People API rather than CardDAV.
//!
//! Google's CardDAV takes only the `carddav` scope, which the consent screen
//! describes as "see, edit, download, and permanently delete your contacts".
//! Haruspex only reads, and Google asks apps to request the narrowest scope
//! that does the job, so contacts come from the People API under
//! `contacts.readonly` — mapped onto the same `Contact` the CardDAV path
//! produces, so the tools cannot tell the difference.

use serde::Deserialize;
use std::time::Duration;

use super::vcard::{Contact, ContactSource, TypedValue};
use crate::proxy::{apply_proxy, ProxyConfig};

const CONNECTIONS: &str = "https://people.googleapis.com/v1/people/me/connections";
const PERSON_FIELDS: &str =
    "names,emailAddresses,phoneNumbers,addresses,organizations,birthdays,biographies,photos";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Pages of 1,000 contacts. A personal address book is a few hundred; this
/// bounds a pathological one rather than limiting a real one.
const MAX_PAGES: usize = 10;

/// What the settings card calls the one address book a Google account has.
pub const ADDRESS_BOOK_NAME: &str = "Contacts";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsPage {
    #[serde(default)]
    connections: Vec<Person>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Person {
    resource_name: String,
    names: Vec<Name>,
    email_addresses: Vec<Typed>,
    phone_numbers: Vec<Typed>,
    addresses: Vec<Address>,
    organizations: Vec<Organization>,
    birthdays: Vec<Birthday>,
    biographies: Vec<Biography>,
    photos: Vec<Photo>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Name {
    display_name: Option<String>,
    given_name: Option<String>,
    family_name: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Typed {
    value: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Address {
    formatted_value: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Organization {
    name: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Birthday {
    date: Option<Date>,
    text: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Date {
    year: Option<u32>,
    month: Option<u32>,
    day: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Biography {
    value: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Photo {
    default: bool,
}

/// Every contact in the account's "My contacts".
pub async fn fetch_contacts(
    access_token: &str,
    source: &ContactSource,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<Contact>, String> {
    let mut contacts = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = fetch_page(access_token, 1000, page_token.as_deref(), proxy).await?;
        contacts.extend(
            page.connections
                .into_iter()
                .filter_map(|p| to_contact(p, source)),
        );
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    Ok(contacts)
}

/// One small request, for the settings card's Check: it proves the token and
/// the API both work without reading the whole address book.
pub async fn check(access_token: &str, proxy: Option<&ProxyConfig>) -> Result<(), String> {
    fetch_page(access_token, 1, None, proxy).await.map(|_| ())
}

async fn fetch_page(
    access_token: &str,
    size: u32,
    page_token: Option<&str>,
    proxy: Option<&ProxyConfig>,
) -> Result<ConnectionsPage, String> {
    let mut url = url::Url::parse(CONNECTIONS).expect("the People API URL is valid");
    url.query_pairs_mut()
        .append_pair("personFields", PERSON_FIELDS)
        .append_pair("pageSize", &size.to_string());
    if let Some(token) = page_token {
        url.query_pairs_mut().append_pair("pageToken", token);
    }
    let http = apply_proxy(reqwest::Client::builder().timeout(REQUEST_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))?;
    let response = http
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Could not reach Google Contacts: {}", e.without_url()))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
        return Err(match message {
            Some(m) => format!("Google Contacts refused the request (HTTP {status}): {m}"),
            None => format!("Google Contacts answered HTTP {status}."),
        });
    }
    serde_json::from_str(&text).map_err(|_| "Google Contacts' answer could not be read.".into())
}

/// A person as a `Contact`, or `None` for one with neither a name nor any
/// way to reach them — nothing a question could be answered from.
fn to_contact(person: Person, source: &ContactSource) -> Option<Contact> {
    let name = person.names.into_iter().next().unwrap_or_default();
    let emails = typed(person.email_addresses);
    let phones = typed(person.phone_numbers);
    let full_name = name
        .display_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .or_else(|| {
            let joined = [name.given_name.as_deref(), name.family_name.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            (!joined.trim().is_empty()).then_some(joined)
        })
        .or_else(|| emails.first().map(|e| e.value.clone()))
        .or_else(|| phones.first().map(|p| p.value.clone()))?;
    let organization = person.organizations.into_iter().next().unwrap_or_default();
    Some(Contact {
        account_id: source.account_id.clone(),
        account_label: source.account_label.clone(),
        address_book: source.address_book.clone(),
        uid: person.resource_name,
        full_name,
        first_name: name.given_name,
        last_name: name.family_name,
        emails,
        phones,
        addresses: person
            .addresses
            .into_iter()
            .filter_map(|a| {
                Some(TypedValue {
                    kind: kind(a.kind),
                    value: a.formatted_value.filter(|v| !v.trim().is_empty())?,
                })
            })
            .collect(),
        organization: organization.name,
        title: organization.title,
        note: person
            .biographies
            .into_iter()
            .find_map(|b| b.value)
            .filter(|v| !v.trim().is_empty()),
        birthday: person.birthdays.into_iter().find_map(birthday),
        // Google gives every contact a generated letter avatar, marked
        // `default`; only a real photo counts.
        has_photo: person.photos.iter().any(|p| !p.default),
    })
}

fn typed(values: Vec<Typed>) -> Vec<TypedValue> {
    values
        .into_iter()
        .filter_map(|t| {
            Some(TypedValue {
                kind: kind(t.kind),
                value: t.value.filter(|v| !v.trim().is_empty())?,
            })
        })
        .collect()
}

/// Google's `type` lowercased, as the vCard path normalises `TYPE`.
fn kind(kind: Option<String>) -> Option<String> {
    kind.map(|k| k.trim().to_lowercase())
        .filter(|k| !k.is_empty())
}

/// `1980-04-01`, or `--04-01` without a year — the vCard forms the CardDAV
/// path produces.
fn birthday(b: Birthday) -> Option<String> {
    match b.date {
        Some(Date {
            year,
            month: Some(month),
            day: Some(day),
        }) => Some(match year {
            Some(year) => format!("{year:04}-{month:02}-{day:02}"),
            None => format!("--{month:02}-{day:02}"),
        }),
        _ => b.text.filter(|t| !t.trim().is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> ContactSource {
        ContactSource {
            account_id: "g".into(),
            account_label: "Google".into(),
            address_book: ADDRESS_BOOK_NAME.into(),
        }
    }

    fn parse(json: &str) -> Vec<Contact> {
        let page: ConnectionsPage = serde_json::from_str(json).unwrap();
        page.connections
            .into_iter()
            .filter_map(|p| to_contact(p, &source()))
            .collect()
    }

    #[test]
    fn a_person_maps_onto_a_contact() {
        let contacts = parse(
            r#"{"connections":[{"resourceName":"people/c123",
            "names":[{"displayName":"Sam Lee","givenName":"Sam","familyName":"Lee"}],
            "emailAddresses":[{"value":"sam@example.com","type":"work"}],
            "phoneNumbers":[{"value":"+44 7700 900000","type":"mobile"}],
            "addresses":[{"formattedValue":"1 High St, Leeds","type":"Home"}],
            "organizations":[{"name":"Acme","title":"Engineer"}],
            "birthdays":[{"date":{"month":4,"day":1}}],
            "biographies":[{"value":"Met at the conference"}],
            "photos":[{"url":"x","default":true}]}],"totalPeople":1}"#,
        );
        let c = &contacts[0];
        assert_eq!(c.uid, "people/c123");
        assert_eq!(c.full_name, "Sam Lee");
        assert_eq!(c.last_name.as_deref(), Some("Lee"));
        assert_eq!(c.emails[0].value, "sam@example.com");
        assert_eq!(c.emails[0].kind.as_deref(), Some("work"));
        assert_eq!(c.phones[0].kind.as_deref(), Some("mobile"));
        assert_eq!(c.addresses[0].kind.as_deref(), Some("home"));
        assert_eq!(c.organization.as_deref(), Some("Acme"));
        assert_eq!(c.title.as_deref(), Some("Engineer"));
        assert_eq!(c.birthday.as_deref(), Some("--04-01"));
        assert_eq!(c.note.as_deref(), Some("Met at the conference"));
        assert!(!c.has_photo, "the generated letter avatar is not a photo");
        assert_eq!(c.address_book, "Contacts");
    }

    #[test]
    fn a_nameless_contact_is_known_by_how_to_reach_them() {
        let contacts = parse(
            r#"{"connections":[{"resourceName":"people/c1",
            "emailAddresses":[{"value":"noname@example.com"}]}]}"#,
        );
        assert_eq!(contacts[0].full_name, "noname@example.com");
        assert_eq!(contacts[0].emails[0].kind, None);
    }

    #[test]
    fn a_contact_with_nothing_to_go_on_is_skipped() {
        assert!(parse(r#"{"connections":[{"resourceName":"people/c1"}]}"#).is_empty());
    }

    #[test]
    fn a_full_birthday_and_a_real_photo_are_kept() {
        let contacts = parse(
            r#"{"connections":[{"resourceName":"people/c1","names":[{"displayName":"A"}],
            "birthdays":[{"date":{"year":1980,"month":4,"day":1}}],
            "photos":[{"url":"x"}]}]}"#,
        );
        assert_eq!(contacts[0].birthday.as_deref(), Some("1980-04-01"));
        assert!(contacts[0].has_photo);
    }

    #[test]
    fn an_empty_address_book_reads_as_empty() {
        assert!(parse(r#"{"totalPeople":0}"#).is_empty());
    }
}
