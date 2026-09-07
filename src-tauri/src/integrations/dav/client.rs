//! The WebDAV request layer: PROPFIND, REPORT, and enough XML to read a
//! multistatus response.
//!
//! Shared by CalDAV here and CardDAV in Phase 11 — the verbs and the response
//! shape are identical, only the properties and the report body differ.
//!
//! # Why quick-xml and not the scraper already in the tree
//!
//! `scraper` is an HTML parser. DAV is XML with meaningful namespaces, where
//! `<C:calendar-home-set>` and `<D:href>` mean different things depending on
//! what `C:` and `D:` were bound to. An HTML parser reads that as tag soup and
//! would answer confidently and wrongly.
//!
//! Namespaces are handled by matching on the **local name** rather than the
//! prefix. Servers bind `DAV:` to `d:`, `D:`, or a default namespace, and
//! Nextcloud, Fastmail and iCloud all make different choices; keying on the
//! prefix works against one server and fails against the next.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::time::Duration;

use super::account::DavAccount;
use crate::proxy::{apply_proxy, ProxyConfig};

/// Per-request timeout.
///
/// A calendar query against a year of events on a small self-hosted box is
/// genuinely slow; an unreachable host must still fail rather than hang the
/// tool call that is waiting on it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// One `<response>` from a multistatus document: the href it describes and the
/// properties that came back for it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DavResponse {
    pub href: String,
    /// Property local-name → text content. Flattened deliberately: DAV
    /// properties nest arbitrarily, and every property this integration reads
    /// is either text or a single nested href.
    pub props: std::collections::BTreeMap<String, String>,
    /// `resourcetype` children, by local name — `collection`, `calendar`,
    /// `addressbook`. How you tell a calendar from the folder holding it.
    pub resource_types: Vec<String>,
    /// `supported-calendar-component-set` children — `VEVENT`, `VTODO`.
    pub components: Vec<String>,
}

pub struct DavClient {
    http: reqwest::Client,
    auth: String,
}

impl DavClient {
    pub fn new(account: &DavAccount, proxy: Option<&ProxyConfig>) -> Result<Self, String> {
        let http = apply_proxy(
            reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                // Discovery is a chain of redirects by design: /.well-known/caldav
                // is specified to redirect, often more than once.
                .redirect(reqwest::redirect::Policy::limited(5)),
            proxy,
        )?
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))?;
        Ok(Self {
            http,
            auth: account.auth_header(),
        })
    }

    /// A PROPFIND for the named properties.
    ///
    /// `depth` is `"0"` for the resource itself and `"1"` for its children —
    /// the only two values any of this needs, and the two every server
    /// supports. Infinite depth is widely refused and never required here.
    pub async fn propfind(
        &self,
        url: &str,
        depth: &str,
        body: &str,
    ) -> Result<Vec<DavResponse>, String> {
        let response = self
            .http
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
                url,
            )
            .header("Authorization", &self.auth)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| describe_transport_error(url, &e))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() && status.as_u16() != 207 {
            return Err(describe_status(url, status.as_u16(), &text));
        }
        Ok(parse_multistatus(&text))
    }

    /// The raw body of a PROPFIND.
    ///
    /// Callers that need `supported-calendar-component-set` use this and parse
    /// the document twice: that property carries its values as attributes on
    /// empty elements, which the flattened response shape drops. Reading one
    /// document twice is cheaper than asking the server twice.
    pub async fn propfind_raw(&self, url: &str, depth: &str, body: &str) -> Result<String, String> {
        let response = self
            .http
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
                url,
            )
            .header("Authorization", &self.auth)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| describe_transport_error(url, &e))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() && status.as_u16() != 207 {
            return Err(describe_status(url, status.as_u16(), &text));
        }
        Ok(text)
    }

    /// A calendar-query or addressbook-query REPORT.
    pub async fn report(
        &self,
        url: &str,
        depth: &str,
        body: &str,
    ) -> Result<Vec<DavResponse>, String> {
        let response = self
            .http
            .request(
                reqwest::Method::from_bytes(b"REPORT").expect("REPORT is a valid method"),
                url,
            )
            .header("Authorization", &self.auth)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| describe_transport_error(url, &e))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() && status.as_u16() != 207 {
            return Err(describe_status(url, status.as_u16(), &text));
        }
        Ok(parse_multistatus(&text))
    }

    /// Follow `/.well-known/...`, which is specified to redirect.
    ///
    /// Returns the URL that answered, whether that was the original or one it
    /// was redirected to.
    pub async fn resolve_well_known(&self, url: &str) -> Option<String> {
        let response = self
            .http
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
                url,
            )
            .header("Authorization", &self.auth)
            .header("Depth", "0")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PRINCIPAL_BODY.to_string())
            .send()
            .await
            .ok()?;
        (response.status().is_success() || response.status().as_u16() == 207)
            .then(|| response.url().to_string())
    }
}

