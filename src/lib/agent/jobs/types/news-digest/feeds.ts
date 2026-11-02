/**
 * RSS and Atom feeds for the news digest: fetched through the network proxy
 * and read with `DOMParser`, with no model. Each item keeps the same id from
 * one fetch to the next, so the card can tell which headlines are new.
 */
import { invoke } from '@tauri-apps/api/core';
import type { FetchedPage } from '#lib/ipc/gen/FetchedPage.ts';
import { getSettings } from '#lib/stores/settings.ts';

/** A few general and tech feeds to start from, each checked to serve XML. */
export const PRESET_FEEDS: { name: string; url: string }[] = [
	{ name: 'BBC News — World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
	{ name: 'The Guardian — World', url: 'https://www.theguardian.com/world/rss' },
	{ name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
	{ name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
	{ name: 'Hacker News — front page', url: 'https://hnrss.org/frontpage' }
];

export interface FeedItem {
	/** Stable across fetches: from the feed URL and the item's guid (or link). */
	id: string;
	title: string;
	link: string;
	/** The feed's own title ("BBC News"). */
	source: string;
	/** Epoch ms, or null when the item has no date. */
	published: number | null;
	/** The first 300 characters of the description, without markup. */
	summary: string;
}

const SUMMARY_CHARS = 300;

/** The first 16 hex characters of SHA-256 over the text. */
async function shortHash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Text without HTML tags or runs of white space. */
export function plainText(html: string): string {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function childText(el: Element, ...names: string[]): string {
	for (const name of names) {
		const found = [...el.children].find((c) => c.localName === name);
		const text = found?.textContent?.trim();
		if (text) return text;
	}
	return '';
}

function atomLink(entry: Element): string {
	const links = [...entry.children].filter((c) => c.localName === 'link');
	const alternate =
		links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate') ?? links[0];
	return alternate?.getAttribute('href')?.trim() ?? '';
}

function dateOf(text: string): number | null {
	const at = Date.parse(text);
	return Number.isNaN(at) ? null : at;
}

/**
 * The items of an RSS 2.0, RSS 1.0 or Atom document. Throws "Not a feed."
 * for anything else, such as an HTML page where a feed was expected.
 */
export async function parseFeed(xml: string, feedUrl: string): Promise<FeedItem[]> {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	const root = doc.documentElement;
	const isAtom = root?.localName === 'feed';
	const isRss = root?.localName === 'rss' || root?.localName === 'RDF';
	if (doc.querySelector('parsererror') || !(isAtom || isRss)) throw new Error('Not a feed.');

	const channel = isAtom
		? root
		: ([...root.children].find((c) => c.localName === 'channel') ?? root);
	const source = childText(channel, 'title') || new URL(feedUrl).hostname;
	const entries = [...root.getElementsByTagNameNS('*', isAtom ? 'entry' : 'item')];

	const items: FeedItem[] = [];
	for (const e of entries) {
		const link = isAtom ? atomLink(e) : childText(e, 'link');
		const key = childText(e, isAtom ? 'id' : 'guid') || link;
		const title = plainText(childText(e, 'title'));
		if (!key || !title) continue;
		items.push({
			id: await shortHash(`${feedUrl}\n${key}`),
			title,
			link,
			source,
			published: dateOf(
				isAtom ? childText(e, 'published', 'updated') : childText(e, 'pubDate', 'date')
			),
			summary: plainText(
				isAtom ? childText(e, 'summary', 'content') : childText(e, 'description', 'encoded')
			).slice(0, SUMMARY_CHARS)
		});
	}
	return items;
}

/** One feed's items, fetched through Settings → Network → Network Proxy. */
export async function fetchFeed(url: string): Promise<FeedItem[]> {
	const page = await invoke<FetchedPage>('proxy_fetch', {
		url,
		caller: 'home-news',
		proxy: getSettings().proxy
	});
	return parseFeed(page.text, url);
}

/**
 * The items a pick chooses from: from the last `hours` (undated ones kept),
 * one per link, newest first, at most `cap`.
 */
export function freshItems(items: FeedItem[], hours: number, now: number, cap: number): FeedItem[] {
	const floor = now - hours * 3_600_000;
	const seen = new Set<string>();
	return items
		.filter((i) => i.published === null || i.published >= floor)
		.sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
		.filter((i) => {
			const key = i.link || i.id;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, cap);
}
