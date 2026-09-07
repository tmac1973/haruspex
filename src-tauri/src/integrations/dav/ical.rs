//! iCalendar → a flat shape the model can reason about.
//!
//! Everything here exists because a language model should never be handed raw
//! iCalendar. A `VEVENT` carrying `RRULE:FREQ=WEEKLY;BYDAY=TU` plus two
//! `EXDATE`s and a `RECURRENCE-ID` override is a small program, and asking a
//! model to execute it is a wrong answer waiting to happen — silently wrong,
//! on a question about the user's actual week.
//!
//! So recurrence is expanded here, over the window that was asked for, and what
//! comes out is a list of concrete occurrences with real start and end times.
//!
//! # Malformed input is skipped, never fatal
//!
//! One unparseable event in a calendar of four hundred must not fail the query.
//! Real calendars accumulate junk from a decade of clients, and "your calendar
//! could not be read" is a much worse answer than a list missing one entry.

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

/// One concrete occurrence of an event, in the window that was requested.
///
/// Flat, like `EmailListing` — no nested components, no recurrence rules, no
/// iCalendar vocabulary. The model gets facts it can answer questions from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    /// The account this came from — the opaque UUID, echoed back verbatim.
    pub account_id: String,
    /// Its human label, so the model can match "my work calendar" without a
    /// separate lookup.
    pub account_label: String,
    /// The calendar within that account.
    pub calendar_name: String,

    /// `UID` from the source event. Shared by every occurrence of a recurring
    /// event, so it identifies the series rather than the instance.
    pub uid: String,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,

    /// RFC 3339, in the user's local zone. The same convention `EmailListing`
    /// uses for dates.
    pub start: String,
    pub end: String,
    /// The zone the event was authored in, kept because "3pm Tokyo time" is
    /// sometimes the answer even after conversion.
    pub time_zone: Option<String>,

    /// All-day events have no meaningful time of day. Flagged rather than
    /// inferred from a midnight start, which a real timed event can also have.
    pub all_day: bool,

    pub organizer: Option<String>,
    #[serde(default)]
    pub attendees: Vec<String>,
    /// `CONFIRMED`, `TENTATIVE`, `CANCELLED`, when the event said.
    pub status: Option<String>,
    /// True when this occurrence came from a recurrence rule rather than being
    /// a one-off. Useful context for a model asked "is this every week?".
    pub recurring: bool,
}

/// Where the event came from, threaded through so every occurrence can name it.
#[derive(Clone, Debug)]
pub struct EventSource {
    pub account_id: String,
    pub account_label: String,
    pub calendar_name: String,
}

/// The most occurrences one recurring event may contribute to a window.
///
/// A daily rule over a year is 365 legitimate occurrences; a malformed or
/// hostile one (`FREQ=SECONDLY`) is unbounded. The cap is high enough that no
/// realistic calendar hits it and low enough that a bad rule cannot exhaust
/// memory answering "what's on this week".
const MAX_OCCURRENCES_PER_EVENT: usize = 1000;

/// Parse an iCalendar document into concrete occurrences within `[from, to)`.
///
/// `local` is the zone times are converted into — the user's, resolved once by
/// the caller rather than read from the environment here, so tests are not at
/// the mercy of the machine running them.
pub fn parse_events(
    ics: &str,
    source: &EventSource,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    local: Tz,
) -> Vec<CalendarEvent> {
    let mut out = Vec::new();
    let reader = ical::IcalParser::new(std::io::Cursor::new(ics.as_bytes()));
    for calendar in reader.flatten() {
        for event in &calendar.events {
            // A single bad VEVENT is skipped; the rest of the calendar still
            // answers the question.
            out.extend(expand_event(event, source, from, to, local));
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start));
    out
}

/// The properties we care about, pulled out of ical's untyped property list.
struct RawEvent {
    uid: String,
    summary: String,
    description: Option<String>,
    location: Option<String>,
    organizer: Option<String>,
    attendees: Vec<String>,
    status: Option<String>,
    dtstart: String,
    dtstart_tzid: Option<String>,
    dtstart_is_date: bool,
    dtend: Option<String>,
    dtend_is_date: bool,
    duration: Option<String>,
    rrule: Option<String>,
    exdates: Vec<String>,
}

