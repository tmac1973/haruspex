/**
 * Which image URLs a conversation is allowed to fetch.
 *
 * This is the prompt-injection defence, and it is the reason the whole image
 * pipeline is safe to point at model output. A page the model reads can say
 * anything, including `![](https://attacker.example/beacon.png)`, and the model
 * may echo it into its reply. Rendering that would fire a request carrying the
 * user's IP to an address the attacker chose — a tracking pixel with extra
 * steps.
 *
 * So a URL is fetchable only if this conversation's own tool results produced
 * it. Two sources, and nothing else may be added:
 *
 *   - every result of an `image_search` call, with its full provenance;
 *   - the `heroImage` of a `fetch_url` / `research_url` step, tagged `page_og`
 *     and carrying no licence.
 *
 * A URL the model wrote that is not in the set is never fetched. That also
 * disposes of hallucinated image URLs, which a 9B produces readily — they
 * simply never resolve, and the renderer shows nothing.
 */

import type { SearchStep } from '$lib/agent/loop';
import type { ImageRequest } from '$lib/ipc/gen/ImageRequest';
import type { ImageSearchResult } from '$lib/ipc/gen/ImageSearchResult';

/**
 * Markdown image refs. Global, as `matchAll` requires — it iterates over a
 * clone, so `lastIndex` is not shared between the two functions below.
 */
const IMAGE_REF_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Build the fetchable set for a conversation from its tool steps.
 *
 * Derived rather than accumulated: the steps are already the record of what
 * the turn did, so there is no second piece of state to keep in sync, and a
 * step list restored from the database yields the same answer it did live.
 */
export function eligibleImages(steps: readonly SearchStep[]): Map<string, ImageRequest> {
	const out = new Map<string, ImageRequest>();

	for (const step of steps) {
		if (step.toolName === 'image_search') {
			for (const req of parseImageSearchResults(step.result)) {
				// First writer wins: a URL returned by two sources keeps the
				// provenance of whichever reported it first, matching how the
				// cache resolves the same collision.
				if (!out.has(req.url)) out.set(req.url, req);
			}
			continue;
		}

		if (step.toolName === 'fetch_url' || step.toolName === 'research_url') {
			const hero = step.heroImage;
			if (!hero) continue;
			if (!out.has(hero)) {
				out.set(hero, {
					url: hero,
					// Forces licence `unknown` and `embeddable: false` in Rust,
					// whatever the page claimed about itself.
					source: 'page_og',
					license: null,
					license_version: null,
					attribution: null,
					description_url: null
				});
			}
		}
	}

	return out;
}

/**
 * Pull requests out of an `image_search` tool result.
 *
 * The result is the JSON the tool returned. Anything unparseable yields
 * nothing — a malformed result must not widen what may be fetched.
 */
function parseImageSearchResults(result: string | undefined): ImageRequest[] {
	if (!result) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(result);
	} catch {
		return [];
	}
	if (typeof parsed !== 'object' || parsed === null) return [];
	const results = (parsed as { results?: unknown }).results;
	if (!Array.isArray(results)) return [];

	return results.map(toRequest).filter((r): r is ImageRequest => r !== null);
}

/** One search result → one request, or null if it carries no usable URL. */
function toRequest(raw: unknown): ImageRequest | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const item = raw as Partial<ImageSearchResult>;
	if (typeof item.url !== 'string' || !item.url) return null;
	return {
		url: item.url,
		source: typeof item.source === 'string' && item.source ? item.source : 'unknown',
		license: item.license || null,
		license_version: null,
		attribution: item.attribution || null,
		description_url: item.description_url || null
	};
}

/**
 * Every distinct http(s) markdown image URL in some text, in document order.
 *
 * Used by rehydration, which has no eligibility set to intersect against and
 * instead asks the cache which of these it already holds.
 */
export function imageUrlsInText(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(IMAGE_REF_RE)) {
			const url = match[1]?.trim();
			if (url && /^https?:/i.test(url)) seen.add(url);
		}
	}
	return [...seen];
}

/**
 * The image URLs a reply asks for that this conversation is actually allowed
 * to fetch, capped and in document order.
 *
 * The cap is enforced here rather than trusted to the prompt. The prompt asks
 * for one to three images; a small model will sometimes ask for eight, and
 * this is what makes the ceiling real.
 */
export function resolvableFromReply(
	text: string,
	eligible: ReadonlyMap<string, ImageRequest>,
	max: number
): ImageRequest[] {
	const out: ImageRequest[] = [];
	const taken = new Set<string>();

	for (const match of text.matchAll(IMAGE_REF_RE)) {
		const url = match[1]?.trim();
		if (!url || taken.has(url)) continue;
		const req = eligible.get(url);
		// The injection guard, in one line: not in the set, not fetched.
		if (!req) continue;
		taken.add(url);
		out.push(req);
		if (out.length >= max) break;
	}

	return out;
}
