/**
 * How much of a fetched page `fetch_url` and `research_url` hand on, and what
 * they say about the rest.
 *
 * The page arrives whole (up to a 400 KB ceiling in Rust). It used to be cut
 * to 4,000 characters there for every model, which left a paper at its
 * abstract and an app page inside its data blob, and nothing told the model:
 * `research_url` answered "No relevant information found" about pages that
 * had the answer further down. Now the cut follows the turn's context window
 * and is always named.
 */

import type { BackendOverride } from '#lib/api.ts';
import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';
import type { FetchedPage } from '#lib/ipc/gen/FetchedPage.ts';
import type { PageLink } from '#lib/ipc/gen/PageLink.ts';
import { clampInt } from '#lib/utils/clampInt.ts';

/** Characters per token, on the low side so a budget doesn't overrun. */
const CHARS_PER_TOKEN = 3;
/** Assumed when the backend doesn't say. */
const FALLBACK_CONTEXT = 32_768;

/** `fetch_url` lands in the conversation, so it gets a slice of the window. */
const FETCH_SHARE = 0.1;
const FETCH_MIN_CHARS = 8_000;
const FETCH_MAX_CHARS = 48_000;

/** `research_url`'s reader has a call of its own, so it gets most of one. */
const RESEARCH_SHARE = 0.75;
const RESEARCH_MIN_CHARS = 12_000;
const RESEARCH_MAX_CHARS = 200_000;

/** Less visible text than this usually means a page built by JavaScript. */
export const THIN_PAGE_CHARS = 1_500;

function contextTokens(backend?: BackendOverride | null): number {
	try {
		return resolveBackendDescriptor(backend ?? undefined).contextSize || FALLBACK_CONTEXT;
	} catch {
		return FALLBACK_CONTEXT;
	}
}

/** Characters of page text `fetch_url` returns on this turn's model. */
export function fetchUrlBudget(backend?: BackendOverride | null): number {
	return clampInt(
		contextTokens(backend) * FETCH_SHARE * CHARS_PER_TOKEN,
		FETCH_MIN_CHARS,
		FETCH_MAX_CHARS
	);
}

/**
 * Characters of page text `research_url`'s reader is given, leaving room for
 * its instructions and its `replyTokens` of findings.
 */
export function researchBudget(replyTokens: number, backend?: BackendOverride | null): number {
	const room = (contextTokens(backend) - replyTokens - 1_000) * CHARS_PER_TOKEN * RESEARCH_SHARE;
	return clampInt(room, RESEARCH_MIN_CHARS, RESEARCH_MAX_CHARS);
}

export interface CutPage {
	text: string;
	/** Characters handed on. */
	shown: number;
	/** Characters in the page before any cut, here or in Rust. */
	full: number;
}

/** `page`'s text cut to `budget` characters at a line or word. */
export function cutPage(page: Omit<FetchedPage, 'links'>, budget: number): CutPage {
	const full = Math.max(page.full_length || 0, page.text.length);
	if (page.text.length <= budget) return { text: page.text, shown: page.text.length, full };
	const head = page.text.slice(0, budget);
	const at = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '));
	const text = at >= budget * 0.8 ? head.slice(0, at) : head;
	return { text, shown: text.length, full };
}

export function wasCut(c: CutPage): boolean {
	return c.shown < c.full;
}

const n = (x: number) => x.toLocaleString('en-US');

/** The line `fetch_url` adds under a cut page. */
export function fetchCutNote(c: CutPage): string {
	return wasCut(c)
		? `\n\n[Showing the first ${n(c.shown)} of ${n(c.full)} characters of this page. To find something further in, call research_url with a focus.]`
		: '';
}

/**
 * What `research_url` adds under its findings: how much of the page it read
 * when it didn't read all of it, and, when it found nothing, why that may not
 * mean the page has nothing.
 */
