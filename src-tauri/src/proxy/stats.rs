//! Search statistics — in-memory session counters, the typed failure
//! kinds, and the `StatSink` trait behind which lifetime persistence
//! hides.
//!
//! The session store (`SearchStats`) is reset at app startup. Lifetime
//! persistence is whatever implements `StatSink` (the SQLite `Database`
//! in production); callers in `proxy/mod.rs` and `search.rs` update both
//! sides per outcome via the `record_*` helpers below. The proxy module
//! deliberately knows nothing about the db layer — the dependency points
//! the other way (db implements this module's trait).

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;

/// Why a search engine attempt didn't return usable results. Each kind
/// maps 1:1 to a `fail_*` column in `search_stats_engines`.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SearchFailureKind {
    /// Non-2xx HTTP status from the engine (429, 403, 503, etc.).
    Http,
    /// Engine returned 200 but the body is a bot-detection / captcha /
    /// cookie wall instead of search results.
    RateLimited,
    /// HTML structure didn't match our selectors — typically means the
    /// engine restructured its markup.
    Parse,
    /// Engine returned 200, parsed cleanly, but produced zero results.
    Empty,
    /// reqwest connect/send error (DNS, TLS handshake, broken pipe, ...).
    Network,
    /// FETCH_TIMEOUT exceeded.
    Timeout,
    /// Anything else (uncategorized).
    Other,
}

impl SearchFailureKind {
    /// Column name in the `search_stats_engines` table. Kept here so the
    /// proxy layer doesn't need to know about the db schema.
    pub fn db_column(self) -> &'static str {
        match self {
            SearchFailureKind::Http => "fail_http",
            SearchFailureKind::RateLimited => "fail_rate_limited",
            SearchFailureKind::Parse => "fail_parse",
            SearchFailureKind::Empty => "fail_empty",
            SearchFailureKind::Network => "fail_network",
            SearchFailureKind::Timeout => "fail_timeout",
            SearchFailureKind::Other => "fail_other",
        }
    }
}

/// Typed engine failure — replaces the bare `String` error that engine
/// functions previously returned, so the rotation layer and stats can
/// classify the reason. Converts cleanly back to `String` at the public
/// Tauri boundary via `Into<String>`.
#[derive(Clone, Debug)]
pub struct SearchFailure {
    pub kind: SearchFailureKind,
    pub message: String,
}

impl SearchFailure {
    pub fn new(kind: SearchFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    /// Convenience for the bulk of message strings we already produce.
    pub fn other(message: impl Into<String>) -> Self {
        Self::new(SearchFailureKind::Other, message)
    }
}

impl std::fmt::Display for SearchFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<SearchFailure> for String {
    fn from(f: SearchFailure) -> String {
        f.message
    }
}

/// Position of this engine in the auto-rotation try order for a given
/// search. Used to bookkeeping first-choice vs. fallback metrics. `None`
/// means this attempt didn't come from auto-rotation (direct provider call).
#[derive(Clone, Copy, Debug)]
pub enum AutoPosition {
    First,
    Fallback,
}

/// One recorded outcome to feed into both session and lifetime stores.
#[derive(Clone, Debug)]
pub struct RecordedOutcome {
    /// Either Ok(latency_ms) on success or Err(kind) on failure.
    pub result: Result<u64, SearchFailureKind>,
    pub position: Option<AutoPosition>,
}

/// Incremental change to a single engine's lifetime stats row.
///
/// Caller is expected to set `attempt = true` for every recorded outcome and
/// exactly one of: `success = true` OR `failure_column = Some(...)`. The
/// `failure_column` must be one of the seven `fail_*` column names defined
/// in `search_stats_engines`; passing anything else returns an error rather
/// than silently corrupting the SQL.
#[derive(Clone, Debug, Default)]
pub struct EngineStatDelta {
    pub attempt: bool,
    pub success: bool,
    pub latency_ms: u64,
    pub failure_column: Option<&'static str>,
    pub now_ms: i64,
    pub first_choice: bool,
    pub fallback: bool,
    pub fallback_success: bool,
}

/// Per-engine stats fields shared by the session and lifetime rows.
/// Embedded via `#[serde(flatten)]`/`#[ts(flatten)]` so the JSON wire shape
/// and the generated TS types stay identical to when these fields were
/// declared inline in both structs.
#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
pub struct EngineStatsCore {
    pub engine: String,
    #[ts(type = "number")]
    pub attempts: u64,
    #[ts(type = "number")]
    pub successes: u64,
    #[ts(type = "number")]
    pub total_latency_ms: u64,
    #[ts(type = "number")]
    pub max_latency_ms: u64,
    #[ts(type = "number | null")]
    pub last_success_at: Option<i64>,
    #[ts(type = "number | null")]
    pub last_failure_at: Option<i64>,
    #[ts(type = "number")]
    pub first_choice_attempts: u64,
    #[ts(type = "number")]
    pub fallback_attempts: u64,
    #[ts(type = "number")]
    pub fallback_successes: u64,
}

/// Snapshot of a single engine's lifetime stats row. Mirrors the column
/// layout so the frontend can render it without re-fetching per row.
#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EngineLifetimeStats {
    #[serde(flatten)]
    #[ts(flatten)]
    pub core: EngineStatsCore,
    #[ts(type = "number")]
    pub fail_http: u64,
    #[ts(type = "number")]
    pub fail_rate_limited: u64,
    #[ts(type = "number")]
    pub fail_parse: u64,
    #[ts(type = "number")]
    pub fail_empty: u64,
    #[ts(type = "number")]
    pub fail_network: u64,
    #[ts(type = "number")]
    pub fail_timeout: u64,
    #[ts(type = "number")]
    pub fail_other: u64,
}

