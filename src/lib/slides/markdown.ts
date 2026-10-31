/**
 * Markdown a model writes into slide text out of habit. A slide isn't
 * Markdown, so `**bold**` would show its asterisks and `![alt](path)` would
 * show as text: bold becomes a bold run, and a picture becomes the slide's
 * image (`liftImageBullets` in prepare.ts).
 */

export interface TextRun {
	text: string;
	bold: boolean;
}

/** A bullet that is nothing but a Markdown picture, `![alt](path)`. */
const IMAGE_BULLET = /^!\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)$/;

/** The picture's path when `text` is a Markdown picture on its own. */
export function markdownImage(text: string): string | undefined {
	return IMAGE_BULLET.exec(text.trim())?.[1];
}

/**
 * `text` split at its `**` markers into plain and bold runs. Markers that
 * don't pair up are dropped, and the text stays plain.
 */
export function boldRuns(text: string): TextRun[] {
	const parts = text.split('**');
	if (parts.length === 1) return [{ text, bold: false }];
	if (parts.length % 2 === 0) return [{ text: parts.join(''), bold: false }];
	return parts
		.map((part, i) => ({ text: part, bold: i % 2 === 1 }))
		.filter((run) => run.text.length > 0);
}

/** `text` without its `**` markers. */
export function plainText(text: string): string {
	return text.split('**').join('');
}
