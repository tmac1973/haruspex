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

pub mod account;
pub mod caldav;
pub mod carddav;
pub mod client;
pub mod commands;
pub mod discovery;
pub mod ical;
pub mod vcard;