#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LifetimeStatsSnapshot {
    pub engines: Vec<EngineLifetimeStats>,
    #[ts(as = "HashMap<String, u32>")]
    pub globals: HashMap<String, u64>,
}

/// Lifetime persistence seam for search stats. The proxy records through
/// this trait instead of touching the db layer directly; `Database`
/// implements it in `db/stats.rs` (db depends on proxy, not vice-versa).
///
/// The two `record_*` methods are fire-and-forget: implementations must
/// swallow (and log) persistence failures, because a transient DB error
/// shouldn't break the search itself.
pub trait StatSink: Send + Sync {
    /// Apply one engine-attempt delta to the lifetime store.
    fn record_engine(&self, engine: &str, delta: &EngineStatDelta);
    /// Bump one global counter (keyed by `GlobalCounter::db_key`).
    fn record_global(&self, counter: &str);
    /// Read the full lifetime snapshot (for the stats UI).
    fn lifetime_snapshot(&self) -> Result<LifetimeStatsSnapshot, String>;
    /// Reset all lifetime stats.
    fn reset_lifetime(&self) -> Result<(), String>;
}

/// Managed-state wrapper so Tauri commands can inject the sink without
/// naming the concrete implementation.
pub struct StatSinkHandle(pub std::sync::Arc<dyn StatSink>);

/// Which global counter to bump in `record_global_both`.
#[derive(Clone, Copy)]
pub(crate) enum GlobalCounter {
    Query,
    CacheHit,
    AllEnginesFailed,
}

impl GlobalCounter {
    fn db_key(self) -> &'static str {
        match self {
            GlobalCounter::Query => "total_queries",
            GlobalCounter::CacheHit => "cache_hits",
            GlobalCounter::AllEnginesFailed => "all_engines_failed",
        }
    }
}

/// Update both the in-memory session counters and the lifetime store
/// for a single engine attempt. Persistence failures are logged (by the
/// sink) but don't propagate — a transient DB error shouldn't break the
/// search itself.
pub(super) fn record_outcome_both(
    stats: &SearchStats,
    sink: &dyn StatSink,
    engine: &str,
    outcome: &RecordedOutcome,
) {
    stats.record_outcome(engine, outcome);

    let now = now_ms();
    let (success, latency_ms, failure_column) = match &outcome.result {
        Ok(ms) => (true, *ms, None),
        Err(kind) => (false, 0, Some(kind.db_column())),
    };
    let delta = EngineStatDelta {
        attempt: true,
        success,
        latency_ms,
        failure_column,
        now_ms: now,
        first_choice: matches!(outcome.position, Some(AutoPosition::First)),
        fallback: matches!(outcome.position, Some(AutoPosition::Fallback)),
        fallback_success: success && matches!(outcome.position, Some(AutoPosition::Fallback)),
    };
    sink.record_engine(engine, &delta);
}

