//! Tauri commands for calendars.
//!
//! Thin, like the MCP ones: resolve a client, fan out over the account's
//! calendars, hand back a flat list. The account list arrives from the frontend
//! rather than being read here, exactly as the email commands take theirs —
//! settings live in one place and the backend does not get a second copy to
//! disagree with.

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;

use super::account::DavAccount;
use super::caldav;
use super::client::DavClient;
use super::discovery::{self, CalendarCollection};
use super::ical::{CalendarEvent, EventSource};
use crate::proxy::ProxyConfig;

/// How far either side of now `calendar_list_events` looks when the caller
/// gives no window.
///
/// A week back and four weeks forward. Asking a model to compute dates before
/// it can ask a question is a step it gets wrong often enough to matter, and
/// "what's coming up" is the overwhelmingly common question — but a little
/// history makes "when did I last meet Sarah" answerable too.
const DEFAULT_PAST: i64 = 7;
const DEFAULT_FUTURE: i64 = 28;

/// A calendar as the settings UI shows it after discovery.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredCalendar {
    pub url: String,
    pub name: String,
    pub color: Option<String>,
}

impl From<CalendarCollection> for DiscoveredCalendar {
    fn from(c: CalendarCollection) -> Self {
        Self {
            url: c.url,
            name: c.name,
            color: c.color,
        }
    }
}

/// Check an account's credentials and report what it can see.
///
/// Run from the settings form, so a wrong password is caught while the user is
/// still looking at the field that holds it rather than the first time the
/// model asks about their week.
#[tauri::command]
pub async fn dav_discover_calendars(
    account: DavAccount,
    proxy: Option<ProxyConfig>,
) -> Result<Vec<DiscoveredCalendar>, String> {
    if account.needs_oauth() {
        return Err(
            "Google Calendar needs OAuth, which this integration does not do. \
             Add it under MCP integrations instead."
                .into(),
        );
    }
    if !account.is_usable() {
        return Err("This account still needs an address, username and password.".into());
    }
    let client = DavClient::new(&account, proxy.as_ref())?;
    Ok(discovery::discover_calendars(&client, &account)
        .await?
        .into_iter()
        .map(DiscoveredCalendar::from)
        .collect())
}

/// Events across every enabled account, in a window.
///
/// Fans out over accounts and their calendars. One account failing does not
/// fail the query — a user with a working personal calendar and a broken work
/// one should still get their personal events, with the failure named
/// alongside rather than swallowed.
#[tauri::command]
pub async fn dav_list_events(
    accounts: Vec<DavAccount>,
    start: Option<String>,
    end: Option<String>,
    calendar: Option<String>,
    time_zone: Option<String>,
    proxy: Option<ProxyConfig>,
) -> Result<CalendarQueryResult, String> {
    let (from, to) = window(start.as_deref(), end.as_deref())?;
    let local = resolve_zone(time_zone.as_deref());

    let mut events = Vec::new();
    let mut problems = Vec::new();

    for account in accounts.iter().filter(|a| a.is_usable()) {
        match fetch_account(
            account,
            &from,
            &to,
            calendar.as_deref(),
            local,
            proxy.as_ref(),
        )
        .await
        {
            Ok(mut found) => events.append(&mut found),
            Err(e) => problems.push(format!("{}: {e}", account.label)),
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(CalendarQueryResult { events, problems })
}

/// Events matching a free-text query.
///
/// A thin wrapper over the same fetch, filtered locally. CalDAV has a
/// `text-match` filter, but servers vary in which properties they will match
/// and several ignore it silently — a search that quietly returns nothing on
/// one server and works on another is worse than one that is consistently
/// honest, and the window is already bounded so the volume is small.
#[tauri::command]
pub async fn dav_search_events(
    accounts: Vec<DavAccount>,
    query: String,
    start: Option<String>,
    end: Option<String>,
    time_zone: Option<String>,
    proxy: Option<ProxyConfig>,
) -> Result<CalendarQueryResult, String> {
    let mut result = dav_list_events(accounts, start, end, None, time_zone, proxy).await?;
    result.events.retain(|e| caldav::matches(e, &query));
    Ok(result)
}

/// Events plus whatever went wrong, rather than one or the other.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CalendarQueryResult {
    pub events: Vec<CalendarEvent>,
    /// Accounts that failed, named. The model relays these rather than
    /// reporting an empty calendar as though it were an empty week.
    pub problems: Vec<String>,
}

async fn fetch_account(
    account: &DavAccount,
    from: &DateTime<Utc>,
    to: &DateTime<Utc>,
    calendar_filter: Option<&str>,
    local: Tz,
    proxy: Option<&ProxyConfig>,
) -> Result<Vec<CalendarEvent>, String> {
    let client = DavClient::new(account, proxy)?;
    let calendars = discovery::discover_calendars(&client, account).await?;

    let mut events = Vec::new();
    for collection in calendars
        .iter()
        .filter(|c| matches_filter(c, calendar_filter))
    {
        let source = EventSource {
            account_id: account.id.clone(),
            account_label: account.label.clone(),
            calendar_name: collection.name.clone(),
        };
        // One unreachable calendar does not fail the others: a shared calendar
        // whose permissions changed is common, and it should cost that
        // calendar rather than the whole answer.
        if let Ok(mut found) =
            caldav::fetch_events(&client, collection, &source, *from, *to, local).await
        {
            events.append(&mut found);
        }
    }
    Ok(events)
}

/// Whether a calendar matches what the caller named.
///
/// Substring, case-insensitive: the model passes whatever the user said, and
/// "work" should find "Work Calendar".
fn matches_filter(calendar: &CalendarCollection, filter: Option<&str>) -> bool {
    match filter.map(str::trim).filter(|f| !f.is_empty()) {
        None => true,
        Some(f) => calendar.name.to_lowercase().contains(&f.to_lowercase()),
    }
}

/// The window to query, defaulting around now.
pub fn window(
    start: Option<&str>,
    end: Option<&str>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    let now = Utc::now();
    let from = match start {
        Some(s) => parse_boundary(s)?,
        None => now - Duration::days(DEFAULT_PAST),
    };
    let to = match end {
        Some(s) => parse_boundary(s)?,
        None => now + Duration::days(DEFAULT_FUTURE),
    };
    if to <= from {
        return Err("the end of the range must be after its start".into());
    }
    Ok((from, to))
}

/// Accept both what a model naturally writes and what a machine emits.
///
/// A model asked for "next Tuesday" produces `2026-09-15`; code produces a full
/// RFC 3339 timestamp. Refusing the first would push date arithmetic back onto
/// the model, which is what the defaults exist to avoid.
fn parse_boundary(value: &str) -> Result<DateTime<Utc>, String> {
    let value = value.trim();
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Ok(DateTime::from_naive_utc_and_offset(
            date.and_hms_opt(0, 0, 0).expect("midnight is a valid time"),
            Utc,
        ));
    }
    Err(format!(
        "'{value}' is not a date. Use YYYY-MM-DD or a full timestamp."
    ))
}

