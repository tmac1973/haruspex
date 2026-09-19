//! Does a result set actually answer the query it was asked?
//!
//! Every other guard in this module asks whether an engine *responded* —
//! a status, a challenge page, a parse. None of them asks whether the
//! response is about the right thing, because until Bing started doing this
//! it never needed to be asked: an engine either answered or blocked.
//!
//! Measured on 2026-09-19, plain HTTP, no proxy, same headers `search_bing`
//! sends: `q=Dave+Smith+comedian+libertarian+podcast` returned ten clean
//! `li.b_algo` results about the *Dave* banking app, four runs out of four;
//! `q=best+espresso+machine+2026+review` returned Best Buy and the
//! Merriam-Webster entry for "best". The query survives verbatim in the page's
//! own search box (`input#sb_form_q`) — only the results are for something
//! else. Through an HTTP proxy it degrades further, to a different unrelated
//! SERP on every request (Outlook, Telegram Desktop, Bollywood news).
//!
//! HTTP 200, 120-180 KB, parses to eight well-formed results with real titles,
//! real snippets and real URLs. Nothing upstream of here can tell it from an
//! answer, which is how Bing reached 590 attempts and 590 successes with
//! `last_failure_at` still NULL while it was serving decoys — the one engine
//! in the table that had never once failed, because it *could* not.
//!
//! So the check is on the only thing a decoy cannot fake: whether the words
//! of the query appear in the results at all.

use super::SearchResult;

/// Share of the query's content terms that must appear somewhere in a result
/// set for it to count as an answer.
///
/// Deliberately low. This is not a relevance ranker — it is a smoke alarm, and
/// the only thing it must never do is reject a real SERP. A genuine result set
/// for a long query routinely covers only the distinctive half of it: the live
/// Brave results for "Dave Smith comedian far right alt right controversy"
/// cover dave / smith / comedian / right and none of far / alt / controversy,
/// which is 4 of 7. The decoys scored 1 of 10 and 0 of 8.
const MIN_TERM_COVERAGE_PCT: usize = 34;

/// Words that carry no topic, so counting them as coverage would let a decoy
/// pass on "the" and "of" alone — and, more importantly, counting them in the
/// *denominator* would penalise a real SERP for not repeating them.
///
/// English only, and short on purpose: an over-eager list starts eating real
/// query terms, and the cost of leaving a filler word in is one extra term in
/// the denominator, while the cost of removing a real one is a wrong verdict.
const STOPWORDS: &[&str] = &[
    "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "before",
    "being", "but", "by", "can", "did", "do", "does", "for", "from", "had", "has", "have", "how",
    "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our", "out",
    "over", "she", "should", "so", "some", "than", "that", "the", "their", "them", "then", "there",
    "these", "they", "this", "to", "up", "was", "we", "were", "what", "when", "where", "which",
    "who", "why", "will", "with", "would", "you", "your",
];

/// The topic-bearing terms of a query, lowercased and deduped.
///
/// Splits on anything non-alphanumeric, so quotes, hyphens and punctuation
/// fall away and `"alt-right"` contributes both halves. CJK text has no
/// internal breaks to split on and survives as one term, which is the
/// intended behaviour: it is then matched as a substring.
fn query_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in query.split(|c: char| !c.is_alphanumeric()) {
        // Single characters carry too little to match on: "C" would hit every
        // result that happens to contain a c.
        if word.chars().count() < 2 {
            continue;
        }
        let lower = word.to_lowercase();
        if STOPWORDS.contains(&lower.as_str()) || terms.contains(&lower) {
            continue;
        }
        terms.push(lower);
    }
    terms
}

/// How many of `terms` appear anywhere in the result set.
///
/// Substring matching, so "comedian" is covered by "comedians" and "libertarian
/// comedian Dave Smith". It over-matches slightly ("right" inside "bright"),
/// which errs toward accepting a result set — the safe direction.
fn covered_terms(terms: &[String], results: &[SearchResult]) -> usize {
    let haystacks: Vec<String> = results
        .iter()
        .map(|r| format!("{} {} {}", r.title, r.snippet, r.url).to_lowercase())
        .collect();
    terms
        .iter()
        .filter(|term| haystacks.iter().any(|h| h.contains(term.as_str())))
        .count()
}