fn read_raw(event: &ical::parser::ical::component::IcalEvent) -> Option<RawEvent> {
    let mut raw = RawEvent {
        uid: String::new(),
        summary: String::new(),
        description: None,
        location: None,
        organizer: None,
        attendees: Vec::new(),
        status: None,
        dtstart: String::new(),
        dtstart_tzid: None,
        dtstart_is_date: false,
        dtend: None,
        dtend_is_date: false,
        duration: None,
        rrule: None,
        exdates: Vec::new(),
    };

    for prop in &event.properties {
        let value = prop.value.clone().unwrap_or_default();
        let params = prop.params.as_ref();
        let param = |name: &str| -> Option<String> {
            params.and_then(|ps| {
                ps.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(name))
                    .and_then(|(_, v)| v.first().cloned())
            })
        };
        match prop.name.to_ascii_uppercase().as_str() {
            "UID" => raw.uid = value,
            "SUMMARY" => raw.summary = value,
            "DESCRIPTION" => raw.description = non_empty(value),
            "LOCATION" => raw.location = non_empty(value),
            "ORGANIZER" => raw.organizer = non_empty(strip_mailto(&value)),
            "ATTENDEE" => {
                if let Some(a) = non_empty(strip_mailto(&value)) {
                    raw.attendees.push(a);
                }
            }
            "STATUS" => raw.status = non_empty(value),
            "DTSTART" => {
                raw.dtstart_is_date =
                    param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
                raw.dtstart_tzid = param("TZID");
                raw.dtstart = value;
            }
            "DTEND" => {
                raw.dtend_is_date = param("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE"));
                raw.dtend = non_empty(value);
            }
            "DURATION" => raw.duration = non_empty(value),
            "RRULE" => raw.rrule = non_empty(value),
            "EXDATE" => raw.exdates.push(value),
            _ => {}
        }
    }

    // An event with no start is not an event. Everything else can be missing.
    (!raw.dtstart.is_empty()).then_some(raw)
}

fn non_empty(s: String) -> Option<String> {
    (!s.trim().is_empty()).then_some(s)
}

/// `mailto:someone@example.com` → `someone@example.com`.
///
/// Attendees and organizers are almost always mailto URIs, and the scheme is
/// noise to a model being asked "who is coming".
fn strip_mailto(value: &str) -> String {
    value
        .strip_prefix("mailto:")
        .or_else(|| value.strip_prefix("MAILTO:"))
        .unwrap_or(value)
        .to_string()
}

/// Parse an iCalendar date-time in any of the three forms it takes.
///
/// `20260907T140000Z` (UTC), `20260907T140000` with a `TZID` parameter (that
/// zone), and bare local time with neither (floating — treated as the user's
/// zone, which is what every client does).
fn parse_datetime(value: &str, tzid: Option<&str>, local: Tz) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Some(stripped) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some(Utc.from_utc_datetime(&naive));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    let zone: Tz = tzid.and_then(|t| t.parse().ok()).unwrap_or(local);
    // A local time can be ambiguous (the hour that repeats when DST ends) or
    // non-existent (the hour that is skipped when it starts). Taking the
    // earliest candidate matches what calendar clients do, and refusing would
    // drop a real event.
    zone.from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Parse a `VALUE=DATE` value: `20260907`.
fn parse_date(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(value.trim(), "%Y%m%d").ok()
}

/// An all-day event's start, as an instant in the user's zone.
fn all_day_start(date: NaiveDate, local: Tz) -> Option<DateTime<Utc>> {
    local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Parse an iCalendar `DURATION` (`PT1H30M`, `P1D`, `-PT15M`).
fn parse_duration(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (sign, rest) = match value.strip_prefix('-') {
        Some(rest) => (-1i64, rest),
        None => (1i64, value.strip_prefix('+').unwrap_or(value)),
    };
    let rest = rest.strip_prefix('P')?;
    let (date_part, time_part) = match rest.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (rest, None),
    };

    let mut seconds = 0i64;
    let mut number = String::new();
    for ch in date_part.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
            continue;
        }
        let n: i64 = number.parse().ok()?;
        number.clear();
        seconds += match ch {
            'W' => n * 7 * 86_400,
            'D' => n * 86_400,
            _ => return None,
        };
    }
    if let Some(time_part) = time_part {
        for ch in time_part.chars() {
            if ch.is_ascii_digit() {
                number.push(ch);
                continue;
            }
            let n: i64 = number.parse().ok()?;
            number.clear();
            seconds += match ch {
                'H' => n * 3600,
                'M' => n * 60,
                'S' => n,
                _ => return None,
            };
        }
    }
    number.is_empty().then(|| Duration::seconds(sign * seconds))
}

