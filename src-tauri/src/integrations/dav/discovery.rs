//! Finding a user's calendars and address books from what they typed.
//!
//! The user types `me@fastmail.com` or `https://cloud.example.com`. Getting
//! from that to a list of collection URLs is four steps, and every server does
//! them slightly differently:
//!
//! 1. `/.well-known/caldav` (or `carddav`) on the host, following redirects
//!    (RFC 6764).
//! 2. PROPFIND for `current-user-principal` — who am I.
//! 3. PROPFIND that principal for `calendar-home-set` (or
//!    `addressbook-home-set`) — where are my collections.
//! 4. PROPFIND the home set, depth 1 — what is in it.
//!
//! The ladder is identical for both protocols; only the well-known path, the
//! home-set property and the resource type differ, which is why it is written
//! once and parameterised by [`Protocol`].
//!
//! # One account, both protocols, either missing
//!
//! Nextcloud and Fastmail serve calendars and contacts from a single login,
//! and a calendar-only server is common too. Both are discovered from one set
//! of credentials, and each is allowed to fail on its own: an account that
//! serves calendars and not contacts must show its calendars, not an error.
//!
//! # No DNS SRV lookup, deliberately
//!
//! RFC 6764 puts `_caldavs._tcp` first, and this does not implement it. Doing
//! so means adding a full DNS resolver to the tree for a branch that never
//! fires against Nextcloud, Fastmail, iCloud, Radicale, Baikal or Synology —
//! every one of which answers `.well-known`. The case SRV uniquely covers is a
//! server on a different host from the mail domain whose admin published an
//! SRV record but no `.well-known`, and a user in that position knows their
//! URL: the manual override below is the shorter path to a working account
//! than a megabyte of resolver is.
//!
//! # The manual override is an override, not a fallback
//!
//! Plenty of self-hosted setups have partial discovery. A user who knows their
//! collection URL should be able to say so and skip all of this, rather than
//! being told their own server is misconfigured.

use super::account::DavAccount;
use super::client::{DavClient, DavResponse, PRINCIPAL_BODY};

/// PROPFIND body asking a principal where its calendars live.
const CALENDAR_HOME_SET_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>"#;

/// The same, for address books.
const CONTACTS_HOME_SET_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><c:addressbook-home-set/></d:prop>
</d:propfind>"#;

/// PROPFIND body listing the address books in a home set.
const ADDRESS_BOOKS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <cs:getctag/>
  </d:prop>
</d:propfind>"#;

/// Which of the two protocols a discovery run is asking about.
///
/// Everything structural is shared; these three values are the whole of the
/// difference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    CalDav,
    CardDav,
}

impl Protocol {
    fn well_known(self) -> &'static str {
        match self {
            Protocol::CalDav => "caldav",
            Protocol::CardDav => "carddav",
        }
    }

    fn home_set_body(self) -> &'static str {
        match self {
            Protocol::CalDav => CALENDAR_HOME_SET_BODY,
            Protocol::CardDav => CONTACTS_HOME_SET_BODY,
        }
    }

    fn home_set_prop(self) -> &'static str {
        match self {
            Protocol::CalDav => "calendar-home-set",
            Protocol::CardDav => "addressbook-home-set",
        }
    }

    /// What the settings form calls the manual override, quoted back to the
    /// user in the error that suggests they use it.
    fn override_field(self) -> &'static str {
        match self {
            Protocol::CalDav => "Calendar URL",
            Protocol::CardDav => "Contacts URL",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Protocol::CalDav => "calendars",
            Protocol::CardDav => "address books",
        }
    }
}

/// PROPFIND body listing the collections in a home set, with the properties
/// worth showing the user.
const COLLECTIONS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <cs:getctag/>
    <ic:calendar-color/>
    <c:supported-calendar-component-set/>
  </d:prop>
</d:propfind>"#;

