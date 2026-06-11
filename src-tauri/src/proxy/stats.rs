//! Search statistics — in-memory session counters and the typed failure
//! kinds shared with the lifetime SQLite store.
//!
//! The session store (`SearchStats`) is reset at app startup. Lifetime
//! persistence lives in `db.rs`; callers in `proxy/mod.rs` and `search.rs`
//! update both sides per outcome.

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

#[derive(Clone, Debug, Default, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct EngineSessionStats {
    pub engine: String,
    #[ts(type = "number")]
    pub attempts: u64,
    #[ts(type = "number")]
    pub successes: u64,
    #[ts(as = "HashMap<SearchFailureKind, u32>")]
    pub failures_by_kind: HashMap<SearchFailureKind, u64>,
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
                engine: engine.to_string(),
                ..Default::default()
            });

        entry.attempts += 1;
        match outcome.position {
            Some(AutoPosition::First) => entry.first_choice_attempts += 1,
            Some(AutoPosition::Fallback) => entry.fallback_attempts += 1,
            None => {}
        }

        match outcome.result {
            Ok(latency_ms) => {
                entry.successes += 1;
                entry.total_latency_ms += latency_ms;
                if latency_ms > entry.max_latency_ms {
                    entry.max_latency_ms = latency_ms;
                }
                entry.last_success_at = Some(now);
                if matches!(outcome.position, Some(AutoPosition::Fallback)) {
                    entry.fallback_successes += 1;
                }
            }
            Err(kind) => {
                *entry.failures_by_kind.entry(kind).or_insert(0) += 1;
                entry.last_failure_at = Some(now);
            }
        }
    }

    pub fn snapshot(&self) -> SessionStatsSnapshot {
        let engines = self.engines.lock().unwrap();
        let globals = self.globals.lock().unwrap();
        let mut list: Vec<EngineSessionStats> = engines.values().cloned().collect();
        list.sort_by(|a, b| a.engine.cmp(&b.engine));
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
        let e = snap.engines.iter().find(|e| e.engine == "ddg").unwrap();
        assert_eq!(e.attempts, 3);
        assert_eq!(e.successes, 2);
        assert_eq!(e.total_latency_ms, 400);
        assert_eq!(e.max_latency_ms, 300);
        assert_eq!(e.first_choice_attempts, 3);
        assert_eq!(e.fallback_attempts, 0);
        assert_eq!(
            e.failures_by_kind.get(&SearchFailureKind::RateLimited),
            Some(&1)
        );
        assert!(e.last_success_at.is_some());
        assert!(e.last_failure_at.is_some());
    }

    #[test]
    fn fallback_success_bookkeeping() {
        let s = SearchStats::new();
        s.record_outcome("brave_html", &fail(SearchFailureKind::Http));
        s.record_outcome("ddg", &success(200, Some(AutoPosition::Fallback)));

        let snap = s.snapshot();
        let ddg = snap.engines.iter().find(|e| e.engine == "ddg").unwrap();
        assert_eq!(ddg.fallback_attempts, 1);
        assert_eq!(ddg.fallback_successes, 1);
        assert_eq!(ddg.first_choice_attempts, 0);
    }

    #[test]
    fn distinct_engines_isolated() {
        let s = SearchStats::new();
        s.record_outcome("ddg", &success(100, None));
        s.record_outcome("mojeek", &fail(SearchFailureKind::Parse));

        let snap = s.snapshot();
        assert_eq!(snap.engines.len(), 2);
        let ddg = snap.engines.iter().find(|e| e.engine == "ddg").unwrap();
        let m = snap.engines.iter().find(|e| e.engine == "mojeek").unwrap();
        assert_eq!(ddg.successes, 1);
        assert_eq!(m.successes, 0);
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