/// A failure that never reached the server, worded for someone who has just
/// typed a server address into a settings form.
fn describe_transport_error(url: &str, e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{url} did not respond in time")
    } else if e.is_connect() {
        format!("could not connect to {url}: check the address and that the server is reachable")
    } else {
        format!("request to {url} failed: {e}")
    }
}

/// A failure the server chose, named rather than dumped.
///
/// 401 is by far the most common and has one cause worth stating; the rest
/// carry the body, truncated, because a DAV error body is occasionally the only
/// thing that explains a misconfiguration.
fn describe_status(url: &str, status: u16, body: &str) -> String {
    match status {
        401 | 403 => format!(
            "{url} rejected the username or password. \
             Most servers need an app password rather than your account password."
        ),
        404 => format!("{url} was not found on this server"),
        _ => {
            let detail: String = body.chars().take(300).collect();
            let detail = detail.trim();
            if detail.is_empty() {
                format!("{url} returned HTTP {status}")
            } else {
                format!("{url} returned HTTP {status}: {detail}")
            }
        }
    }
}

/// PROPFIND body asking who the authenticated user is.
pub const PRINCIPAL_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#;

/// Parse a `multistatus` document into one entry per `<response>`.
///
/// Deliberately tolerant. A server that returns a 404 propstat alongside a 200
/// one, or that nests properties deeper than expected, should still yield what
/// it did answer — a strict parser here turns one unexpected property into a
/// calendar that cannot be listed.
pub fn parse_multistatus(xml: &str) -> Vec<DavResponse> {
    let mut reader = Reader::from_str(xml);
    // Text is NOT trimmed by the reader. `calendar-data` and `address-data`
    // carry a whole iCalendar or vCard document as character data, and an
    // escaped `&` in it — "Bob & Alice sync", "Smith & Jones" — splits that
    // document into several text events with an entity between them. Trimming
    // each piece would eat the spaces around the ampersand; values are trimmed
    // once, whole, when the response closes.
    reader.config_mut().trim_text(false);

    let mut responses: Vec<DavResponse> = Vec::new();
    let mut current: Option<DavResponse> = None;
    // The element stack, by local name, so a value can be attributed to the
    // property that contains it however deeply it nests.
    let mut stack: Vec<String> = Vec::new();
    let mut in_resource_type = false;
    let mut in_href_prop: Option<String> = None;
    // Whether the response's own href has been read. A response has exactly
    // one, and properties further down contain hrefs of their own.
    let mut href_done = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().into_inner());
                match name.as_str() {
                    "response" => {
                        current = Some(DavResponse::default());
                        href_done = false;
                    }
                    "resourcetype" => in_resource_type = true,
                    // These properties carry their value as a nested <href>
                    // rather than as text.
                    "current-user-principal" | "calendar-home-set" | "addressbook-home-set" => {
                        in_href_prop = Some(name.clone())
                    }
                    _ => {}
                }
                stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name().into_inner());
                if in_resource_type {
                    if let Some(r) = current.as_mut() {
                        r.resource_types.push(name);
                    }
                }
            }
            Ok(Event::Text(e)) => {
                let text = e.xml10_content().into_owned();
                append_text(&mut current, &stack, &in_href_prop, href_done, &text);
            }
            // `&amp;` and friends arrive as their own event, splitting the text
            // around them. Without this arm the value stops at the first
            // ampersand — which, for a calendar or an address book, means
            // losing everything after the first entry with an "&" in it.
            Ok(Event::GeneralRef(e)) => {
                let resolved = match e.resolve_char_ref() {
                    Ok(Some(c)) => c.to_string(),
                    // A named entity: the five XML predefined ones are all that
                    // may legally appear without a DTD.
                    _ => match quick_xml::escape::resolve_predefined_entity(&e.into_inner()) {
                        Some(text) => text.to_string(),
                        None => continue,
                    },
                };
                append_text(&mut current, &stack, &in_href_prop, href_done, &resolved);
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().into_inner());
                if name == "resourcetype" {
                    in_resource_type = false;
                }
                if in_href_prop.as_deref() == Some(name.as_str()) {
                    in_href_prop = None;
                }
                if name == "href" && in_href_prop.is_none() && !href_done {
                    href_done = true;
                }
                if name == "response" {
                    if let Some(mut r) = current.take() {
                        // Trimmed once, whole, now that no more of it can
                        // arrive. Empty properties — a 404 propstat's — are
                        // dropped so they do not shadow a real value.
                        r.href = r.href.trim().to_string();
                        r.props.retain(|_, v| {
                            *v = v.trim().to_string();
                            !v.is_empty()
                        });
                        responses.push(r);
                    }
                }
                stack.pop();
            }
            Ok(Event::Eof) => break,
            // A malformed document yields what was read before the break
            // rather than nothing: a server that appends junk should not cost
            // the user their calendar list.
            Err(_) => break,
            _ => {}
        }
    }
    responses
}

