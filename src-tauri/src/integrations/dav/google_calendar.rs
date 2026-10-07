//! Google calendars, read through the Calendar API rather than CalDAV.
//!
//! Google's CalDAV lists calendars for a read-only token but refuses to hand
//! over events without full read-write access — a consent screen asking to
//! "see, edit, share and permanently delete" calendars, for a feature that
//! only reads. The Calendar API serves events under `calendar.readonly`, and
//! does the window filtering and recurrence expansion itself
//! (`singleEvents=true`), so this maps its JSON straight onto the same
//! `CalendarEvent` the CalDAV path produces. Contacts stay on CardDAV.

use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use std::time::Duration;

use super::ical::{all_day_start, CalendarEvent, EventSource};
use crate::proxy::{apply_proxy, ProxyConfig};

const API: &str = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Pages of events per calendar per query. 2,500 events a page; past this the
/// window is not a question anyone is asking.
const MAX_PAGES: usize = 4;

/// One calendar on the account's calendar list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoogleCalendar {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarList {
    #[serde(default)]
    items: Vec<CalendarListEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalendarListEntry {
    id: String,
    summary: Option<String>,
    summary_override: Option<String>,
    background_color: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsPage {
    #[serde(default)]
    items: Vec<ApiEvent>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEvent {
    id: String,
    #[serde(rename = "iCalUID")]
    ical_uid: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    start: Option<When>,
    end: Option<When>,
    organizer: Option<Person>,
    #[serde(default)]
    attendees: Vec<Person>,
    recurring_event_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct When {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize)]
struct Person {
    email: Option<String>,
}

/// The calendars this account can read.
pub async fn list_calendars(
    access_token: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<GoogleCalendar>, String> {
    let list: CalendarList = get_json(
        &format!("{API}/users/me/calendarList?minAccessRole=reader"),
        access_token,
        proxy,
    )
    .await?;
    Ok(list
        .items
        .into_iter()
        .map(|c| GoogleCalendar {
            name: c
                .summary_override
                .or(c.summary)
                .unwrap_or_else(|| c.id.clone()),
            id: c.id,
            color: c.background_color,
        })
        .collect())
}

/// Every event occurrence in one calendar between `from` and `to`.
pub async fn fetch_events(
    access_token: &str,
    calendar: &GoogleCalendar,
    source: &EventSource,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    local: Tz,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<CalendarEvent>, String> {
    let mut events = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = url::Url::parse(&format!(
            "{API}/calendars/{}/events",
            urlencoding::encode(&calendar.id)
        ))
        .map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("timeMin", &from.to_rfc3339())
            .append_pair("timeMax", &to.to_rfc3339())
            .append_pair("singleEvents", "true")
            .append_pair("orderBy", "startTime")
            .append_pair("maxResults", "2500");
        if let Some(token) = &page_token {
            url.query_pairs_mut().append_pair("pageToken", token);
        }
        let page: EventsPage = get_json(url.as_str(), access_token, proxy).await?;
        events.extend(
            page.items
                .into_iter()
                .filter_map(|e| to_event(e, source, local)),
        );
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    Ok(events)
}

/// One API event as a `CalendarEvent`, or `None` for a cancelled occurrence
/// or one with no start we can read.
fn to_event(event: ApiEvent, source: &EventSource, local: Tz) -> Option<CalendarEvent> {
    if event.status.as_deref() == Some("cancelled") {
        return None;
    }
    let start = event.start?;
    let all_day = start.date_time.is_none();
    let start_at = instant(&start, local)?;
    let end_at = event
        .end
        .as_ref()
        .and_then(|e| instant(e, local))
        .filter(|e| *e >= start_at)
        .unwrap_or(start_at);
    Some(CalendarEvent {
        account_id: source.account_id.clone(),
        account_label: source.account_label.clone(),
        calendar_name: source.calendar_name.clone(),
        uid: event.ical_uid.unwrap_or(event.id),
        summary: event.summary.unwrap_or_default(),
        description: event.description.filter(|s| !s.trim().is_empty()),
        location: event.location.filter(|s| !s.trim().is_empty()),
        start: start_at.with_timezone(&local).to_rfc3339(),
        end: end_at.with_timezone(&local).to_rfc3339(),
        time_zone: start.time_zone,
        all_day,
        organizer: event.organizer.and_then(|p| p.email),
        attendees: event
            .attendees
            .into_iter()
            .filter_map(|p| p.email)
            .collect(),
        status: event.status.map(|s| s.to_ascii_uppercase()),
        recurring: event.recurring_event_id.is_some(),
    })
}

/// A start or end as an instant. All-day dates are midnight in the user's
/// zone, as the CalDAV path reads them.
fn instant(when: &When, local: Tz) -> Option<DateTime<Utc>> {
    if let Some(dt) = &when.date_time {
        return DateTime::parse_from_rfc3339(dt)
            .ok()
            .map(|d| d.with_timezone(&Utc));
    }
    let date = NaiveDate::parse_from_str(when.date.as_deref()?, "%Y-%m-%d").ok()?;
    all_day_start(date, local)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    url: &str,
    access_token: &str,
    proxy: Option<&ProxyConfig>,
) -> Result<T, String> {
    let http = apply_proxy(reqwest::Client::builder().timeout(REQUEST_TIMEOUT), proxy)?
        .build()
        .map_err(|e| format!("could not create an HTTP client: {e}"))?;
    let response = http
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Could not reach Google Calendar: {}", e.without_url()))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(describe_error(status.as_u16(), &text));
    }
    serde_json::from_str(&text).map_err(|_| "Google Calendar's answer could not be read.".into())
}

/// Google's own message, which names the actual cause ("API has not been
/// used in project …", "insufficient permissions") better than a status code.
fn describe_error(status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string));
    match message {
        Some(m) => format!("Google Calendar refused the request (HTTP {status}): {m}"),
        None => format!("Google Calendar answered HTTP {status}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> EventSource {
        EventSource {
            account_id: "g".into(),
            account_label: "Google".into(),
            calendar_name: "Personal".into(),
        }
    }

    fn parse(json: &str) -> Vec<CalendarEvent> {
        let page: EventsPage = serde_json::from_str(json).unwrap();
        page.items
            .into_iter()
            .filter_map(|e| to_event(e, &source(), chrono_tz::Europe::London))
            .collect()
    }

    #[test]
    fn a_timed_occurrence_maps_onto_a_calendar_event() {
        let events = parse(
            r#"{"items":[{"id":"abc_20261006T090000Z","iCalUID":"abc@google.com",
            "status":"confirmed","summary":"Standup","location":"Room 3",
            "start":{"dateTime":"2026-10-06T10:00:00+01:00","timeZone":"Europe/London"},
            "end":{"dateTime":"2026-10-06T10:15:00+01:00","timeZone":"Europe/London"},
            "organizer":{"email":"boss@example.com"},
            "attendees":[{"email":"me@example.com"},{"email":"sam@example.com"}],
            "recurringEventId":"abc"}]}"#,
        );
        let e = &events[0];
        assert_eq!(e.uid, "abc@google.com", "the series' iCal UID, like CalDAV");
        assert_eq!(e.start, "2026-10-06T10:00:00+01:00");
        assert_eq!(e.end, "2026-10-06T10:15:00+01:00");
        assert!(!e.all_day);
        assert!(e.recurring);
        assert_eq!(e.status.as_deref(), Some("CONFIRMED"));
        assert_eq!(e.attendees, ["me@example.com", "sam@example.com"]);
        assert_eq!(e.calendar_name, "Personal");
    }

    #[test]
    fn an_all_day_event_starts_at_local_midnight() {
        let events = parse(
            r#"{"items":[{"id":"x","summary":"Holiday",
            "start":{"date":"2026-12-25"},"end":{"date":"2026-12-26"}}]}"#,
        );
        assert!(events[0].all_day);
        assert_eq!(events[0].start, "2026-12-25T00:00:00+00:00");
        assert_eq!(events[0].end, "2026-12-26T00:00:00+00:00");
        assert!(!events[0].recurring);
    }

    #[test]
    fn a_cancelled_occurrence_is_dropped() {
        let events =
            parse(r#"{"items":[{"id":"x","status":"cancelled","start":{"date":"2026-12-25"}}]}"#);
        assert!(events.is_empty());
    }

    #[test]
    fn googles_own_error_message_is_kept() {
        let err = describe_error(
            403,
            r#"{"error":{"code":403,"message":"Google Calendar API has not been used in project 1 before or it is disabled."}}"#,
        );
        assert!(err.contains("has not been used"), "{err}");
    }
}