/// One address book found on the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddressBook {
    /// Absolute URL, resolved against the server the href came from.
    pub url: String,
    pub name: String,
    /// The server's change tag, same meaning as a calendar's.
    pub ctag: Option<String>,
}

/// One calendar found on the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalendarCollection {
    /// Absolute URL, resolved against the server the href came from.
    pub url: String,
    pub name: String,
    /// The server's change tag. When it has not moved, nothing in the calendar
    /// has, and a cached answer is still correct.
    pub ctag: Option<String>,
    pub color: Option<String>,
}

/// Turn whatever the user typed into a base URL to start from.
///
/// An address like `me@fastmail.com` becomes `https://fastmail.com`; a URL is
/// taken as given. HTTPS is assumed for a bare host — a calendar password over
/// plaintext HTTP is not something to do silently, and a server that genuinely
/// needs it can be reached through the manual override.
pub fn base_url(address: &str) -> Result<String, String> {
    let trimmed = address.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("no server address given".into());
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_string());
    }
    let host = trimmed.rsplit_once('@').map(|(_, h)| h).unwrap_or(trimmed);
    if host.is_empty() || host.contains('/') {
        return Err(format!("'{address}' is not a server address or URL"));
    }
    Ok(format!("https://{host}"))
}

/// Resolve an href from a multistatus response against the server it came from.
///
/// DAV servers return paths, not URLs, and the path is relative to the origin
/// rather than to the request URL — a fact that produces a 404 the first time
/// you get it wrong.
pub fn absolutize(base: &str, href: &str) -> String {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    match reqwest::Url::parse(base).and_then(|u| u.join(href)) {
        Ok(url) => url.to_string(),
        Err(_) => format!(
            "{}/{}",
            base.trim_end_matches('/'),
            href.trim_start_matches('/')
        ),
    }
}

/// Pick the calendars out of a home-set listing.
///
/// A home set contains the calendars *and itself*, both of which are
/// collections; only the ones that are also `calendar` are calendars. Listing
/// the container as a calendar gives the user an empty entry they cannot
/// explain.
///
/// Collections that do not hold events are skipped too: a CalDAV home set
/// commonly carries a `VTODO`-only task list and an inbox, and neither answers
/// "what's on this week".
pub fn calendars_from(
    base: &str,
    responses: &[DavResponse],
    components: &[Vec<String>],
) -> Vec<CalendarCollection> {
    responses
        .iter()
        .enumerate()
        .filter(|(_, r)| r.resource_types.iter().any(|t| t == "calendar"))
        .filter(|(i, _)| {
            components
                .get(*i)
                .map(|c| c.is_empty() || c.iter().any(|n| n.eq_ignore_ascii_case("VEVENT")))
                .unwrap_or(true)
        })
        .map(|(_, r)| CalendarCollection {
            url: absolutize(base, &r.href),
            name: r
                .props
                .get("displayname")
                .filter(|n| !n.trim().is_empty())
                .cloned()
                // A calendar with no display name still needs calling
                // something; its last path segment is what the server's own
                // web UI usually shows.
                .unwrap_or_else(|| last_segment(&r.href)),
            ctag: r.props.get("getctag").cloned(),
            color: r.props.get("calendar-color").cloned(),
        })
        .collect()
}

/// Pick the address books out of a home-set listing.
///
/// Same shape as `calendars_from`, and the same reason for the resource-type
/// filter: a CardDAV home set contains itself, and listing the container gives
/// the user an empty address book they cannot explain.
pub fn address_books_from(base: &str, responses: &[DavResponse]) -> Vec<AddressBook> {
    responses
        .iter()
        .filter(|r| r.resource_types.iter().any(|t| t == "addressbook"))
        .map(|r| AddressBook {
            url: absolutize(base, &r.href),
            name: r
                .props
                .get("displayname")
                .filter(|n| !n.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| last_segment_or(&r.href, "Contacts")),
            ctag: r.props.get("getctag").cloned(),
        })
        .collect()
}

