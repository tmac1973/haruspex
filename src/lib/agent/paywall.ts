/**
 * Detect whether a fetched page is behind a paywall, login gate, or
 * "register to continue" interstitial. Called by `executeFetchUrl` and
 * `executeResearchUrl` so we can reject the page before the model has a
 * chance to hallucinate facts from a teaser/stub that looks like content.
 *
 * Detection is signal-based, not host-based — we do not maintain a list
 * of known paywalled publishers. Two layers:
 *
 *   1. A Rust-side check (in `fetch_and_extract`) that inspects raw HTML
 *      for standardized paywall metadata before stripping to text. When
 *      a page self-declares via Schema.org `isAccessibleForFree: false`
 *      or OpenGraph `article:content_tier = locked`, the Tauri layer
 *      returns the content prefixed with a sentinel; this detector
 *      picks up that sentinel and flags the page. This catches the wide
 *      range of publishers that follow the Google News "subscription
 *      and paywalled content" spec, without naming any of them.
 *
 *   2. A content heuristic here in TS: if the extracted page body is
 *      short and contains a strong paywall phrase, treat it as gated.
 *      This is the fallback for pages that return a login stub without
 *      emitting the standardized metadata. The length cap keeps us
 *      from flagging a real article that merely has a "subscribe to our
 *      newsletter" footer.
 *
 * Returning `{ paywalled: true, reason }` causes the tool layer to
 * surface a "Paywalled:" error to the model and skip source numbering
 * for the URL, so it never appears as a citation target.
 */

export interface PaywallDetection {
	paywalled: boolean;
	reason?: string;
}

/**
 * Sentinel prefix emitted by the Rust fetcher when the raw HTML carries
 * a standardized paywall marker (Schema.org isAccessibleForFree=false
 * or OpenGraph article:content_tier=locked). Kept in sync with the
 * constant of the same meaning in `proxy.rs` — if you change one, change
 * the other.
 */
export const RUST_PAYWALL_SENTINEL = '[[HARUSPEX_PAYWALL_SIGNAL]]';

// Phrases that strongly suggest the rendered content is a gate, not an
// article. Kept specific — generic words like "subscribe" or "login"
// appear in navigation chrome on plenty of free sites, and we only fire
// on these when the content is also short (see SHORT_CONTENT_THRESHOLD).
const PAYWALL_PHRASES: readonly string[] = [
	'subscribe to continue',
	'subscribe to read',
	'sign in to continue',
	'sign in to read',
	'log in to continue',
	'log in to read',
	'create an account to continue',
	'create a free account to continue',
	'register to continue',
	'this article is for subscribers',
	'subscribers only',
	'premium article',
	'premium content',
	'you have reached your article limit',
	'you have read your',
	'to continue reading',
	'become a subscriber',
	'unlock this article',
	'already a subscriber',
	'paid subscribers'
];

// When the extracted page body is shorter than this, a single paywall
// phrase is enough to flag it. Real articles are typically 2–10 KB of
// text even after readability extraction; a stub under ~1.5 KB plus a
// gate phrase is almost always a paywall teaser.
const SHORT_CONTENT_THRESHOLD = 1500;

export function detectPaywall(_url: string, content: string): PaywallDetection {
	if (!content) return { paywalled: false };

	// Layer 1: the Rust fetcher flagged the raw HTML as paywalled via a
	// standardized metadata marker. The sentinel is always the first line
	// of the returned content when present.
	if (content.startsWith(RUST_PAYWALL_SENTINEL)) {
		// Format emitted by Rust: "<sentinel> <reason>\n<body-or-empty>"
		const firstLine = content.split('\n', 1)[0];
		const reason = firstLine.slice(RUST_PAYWALL_SENTINEL.length).trim();
		return {
			paywalled: true,
			reason: reason || 'page declares itself paywalled in metadata'
		};
	}

	// Layer 2: content heuristic. Only fires when the body is short
	// enough that a gate phrase is plausibly the whole content — prevents
	// false positives on long articles that happen to contain "subscribe"
	// in a footer.
	if (content.length > SHORT_CONTENT_THRESHOLD) return { paywalled: false };

	const lowered = content.toLowerCase();
	const matched = PAYWALL_PHRASES.find((p) => lowered.includes(p));
	if (!matched) return { paywalled: false };

	return {
		paywalled: true,
		reason: `page is short (${content.length} chars) and contains the phrase "${matched}"`
	};
}