/// Add a run of character data to whatever element is currently open.
///
/// Called for both text and resolved entity references, so a value split by an
/// `&amp;` is reassembled rather than truncated.
fn append_text(
    current: &mut Option<DavResponse>,
    stack: &[String],
    in_href_prop: &Option<String>,
    href_done: bool,
    text: &str,
) {
    let Some(name) = stack.last() else { return };
    let Some(r) = current.as_mut() else { return };
    match name.as_str() {
        // An <href> means different things depending on where it sits: the
        // response's own path, or the value of a property like
        // calendar-home-set.
        "href" => match in_href_prop {
            Some(prop) => r.props.entry(prop.clone()).or_default().push_str(text),
            None if !href_done => r.href.push_str(text),
            None => {}
        },
        "comp" => {}
        _ => r.props.entry(name.clone()).or_default().push_str(text),
    }
}

/// Component names from `supported-calendar-component-set`, which carries them
/// as attributes on empty `<comp>` elements rather than as text.
pub fn parse_supported_components(xml: &str) -> Vec<Vec<String>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut all = Vec::new();
    let mut current: Vec<String> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if local_name(e.name().into_inner()) == "response" => {
                current = Vec::new();
            }
            Ok(Event::Empty(e)) | Ok(Event::Start(e))
                if local_name(e.name().into_inner()) == "comp" =>
            {
                if let Some(name) = e
                    .attributes()
                    .flatten()
                    .find(|a| local_name(a.key.into_inner()) == "name")
                {
                    current.push(name.value.to_string());
                }
            }
            Ok(Event::End(e)) if local_name(e.name().into_inner()) == "response" => {
                all.push(std::mem::take(&mut current));
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    all
}