/// The zone to present times in.
///
/// Passed from the frontend, which knows the browser's zone, rather than read
/// from the process environment — a Tauri backend's `TZ` is whatever launched
/// it, which on a desktop is frequently not what the user's clock shows.
fn resolve_zone(name: Option<&str>) -> Tz {
    name.and_then(|n| n.parse().ok()).unwrap_or(chrono_tz::UTC)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collection(name: &str) -> CalendarCollection {
        CalendarCollection {
            url: format!("https://x.test/{name}/"),
            name: name.into(),
            ctag: None,
            color: None,
        }
    }

    #[test]
    fn the_default_window_reaches_backwards_as_well_as_forwards() {
        // "What's coming up" is the common question, but "when did I last meet
        // Sarah" should be answerable without the model computing dates.
        let (from, to) = window(None, None).unwrap();
        let now = Utc::now();
        assert!(from < now, "the window starts in the past");
        assert!(to > now + Duration::days(20), "and reaches well ahead");
    }

    #[test]
    fn a_plain_date_is_accepted_because_that_is_what_a_model_writes() {
        let (from, to) = window(Some("2026-09-07"), Some("2026-09-08")).unwrap();
        assert_eq!(from.to_rfc3339(), "2026-09-07T00:00:00+00:00");
        assert_eq!(to.to_rfc3339(), "2026-09-08T00:00:00+00:00");
    }

    #[test]
    fn a_full_timestamp_is_accepted_too() {
        let (from, _) = window(Some("2026-09-07T09:30:00Z"), Some("2026-09-08")).unwrap();
        assert_eq!(from.to_rfc3339(), "2026-09-07T09:30:00+00:00");
    }

    #[test]
    fn an_unparseable_date_says_what_it_wanted() {
        let err = window(Some("next tuesday"), None).unwrap_err();
        assert!(err.contains("YYYY-MM-DD"), "got {err}");
    }

    #[test]
    fn a_backwards_range_is_refused_rather_than_silently_empty() {
        // Returning nothing would read as "you have no events that week".
        let err = window(Some("2026-09-08"), Some("2026-09-07")).unwrap_err();
        assert!(err.contains("after its start"), "got {err}");
    }

    #[test]
    fn a_calendar_filter_matches_the_way_a_user_would_say_it() {
        assert!(matches_filter(&collection("Work Calendar"), Some("work")));
        assert!(matches_filter(&collection("Work Calendar"), Some("WORK")));
        assert!(!matches_filter(&collection("Personal"), Some("work")));
    }

    #[test]
    fn no_filter_means_every_calendar() {
        assert!(matches_filter(&collection("Anything"), None));
        assert!(matches_filter(&collection("Anything"), Some("   ")));
    }

    #[test]
    fn an_unknown_zone_falls_back_rather_than_failing_the_query() {
        // A wrong zone shifts times; a failed query answers nothing.
        assert_eq!(
            resolve_zone(Some("Europe/London")),
            chrono_tz::Europe::London
        );
        assert_eq!(resolve_zone(Some("Mars/Olympus")), chrono_tz::UTC);
        assert_eq!(resolve_zone(None), chrono_tz::UTC);
    }
}
