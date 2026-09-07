//! Asking a calendar what is on.
//!
//! The one interesting decision here is that the **server** does the date
//! filtering, via a `calendar-query` REPORT with a `time-range` element, rather
//! than us fetching a calendar and filtering locally. A year of a busy
//! calendar is megabytes of iCalendar; "what's on Thursday" should not move
//! all of it over the wire, and on a self-hosted box behind a domestic
//! connection the difference is the answer arriving or timing out.
//!
//! Recurrence is the exception the server cannot help with. Some servers honour
//! `calendar-query`'s expansion, most do not, and the ones that do disagree
//! about edge cases — so occurrences are expanded here, in `ical.rs`, over the
//! same window that was asked for.

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use super::client::DavClient;
use super::discovery::CalendarCollection;
use super::ical::{parse_events, CalendarEvent, EventSource};

/// A `calendar-query` REPORT restricted to `VEVENT`s overlapping a window.
///
/// The `time-range` is on the `VEVENT` rather than the calendar as a whole,
/// which is what makes a server return an event that *started* before the
/// window but is still running inside it — the conference that began on Monday
/// when you ask about Wednesday.
pub fn calendar_query_body(from: DateTime<Utc>, to: DateTime<Utc>) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="{}" end="{}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>"#,
        from.format("%Y%m%dT%H%M%SZ"),
        to.format("%Y%m%dT%H%M%SZ")
    )
}

/// Every event in one calendar between `from` and `to`.
pub async fn fetch_events(
    client: &DavClient,
    calendar: &CalendarCollection,
    source: &EventSource,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    local: Tz,
) -> Result<Vec<CalendarEvent>, String> {
    let body = calendar_query_body(from, to);
    let responses = client.report(&calendar.url, "1", &body).await?;

    // Each response carries one VCALENDAR holding one event — or several, when
    // a recurring event has overrides. Parsed one at a time so a single
    // unreadable item costs that item rather than the query.
    let mut events = Vec::new();
    for response in &responses {
        if let Some(data) = response.props.get("calendar-data") {
            events.extend(parse_events(data, source, from, to, local));
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(events)
}

/// Does this event match a free-text query?
///
/// Matched over the fields a person would search by — what it was called, where
/// it was, who was there — case-insensitively, on substrings. Deliberately not
/// a ranked search: the model asked for "events mentioning Sarah" and wants all
/// of them, not the best three.
pub fn matches(event: &CalendarEvent, needle: &str) -> bool {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return true;
    }
    let haystacks = [
        Some(event.summary.as_str()),
        event.description.as_deref(),
        event.location.as_deref(),
        event.organizer.as_deref(),
    ];
    haystacks
        .iter()
        .flatten()
        .any(|h| h.to_lowercase().contains(&needle))
        || event
            .attendees
            .iter()
            .any(|a| a.to_lowercase().contains(&needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> CalendarEvent {
        CalendarEvent {
            account_id: "a".into(),
            account_label: "Work".into(),
            calendar_name: "Team".into(),
            uid: "1".into(),
            summary: "Quarterly review".into(),
            description: Some("Bring the deck".into()),
            location: Some("Room 3".into()),
            start: "2026-09-07T14:00:00Z".into(),
            end: "2026-09-07T15:00:00Z".into(),
            time_zone: None,
            all_day: false,
            organizer: Some("boss@example.com".into()),
            attendees: vec!["sarah@example.com".into(), "tim@example.com".into()],
            status: None,
            recurring: false,
        }
    }

    fn window() -> (DateTime<Utc>, DateTime<Utc>) {
        (
            DateTime::parse_from_rfc3339("2026-09-07T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            DateTime::parse_from_rfc3339("2026-09-08T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        )
    }

    #[test]
    fn the_query_asks_the_server_to_do_the_filtering() {
        // A year of a busy calendar is megabytes. "What's on Thursday" should
        // not move all of it over the wire.
        let (from, to) = window();
        let body = calendar_query_body(from, to);
        assert!(body.contains(r#"<c:time-range start="20260907T000000Z" end="20260908T000000Z"/>"#));
    }

    #[test]
    fn the_time_range_is_scoped_to_events_not_the_whole_calendar() {
        // Scoping it to VEVENT is what makes a server return the conference
        // that started on Monday when you ask about Wednesday.
        let (from, to) = window();
        let body = calendar_query_body(from, to);
        let vevent = body.find(r#"name="VEVENT""#).expect("VEVENT filter");
        let range = body.find("time-range").expect("time-range");
        assert!(vevent < range, "the range belongs inside the VEVENT filter");
    }

    #[test]
    fn the_query_asks_for_the_event_data_itself() {
        let (from, to) = window();
        assert!(calendar_query_body(from, to).contains("calendar-data"));
    }

    #[test]
    fn search_matches_the_fields_a_person_would_search_by() {
        assert!(matches(&event(), "quarterly"));
        assert!(matches(&event(), "deck"), "description");
        assert!(matches(&event(), "room 3"), "location");
        assert!(matches(&event(), "sarah"), "attendee");
        assert!(matches(&event(), "boss@example.com"), "organizer");
    }

    #[test]
    fn search_ignores_case_and_matches_substrings() {
        // "events about the review" should find "Quarterly review".
        assert!(matches(&event(), "REVIEW"));
        assert!(matches(&event(), "arterly"));
    }

    #[test]
    fn an_empty_query_matches_everything() {
        // calendar_search with no text degrades to calendar_list_events rather
        // than returning nothing.
        assert!(matches(&event(), ""));
        assert!(matches(&event(), "   "));
    }

    #[test]
    fn search_does_not_match_what_is_not_there() {
        assert!(!matches(&event(), "dentist"));
    }

    #[test]
    fn an_event_missing_optional_fields_is_still_searchable() {
        let sparse = CalendarEvent {
            description: None,
            location: None,
            organizer: None,
            attendees: Vec::new(),
            ..event()
        };
        assert!(matches(&sparse, "quarterly"));
        assert!(!matches(&sparse, "room"));
    }
}
