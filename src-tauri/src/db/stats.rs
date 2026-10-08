use super::*;
use crate::proxy::stats::{
    DailyEngineStats, DailyGlobal, DailyStatsSnapshot, EngineLifetimeStats, EngineStatDelta,
    EngineStatsCore, LifetimeStatsSnapshot, StatSink,
};
use log::warn;
use rusqlite::params;
use std::collections::HashMap;

const VALID_FAILURE_COLUMNS: &[&str] = &[
    "fail_http",
    "fail_rate_limited",
    "fail_parse",
    "fail_empty",
    "fail_irrelevant",
    "fail_network",
    "fail_timeout",
    "fail_other",
];

/// Per-day rows are kept this long, then dropped.
const DAILY_KEEP_DAYS: u32 = 90;

/// The local date of `now_ms`, or of now when it is 0, as `YYYY-MM-DD`.
fn local_day(now_ms: i64) -> String {
    use chrono::TimeZone;
    let at = if now_ms > 0 {
        chrono::Local
            .timestamp_millis_opt(now_ms)
            .single()
            .unwrap_or_else(chrono::Local::now)
    } else {
        chrono::Local::now()
    };
    at.format("%Y-%m-%d").to_string()
}

impl Database {
    /// UPSERT a single engine's stats row with the given delta. Runs as
    /// two statements (INSERT-OR-IGNORE then UPDATE) under the connection
    /// Mutex, so other writers can't race in between. The failure column
    /// name is validated against a whitelist — passing an unknown name
    /// returns an error rather than constructing arbitrary SQL.
    pub fn update_engine_stat(&self, engine: &str, delta: &EngineStatDelta) -> Result<(), String> {
        if let Some(col) = delta.failure_column {
            if !VALID_FAILURE_COLUMNS.contains(&col) {
                return Err(format!("Unknown failure column: {}", col));
            }
        }

        let conn = self.conn();

        conn.execute(
            "INSERT INTO search_stats_engines (engine) VALUES (?1) ON CONFLICT(engine) DO NOTHING",
            params![engine],
        )
        .map_err(|e| format!("Stats insert failed: {}", e))?;

        // Translate the delta into per-column increments. Only the active
        // failure column (validated above) increments by 1; the rest stay 0.
        let fail = |name: &str| -> i64 { (delta.failure_column == Some(name)) as i64 };

        let attempt_inc: u64 = if delta.attempt { 1 } else { 0 };
        let success_inc: u64 = if delta.success { 1 } else { 0 };
        let first_choice_inc: u64 = if delta.first_choice { 1 } else { 0 };
        let fallback_inc: u64 = if delta.fallback { 1 } else { 0 };
        let fallback_success_inc: u64 = if delta.fallback_success { 1 } else { 0 };
        let latency = if delta.success { delta.latency_ms } else { 0 };
        let success_ts: i64 = if delta.success && delta.now_ms > 0 {
            delta.now_ms
        } else {
            0
        };
        let failure_ts: i64 = if delta.failure_column.is_some() && delta.now_ms > 0 {
            delta.now_ms
        } else {
            0
        };

        conn.execute(
            "UPDATE search_stats_engines SET
                attempts = attempts + ?1,
                successes = successes + ?2,
                fail_http = fail_http + ?3,
                fail_rate_limited = fail_rate_limited + ?4,
                fail_parse = fail_parse + ?5,
                fail_empty = fail_empty + ?6,
                fail_irrelevant = fail_irrelevant + ?7,
                fail_network = fail_network + ?8,
                fail_timeout = fail_timeout + ?9,
                fail_other = fail_other + ?10,
                total_latency_ms = total_latency_ms + ?11,
                max_latency_ms = MAX(max_latency_ms, ?12),
                last_success_at = CASE WHEN ?13 > 0 THEN ?13 ELSE last_success_at END,
                last_failure_at = CASE WHEN ?14 > 0 THEN ?14 ELSE last_failure_at END,
                first_choice_attempts = first_choice_attempts + ?15,
                fallback_attempts = fallback_attempts + ?16,
                fallback_successes = fallback_successes + ?17
             WHERE engine = ?18",
            params![
                attempt_inc as i64,
                success_inc as i64,
                fail("fail_http"),
                fail("fail_rate_limited"),
                fail("fail_parse"),
                fail("fail_empty"),
                fail("fail_irrelevant"),
                fail("fail_network"),
                fail("fail_timeout"),
                fail("fail_other"),
                latency as i64,
                latency as i64,
                success_ts,
                failure_ts,
                first_choice_inc as i64,
                fallback_inc as i64,
                fallback_success_inc as i64,
                engine,
            ],
        )
        .map_err(|e| format!("Stats update failed: {}", e))?;

        // The same outcome, counted against today too.
        let day = local_day(delta.now_ms);
        conn.execute(
            "INSERT INTO search_stats_daily
                (day, engine, attempts, successes, fail_rate_limited, fail_empty, fail_other)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(day, engine) DO UPDATE SET
                attempts = attempts + excluded.attempts,
                successes = successes + excluded.successes,
                fail_rate_limited = fail_rate_limited + excluded.fail_rate_limited,
                fail_empty = fail_empty + excluded.fail_empty,
                fail_other = fail_other + excluded.fail_other",
            params![
                day,
                engine,
                attempt_inc as i64,
                success_inc as i64,
                fail("fail_rate_limited"),
                fail("fail_empty"),
                delta
                    .failure_column
                    .is_some_and(|c| c != "fail_rate_limited" && c != "fail_empty")
                    as i64,
            ],
        )
        .map_err(|e| format!("Daily stats update failed: {}", e))?;

        Ok(())
    }