/// Classify a single engine call's `Result` (success / empty / typed
/// failure) into a `RecordedOutcome` and persist it through both stores.
/// Empty results (Ok with no items) are recorded as a `Empty` failure
/// for stats purposes even though the engine technically succeeded.
pub(crate) fn record_engine_result(
    stats: &SearchStats,
    sink: &dyn StatSink,
    engine: &str,
    result: &Result<Vec<super::SearchResult>, SearchFailure>,
    elapsed_ms: u64,
    position: Option<AutoPosition>,
) {
    let outcome = match result {
        Ok(r) if r.is_empty() => RecordedOutcome {
            result: Err(SearchFailureKind::Empty),
            position,
        },
        Ok(_) => RecordedOutcome {
            result: Ok(elapsed_ms),
            position,
        },
        Err(f) => RecordedOutcome {
            result: Err(f.kind),
            position,
        },
    };
    record_outcome_both(stats, sink, engine, &outcome);
}

pub(crate) fn record_global_both(stats: &SearchStats, sink: &dyn StatSink, counter: GlobalCounter) {
    match counter {
        GlobalCounter::Query => stats.record_query(),
        GlobalCounter::CacheHit => stats.record_cache_hit(),
        GlobalCounter::AllEnginesFailed => stats.record_all_engines_failed(),
    }
    sink.record_global(counter.db_key());
}

#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EngineSessionStats {
    #[serde(flatten)]
    #[ts(flatten)]
    pub core: EngineStatsCore,
    #[ts(as = "HashMap<SearchFailureKind, u32>")]
    pub failures_by_kind: HashMap<SearchFailureKind, u64>,
}

#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct GlobalCounters {
    #[ts(type = "number")]
    pub cache_hits: u64,
    #[ts(type = "number")]
    pub total_queries: u64,
    #[ts(type = "number")]
    pub all_engines_failed: u64,
}

#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct SessionStatsSnapshot {
    pub engines: Vec<EngineSessionStats>,
    pub globals: GlobalCounters,
}

pub struct SearchStats {
    engines: Mutex<HashMap<String, EngineSessionStats>>,
    globals: Mutex<GlobalCounters>,
}

impl SearchStats {
    pub fn new() -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            globals: Mutex::new(GlobalCounters::default()),
        }
    }

    pub fn record_query(&self) {
        let mut g = self.globals.lock().unwrap();
        g.total_queries += 1;
    }

    pub fn record_cache_hit(&self) {
        let mut g = self.globals.lock().unwrap();
        g.cache_hits += 1;
    }

    pub fn record_all_engines_failed(&self) {
        let mut g = self.globals.lock().unwrap();
        g.all_engines_failed += 1;
    }

    pub fn record_outcome(&self, engine: &str, outcome: &RecordedOutcome) {
        let now = now_ms();
        let mut engines = self.engines.lock().unwrap();
        let entry = engines
            .entry(engine.to_string())
            .or_insert_with(|| EngineSessionStats {
                core: EngineStatsCore {
                    engine: engine.to_string(),
                    ..Default::default()
                },
                ..Default::default()
            });

        let core = &mut entry.core;
        core.attempts += 1;
        match outcome.position {
            Some(AutoPosition::First) => core.first_choice_attempts += 1,
            Some(AutoPosition::Fallback) => core.fallback_attempts += 1,
            None => {}
        }

        match outcome.result {
            Ok(latency_ms) => {
                core.successes += 1;
                core.total_latency_ms += latency_ms;
                if latency_ms > core.max_latency_ms {
                    core.max_latency_ms = latency_ms;
                }
                core.last_success_at = Some(now);
                if matches!(outcome.position, Some(AutoPosition::Fallback)) {
                    core.fallback_successes += 1;
                }
            }
            Err(kind) => {
                *entry.failures_by_kind.entry(kind).or_insert(0) += 1;
                entry.core.last_failure_at = Some(now);
            }
        }
    }

    pub fn snapshot(&self) -> SessionStatsSnapshot {
        let engines = self.engines.lock().unwrap();
        let globals = self.globals.lock().unwrap();
        let mut list: Vec<EngineSessionStats> = engines.values().cloned().collect();
        list.sort_by(|a, b| a.core.engine.cmp(&b.core.engine));
        SessionStatsSnapshot {
            engines: list,
            globals: globals.clone(),
        }
    }
}