/// Does this result set look like an answer to this query?
///
/// True whenever there is nothing to judge — no results (the `Empty`
/// classification already covers that, and it carries a better diagnosis) or
/// no content terms in the query at all.
pub(super) fn answers_query(query: &str, results: &[SearchResult]) -> bool {
    if results.is_empty() {
        return true;
    }
    let terms = query_terms(query);
    if terms.is_empty() {
        return true;
    }
    // At least one term always, so a single-term query still has to be
    // mentioned — that is the case where a decoy is otherwise invisible.
    let needed = (terms.len() * MIN_TERM_COVERAGE_PCT).div_ceil(100).max(1);
    covered_terms(&terms, results) >= needed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(title: &str, url: &str, snippet: &str) -> SearchResult {
        SearchResult {
            title: title.to_string(),
            url: url.to_string(),
            snippet: snippet.to_string(),
        }
    }

    #[test]
    fn terms_drop_stopwords_punctuation_and_duplicates() {
        assert_eq!(
            query_terms("Dave Smith comedian far right alt-right controversy"),
            [
                "dave",
                "smith",
                "comedian",
                "far",
                "right",
                "alt",
                "controversy"
            ]
        );
        // Quotes are punctuation, and the phrase still contributes its words.
        assert_eq!(
            query_terms("\"white genocide\" theory"),
            ["white", "genocide", "theory"]
        );
        // A query of pure filler has nothing to judge on.
        assert!(query_terms("what is it about").is_empty());
    }

    /// The exact decoy Bing served on 2026-09-19 for a Dave Smith query:
    /// ten clean results about the Dave banking app. One term of ten.
    #[test]
    fn bings_first_term_decoy_is_rejected() {
        let results = vec![
            result(
                "Get Up To $500 In 5 Minutes Or Less | Dave",
                "https://dave.com/",
                "Want the best mobile financial app?",
            ),
            result(
                "Dave - Mobile Banking App - Cash Advance, Budget, Build Credit",
                "https://dave.com/macais",
                "Get a cash advance up to $500.",
            ),
            result(
                "Dave: Credit, Cash & Money App - Apps on Google Play",
                "https://play.google.com/store/apps/details?id=com.dave",
                "You could get up to $500 when you download Dave.",
            ),
            result(
                "Dave (rapper) - Wikipedia",
                "https://en.m.wikipedia.org/wiki/Dave_(rapper)",
                "David Orobosa Michael Omoregie, known professionally as Dave.",
            ),
        ];
        assert!(!answers_query(
            "Dave Smith comedian Southern Poverty Law Center far right designation",
            &results
        ));
    }

    /// The proxied form of the same failure: an unrelated SERP per request.
    #[test]
    fn an_entirely_unrelated_serp_is_rejected() {
        let results = vec![
            result(
                "Telegram Desktop",
                "https://desktop.telegram.org/",
                "Telegram for Windows, macOS and Linux.",
            ),
            result(
                "Bollywood News, Movie Reviews, Ratings",
                "https://www.bollywoodhungama.com/",
                "Latest Bollywood news and box office.",
            ),
        ];
        assert!(!answers_query(
            "Dave Smith comedian libertarian podcast",
            &results
        ));
    }

    /// Live Brave results for the query that started this, covering only the
    /// distinctive half of it. A real SERP must pass, or the guard is worse
    /// than the bug.
    #[test]
    fn a_real_serp_covering_only_part_of_the_query_is_accepted() {
        let results = vec![
            result(
                "Dave Smith (comedian) - Wikipedia",
                "https://en.wikipedia.org/wiki/Dave_Smith_(comedian)",
                "American political commentator and stand-up comedian.",
            ),
            result(
                "The Remarkable Idiocy of Comic Dave Smith",
                "https://www.nationalreview.com/",
                "The comedian's foreign policy commentary.",
            ),
            result(
                "Dave Smith-Douglas Murray debate highlights Right-wing fault lines",
                "https://www.example.com/",
                "The debate aired on the Joe Rogan Experience.",
            ),
        ];
        assert!(answers_query(
            "Dave Smith comedian far right alt right controversy",
            &results
        ));
    }

    /// A technical query whose results use the words: the common case, and the
    /// one a too-strict threshold would break first.
    #[test]
    fn an_ordinary_technical_serp_is_accepted() {
        let results = vec![
            result(
                "Tokio - An asynchronous Rust runtime",
                "https://tokio.rs/",
                "Tokio is an asynchronous runtime for Rust.",
            ),
            result(
                "Async in depth | Tokio",
                "https://tokio.rs/tokio/tutorial/async",
                "How Rust's async works.",
            ),
        ];
        assert!(answers_query("rust async runtime tokio", &results));
    }

    /// A single-term query is the one case where "cover a third of the terms"
    /// would round to zero and wave everything through.
    #[test]
    fn a_single_term_query_still_has_to_be_mentioned() {
        let hit = vec![result(
            "Ouagadougou - Wikipedia",
            "https://en.wikipedia.org/wiki/Ouagadougou",
            "Capital of Burkina Faso.",
        )];
        let miss = vec![result(
            "Best Buy: Shop Online For Deals",
            "https://www.bestbuy.ca/",
            "Shop online for deals and save.",
        )];
        assert!(answers_query("Ouagadougou", &hit));
        assert!(!answers_query("Ouagadougou", &miss));
    }

    /// Substring matching is what lets a plural or an inflection count.
    #[test]
    fn inflections_count_as_coverage() {
        let results = vec![result(
            "Why Do Cats Knead Blankets?",
            "https://example.com/cats",
            "Kneading is a leftover kitten behaviour.",
        )];
        assert!(answers_query("why does my cat knead blankets", &results));
    }

    /// Nothing to judge: an empty set is the Empty classification's business,
    /// and it carries a better diagnosis than this one would.
    #[test]
    fn an_empty_result_set_is_left_alone() {
        assert!(answers_query("anything at all", &[]));
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use crate::proxy::search::{search_brave_html, search_duckduckgo, search_yahoo};

    /// Queries chosen to stress the shapes a term-coverage check is worst at:
    /// a natural-language question full of filler, a long multi-clause query,
    /// a quoted phrase, an acronym, a non-English query, and a query whose
    /// answer is a synonym of the question rather than a repeat of it.
    const QUERIES: &[&str] = &[
        "what is the current population of Ouagadougou",
        "why does my cat knead blankets before lying down",
        "Dave Smith comedian Southern Poverty Law Center far right designation",
        "\"strangler fig\" pattern incremental migration legacy monolith",
        "CRDT last-write-wins register vs multi-value register tradeoffs",
        "wie lange dauert ein Marathon Weltrekord",
        "cheapest way to get from Narita to Shibuya",
        "rust async runtime tokio",
    ];

    /// The safety property, against live SERPs: the guard must not reject a
    /// real result set. A false reject costs a healthy engine a 90s cooldown,
    /// and enough of them starve the rotation — which is the exact pathology
    /// that let a decoy-serving engine answer everything in the first place.
    ///
    /// Ignored: needs the network. Run with
    /// `cargo test --manifest-path src-tauri/Cargo.toml relevance::live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn the_guard_accepts_live_results_from_working_engines() {
        let mut checked = 0;
        for query in QUERIES {
            for engine in ["duckduckgo", "yahoo", "brave_html"] {
                // Paced on every attempt, failures included, and far slower
                // than production pacing: both engines start refusing within
                // seconds of a burst, and an engine that refuses contributes
                // no evidence either way. Brave is the eager one — it 429s at
                // anything under roughly 20s between requests.
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                let results = match engine {
                    "duckduckgo" => search_duckduckgo(query, "any", None).await,
                    "yahoo" => search_yahoo(query, "any", None).await,
                    _ => search_brave_html(query, "any", None).await,
                };
                // An engine that is blocked or rate-limited today proves
                // nothing either way; only a real result set is evidence.
                let results = match results {
                    Ok(results) => results,
                    Err(e) => {
                        println!("{engine:12} unavailable — {e}");
                        continue;
                    }
                };
                if results.is_empty() {
                    continue;
                }
                let terms = query_terms(query);
                let covered = covered_terms(&terms, &results);
                println!(
                    "{engine:12} {covered}/{} terms — {query}\n             first: {}",
                    terms.len(),
                    results[0].title
                );
                assert!(
                    answers_query(query, &results),
                    "{engine} returned {} real results for {query:?} and the guard rejected them \
                     ({covered} of {} terms covered)",
                    results.len(),
                    terms.len()
                );
                checked += 1;
            }
        }
        assert!(
            checked >= 4,
            "only {checked} live result sets came back — too few to conclude anything"
        );
    }
}