/// The part of a qualified name after the prefix.
///
/// Servers bind `DAV:` to `d:`, `D:` or a default namespace, and match on the
/// prefix works against one server and fails against the next.
fn local_name(raw: impl AsRef<[u8]>) -> String {
    let name = String::from_utf8_lossy(raw.as_ref()).into_owned();
    name.rsplit(':')
        .next()
        .unwrap_or(&name)
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_escaped_ampersand_does_not_truncate_the_data_it_sits_in() {
        // The bug this guards: quick-xml reports `&amp;` as its own event,
        // splitting the character data around it. Keeping only the first piece
        // silently loses every contact after the first "Smith & Jones" — and
        // every event after the first "Bob & Alice sync".
        let xml = concat!(
            r#"<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">"#,
            "<response><href>/a.vcf</href><propstat><prop><c:address-data>",
            "BEGIN:VCARD\nFN:Smith &amp; Jones\nORG:A &amp; B Ltd\nEND:VCARD\n",
            "</c:address-data></prop></propstat></response></multistatus>"
        );
        let responses = parse_multistatus(xml);
        let data = responses[0]
            .props
            .get("address-data")
            .expect("address-data");
        assert!(data.contains("FN:Smith & Jones"), "got {data:?}");
        assert!(data.contains("ORG:A & B Ltd"), "got {data:?}");
        assert!(data.ends_with("END:VCARD"), "got {data:?}");
    }

    #[test]
    fn the_spaces_around_an_entity_survive() {
        // The reason the reader no longer trims each text event: trimming the
        // pieces either side of the entity would join them as "Smith&Jones".
        let xml = concat!(
            r#"<multistatus xmlns="DAV:"><response><href>/c/</href>"#,
            "<propstat><prop><displayname>Smith &amp; Jones</displayname>",
            "</prop></propstat></response></multistatus>"
        );
        assert_eq!(
            parse_multistatus(xml)[0].props.get("displayname").unwrap(),
            "Smith & Jones"
        );
    }

    #[test]
    fn a_numeric_character_reference_is_resolved_too() {
        // Servers escape newlines inside calendar data as &#13;.
        let xml = concat!(
            r#"<multistatus xmlns="DAV:"><response><href>/c/</href>"#,
            "<propstat><prop><displayname>a&#38;b</displayname>",
            "</prop></propstat></response></multistatus>"
        );
        assert_eq!(
            parse_multistatus(xml)[0].props.get("displayname").unwrap(),
            "a&b"
        );
    }

    #[test]
    fn an_empty_property_does_not_shadow_the_real_one() {
        // Servers answer a multiget with a 200 propstat and a 404 propstat, and
        // the empty element in the second must not blank the first.
        let xml = concat!(
            r#"<multistatus xmlns="DAV:"><response><href>/c/</href>"#,
            "<propstat><prop><displayname>Home</displayname></prop>",
            "<status>HTTP/1.1 200 OK</status></propstat>",
            "<propstat><prop><getctag/></prop>",
            "<status>HTTP/1.1 404 Not Found</status></propstat>",
            "</response></multistatus>"
        );
        let response = &parse_multistatus(xml)[0];
        assert_eq!(response.props.get("displayname").unwrap(), "Home");
        assert!(!response.props.contains_key("getctag"));
    }

    #[test]
    fn the_responses_own_href_is_not_overwritten_by_one_inside_a_property() {
        let xml = concat!(
            r#"<multistatus xmlns="DAV:"><response><href>/principals/tim/</href>"#,
            "<propstat><prop><current-user-principal><href>/principals/other/</href>",
            "</current-user-principal></prop></propstat></response></multistatus>"
        );
        let response = &parse_multistatus(xml)[0];
        assert_eq!(response.href, "/principals/tim/");
        assert_eq!(
            response.props.get("current-user-principal").unwrap(),
            "/principals/other/"
        );
    }

    /// A Nextcloud-shaped principal response: lowercase `d:` prefix.
    const NEXTCLOUD_PRINCIPAL: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/</d:href>
    <d:propstat>
      <d:prop><d:current-user-principal><d:href>/remote.php/dav/principals/users/tim/</d:href></d:current-user-principal></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

    /// Fastmail-shaped: uppercase `D:` prefix, different namespace prefixes.
    const FASTMAIL_HOME_SET: &str = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/principals/user/me@fastmail.com/</D:href>
    <D:propstat>
      <D:prop><C:calendar-home-set><D:href>/dav/calendars/user/me@fastmail.com/</D:href></C:calendar-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    /// iCloud-shaped: a default DAV namespace with no prefix at all.
    const ICLOUD_COLLECTIONS: &str = r#"<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <response>
    <href>/123/calendars/home/</href>
    <propstat>
      <prop>
        <displayname>Home</displayname>
        <resourcetype><collection/><cal:calendar/></resourcetype>
        <ic:calendar-color>#FF2968</ic:calendar-color>
        <getctag>HwoQEgwAAAh4AAAAAA==</getctag>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/123/calendars/</href>
    <propstat>
      <prop>
        <displayname>Calendars</displayname>
        <resourcetype><collection/></resourcetype>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>"#;

    #[test]
    fn a_lowercase_dav_prefix_parses() {
        let responses = parse_multistatus(NEXTCLOUD_PRINCIPAL);
        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].href, "/remote.php/dav/");
        assert_eq!(
            responses[0]
                .props
                .get("current-user-principal")
                .map(String::as_str),
            Some("/remote.php/dav/principals/users/tim/")
        );
    }

    #[test]
    fn an_uppercase_prefix_parses_the_same_way() {
        // Servers bind DAV: to whatever they like. Keying on the prefix works
        // against one server and fails against the next.
        let responses = parse_multistatus(FASTMAIL_HOME_SET);
        assert_eq!(
            responses[0]
                .props
                .get("calendar-home-set")
                .map(String::as_str),
            Some("/dav/calendars/user/me@fastmail.com/")
        );
    }

    #[test]
    fn a_default_namespace_with_no_prefix_parses_too() {
        let responses = parse_multistatus(ICLOUD_COLLECTIONS);
        assert_eq!(responses.len(), 2);
        assert_eq!(
            responses[0].props.get("displayname").map(String::as_str),
            Some("Home")
        );
    }

    #[test]
    fn a_calendar_is_distinguishable_from_the_folder_holding_it() {
        // Both are collections. Only one is a calendar, and listing the folder
        // as a calendar produces an empty calendar the user cannot explain.
        let responses = parse_multistatus(ICLOUD_COLLECTIONS);
        assert!(responses[0]
            .resource_types
            .contains(&"calendar".to_string()));
        assert!(responses[0]
            .resource_types
            .contains(&"collection".to_string()));
        assert!(!responses[1]
            .resource_types
            .contains(&"calendar".to_string()));
    }

    #[test]
    fn the_responses_own_href_is_not_confused_with_a_property_href() {
        // Both are <href>. Which one it is depends on what contains it.
        let responses = parse_multistatus(FASTMAIL_HOME_SET);
        assert_eq!(responses[0].href, "/dav/principals/user/me@fastmail.com/");
        assert_ne!(
            responses[0]
                .props
                .get("calendar-home-set")
                .map(String::as_str),
            Some(responses[0].href.as_str())
        );
    }

    #[test]
    fn extra_properties_are_carried_rather_than_dropped() {
        let responses = parse_multistatus(ICLOUD_COLLECTIONS);
        assert_eq!(
            responses[0].props.get("calendar-color").map(String::as_str),
            Some("#FF2968")
        );
        assert!(responses[0].props.contains_key("getctag"));
    }

    #[test]
    fn supported_components_come_from_attributes_not_text() {
        let xml = r#"<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
          <response><href>/c/</href><propstat><prop>
            <c:supported-calendar-component-set><c:comp name="VEVENT"/><c:comp name="VTODO"/></c:supported-calendar-component-set>
          </prop></propstat></response>
        </multistatus>"#;
        assert_eq!(
            parse_supported_components(xml),
            vec![vec!["VEVENT".to_string(), "VTODO".to_string()]]
        );
    }

    #[test]
    fn a_truncated_document_yields_what_was_read_rather_than_nothing() {
        // A server that appends junk, or a connection cut mid-stream, should
        // not cost the user their whole calendar list.
        let truncated = &ICLOUD_COLLECTIONS[..ICLOUD_COLLECTIONS.len() / 2];
        let _ = parse_multistatus(truncated);
        let with_junk = format!("{ICLOUD_COLLECTIONS}<<<not xml");
        assert_eq!(parse_multistatus(&with_junk).len(), 2);
    }

    #[test]
    fn an_empty_or_unrelated_document_yields_nothing() {
        assert!(parse_multistatus("").is_empty());
        assert!(parse_multistatus("<html><body>hello</body></html>").is_empty());
    }

    #[test]
    fn an_auth_failure_names_the_app_password_because_that_is_usually_it() {
        let message = describe_status("https://dav.example.com/", 401, "");
        assert!(message.contains("app password"), "got {message}");
        assert!(describe_status("https://x/", 403, "").contains("app password"));
    }

    #[test]
    fn other_statuses_carry_the_servers_own_explanation_truncated() {
        let long = "x".repeat(1000);
        let message = describe_status("https://x/", 500, &long);
        assert!(message.contains("HTTP 500"));
        assert!(message.len() < 400, "the body is truncated, not dumped");

        assert_eq!(
            describe_status("https://x/y", 404, ""),
            "https://x/y was not found on this server"
        );
    }
}
