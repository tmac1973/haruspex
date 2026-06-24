//! Shared mutable proxy state: per-engine rate limiting, failure
//! cooldowns, the search/fetch caches, and the auto-rotation cursor.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::config::{AUTO_ENGINES, FETCH_CACHE_TTL, SEARCH_CACHE_TTL};
use super::SearchResult;

struct CacheEntry<T> {
    value: T,
    expires_at: Instant,
}

pub struct ProxyState {
    last_search_time: Mutex<HashMap<String, Instant>>,
    engine_failures: Mutex<HashMap<String, Instant>>,
    search_cache: Mutex<HashMap<String, CacheEntry<Vec<SearchResult>>>>,
    fetch_cache: Mutex<HashMap<String, CacheEntry<String>>>,
    /// Index of the next engine to try first in auto-rotation. Incremented
    /// after each successful search so we round-robin through the engines
    /// instead of always starting with the same one.
    auto_rotation_cursor: Mutex<usize>,
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            last_search_time: Mutex::new(HashMap::new()),
            engine_failures: Mutex::new(HashMap::new()),
            search_cache: Mutex::new(HashMap::new()),
            fetch_cache: Mutex::new(HashMap::new()),
            auto_rotation_cursor: Mutex::new(0),
        }
    }

    /// Get the rotation order: starts at the cursor and wraps around so
    /// every engine is tried once. Does NOT advance the cursor — call
    /// advance_rotation_cursor() after a successful search.
    pub(super) fn rotation_order(&self) -> Vec<&'static str> {
        let cursor = *self.auto_rotation_cursor.lock().unwrap();
        let n = AUTO_ENGINES.len();
        (0..n).map(|i| AUTO_ENGINES[(cursor + i) % n]).collect()
    }

    pub(super) fn advance_rotation_cursor(&self) {
        let mut cursor = self.auto_rotation_cursor.lock().unwrap();
        *cursor = (*cursor + 1) % AUTO_ENGINES.len();
    }

    pub(super) async fn rate_limit_engine(&self, engine: &str, interval: Duration) {
        // Reserve the next available slot under the lock, then sleep outside
        // it. The previous version did std::thread::sleep while holding the
        // guard, which blocked a tokio worker thread for up to 6 s and
        // serialized searches across *all* engines (they share the one map).
        let wait = {
            let mut last_times = self.last_search_time.lock().unwrap();
            let now = Instant::now();
            let next = match last_times.get(engine) {
                Some(last) => (*last + interval).max(now),
                None => now,
            };
            last_times.insert(engine.to_string(), next);
            next - now
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }

    pub(super) fn record_failure(&self, engine: &str) {
        let mut failures = self.engine_failures.lock().unwrap();
        failures.insert(engine.to_string(), Instant::now());
    }

    pub(super) fn is_engine_healthy(&self, engine: &str, cooldown: Duration) -> bool {
        let failures = self.engine_failures.lock().unwrap();
        match failures.get(engine) {
            Some(failed_at) => failed_at.elapsed() >= cooldown,
            None => true,
        }
    }

    pub(super) fn get_cached_search(&self, query: &str) -> Option<Vec<SearchResult>> {
        let cache = self.search_cache.lock().unwrap();
        cache.get(query).and_then(|entry| {
            if entry.expires_at > Instant::now() {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    pub(super) fn cache_search(&self, query: &str, results: &[SearchResult]) {
        let mut cache = self.search_cache.lock().unwrap();
        cache.insert(
            query.to_string(),
            CacheEntry {
                value: results.to_vec(),
                expires_at: Instant::now() + SEARCH_CACHE_TTL,
            },
        );
    }

    pub(super) fn get_cached_fetch(&self, url: &str) -> Option<String> {
        let cache = self.fetch_cache.lock().unwrap();
        cache.get(url).and_then(|entry| {
            if entry.expires_at > Instant::now() {
                Some(entry.value.clone())
            } else {
                None
            }
        })
    }

    pub(super) fn cache_fetch(&self, url: &str, content: &str) {
        let mut cache = self.fetch_cache.lock().unwrap();
        cache.insert(
            url.to_string(),
            CacheEntry {
                value: content.to_string(),
                expires_at: Instant::now() + FETCH_CACHE_TTL,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::super::config::{ENGINE_COOLDOWN, RATE_LIMIT_INTERVAL};
    use super::*;

    #[test]
    fn cache_stores_and_retrieves() {
        let state = ProxyState::new();
        let results = vec![SearchResult {
            title: "Test".to_string(),
            url: "https://example.com".to_string(),
            snippet: "A test result".to_string(),
        }];

        state.cache_search("test query", &results);
        let cached = state.get_cached_search("test query");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().len(), 1);

        // Miss for different query
        assert!(state.get_cached_search("other query").is_none());
    }

    #[test]
    fn fetch_cache_stores_and_retrieves() {
        let state = ProxyState::new();
        state.cache_fetch("https://example.com", "cached content");
        let cached = state.get_cached_fetch("https://example.com");
        assert!(cached.is_some());
        assert_eq!(cached.unwrap(), "cached content");
    }

    #[test]
    fn engine_failure_tracking() {
        let state = ProxyState::new();
        assert!(state.is_engine_healthy("brave_html", ENGINE_COOLDOWN));
        state.record_failure("brave_html");
        assert!(!state.is_engine_healthy("brave_html", ENGINE_COOLDOWN));
        // Other engines unaffected
        assert!(state.is_engine_healthy("duckduckgo", ENGINE_COOLDOWN));
        assert!(state.is_engine_healthy("mojeek", ENGINE_COOLDOWN));
    }

    #[tokio::test]
    async fn per_engine_rate_limit() {
        let state = ProxyState::new();
        // First call should not block
        state
            .rate_limit_engine("brave_html", RATE_LIMIT_INTERVAL)
            .await;
        // Different engine should also not block
        state.rate_limit_engine("mojeek", RATE_LIMIT_INTERVAL).await;
        // Verify both tracked independently
        let times = state.last_search_time.lock().unwrap();
        assert!(times.contains_key("brave_html"));
        assert!(times.contains_key("mojeek"));
    }

    #[test]
    fn rotation_starts_at_first_engine() {
        let state = ProxyState::new();
        let order = state.rotation_order();
        assert_eq!(
            order,
            vec!["startpage", "brave_html", "duckduckgo", "mojeek"]
        );
    }

    #[test]
    fn rotation_advances_after_success() {
        let state = ProxyState::new();
        // First search starts with startpage
        assert_eq!(state.rotation_order()[0], "startpage");

        // After advancing, the next one starts with brave_html
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["brave_html", "duckduckgo", "mojeek", "startpage"]
        );

        // Advance through the rest of the cycle.
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["duckduckgo", "mojeek", "startpage", "brave_html"]
        );

        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["mojeek", "startpage", "brave_html", "duckduckgo"]
        );

        // And wraps back around to startpage
        state.advance_rotation_cursor();
        assert_eq!(
            state.rotation_order(),
            vec!["startpage", "brave_html", "duckduckgo", "mojeek"]
        );
    }

    #[test]
    fn rotation_full_cycle_uses_each_engine() {
        let state = ProxyState::new();
        // Track which engine appears first across N consecutive searches.
        // After AUTO_ENGINES.len() advances we should have seen each engine
        // in position 0 exactly once.
        let mut firsts = std::collections::HashSet::new();
        for _ in 0..AUTO_ENGINES.len() {
            firsts.insert(state.rotation_order()[0]);
            state.advance_rotation_cursor();
        }
        assert_eq!(firsts.len(), AUTO_ENGINES.len());
        for engine in AUTO_ENGINES {
            assert!(firsts.contains(*engine));
        }
    }

    #[test]
    fn rotation_includes_all_engines() {
        // Every rotation order returned should be a permutation of all engines.
        let state = ProxyState::new();
        for _ in 0..6 {
            let order = state.rotation_order();
            assert_eq!(order.len(), AUTO_ENGINES.len());
            let mut sorted = order.clone();
            sorted.sort();
            let mut expected: Vec<&str> = AUTO_ENGINES.to_vec();
            expected.sort();
            assert_eq!(sorted, expected);
            state.advance_rotation_cursor();
        }
    }
}
