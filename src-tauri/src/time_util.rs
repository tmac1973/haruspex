//! Small time helpers shared across the backend.
//!
//! These existed as private copies in several modules (`db::chrono_now`,
//! `proxy::stats::now_ms`, `app_log::days_to_ymd`, and an inlined calendar
//! conversion in the IMAP client). Consolidated here so the epoch/calendar
//! math lives in exactly one place.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch (0 if the clock is before the epoch).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Nanoseconds since the Unix epoch — used for unique temp-file suffixes.
pub fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Convert days-since-epoch to a `(year, month, day)` tuple using Howard
/// Hinnant's civil-from-days algorithm — no chrono dependency, correct for
/// the proleptic Gregorian calendar.
pub fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_1970_01_01() {
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
    }

    #[test]
    fn known_dates() {
        // 2000-01-01 is day 10957; 2026-06-08 is day 20612.
        assert_eq!(days_to_ymd(10957), (2000, 1, 1));
        assert_eq!(days_to_ymd(20612), (2026, 6, 8));
    }

    #[test]
    fn leap_day_and_year_boundaries() {
        assert_eq!(days_to_ymd(18321), (2020, 2, 29)); // leap day
        assert_eq!(days_to_ymd(19723), (2024, 1, 1)); // year boundary
    }

    #[test]
    fn pre_epoch_days() {
        assert_eq!(days_to_ymd(-1), (1969, 12, 31));
        // 1969 is not a leap year: 365 days before the epoch is 1969-01-01.
        assert_eq!(days_to_ymd(-365), (1969, 1, 1));
    }

    #[test]
    fn now_ms_and_now_nanos_agree() {
        let ms = now_ms();
        let nanos_as_ms = (now_nanos() / 1_000_000) as i64;
        // Both read the same clock; sampled back-to-back they must agree to
        // within a generous few seconds, and in order (nanos sampled later).
        assert!(nanos_as_ms >= ms);
        assert!(nanos_as_ms - ms < 5_000);
    }

    #[test]
    fn now_ms_maps_to_a_plausible_calendar_date() {
        // Ties the wall clock to the calendar math: ms → days → (y, m, d)
        // must land on a sane current date, not 1970 or year 50000.
        let days = now_ms() / 86_400_000;
        let (year, month, day) = days_to_ymd(days);
        assert!((2026..2100).contains(&year), "year was {year}");
        assert!((1..=12).contains(&month));
        assert!((1..=31).contains(&day));
    }
}