export function researchNote(c: CutPage, foundNothing: boolean): string {
	const notes: string[] = [];
	if (wasCut(c)) {
		notes.push(`Read the first ${n(c.shown)} of ${n(c.full)} characters of this page.`);
	}
	if (foundNothing && c.full < THIN_PAGE_CHARS) {
		notes.push(
			`The page gave only ${n(c.full)} characters of text, so it is probably built with JavaScript. fetch_url returns the same text. Try the site's API, another page, or the search snippet.`
		);
	} else if (foundNothing && wasCut(c)) {
		notes.push('The answer may be in the part not read: try a page that leads with it.');
	}
	return notes.length ? `\n\n[${notes.join(' ')}]` : '';
}

/** Findings shorter than this count as thin: the page list may help more. */
const THIN_FINDINGS_CHARS = 400;
/** Most links `research_url` lists. */
const RESEARCH_LINKS = 15;
/** A focus that asks where things are, not what a page says. */
const ASKS_FOR_PAGES = /\b(links?|pages?|urls?|sub-?pages?|navigat\w*|sitemap)\b/i;

/** A page as the link lists read it; a cached or mocked page may have no list. */
type LinkedPage = { links?: readonly PageLink[] };

/** `links` as a list headed "Links on this page", or '' when there are none. */
export function linkList(links: readonly PageLink[]): string {
	if (!links.length) return '';
	const lines = links.map((l) => `- ${l.text}: ${l.url}`);
	return `\n\nLinks on this page:\n${lines.join('\n')}`;
}

/**
 * The links `fetch_url` adds after the page text: as many as fit in the
 * `room` characters its budget has left.
 */
export function fetchLinks(page: LinkedPage, room: number): string {
	const links = page.links ?? [];
	let fitted = links.length;
	while (fitted > 0 && linkList(links.slice(0, fitted)).length > room) fitted--;
	return linkList(links.slice(0, fitted));
}

/**
 * The links `research_url` adds under its findings: only when they found
 * little, or when the focus asks for pages. A page's links are not findings,
 * and listing them under every answer would only cost context.
 */
export function researchLinks(page: LinkedPage, findings: string, focus: string): string {
	const thin = findings.trim().length < THIN_FINDINGS_CHARS;
	if (!thin && !ASKS_FOR_PAGES.test(focus)) return '';
	return linkList((page.links ?? []).slice(0, RESEARCH_LINKS));
}

/**
 * `value` with only the dotted `paths` kept, structure and all. An array is
 * picked item by item, at the top or partway down a path, so
 * `items.name,items.url` keeps each item's name and URL together.
 */
export function pickFields(value: unknown, paths: readonly string[][]): unknown {
	if (Array.isArray(value)) return value.map((item) => pickFields(item, paths));
	if (paths.some((p) => p.length === 0)) return value;
	if (value === null || typeof value !== 'object') return undefined;
	const byKey = new Map<string, string[][]>();
	for (const [key, ...rest] of paths) byKey.set(key, [...(byKey.get(key) ?? []), rest]);
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, rest] of byKey) {
		if (!(key in record)) continue;
		const picked = pickFields(record[key], rest);
		if (picked !== undefined) out[key] = picked;
	}
	return out;
}

/** True when nothing was kept: `{}`, or an array of only those. */
function pickedNothing(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(pickedNothing);
	return !!value && typeof value === 'object' && Object.keys(value).length === 0;
}

/** The top-level keys of `value`, or of its first item when it is an array. */
function topKeys(value: unknown): string[] {
	const first = Array.isArray(value) ? value[0] : value;
	return first && typeof first === 'object' && !Array.isArray(first) ? Object.keys(first) : [];
}

/**
 * The page text with only `fields` (comma-separated dotted paths) kept, when
 * it is JSON; otherwise the text as it was, with a note saying why.
 */
export function selectJsonFields(text: string, fields: string): string {
	const paths = fields
		.split(',')
		.map((f) => f.trim())
		.filter(Boolean)
		.map((f) => f.split('.').filter(Boolean));
	if (!paths.length) return text;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return `[fields was ignored: this response is not JSON, or it was too long to read whole.]\n\n${text}`;
	}
	const picked = pickFields(value, paths);
	if (pickedNothing(picked)) {
		const keys = topKeys(value);
		const has = keys.length ? ` Its top-level fields are: ${keys.slice(0, 40).join(', ')}.` : '';
		return `[None of the fields (${fields}) is in this JSON.${has}]`;
	}
	return JSON.stringify(picked, null, 1);
}
