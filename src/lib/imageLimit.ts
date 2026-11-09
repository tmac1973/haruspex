/**
 * Servers that cap the pictures in one request.
 *
 * vLLM refuses a prompt with more images than its `limit_mm_per_prompt`
 * allows ("At most 4 image(s) may be provided in one prompt."), and some
 * OpenRouter providers run it with that cap. A long agent turn adds the
 * pictures each tool hands back as a message of their own, so a turn that
 * looks at a screenshot or a preview on every round passes the cap partway
 * through and the whole turn fails (#1053).
 *
 * On that refusal the request goes again with only the newest pictures, the
 * older ones replaced by a line saying so, and the cap is remembered for the
 * server and model so later requests are trimmed before they are sent.
 */

import type { ChatMessage } from '#lib/api.ts';

/** The cap a server's error text states, or null when it isn't an image-count refusal. */
export function imageLimitFromError(text: string): number | null {
	const match = /at most (\d+) images?(?:\(s\))? may be provided/i.exec(text);
	if (!match) return null;
	const limit = Number(match[1]);
	return Number.isInteger(limit) && limit >= 0 ? limit : null;
}

/** How many pictures `messages` carries. */
export function countImages(messages: ChatMessage[]): number {
	let count = 0;
	for (const m of messages) {
		if (typeof m.content === 'string') continue;
		for (const p of m.content) if (p.type === 'image_url') count++;
	}
	return count;
}

/** What stands in for a picture left out of the request. */
export function omittedImageNote(limit: number): string {
	return `[An earlier picture was left out here: this server takes at most ${limit} per request.]`;
}

/**
 * `messages` with at most `limit` pictures: the newest are kept, each older
 * one becomes a text part saying it was left out. Returns `messages` itself
 * when nothing needs dropping. Never changes the messages it was given.
 */
export function capImages(messages: ChatMessage[], limit: number): ChatMessage[] {
	let excess = countImages(messages) - limit;
	if (excess <= 0) return messages;
	return messages.map((m) => {
		if (excess <= 0 || typeof m.content === 'string') return m;
		if (!m.content.some((p) => p.type === 'image_url')) return m;
		const content = m.content.map((p) => {
			if (p.type !== 'image_url' || excess <= 0) return p;
			excess--;
			return { type: 'text' as const, text: omittedImageNote(limit) };
		});
		return { ...m, content };
	});
}

/** Learned caps, by `imageLimitKey`. Lives as long as the app does. */
const learned = new Map<string, number>();

/** The key a cap is remembered under: one model on one endpoint. */
export function imageLimitKey(url: string, model: string): string {
	return `${url}\n${model}`;
}

/** The cap learned for `key`, if any. */
export function knownImageLimit(key: string): number | undefined {
	return learned.get(key);
}

/** Remember `limit` for `key`; a lower cap replaces a higher one, never the reverse. */
export function rememberImageLimit(key: string, limit: number): void {
	const known = learned.get(key);
	if (known === undefined || limit < known) learned.set(key, limit);
}

/** Test seam: forget every learned cap. */
export function resetImageLimits(): void {
	learned.clear();
}
