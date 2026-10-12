//! CalDAV and CardDAV: the user's own calendar and contacts, from their own
//! server.
//!
//! Completes the local-first PIM story IMAP started. Read-only, exactly as
//! email shipped read-only first — a wrong answer about the calendar is a
//! missed meeting; a wrong *write* is a meeting nobody else knows was moved.
//!
//! One account covers both collection types, because that is how every server
//! this targets actually works: a Nextcloud login reaches calendars and
//! contacts alike.

/// Per-request timeout for every DAV and Google call.
///
/// A calendar query against a year of events on a small self-hosted box is
/// genuinely slow; an unreachable host must still fail rather than hang the
/// tool call that is waiting on it.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub mod account;
pub mod caldav;
pub mod carddav;
pub mod client;
pub mod commands;
pub mod discovery;
pub mod google;
pub mod google_calendar;
pub mod google_contacts;
pub mod ical;
pub mod ics_feed;
pub mod vcard;