fn last_segment(href: &str) -> String {
    last_segment_or(href, "Calendar")
}

fn last_segment_or(href: &str, fallback: &str) -> String {
    href.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

/// Find every calendar this account can see.
pub async fn discover_calendars(
    client: &DavClient,
    account: &DavAccount,
) -> Result<Vec<CalendarCollection>, String> {
    let base = base_url(&account.address)?;

    // The override skips discovery entirely — it exists for servers whose
    // discovery is incomplete, so running discovery first would defeat it.
    let home = match account
        .calendar_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        Some(url) => absolutize(&base, url),
        None => discover_home_set(client, &base, Protocol::CalDav).await?,
    };

    // One request, parsed twice. `supported-calendar-component-set` carries
    // its values as attributes, which the flattened response shape drops, so
    // the same document is read again for that one property — asking the
    // server twice for it would be a round trip spent on nothing.
    let raw = client.propfind_raw(&home, "1", COLLECTIONS_BODY).await?;
    let responses = super::client::parse_multistatus(&raw);
    let components = super::client::parse_supported_components(&raw);
    let calendars = calendars_from(&base, &responses, &components);

    if calendars.is_empty() {
        return Err(format!(
            "{home} answered, but no calendars were found there. \
             If you know your calendar URL, enter it under 'Calendar URL'."
        ));
    }
    Ok(calendars)
}

/// Find every address book this account can see.
pub async fn discover_address_books(
    client: &DavClient,
    account: &DavAccount,
) -> Result<Vec<AddressBook>, String> {
    let base = base_url(&account.address)?;

    let home = match account
        .contacts_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        Some(url) => absolutize(&base, url),
        None => discover_home_set(client, &base, Protocol::CardDav).await?,
    };

    let responses = client.propfind(&home, "1", ADDRESS_BOOKS_BODY).await?;
    let books = address_books_from(&base, &responses);

    if books.is_empty() {
        return Err(format!(
            "{home} answered, but no address books were found there. \
             If you know your contacts URL, enter it under 'Contacts URL'."
        ));
    }
    Ok(books)
}

/// Steps 1–3: well-known, principal, home set.
async fn discover_home_set(
    client: &DavClient,
    base: &str,
    protocol: Protocol,
) -> Result<String, String> {
    let well_known = format!("{base}/.well-known/{}", protocol.well_known());
    // A server that does not implement .well-known is common enough that its
    // absence is not an error; the root often answers the same PROPFIND.
    let entry = client
        .resolve_well_known(&well_known)
        .await
        .unwrap_or_else(|| base.to_string());

    let principal = first_prop(
        &client.propfind(&entry, "0", PRINCIPAL_BODY).await?,
        "current-user-principal",
    )
    .ok_or_else(|| {
        format!(
            "{entry} did not say which account these credentials belong to. \
             If you know your URL, enter it under '{}'.",
            protocol.override_field()
        )
    })?;

    let principal_url = absolutize(base, &principal);
    first_prop(
        &client
            .propfind(&principal_url, "0", protocol.home_set_body())
            .await?,
        protocol.home_set_prop(),
    )
    .map(|home| absolutize(base, &home))
    .ok_or_else(|| {
        format!(
            "{principal_url} did not say where its {} are. \
             If you know your URL, enter it under '{}'.",
            protocol.noun(),
            protocol.override_field()
        )
    })
}

