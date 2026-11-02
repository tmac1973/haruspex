import { stripThinkBlocks } from '#lib/markdown.ts';

const FENCED_HTML = /```html[^\n]*\n([\s\S]*?)```/gi;

/**
 * The HTML document in a 3D specialist's answer: the longest fenced ```html
 * block, else the whole answer when it is a bare document, else `null`.
 */
export function extractHtml(content: string): string | null {
	const text = stripThinkBlocks(content);
	let best: string | null = null;
	for (const m of text.matchAll(FENCED_HTML)) {
		if (best === null || m[1].length > best.length) best = m[1];
	}
	if (best !== null) return best;
	const trimmed = text.trim();
	return /^<(!doctype|html)/i.test(trimmed) ? trimmed : null;
}