    pub fn increment_global(&self, key: &str) -> Result<(), String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO search_stats_globals (key, value) VALUES (?1, 1)
             ON CONFLICT(key) DO UPDATE SET value = value + 1",
            params![key],
        )
        .map_err(|e| format!("Globals upsert failed: {}", e))?;
        conn.execute(
            "INSERT INTO search_stats_daily_globals (day, key, value) VALUES (?1, ?2, 1)
             ON CONFLICT(day, key) DO UPDATE SET value = value + 1",
            params![local_day(0), key],
        )
        .map_err(|e| format!("Daily globals upsert failed: {}", e))?;
        Ok(())
    }

    /// The last `days` local days of per-engine and global counts, newest
    /// first. Rows older than [`DAILY_KEEP_DAYS`] are dropped on the way.
    pub fn daily_stats_snapshot(&self, days: u32) -> Result<DailyStatsSnapshot, String> {
        let conn = self.conn();
        let cutoff = |n: u32| {
            (chrono::Local::now().date_naive() - chrono::Days::new(u64::from(n)))
                .format("%Y-%m-%d")
                .to_string()
        };
        let keep = cutoff(DAILY_KEEP_DAYS);
        conn.execute_batch(&format!(
            "DELETE FROM search_stats_daily WHERE day < '{keep}';
             DELETE FROM search_stats_daily_globals WHERE day < '{keep}';"
        ))
        .map_err(|e| format!("Daily stats prune failed: {}", e))?;
        // `days` counts today: the window starts `days - 1` days back.
        let from = cutoff(days.saturating_sub(1));
        let mut stmt = conn
            .prepare(
                "SELECT day, engine, attempts, successes, fail_rate_limited, fail_empty, fail_other
                 FROM search_stats_daily WHERE day >= ?1 ORDER BY day DESC, engine",
            )
            .map_err(|e| format!("Daily stats prepare failed: {}", e))?;
        let engines = stmt
            .query_map(params![from], |row| {
                Ok(DailyEngineStats {
                    day: row.get(0)?,
                    engine: row.get(1)?,
                    attempts: row.get::<_, i64>(2)? as u64,
                    successes: row.get::<_, i64>(3)? as u64,
                    fail_rate_limited: row.get::<_, i64>(4)? as u64,
                    fail_empty: row.get::<_, i64>(5)? as u64,
                    fail_other: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|e| format!("Daily stats query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Daily stats row read failed: {}", e))?;
        let mut gstmt = conn
            .prepare(
                "SELECT day, key, value FROM search_stats_daily_globals
                 WHERE day >= ?1 ORDER BY day DESC, key",
            )
            .map_err(|e| format!("Daily globals prepare failed: {}", e))?;
        let globals = gstmt
            .query_map(params![from], |row| {
                Ok(DailyGlobal {
                    day: row.get(0)?,
                    key: row.get(1)?,
                    value: row.get::<_, i64>(2)? as u64,
                })
            })
            .map_err(|e| format!("Daily globals query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Daily globals row read failed: {}", e))?;
        Ok(DailyStatsSnapshot { engines, globals })
    }

    pub fn lifetime_stats_snapshot(&self) -> Result<LifetimeStatsSnapshot, String> {
        let conn = self.conn();

        let mut stmt = conn
            .prepare(
                "SELECT engine, attempts, successes,
                        fail_http, fail_rate_limited, fail_parse, fail_empty,
                        fail_network, fail_timeout, fail_other, fail_irrelevant,
                        total_latency_ms, max_latency_ms,
                        last_success_at, last_failure_at,
                        first_choice_attempts, fallback_attempts, fallback_successes
                 FROM search_stats_engines
                 ORDER BY engine",
            )
            .map_err(|e| format!("Snapshot prepare failed: {}", e))?;

        let engines = stmt
            .query_map([], |row| {
                Ok(EngineLifetimeStats {
                    core: EngineStatsCore {
                        engine: row.get(0)?,
                        attempts: row.get::<_, i64>(1)? as u64,
                        successes: row.get::<_, i64>(2)? as u64,
                        total_latency_ms: row.get::<_, i64>(11)? as u64,
                        max_latency_ms: row.get::<_, i64>(12)? as u64,
                        last_success_at: row.get::<_, Option<i64>>(13)?,
                        last_failure_at: row.get::<_, Option<i64>>(14)?,
                        first_choice_attempts: row.get::<_, i64>(15)? as u64,
                        fallback_attempts: row.get::<_, i64>(16)? as u64,
                        fallback_successes: row.get::<_, i64>(17)? as u64,
                    },
                    fail_http: row.get::<_, i64>(3)? as u64,
                    fail_rate_limited: row.get::<_, i64>(4)? as u64,
                    fail_parse: row.get::<_, i64>(5)? as u64,
                    fail_empty: row.get::<_, i64>(6)? as u64,
                    fail_network: row.get::<_, i64>(7)? as u64,
                    fail_timeout: row.get::<_, i64>(8)? as u64,
                    fail_other: row.get::<_, i64>(9)? as u64,
                    fail_irrelevant: row.get::<_, i64>(10)? as u64,
                })
            })
            .map_err(|e| format!("Snapshot query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Snapshot row read failed: {}", e))?;

        let mut globals = HashMap::new();
        let mut gstmt = conn
            .prepare("SELECT key, value FROM search_stats_globals")
            .map_err(|e| format!("Globals prepare failed: {}", e))?;
        let rows = gstmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| format!("Globals query failed: {}", e))?;
        for r in rows {
            let (k, v) = r.map_err(|e| format!("Globals row read failed: {}", e))?;
            globals.insert(k, v);
        }

        Ok(LifetimeStatsSnapshot { engines, globals })
    }

    pub fn reset_lifetime_stats(&self) -> Result<(), String> {
        let conn = self.conn();
        conn.execute_batch(
            "DELETE FROM search_stats_engines; DELETE FROM search_stats_globals;
             DELETE FROM search_stats_daily; DELETE FROM search_stats_daily_globals;",
        )
        .map_err(|e| format!("Reset failed: {}", e))?;
        Ok(())
    }
}

/// The proxy records search outcomes through this trait (audit A3) so the
/// search subsystem never imports the db layer; the dependency points
/// db→proxy. The two `record_*` methods are fire-and-forget per the trait
/// contract: persistence failures are logged but never propagate, because
/// a transient DB error shouldn't break the search itself.
impl StatSink for Database {
    fn record_engine(&self, engine: &str, delta: &EngineStatDelta) {
        if let Err(e) = self.update_engine_stat(engine, delta) {
            warn!("Failed to persist lifetime stats for {}: {}", engine, e);
        }
    }

    fn record_global(&self, counter: &str) {
        if let Err(e) = self.increment_global(counter) {
            warn!("Failed to persist global stat {}: {}", counter, e);
        }
    }

    fn lifetime_snapshot(&self) -> Result<LifetimeStatsSnapshot, String> {
        self.lifetime_stats_snapshot()
    }

    fn reset_lifetime(&self) -> Result<(), String> {
        self.reset_lifetime_stats()
    }

    fn daily_snapshot(&self, days: u32) -> Result<DailyStatsSnapshot, String> {
        self.daily_stats_snapshot(days)
    }
}