/// The first non-empty value of a property across a multistatus response.
///
/// Servers routinely return several `<response>` elements where only one
/// carries the property, and several `<propstat>` blocks where the others are
/// 404s.
fn first_prop(responses: &[DavResponse], name: &str) -> Option<String> {
    responses
        .iter()
        .find_map(|r| r.props.get(name).filter(|v| !v.trim().is_empty()).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn response(href: &str, types: &[&str], props: &[(&str, &str)]) -> DavResponse {
        DavResponse {
            href: href.into(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<BTreeMap<_, _>>(),
            resource_types: types.iter().map(|t| t.to_string()).collect(),
            components: Vec::new(),
        }
    }

    #[test]
    fn an_email_address_becomes_its_host() {
        assert_eq!(base_url("me@fastmail.com").unwrap(), "https://fastmail.com");
        assert_eq!(base_url(" me@Example.com ").unwrap(), "https://Example.com");
    }

    #[test]
    fn a_url_is_taken_as_given() {
        assert_eq!(
            base_url("https://cloud.example.com/remote.php/dav/").unwrap(),
            "https://cloud.example.com/remote.php/dav"
        );
        // Plaintext is honoured when explicitly asked for, never assumed.
        assert_eq!(
            base_url("http://localhost:5232").unwrap(),
            "http://localhost:5232"
        );
    }

    #[test]
    fn a_bare_host_is_assumed_to_be_https() {
        // A calendar password over plaintext is not something to do silently.
        assert_eq!(
            base_url("cloud.example.com").unwrap(),
            "https://cloud.example.com"
        );
    }

    #[test]
    fn nonsense_is_rejected_rather_than_turned_into_a_url() {
        assert!(base_url("").is_err());
        assert!(base_url("   ").is_err());
        assert!(base_url("not a host/with a path").is_err());
    }

    #[test]
    fn an_href_resolves_against_the_origin_not_the_request_path() {
        // DAV servers return origin-relative paths. Joining them onto the
        // request path produces a 404 the first time you get it wrong.
        assert_eq!(
            absolutize(
                "https://cloud.example.com/remote.php/dav",
                "/remote.php/dav/calendars/tim/"
            ),
            "https://cloud.example.com/remote.php/dav/calendars/tim/"
        );
        assert_eq!(
            absolutize("https://x.test", "https://other.test/cal/"),
            "https://other.test/cal/"
        );
    }

    #[test]
    fn the_container_is_not_listed_as_a_calendar() {
        // A home set is itself a collection. Listing it gives the user an
        // empty calendar they cannot explain.
        let responses = vec![
            response(
                "/dav/cal/",
                &["collection"],
                &[("displayname", "Calendars")],
            ),
            response(
                "/dav/cal/home/",
                &["collection", "calendar"],
                &[("displayname", "Home")],
            ),
        ];
        let found = calendars_from("https://x.test", &responses, &[]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Home");
        assert_eq!(found[0].url, "https://x.test/dav/cal/home/");
    }

    #[test]
    fn a_task_only_collection_is_skipped() {
        // CalDAV home sets commonly carry a VTODO-only list; it answers no
        // question about what is on this week.
        let responses = vec![
            response(
                "/dav/cal/events/",
                &["collection", "calendar"],
                &[("displayname", "Events")],
            ),
            response(
                "/dav/cal/tasks/",
                &["collection", "calendar"],
                &[("displayname", "Tasks")],
            ),
        ];
        let components = vec![vec!["VEVENT".to_string()], vec!["VTODO".to_string()]];
        let found = calendars_from("https://x.test", &responses, &components);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Events");
    }

    #[test]
    fn a_collection_that_declares_nothing_is_kept() {
        // Some servers omit supported-calendar-component-set entirely.
        // Excluding those would hide real calendars.
        let responses = vec![response(
            "/dav/cal/home/",
            &["collection", "calendar"],
            &[("displayname", "Home")],
        )];
        assert_eq!(calendars_from("https://x.test", &responses, &[]).len(), 1);
        assert_eq!(
            calendars_from("https://x.test", &responses, &[vec![]]).len(),
            1
        );
    }

    #[test]
    fn a_nameless_calendar_falls_back_to_its_path() {
        let responses = vec![response("/dav/cal/personal/", &["calendar"], &[])];
        assert_eq!(
            calendars_from("https://x.test", &responses, &[])[0].name,
            "personal"
        );
    }

    #[test]
    fn the_change_tag_and_colour_are_carried_through() {
        let responses = vec![response(
            "/dav/cal/home/",
            &["calendar"],
            &[
                ("displayname", "Home"),
                ("getctag", "abc123"),
                ("calendar-color", "#FF2968"),
            ],
        )];
        let found = calendars_from("https://x.test", &responses, &[]);
        assert_eq!(found[0].ctag.as_deref(), Some("abc123"));
        assert_eq!(found[0].color.as_deref(), Some("#FF2968"));
    }

    #[test]
    fn the_container_is_not_listed_as_an_address_book() {
        // Same trap as the calendar home set: it is itself a collection.
        let responses = vec![
            response(
                "/dav/card/",
                &["collection"],
                &[("displayname", "Contacts")],
            ),
            response(
                "/dav/card/default/",
                &["collection", "addressbook"],
                &[("displayname", "Personal"), ("getctag", "xyz")],
            ),
        ];
        let found = address_books_from("https://x.test", &responses);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Personal");
        assert_eq!(found[0].url, "https://x.test/dav/card/default/");
        assert_eq!(found[0].ctag.as_deref(), Some("xyz"));
    }

    #[test]
    fn a_calendar_is_not_mistaken_for_an_address_book_or_the_reverse() {
        // An account serving both returns both from the same home set on some
        // servers, and each listing must take only its own.
        let responses = vec![
            response("/dav/cal/home/", &["calendar"], &[("displayname", "Home")]),
            response(
                "/dav/card/default/",
                &["addressbook"],
                &[("displayname", "Personal")],
            ),
        ];
        let books = address_books_from("https://x.test", &responses);
        let calendars = calendars_from("https://x.test", &responses, &[]);
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "Personal");
        assert_eq!(calendars.len(), 1);
        assert_eq!(calendars[0].name, "Home");
    }

    #[test]
    fn a_nameless_address_book_falls_back_to_its_path() {
        let responses = vec![response("/dav/card/default/", &["addressbook"], &[])];
        assert_eq!(
            address_books_from("https://x.test", &responses)[0].name,
            "default"
        );
    }

    #[test]
    fn each_protocol_asks_for_its_own_property() {
        // Getting these crossed produces an empty home set and a confusing
        // "no calendars found" against a server that has plenty.
        assert_eq!(Protocol::CalDav.well_known(), "caldav");
        assert_eq!(Protocol::CardDav.well_known(), "carddav");
        assert_eq!(Protocol::CalDav.home_set_prop(), "calendar-home-set");
        assert_eq!(Protocol::CardDav.home_set_prop(), "addressbook-home-set");
        assert!(Protocol::CardDav.home_set_body().contains("carddav"));
        assert!(Protocol::CalDav.home_set_body().contains("caldav"));
    }

    #[test]
    fn a_failure_names_the_settings_field_that_would_fix_it() {
        // "Enter it under 'Calendar URL'" against a contacts failure sends
        // the user to the wrong box.
        assert_eq!(Protocol::CalDav.override_field(), "Calendar URL");
        assert_eq!(Protocol::CardDav.override_field(), "Contacts URL");
    }

    #[test]
    fn a_property_is_found_wherever_in_the_multistatus_it_appears() {
        // Servers routinely return several <response> elements where only one
        // carries the property.
        let responses = vec![
            response("/a/", &[], &[]),
            response("/b/", &[], &[("calendar-home-set", "/dav/cal/")]),
        ];
        assert_eq!(
            first_prop(&responses, "calendar-home-set").as_deref(),
            Some("/dav/cal/")
        );
        assert_eq!(first_prop(&responses, "nothing-like-this"), None);
    }

    #[test]
    fn an_empty_property_is_treated_as_absent() {
        let responses = vec![response("/a/", &[], &[("calendar-home-set", "   ")])];
        assert_eq!(first_prop(&responses, "calendar-home-set"), None);
    }
}
