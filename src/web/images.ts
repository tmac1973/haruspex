/**
 * The pictures in an answer, from the desktop's image cache. The desktop
 * fetched and checked them; the page only asks which it has (`lookupImages`)
 * and puts them in the same map the desktop renders from
 * (`images/resolve.svelte.ts`), so `renderMarkdown` and the image strip work
 * unchanged. Nothing is fetched from the web here.
 */
import { rememberImages } from '#lib/images/resolve.svelte.ts';
import { lookupImages } from './api.ts';

/** `![alt](url)`, as `images/eligible.ts` reads it. */
const IMAGE_REF_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** URLs already asked about. */
const asked = new Set<string>();
/**
 * Misses asked again, and when: the desktop caches an answer's pictures just
 * after the answer ends, so the first ask can come too early.
 */
const RETRY_MS = [3000, 12000];
const tries = new Map<string, number>();
let pending = new Set<string>();
let scheduled = false;

/** The image URLs written into a message's text. Exported for tests. */
export function imageRefs(text: string): string[] {
	return [...text.matchAll(IMAGE_REF_RE)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * Ask the desktop about these URLs, once each. Calls in one tick share a
 * request, so a long transcript makes one.
 */
export function wantImages(urls: readonly string[]): void {
	for (const url of urls) {
		if (asked.has(url)) continue;
		asked.add(url);
		pending.add(url);
	}
	if (scheduled || pending.size === 0) return;
	scheduled = true;
	queueMicrotask(() => {
		const batch = [...pending];
		pending = new Set();
		scheduled = false;
		void lookupImages(batch)
			.then((found) => {
				rememberImages(found);
				for (const url of batch) if (!(url in found)) retryLater(url);
			})
			.catch(() => {
				// Ask again next time, after a dropped connection.
				for (const url of batch) asked.delete(url);
			});
	});
}

function retryLater(url: string): void {
	const n = tries.get(url) ?? 0;
	if (n >= RETRY_MS.length) return;
	tries.set(url, n + 1);
	setTimeout(() => {
		asked.delete(url);
		wantImages([url]);
	}, RETRY_MS[n]);
}

/** Forget what was asked; for tests. */
export function resetImages(): void {
	asked.clear();
	tries.clear();
	pending = new Set();
	scheduled = false;
}
