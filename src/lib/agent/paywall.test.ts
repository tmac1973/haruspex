import { describe, it, expect } from 'vitest';
import { detectPaywall, RUST_PAYWALL_SENTINEL } from '$lib/agent/paywall';

describe('detectPaywall', () => {
	it('picks up the Rust-emitted paywall sentinel', () => {
		const content = `${RUST_PAYWALL_SENTINEL} Schema.org isAccessibleForFree=false\n(no body)`;
		const result = detectPaywall('https://anysite.example/article', content);
		expect(result.paywalled).toBe(true);
		expect(result.reason).toContain('isAccessibleForFree');
	});

	it('uses a fallback reason when the sentinel carries no detail', () => {
		const content = RUST_PAYWALL_SENTINEL;
		const result = detectPaywall('https://anysite.example/article', content);
		expect(result.paywalled).toBe(true);
		expect(result.reason).toBeDefined();
	});

	it('flags short pages that contain a paywall phrase', () => {
		const stub =
			'Short preview of the article. Subscribe to continue reading the rest of this story.';
		const result = detectPaywall('https://smallnewssite.example/article', stub);
		expect(result.paywalled).toBe(true);
		expect(result.reason).toContain('subscribe to continue');
	});

	it('flags short pages with "subscribers only" phrasing', () => {
		const stub = 'This article is for subscribers only. Read a preview below.';
		const result = detectPaywall('https://anysite.example/article', stub);
		expect(result.paywalled).toBe(true);
	});

	it('does not flag a long article that merely has footer chrome', () => {
		// Simulate a real article body with a newsletter footer that
		// happens to include the word "subscribe".
		const body =
			'This is an in-depth article about a topic. '.repeat(200) +
			' Subscribe to our newsletter for updates.';
		const result = detectPaywall('https://freeblog.example/article', body);
		expect(result.paywalled).toBe(false);
	});

	it('does not flag a long article with no paywall phrase', () => {
		const body = 'Article text. '.repeat(500);
		const result = detectPaywall('https://freeblog.example/article', body);
		expect(result.paywalled).toBe(false);
	});

	it('handles empty content gracefully', () => {
		const result = detectPaywall('https://freeblog.example/', '');
		expect(result.paywalled).toBe(false);
	});

	it('does not special-case any specific publisher hostname', () => {
		// Hosts that used to live on an ad-hoc allowlist — they should
		// only be flagged when the content actually signals a paywall.
		const longArticle = 'Article text. '.repeat(500);
		for (const url of [
			'https://www.statista.com/statistics/1234/some-series/',
			'https://www.wsj.com/articles/example',
			'https://www.nytimes.com/2024/01/01/example.html'
		]) {
			const result = detectPaywall(url, longArticle);
			expect(result.paywalled).toBe(false);
		}
	});
});