impl Default for SearchStats {
    fn default() -> Self {
        Self::new()
    }
}

pub(super) fn now_ms() -> i64 {
    crate::time_util::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fail(kind: SearchFailureKind) -> RecordedOutcome {
        RecordedOutcome {
            result: Err(kind),
            position: None,
        }
    }

    fn success(latency_ms: u64, pos: Option<AutoPosition>) -> RecordedOutcome {
        RecordedOutcome {
            result: Ok(latency_ms),
            position: pos,
        }
    }

    #[test]
    fn record_outcome_accumulates_per_engine() {
        let s = SearchStats::new();
        s.record_outcome("ddg", &success(100, Some(AutoPosition::First)));
        s.record_outcome("ddg", &success(300, Some(AutoPosition::First)));
        // Failure with explicit First position to verify it's still counted
        // toward first_choice_attempts (rotation tried it first but it lost).
        s.record_outcome(
            "ddg",
            &RecordedOutcome {
                result: Err(SearchFailureKind::RateLimited),
                position: Some(AutoPosition::First),
            },
        );

        let snap = s.snapshot();
        let e = snap
            .engines
            .iter()
            .find(|e| e.core.engine == "ddg")
            .unwrap();
        assert_eq!(e.core.attempts, 3);
        assert_eq!(e.core.successes, 2);
        assert_eq!(e.core.total_latency_ms, 400);
        assert_eq!(e.core.max_latency_ms, 300);
        assert_eq!(e.core.first_choice_attempts, 3);
        assert_eq!(e.core.fallback_attempts, 0);
        assert_eq!(
            e.failures_by_kind.get(&SearchFailureKind::RateLimited),
            Some(&1)
        );
        assert!(e.core.last_success_at.is_some());
        assert!(e.core.last_failure_at.is_some());
    }

    #[test]
    fn fallback_success_bookkeeping() {
        let s = SearchStats::new();
        s.record_outcome("brave_html", &fail(SearchFailureKind::Http));
        s.record_outcome("ddg", &success(200, Some(AutoPosition::Fallback)));

        let snap = s.snapshot();
        let ddg = snap
            .engines
            .iter()
            .find(|e| e.core.engine == "ddg")
            .unwrap();
        assert_eq!(ddg.core.fallback_attempts, 1);
        assert_eq!(ddg.core.fallback_successes, 1);
        assert_eq!(ddg.core.first_choice_attempts, 0);
    }

    #[test]
    fn distinct_engines_isolated() {
        let s = SearchStats::new();
        s.record_outcome("ddg", &success(100, None));
        s.record_outcome("mojeek", &fail(SearchFailureKind::Parse));

        let snap = s.snapshot();
        assert_eq!(snap.engines.len(), 2);
        let ddg = snap
            .engines
            .iter()
            .find(|e| e.core.engine == "ddg")
            .unwrap();
        let m = snap
            .engines
            .iter()
            .find(|e| e.core.engine == "mojeek")
            .unwrap();
        assert_eq!(ddg.core.successes, 1);
        assert_eq!(m.core.successes, 0);
        assert_eq!(m.failures_by_kind.get(&SearchFailureKind::Parse), Some(&1));
    }

    #[test]
    fn globals_separate_from_engine_counters() {
        let s = SearchStats::new();
        s.record_query();
        s.record_query();
        s.record_cache_hit();
        s.record_all_engines_failed();

        let snap = s.snapshot();
        assert_eq!(snap.globals.total_queries, 2);
        assert_eq!(snap.globals.cache_hits, 1);
        assert_eq!(snap.globals.all_engines_failed, 1);
        assert_eq!(snap.engines.len(), 0);
    }

    #[test]
    fn failure_kind_db_columns_are_distinct() {
        // Guards against typos that would collapse two kinds onto the
        // same SQL column.
        let all = [
            SearchFailureKind::Http,
            SearchFailureKind::RateLimited,
            SearchFailureKind::Parse,
            SearchFailureKind::Empty,
            SearchFailureKind::Network,
            SearchFailureKind::Timeout,
            SearchFailureKind::Other,
        ];
        let cols: Vec<&'static str> = all.iter().map(|k| k.db_column()).collect();
        let unique: std::collections::HashSet<&'static str> = cols.iter().copied().collect();
        assert_eq!(cols.len(), unique.len());
    }
}