/// Every occurrence of one `VEVENT` that falls inside the window.
fn expand_event(
    event: &ical::parser::ical::component::IcalEvent,
    source: &EventSource,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    local: Tz,
) -> Vec<CalendarEvent> {
    let Some(raw) = read_raw(event) else {
        return Vec::new();
    };

    let Some((start, anchor)) = event_start(&raw, local) else {
        // A start we cannot read means we cannot place the event on a day, so
        // it is skipped rather than guessed at.
        return Vec::new();
    };

    let length = event_length(&raw, start, local);
    let excluded = exdates(&raw, local);
    let starts = occurrence_starts(&raw, start, &anchor, from, to);

    starts
        .into_iter()
        .filter(|s| !excluded.iter().any(|e| e == s))
        .filter(|s| *s + length > from && *s < to)
        .map(|occurrence| CalendarEvent {
            account_id: source.account_id.clone(),
            account_label: source.account_label.clone(),
            calendar_name: source.calendar_name.clone(),
            uid: raw.uid.clone(),
            summary: raw.summary.clone(),
            description: raw.description.clone(),
            location: raw.location.clone(),
            start: occurrence.with_timezone(&local).to_rfc3339(),
            end: (occurrence + length).with_timezone(&local).to_rfc3339(),
            time_zone: raw.dtstart_tzid.clone(),
            all_day: raw.dtstart_is_date,
            organizer: raw.organizer.clone(),
            attendees: raw.attendees.clone(),
            status: raw.status.clone(),
            recurring: raw.rrule.is_some(),
        })
        .collect()
}

/// Where a recurrence rule is anchored: the wall-clock time it repeats at, and
/// the zone that wall clock belongs to.
///
/// Both halves matter. Expanding a rule in UTC keeps the *UTC* time constant,
/// which silently moves a 09:00 meeting to 10:00 for the half of the year on
/// the other side of a daylight-saving change. Calendars mean the wall clock.
struct RecurrenceAnchor {
    naive: NaiveDateTime,
    /// `None` for an event authored in UTC (`...Z`), which has no wall clock to
    /// preserve and must not be re-anchored to the reader's zone.
    zone: Option<Tz>,
}

