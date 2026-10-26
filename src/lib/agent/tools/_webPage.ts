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

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Characters of page text `fetch_url` returns on this turn's model. */
export function fetchUrlBudget(backend?: BackendOverride | null): number {
	return clamp(
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
	return clamp(room, RESEARCH_MIN_CHARS, RESEARCH_MAX_CHARS);
}

export interface CutPage {
	text: string;
	/** Characters handed on. */
	shown: number;
	/** Characters in the page before any cut, here or in Rust. */
	full: number;
}

/** `page`'s text cut to `budget` characters at a line or word. */
export function cutPage(page: FetchedPage, budget: number): CutPage {
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
			`The page gave only ${n(c.full)} characters of text, so it may build its content with JavaScript. fetch_url shows what was read; an API or another page may have the same information.`
		);
	} else if (foundNothing && wasCut(c)) {
		notes.push('The answer may be in the part not read: try a page that leads with it.');
	}
	return notes.length ? `\n\n[${notes.join(' ')}]` : '';
}