/// The event's first instant, plus what a recurrence rule should repeat from.
fn event_start(raw: &RawEvent, local: Tz) -> Option<(DateTime<Utc>, RecurrenceAnchor)> {
    if raw.dtstart_is_date {
        let date = parse_date(&raw.dtstart)?;
        return Some((
            all_day_start(date, local)?,
            RecurrenceAnchor {
                naive: date.and_hms_opt(0, 0, 0)?,
                zone: Some(local),
            },
        ));
    }
    let value = raw.dtstart.trim();
    if let Some(stripped) = value.strip_suffix('Z') {
        let naive = NaiveDateTime::parse_from_str(stripped, "%Y%m%dT%H%M%S").ok()?;
        return Some((
            Utc.from_utc_datetime(&naive),
            RecurrenceAnchor { naive, zone: None },
        ));
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S").ok()?;
    let zone: Tz = raw
        .dtstart_tzid
        .as_deref()
        .and_then(|t| t.parse().ok())
        .unwrap_or(local);
    let start = zone
        .from_local_datetime(&naive)
        .earliest()?
        .with_timezone(&Utc);
    Some((
        start,
        RecurrenceAnchor {
            naive,
            zone: Some(zone),
        },
    ))
}

/// How long the event lasts, from `DTEND`, `DURATION`, or the defaults the
/// spec gives when neither is present.
fn event_length(raw: &RawEvent, start: DateTime<Utc>, local: Tz) -> Duration {
    if let Some(dtend) = &raw.dtend {
        let end = if raw.dtend_is_date {
            parse_date(dtend).and_then(|d| all_day_start(d, local))
        } else {
            parse_datetime(dtend, raw.dtstart_tzid.as_deref(), local)
        };
        if let Some(end) = end {
            if end > start {
                return end - start;
            }
        }
    }
    if let Some(duration) = raw.duration.as_deref().and_then(parse_duration) {
        if duration > Duration::zero() {
            return duration;
        }
    }
    // RFC 5545: an all-day event with no end is one day; a timed one is
    // instantaneous. A zero-length timed event still shows on the right day,
    // which is what the question is usually about.
    if raw.dtstart_is_date {
        Duration::days(1)
    } else {
        Duration::zero()
    }
}

/// Instants excluded by `EXDATE`.
fn exdates(raw: &RawEvent, local: Tz) -> Vec<DateTime<Utc>> {
    raw.exdates
        .iter()
        .flat_map(|line| line.split(','))
        .filter_map(|value| {
            if raw.dtstart_is_date {
                parse_date(value).and_then(|d| all_day_start(d, local))
            } else {
                parse_datetime(value, raw.dtstart_tzid.as_deref(), local)
            }
        })
        .collect()
}

/// The start instants this event contributes, expanding `RRULE` when present.
///
/// A rule we cannot parse degrades to the single original occurrence rather
/// than dropping the event: a weekly meeting shown once is wrong, but a weekly
/// meeting shown never is worse.
fn occurrence_starts(
    raw: &RawEvent,
    start: DateTime<Utc>,
    anchor: &RecurrenceAnchor,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Vec<DateTime<Utc>> {
    let Some(rule) = &raw.rrule else {
        return vec![start];
    };
    // Anchored in the event's own zone so every occurrence keeps its wall-clock
    // time. `DTSTART;TZID=America/New_York:20261026T090000` expands to 09:00
    // local on both sides of the November change; the same rule expressed in
    // UTC would put half the year at 10:00.
    let stamp = anchor.naive.format("%Y%m%dT%H%M%S");
    let dtstart = match anchor.zone {
        Some(zone) => format!("DTSTART;TZID={zone}:{stamp}"),
        None => format!("DTSTART:{stamp}Z"),
    };
    let parsed = format!("{dtstart}\nRRULE:{rule}")
        .parse::<rrule::RRuleSet>()
        .map(|set| {
            set.after(from.with_timezone(&rrule::Tz::UTC))
                .before(to.with_timezone(&rrule::Tz::UTC))
        });
    match parsed {
        Ok(set) => set
            .all(MAX_OCCURRENCES_PER_EVENT as u16)
            .dates
            .into_iter()
            .map(|d| d.with_timezone(&Utc))
            .collect(),
        // A rule we cannot parse degrades to the single original occurrence
        // rather than dropping the event: a weekly meeting shown once is
        // wrong, but a weekly meeting shown never is worse.
        Err(_) => vec![start],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> EventSource {
        EventSource {
            account_id: "acct-1".into(),
            account_label: "Fastmail".into(),
            calendar_name: "Personal".into(),
        }
    }

    fn window(from: &str, to: &str) -> (DateTime<Utc>, DateTime<Utc>) {
        (
            DateTime::parse_from_rfc3339(from)
                .unwrap()
                .with_timezone(&Utc),
            DateTime::parse_from_rfc3339(to)
                .unwrap()
                .with_timezone(&Utc),
        )
    }

    fn ics(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}\r\nEND:VCALENDAR\r\n")
    }

    const UTC_TZ: Tz = chrono_tz::UTC;

    #[test]
    fn a_simple_timed_event_comes_back_normalized() {
        let doc = ics(
            "BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Standup\r\nLOCATION:Room 3\r\n\
             DTSTART:20260907T140000Z\r\nDTEND:20260907T143000Z\r\nEND:VEVENT",
        );
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);

        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.summary, "Standup");
        assert_eq!(e.location.as_deref(), Some("Room 3"));
        assert_eq!(e.account_label, "Fastmail");
        assert_eq!(e.calendar_name, "Personal");
        assert!(e.start.starts_with("2026-09-07T14:00:00"));
        assert!(e.end.starts_with("2026-09-07T14:30:00"));
        assert!(!e.all_day);
        assert!(!e.recurring);
    }

    #[test]
    fn an_all_day_event_is_flagged_rather_than_inferred() {
        // A timed event can also start at midnight, so the flag has to come
        // from VALUE=DATE rather than from the time being 00:00.
        let doc = ics("BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Holiday\r\n\
             DTSTART;VALUE=DATE:20260907\r\nEND:VEVENT");
        let (from, to) = window("2026-09-06T00:00:00Z", "2026-09-09T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert_eq!(events.len(), 1);
        assert!(events[0].all_day);
        // No DTEND on an all-day event means one day, per RFC 5545.
        assert!(events[0].end.starts_with("2026-09-08T00:00:00"));

        let timed = ics("BEGIN:VEVENT\r\nUID:3\r\nSUMMARY:Midnight call\r\n\
             DTSTART:20260907T000000Z\r\nDTEND:20260907T010000Z\r\nEND:VEVENT");
        let events = parse_events(&timed, &source(), from, to, UTC_TZ);
        assert!(!events[0].all_day);
    }

    #[test]
    fn a_multi_day_event_appears_when_the_window_catches_its_middle() {
        // Asking "what's on Wednesday" must find a conference that started on
        // Monday. Filtering on the start alone would miss it.
        let doc = ics("BEGIN:VEVENT\r\nUID:4\r\nSUMMARY:Conference\r\n\
             DTSTART:20260907T090000Z\r\nDTEND:20260910T170000Z\r\nEND:VEVENT");
        let (from, to) = window("2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert_eq!(events.len(), 1, "a conference spanning the window is on it");
    }

    #[test]
    fn a_weekly_rule_is_expanded_into_real_occurrences() {
        // The whole reason this module exists: a model handed
        // "RRULE:FREQ=WEEKLY" and asked what is on next Tuesday gets it wrong.
        let doc = ics("BEGIN:VEVENT\r\nUID:5\r\nSUMMARY:Weekly sync\r\n\
             DTSTART:20260901T100000Z\r\nDTEND:20260901T110000Z\r\n\
             RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEND:VEVENT");
        let (from, to) = window("2026-09-01T00:00:00Z", "2026-09-29T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);

        assert_eq!(events.len(), 4, "four Tuesdays in the window");
        assert!(events.iter().all(|e| e.recurring));
        assert!(
            events.iter().all(|e| e.uid == "5"),
            "the UID names the series"
        );
        assert!(events[0].start.starts_with("2026-09-01"));
        assert!(events[3].start.starts_with("2026-09-22"));
    }

    #[test]
    fn an_exdate_removes_the_occurrence_it_names() {
        let doc = ics("BEGIN:VEVENT\r\nUID:6\r\nSUMMARY:Weekly sync\r\n\
             DTSTART:20260901T100000Z\r\nDTEND:20260901T110000Z\r\n\
             RRULE:FREQ=WEEKLY;BYDAY=TU\r\nEXDATE:20260908T100000Z\r\nEND:VEVENT");
        let (from, to) = window("2026-09-01T00:00:00Z", "2026-09-29T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);

        assert_eq!(events.len(), 3, "the cancelled week is gone");
        assert!(!events.iter().any(|e| e.start.starts_with("2026-09-08")));
    }

    #[test]
    fn a_bounded_rule_stops_where_it_says() {
        let doc = ics("BEGIN:VEVENT\r\nUID:7\r\nSUMMARY:Standup\r\n\
             DTSTART:20260901T100000Z\r\nDTEND:20260901T101500Z\r\n\
             RRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT");
        let (from, to) = window("2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z");
        assert_eq!(parse_events(&doc, &source(), from, to, UTC_TZ).len(), 3);
    }

    #[test]
    fn a_zoned_event_converts_into_the_users_zone() {
        let doc = ics("BEGIN:VEVENT\r\nUID:8\r\nSUMMARY:Tokyo call\r\n\
             DTSTART;TZID=Asia/Tokyo:20260907T150000\r\n\
             DTEND;TZID=Asia/Tokyo:20260907T160000\r\nEND:VEVENT");
        let (from, to) = window("2026-09-06T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, chrono_tz::America::New_York);

        assert_eq!(events.len(), 1);
        // 15:00 Tokyo is 02:00 New York the same day.
        assert!(
            events[0].start.starts_with("2026-09-07T02:00:00"),
            "{}",
            events[0].start
        );
        // The authored zone survives the conversion — "3pm Tokyo time" is
        // sometimes the answer.
        assert_eq!(events[0].time_zone.as_deref(), Some("Asia/Tokyo"));
    }

    #[test]
    fn a_recurring_event_keeps_its_wall_clock_time_across_a_dst_boundary() {
        // US DST ended 2026-11-01. A 09:00 New York meeting is 13:00 UTC
        // before and 14:00 UTC after; a naive UTC expansion would drift it an
        // hour and answer the wrong thing for half the year.
        let doc = ics("BEGIN:VEVENT\r\nUID:9\r\nSUMMARY:Morning sync\r\n\
             DTSTART;TZID=America/New_York:20261026T090000\r\n\
             DTEND;TZID=America/New_York:20261026T093000\r\n\
             RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nEND:VEVENT");
        let (from, to) = window("2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, chrono_tz::America::New_York);

        assert_eq!(events.len(), 3);
        for event in &events {
            assert!(
                event.start.contains("T09:00:00"),
                "every occurrence should stay at 09:00 local, got {}",
                event.start
            );
        }
    }

    #[test]
    fn a_duration_is_used_when_there_is_no_end() {
        let doc = ics("BEGIN:VEVENT\r\nUID:10\r\nSUMMARY:Focus\r\n\
             DTSTART:20260907T090000Z\r\nDURATION:PT1H30M\r\nEND:VEVENT");
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert!(events[0].end.starts_with("2026-09-07T10:30:00"));
    }

    #[test]
    fn durations_parse_in_the_forms_calendars_actually_emit() {
        assert_eq!(parse_duration("PT1H"), Some(Duration::hours(1)));
        assert_eq!(parse_duration("PT30M"), Some(Duration::minutes(30)));
        assert_eq!(parse_duration("P1D"), Some(Duration::days(1)));
        assert_eq!(parse_duration("P1W"), Some(Duration::weeks(1)));
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("nonsense"), None);
        assert_eq!(parse_duration("P"), Some(Duration::zero()));
    }

    #[test]
    fn attendees_and_organizers_lose_their_mailto_scheme() {
        // "who is coming" should not be answered with a URI scheme.
        let doc = ics("BEGIN:VEVENT\r\nUID:11\r\nSUMMARY:Review\r\n\
             DTSTART:20260907T140000Z\r\nDTEND:20260907T150000Z\r\n\
             ORGANIZER:mailto:boss@example.com\r\n\
             ATTENDEE:mailto:a@example.com\r\nATTENDEE:mailto:b@example.com\r\nEND:VEVENT");
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert_eq!(events[0].organizer.as_deref(), Some("boss@example.com"));
        assert_eq!(events[0].attendees, vec!["a@example.com", "b@example.com"]);
    }

    #[test]
    fn a_malformed_event_is_skipped_and_the_rest_survive() {
        // Real calendars accumulate junk from a decade of clients. "Your
        // calendar could not be read" is a much worse answer than a list
        // missing one entry.
        let doc = ics("BEGIN:VEVENT\r\nUID:good\r\nSUMMARY:Real\r\n\
             DTSTART:20260907T140000Z\r\nDTEND:20260907T150000Z\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:bad\r\nSUMMARY:Broken\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:nostart\r\nSUMMARY:No start at all\r\nEND:VEVENT");
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].uid, "good");
    }

    #[test]
    fn events_come_back_in_time_order() {
        let doc = ics("BEGIN:VEVENT\r\nUID:late\r\nSUMMARY:Late\r\n\
             DTSTART:20260907T160000Z\r\nDTEND:20260907T170000Z\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:early\r\nSUMMARY:Early\r\n\
             DTSTART:20260907T090000Z\r\nDTEND:20260907T100000Z\r\nEND:VEVENT");
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        let events = parse_events(&doc, &source(), from, to, UTC_TZ);
        assert_eq!(events[0].uid, "early");
        assert_eq!(events[1].uid, "late");
    }

    #[test]
    fn an_event_outside_the_window_is_not_returned() {
        let doc = ics("BEGIN:VEVENT\r\nUID:12\r\nSUMMARY:Last month\r\n\
             DTSTART:20260801T140000Z\r\nDTEND:20260801T150000Z\r\nEND:VEVENT");
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        assert!(parse_events(&doc, &source(), from, to, UTC_TZ).is_empty());
    }

    #[test]
    fn an_empty_or_junk_document_yields_nothing_rather_than_failing() {
        let (from, to) = window("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
        assert!(parse_events("", &source(), from, to, UTC_TZ).is_empty());
        assert!(parse_events("not iCalendar at all", &source(), from, to, UTC_TZ).is_empty());
    }
}
